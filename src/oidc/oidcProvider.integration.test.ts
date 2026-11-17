import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { exportJWK, generateKeyPair } from 'jose';
import Provider from 'oidc-provider';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { loadConfig, type OidcConfig } from '../config.js';
import { createDatabase, type Database } from '../db/client.js';
import { oidcIdentities, users } from '../db/schema/index.js';
import { verifyAccessToken } from '../auth/jwt.js';
import { OIDC_STATE_COOKIE } from '../routes/oidc.js';
import { IntegrationFixtures, listenLocally } from '../testing/integrationFixtures.js';
import { connectMcpClient } from '../testing/mcpClient.js';

/**
 * Sign-in against a generic OpenID Connect provider built on panva's
 * oidc-provider, run in-process. The provider is configured the way a
 * production issuer should be: PKCE required (S256), RS256 ID tokens,
 * client_secret_basic, claims in the ID token, a `groups` scope, and an
 * issuer without a trailing slash. Runs once with a root issuer and once with
 * a path-prefixed issuer.
 */

const CLIENT_ID = 'ptv-mcp-oidc-test';
const CLIENT_SECRET = 'oidc-test-client-secret';
const SCOPES = 'openid email profile groups';

interface ProviderProfile {
  sub: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  preferred_username?: string;
  groups?: string[];
}

/** An oidc-provider issuer on 127.0.0.1, with a scripted user that logs in without a form. */
class TestOidcProvider {
  private readonly server: Server;
  private origin = '';
  private provider: Provider | undefined;
  private readonly profiles = new Map<string, ProviderProfile>();
  private loginAs: string | undefined;
  /** Parameters of the last authorization request the provider saw. */
  lastAuthorizeParams: URLSearchParams | undefined;

  constructor(
    private readonly prefix: string,
    private readonly redirectUri: string,
  ) {
    this.server = createServer((request, response) => {
      this.handle(request, response).catch((err: unknown) => {
        response.writeHead(500, { 'content-type': 'text/plain' });
        response.end(String(err));
      });
    });
  }

  get issuer(): string {
    return `${this.origin}${this.prefix}`;
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    const { port } = this.server.address() as AddressInfo;
    this.origin = `http://127.0.0.1:${port}`;

    const { privateKey } = await generateKeyPair('RS256', { extractable: true });
    const signingKey = {
      ...(await exportJWK(privateKey)),
      kid: 'test-rs256',
      alg: 'RS256',
      use: 'sig',
    };

    this.provider = new Provider(this.issuer, {
      clients: [
        {
          client_id: CLIENT_ID,
          client_secret: CLIENT_SECRET,
          redirect_uris: [this.redirectUri],
          response_types: ['code'],
          grant_types: ['authorization_code'],
          token_endpoint_auth_method: 'client_secret_basic',
          id_token_signed_response_alg: 'RS256',
        },
      ],
      jwks: { keys: [signingKey] },
      cookies: { keys: [randomBytes(24).toString('hex')] },
      pkce: { required: () => true, methods: ['S256'] },
      scopes: ['groups'],
      claims: {
        email: ['email', 'email_verified'],
        profile: ['name', 'preferred_username'],
        groups: ['groups'],
      },
      conformIdTokenClaims: false,
      features: { devInteractions: { enabled: false } },
      interactions: {
        url: (_ctx, interaction) => `${this.prefix}/interaction/${interaction.uid}`,
      },
      findAccount: async (_ctx, sub) => {
        const profile = this.profiles.get(sub);
        if (!profile) return undefined;
        return {
          accountId: sub,
          async claims() {
            const { sub: subject, ...rest } = profile;
            return { sub: subject, ...rest };
          },
        };
      },
    } as ConstructorParameters<typeof Provider>[1]);
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  /** Sets who the next login signs in as. */
  setUser(profile: ProviderProfile): void {
    this.profiles.set(profile.sub, profile);
    this.loginAs = profile.sub;
  }

  /**
   * Serves the provider under its issuer path. The provider is mount-aware
   * the way koa-mount makes it: the prefix is stripped for routing, and
   * `originalUrl` keeps the full path so generated URLs carry the prefix.
   */
  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const full = request.url ?? '/';
    if (this.prefix) {
      if (!new URL(full, this.origin).pathname.startsWith(`${this.prefix}/`)) {
        response.writeHead(404).end();
        return;
      }
      (request as IncomingMessage & { originalUrl?: string }).originalUrl = full;
      request.url = full.slice(this.prefix.length);
    }
    const path = new URL(request.url ?? '/', this.origin).pathname;
    if (/^\/interaction\/[^/]+$/.test(path)) {
      await this.interact(request, response);
      return;
    }
    this.provider!.callback()(request, response);
  }

