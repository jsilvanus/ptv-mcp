import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';

/** The identity the fake IdP signs in as, for the next `/authorize`. */
export interface FakeOidcUser {
  sub: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  preferred_username?: string;
}

interface IssuedCode {
  user: FakeOidcUser;
  clientId: string;
  redirectUri: string;
  nonce: string | undefined;
  codeChallenge: string | undefined;
}

export interface FakeOidcProviderOptions {
  clientId: string;
  /** When set, the token endpoint requires HTTP Basic client authentication with it. */
  clientSecret?: string;
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * A minimal OpenID Connect provider for tests (node:http + jose, RS256 ID
 * tokens): discovery, JWKS, `/authorize` (302 straight back with a code and
 * the state), `/token` (checks PKCE and client auth) and `/userinfo`.
 * Issuer: `http://127.0.0.1:<port>/application/o/test/`, shaped like
 * authentik's.
 */
export class FakeOidcProvider {
  /** Who `/authorize` signs in as. */
  user: FakeOidcUser = { sub: 'unset' };
  /** Leave the email claims out of the ID token (userinfo still has them). */
  omitEmailFromIdToken = false;
  /** Discovery answers 503 while true. */
  down = false;
  /** Number of discovery requests served. */
  discoveryRequests = 0;
  /** The last `/authorize` query. */
  lastAuthorizeParams: URLSearchParams | undefined;

  private server: Server | undefined;
  private privateKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'] | undefined;
  private publicJwk: JWK | undefined;
  private readonly codes = new Map<string, IssuedCode>();
  private readonly accessTokens = new Map<string, FakeOidcUser>();
  private origin = '';

  constructor(private readonly options: FakeOidcProviderOptions) {}

  get issuer(): string {
    return `${this.origin}/application/o/test/`;
  }

  async start(): Promise<void> {
    const { privateKey, publicKey } = await generateKeyPair('RS256');
    this.privateKey = privateKey;
    this.publicJwk = { ...(await exportJWK(publicKey)), kid: 'test-key', alg: 'RS256', use: 'sig' };
    this.server = createServer((request, response) => {
      this.handle(request)
        .then(({ status, headers, body }) => {
          response.writeHead(status, headers);
          response.end(body);
        })
        .catch((err: unknown) => {
          response.writeHead(500, { 'content-type': 'text/plain' });
          response.end(String(err));
        });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('No address');
    this.origin = `http://127.0.0.1:${address.port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }

  private json(status: number, body: unknown) {
    return {
      status,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    };
  }

  private async handle(
    request: IncomingMessage,
  ): Promise<{ status: number; headers: Record<string, string>; body: string }> {
    const url = new URL(request.url ?? '/', this.origin);
    const base = '/application/o/test';

    if (url.pathname === `${base}/.well-known/openid-configuration`) {
      this.discoveryRequests += 1;
      if (this.down) return this.json(503, { error: 'unavailable' });
      return this.json(200, {
        issuer: this.issuer,
        authorization_endpoint: `${this.origin}${base}/authorize`,
        token_endpoint: `${this.origin}${base}/token`,
        userinfo_endpoint: `${this.origin}${base}/userinfo`,
        jwks_uri: `${this.origin}${base}/jwks`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['client_secret_basic', 'none'],
      });
    }

    if (url.pathname === `${base}/jwks`) {
      return this.json(200, { keys: [this.publicJwk] });
    }

    if (url.pathname === `${base}/authorize`) {
      const params = url.searchParams;
      this.lastAuthorizeParams = params;
      const redirectUri = params.get('redirect_uri') ?? '';
      if (params.get('client_id') !== this.options.clientId) {
        return this.json(400, { error: 'invalid_client' });
      }
      const code = randomBytes(16).toString('hex');
      this.codes.set(code, {
        user: { ...this.user },
        clientId: this.options.clientId,
        redirectUri,
        nonce: params.get('nonce') ?? undefined,
        codeChallenge: params.get('code_challenge') ?? undefined,
      });
      const back = new URL(redirectUri);
      back.searchParams.set('code', code);
      const state = params.get('state');
      if (state) back.searchParams.set('state', state);
      return { status: 302, headers: { location: back.toString() }, body: '' };
    }

    if (url.pathname === `${base}/token` && request.method === 'POST') {
      const form = new URLSearchParams(await readBody(request));
      if (this.options.clientSecret) {
        // RFC 6749 2.3.1: id and secret are form-urlencoded before base64.
        const basic = /^Basic (.+)$/.exec(request.headers.authorization ?? '')?.[1];
        const [id, secret] = Buffer.from(basic ?? '', 'base64')
          .toString('utf8')
          .split(':')
          .map((part) => decodeURIComponent(part.replace(/\+/g, ' ')));
        if (id !== this.options.clientId || secret !== this.options.clientSecret) {
          return this.json(401, { error: 'invalid_client' });
        }
      }
      const code = form.get('code') ?? '';
      const issued = this.codes.get(code);
      this.codes.delete(code);
      if (!issued || form.get('redirect_uri') !== issued.redirectUri) {
        return this.json(400, { error: 'invalid_grant' });
      }
      const verifier = form.get('code_verifier') ?? '';
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      if (!issued.codeChallenge || challenge !== issued.codeChallenge) {
        return this.json(400, { error: 'invalid_grant', error_description: 'PKCE' });
      }
      const accessToken = randomBytes(16).toString('hex');
      this.accessTokens.set(accessToken, issued.user);
      const { sub, email, email_verified, ...profile } = issued.user;
      const idToken = await new SignJWT({
        ...profile,
        ...(this.omitEmailFromIdToken ? {} : { email, email_verified }),
        ...(issued.nonce ? { nonce: issued.nonce } : {}),
      })
        .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
        .setIssuer(this.issuer)
        .setAudience(issued.clientId)
        .setSubject(sub)
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(this.privateKey!);
      return this.json(200, {
        access_token: accessToken,
        token_type: 'Bearer',
        expires_in: 300,
        id_token: idToken,
      });
    }

    if (url.pathname === `${base}/userinfo`) {
      const token = (request.headers.authorization ?? '').replace(/^Bearer /, '');
      const user = this.accessTokens.get(token);
      if (!user) return this.json(401, { error: 'invalid_token' });
      return this.json(200, user);
    }

    return this.json(404, { error: 'not_found' });
  }
}