  /** Logs the scripted user in and grants the requested scopes, with no forms. */
  private async interact(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const provider = this.provider!;
    const details = await provider.interactionDetails(request, response);
    if (details.prompt.name === 'login') {
      if (!this.loginAs) throw new Error('No test user set');
      this.lastAuthorizeParams = new URLSearchParams(
        Object.entries(details.params).map(([key, value]): [string, string] => [
          key,
          String(value),
        ]),
      );
      await provider.interactionFinished(
        request,
        response,
        { login: { accountId: this.loginAs } },
        { mergeWithLastSubmission: false },
      );
      return;
    }
    if (details.prompt.name === 'consent') {
      const missing = details.prompt.details as {
        missingOIDCScope?: string[];
        missingOIDCClaims?: string[];
      };
      const grant = new provider.Grant({
        accountId: details.session!.accountId!,
        clientId: String(details.params.client_id),
      });
      if (missing.missingOIDCScope?.length) grant.addOIDCScope(missing.missingOIDCScope.join(' '));
      if (missing.missingOIDCClaims?.length) grant.addOIDCClaims(missing.missingOIDCClaims);
      const grantId = await grant.save();
      await provider.interactionFinished(
        request,
        response,
        { consent: { grantId } },
        { mergeWithLastSubmission: true },
      );
      return;
    }
    throw new Error(`Unhandled interaction prompt: ${details.prompt.name}`);
  }
}

describe.each([
  { label: 'root issuer', prefix: '' },
  { label: 'path-prefixed issuer', prefix: '/idp' },
])('OIDC sign-in against a generic oidc-provider ($label)', ({ prefix }) => {
  const config = loadConfig();
  const db: Database = createDatabase(config.databaseUrl);
  const fixtures = new IntegrationFixtures(db, config);
  const appRedirectUri = `${config.mcpPublicUrl.replace(/\/+$/, '')}/oidc/callback`;
  const appOrigin = new URL(appRedirectUri).origin;
  const idp = new TestOidcProvider(prefix, appRedirectUri);
  const apps: FastifyInstance[] = [];
  let mcpClientId: string;

  function oidcConfig(): OidcConfig {
    return {
      issuer: idp.issuer,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      scopes: SCOPES,
      buttonLabel: 'Sign in with single sign-on',
      createUsers: false,
      trustEmail: false,
    };
  }

  async function app(): Promise<FastifyInstance> {
    const base = { ...config };
    delete base.oidc;
    const instance = await buildApp({
      config: { ...base, logLevel: 'silent', oidc: oidcConfig() },
      db,
    });
    apps.push(instance);
    return instance;
  }

  beforeAll(async () => {
    await idp.start();
    const instance = await app();
    const registered = await instance.inject({
      method: 'POST',
      url: '/oauth/register',
      payload: {
        client_name: 'OIDC provider test client',
        redirect_uris: ['https://mcp-client.example.test/callback'],
      },
    });
    mcpClientId = (registered.json() as { client_id: string }).client_id;
  });

  afterAll(async () => {
    if (mcpClientId)
      await db.execute(sql`DELETE FROM oauth_clients WHERE client_id = ${mcpClientId}`);
    await db.delete(oidcIdentities).where(eq(oidcIdentities.issuer, idp.issuer));
    for (const instance of apps) await instance.close();
    await idp.stop();
    await fixtures.cleanup();
  });

  afterEach(async () => {
    await db.delete(oidcIdentities).where(eq(oidcIdentities.issuer, idp.issuer));
  });

  function stateCookie(setCookie: string | string[] | undefined): string {
    const header = Array.isArray(setCookie) ? setCookie.join(';') : (setCookie ?? '');
    const match = new RegExp(`${OIDC_STATE_COOKIE}=([^;]*)`).exec(header);
    if (!match?.[1]) throw new Error('No OIDC state cookie set');
    return match[1];
  }

  /**
   * Follows the redirects from the provider's authorization endpoint through
   * its interaction pages until it sends the browser back to the app, keeping
   * the provider's cookies like a browser would. Returns the callback path.
   */
  async function throughProvider(start: string): Promise<string> {
    const jar = new Map<string, string>();
    let next = new URL(start);
    for (let hop = 0; hop < 12; hop += 1) {
      if (next.origin === appOrigin) {
        expect(next.pathname).toBe('/oidc/callback');
        return next.pathname + next.search;
      }
      const cookie = [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
      const response = await fetch(next, {
        redirect: 'manual',
        ...(cookie ? { headers: { cookie } } : {}),
      });
      for (const raw of response.headers.getSetCookie()) {
        const pair = raw.split(';')[0] ?? '';
        const index = pair.indexOf('=');
        if (index > 0) jar.set(pair.slice(0, index), pair.slice(index + 1));
      }
      const location = response.headers.get('location');
      if (response.status < 300 || response.status >= 400 || !location) {
        throw new Error(`Unexpected ${response.status} at ${next.pathname} during sign-in`);
      }
      next = new URL(location, next);
    }
    throw new Error('Too many redirects between the app and the provider');
  }

  /** Starts a sign-in on `instance`, lets the provider answer, and returns the callback request. */
  async function signInAtIdp(instance: FastifyInstance, loginUrl = '/oidc/login') {
    const start = await instance.inject({ method: 'GET', url: loginUrl });
    expect(start.statusCode).toBe(302);
    const setCookie = String(start.headers['set-cookie']);
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/SameSite=Lax/);
    const location = String(start.headers.location);
    // The discovered authorization endpoint sits under the issuer's path.
    expect(new URL(location).pathname.startsWith(`${prefix}/`)).toBe(true);
    const callbackPath = await throughProvider(location);
    return { callbackPath, cookie: stateCookie(start.headers['set-cookie']) };
  }

  function callback(instance: FastifyInstance, callbackPath: string, cookie: string) {
    return instance.inject({
      method: 'GET',
      url: callbackPath,
      headers: { cookie: `${OIDC_STATE_COOKIE}=${cookie}` },
    });
  }

  function handoffCode(location: string | undefined): string {
    const match = /^\/login#oidc=(.+)$/.exec(location ?? '');
    if (!match?.[1]) throw new Error(`Unexpected redirect ${location}`);
    return decodeURIComponent(match[1]);
  }

  async function localUser(): Promise<{ userId: string; email: string }> {
    const userId = await fixtures.user('Provider Test User');
    return { userId, email: `${userId}@example.test` };
  }

  it('publishes discovery metadata that matches the required configuration', async () => {
    const response = await fetch(`${idp.issuer}/.well-known/openid-configuration`);
    expect(response.status).toBe(200);
    const metadata = (await response.json()) as Record<string, unknown>;
    expect(metadata.issuer).toBe(idp.issuer);
    expect(idp.issuer.endsWith('/')).toBe(false);
    expect(metadata.code_challenge_methods_supported).toEqual(['S256']);
    expect(metadata.id_token_signing_alg_values_supported).toContain('RS256');
    expect(metadata.token_endpoint_auth_methods_supported).toContain('client_secret_basic');
    expect(String(metadata.authorization_endpoint).startsWith(`${idp.issuer}/`)).toBe(true);
    expect(String(metadata.token_endpoint).startsWith(`${idp.issuer}/`)).toBe(true);
    expect(String(metadata.jwks_uri).startsWith(`${idp.issuer}/`)).toBe(true);
  });

  it('signs a linked user in on the web with PKCE, a nonce and the groups scope', async () => {
    const instance = await app();
    const { userId } = await localUser();
    const subject = randomUUID();
    await db.insert(oidcIdentities).values({ issuer: idp.issuer, subject, userId });
    idp.setUser({
      sub: subject,
      email: 'someone-else@example.test',
      email_verified: true,
      name: 'Provider Test User',
      preferred_username: 'provider-test',
      groups: ['example/tenant-a/viewer'],
    });

    const { callbackPath, cookie } = await signInAtIdp(instance);
    const res = await callback(instance, callbackPath, cookie);
    expect(res.statusCode).toBe(302);
    expect(String(res.headers['set-cookie'])).toMatch(
      new RegExp(`${OIDC_STATE_COOKIE}=;.*Max-Age=0`),
    );

    const sent = idp.lastAuthorizeParams!;
    expect(sent.get('code_challenge_method')).toBe('S256');
    expect(sent.get('code_challenge')).toBeTruthy();
    expect(sent.get('nonce')).toBeTruthy();
    expect(sent.get('scope')?.split(' ')).toEqual(expect.arrayContaining(['openid', 'groups']));
    expect(sent.get('client_id')).toBe(CLIENT_ID);

    const session = await instance.inject({
      method: 'POST',
      url: '/oidc/session',
      payload: { code: handoffCode(res.headers.location) },
    });
    expect(session.statusCode).toBe(200);
    const body = session.json() as { accessToken: string };
    expect((await verifyAccessToken(body.accessToken, config.jwtSecret)).sub).toBe(userId);
  });

  it('completes an MCP authorization through the provider and yields a working token', async () => {
    const instance = await app();
    const { userId, email } = await localUser();
    idp.setUser({
      sub: randomUUID(),
      email,
      email_verified: true,
      groups: ['example/tenant-a/viewer'],
    });

    const codeVerifier = randomBytes(32).toString('base64url');
    const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
    const page = await instance.inject({
      method: 'GET',
      url: `/oauth/authorize?${new URLSearchParams({
        response_type: 'code',
        client_id: mcpClientId,
        redirect_uri: 'https://mcp-client.example.test/callback',
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        state: 'client-state',
      }).toString()}`,
    });
    expect(page.statusCode).toBe(200);
    const ssoHref = /href="(\/oidc\/login\?oauth=[^"]+)"/.exec(page.body)?.[1];
    expect(ssoHref).toBeDefined();

    const { callbackPath, cookie } = await signInAtIdp(instance, ssoHref!);
    const selection = await callback(instance, callbackPath, cookie);
    expect(selection.statusCode).toBe(200);
    const selectionToken = /name="selection_token" value="([^"]+)"/.exec(selection.body)?.[1];
    expect(selectionToken).toBeDefined();

    const approved = await instance.inject({
      method: 'POST',
      url: '/oauth/authorize',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        selection_token: selectionToken!,
        tenant_id: '',
        environment: 'test',
        read_api_version: 'v11',
        write_api_version: '',
      }).toString(),
    });
    expect(approved.statusCode).toBe(302);
    const redirect = new URL(String(approved.headers.location));
    expect(redirect.searchParams.get('state')).toBe('client-state');

    const token = await instance.inject({
      method: 'POST',
      url: '/oauth/token',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        grant_type: 'authorization_code',
        code: redirect.searchParams.get('code')!,
        client_id: mcpClientId,
        redirect_uri: 'https://mcp-client.example.test/callback',
        code_verifier: codeVerifier,
      }).toString(),
    });
    expect(token.statusCode).toBe(200);
    const accessToken = (token.json() as { access_token: string }).access_token;
    expect((await fixtures.oauth.verifyAccessToken(accessToken)).sub).toBe(userId);

    const listening = await app();
    const client = await connectMcpClient(await listenLocally(listening), accessToken);
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toContain('ptv_search_services');
    await client.close();

    await db.delete(users).where(eq(users.email, email));
  });

  it('ends the provider session on sign-out with the ID token as id_token_hint', async () => {
    const instance = await app();
    const { userId } = await localUser();
    const subject = randomUUID();
    await db.insert(oidcIdentities).values({ issuer: idp.issuer, subject, userId });
    idp.setUser({ sub: subject, email: 'someone-else@example.test', email_verified: true });

    const { callbackPath, cookie } = await signInAtIdp(instance);
    const res = await callback(instance, callbackPath, cookie);
    const session = await instance.inject({
      method: 'POST',
      url: '/oidc/session',
      payload: { code: handoffCode(res.headers.location) },
    });
    const { accessToken, refreshToken } = session.json() as {
      accessToken: string;
      refreshToken: string;
    };

    const logout = await instance.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { refreshToken },
    });
    expect(logout.statusCode).toBe(200);
    const { endSessionUrl } = logout.json() as { endSessionUrl: string };
    const end = new URL(endSessionUrl);
    expect(end.origin).toBe(new URL(idp.issuer).origin);
    expect(end.pathname.startsWith(`${prefix}/`)).toBe(true);
    expect(end.searchParams.get('post_logout_redirect_uri')).toBe(
      `${config.mcpPublicUrl.replace(/\/+$/, '')}/login`,
    );
    const idToken = end.searchParams.get('id_token_hint');
    expect(idToken).toBeTruthy();
    const payload = JSON.parse(Buffer.from(idToken!.split('.')[1]!, 'base64url').toString());
    expect(payload.sub).toBe(subject);

    // The refresh token is revoked, so a second sign-out has no IdP hint left.
    const again = await instance.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { refreshToken },
    });
    expect(again.statusCode).toBe(204);
  });
});
