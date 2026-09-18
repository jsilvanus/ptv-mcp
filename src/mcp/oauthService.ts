import { randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { generateOpaqueToken, hashToken } from '../auth/tokens.js';
import { SignJWT, jwtVerify, errors } from 'jose';

const CODE_TTL_MS = 60_000;
const ACCESS_TTL_SECONDS = 3600;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface OAuthClientMetadata {
  client_id?: string;
  client_name?: string;
  redirect_uris: string[];
  grant_types?: string[];
  response_types?: string[];
  token_endpoint_auth_method?: string;
  application_type?: string;
}

export interface AuthorizationRequest {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state?: string;
  scope: string;
  tenantId: string;
  state?: string;
}

export class OAuthService {
  constructor(
    private readonly db: Database,
    private readonly jwtSecret: string,
    private readonly issuer: string,
    private readonly resource: string,
  ) {}

  async registerClient(metadata: OAuthClientMetadata) {
    if (!Array.isArray(metadata.redirect_uris) || metadata.redirect_uris.length === 0) {
      throw new Error('redirect_uris is required');
    }
    const clientId = metadata.client_id ?? `urn:ptv-mcp:client:${randomUUID()}`;
    await this.db.execute(sql`
      INSERT INTO oauth_clients (client_id, client_name, redirect_uris, grant_types, response_types, token_endpoint_auth_method, application_type)
      VALUES (${clientId}, ${metadata.client_name ?? null}, ${JSON.stringify(metadata.redirect_uris)}::jsonb,
              ${JSON.stringify(metadata.grant_types ?? ['authorization_code', 'refresh_token'])}::jsonb,
              ${JSON.stringify(metadata.response_types ?? ['code'])}::jsonb,
              ${metadata.token_endpoint_auth_method ?? 'none'}, ${metadata.application_type ?? 'web'})
      ON CONFLICT (client_id) DO UPDATE SET
        client_name = EXCLUDED.client_name,
        redirect_uris = EXCLUDED.redirect_uris,
        grant_types = EXCLUDED.grant_types,
        response_types = EXCLUDED.response_types,
        token_endpoint_auth_method = EXCLUDED.token_endpoint_auth_method,
        application_type = EXCLUDED.application_type
    `);
    return {
      client_id: clientId,
      client_name: metadata.client_name,
      redirect_uris: metadata.redirect_uris,
      grant_types: metadata.grant_types ?? ['authorization_code', 'refresh_token'],
      response_types: metadata.response_types ?? ['code'],
      token_endpoint_auth_method: metadata.token_endpoint_auth_method ?? 'none',
    };
  }

  async validateClient(clientId: string, redirectUri: string): Promise<boolean> {
    if (this.isCimdClientId(clientId)) {
      const metadata = await this.fetchCimdMetadata(clientId);
      return metadata.redirect_uris.includes(redirectUri);
    }

    const rows = await this.db.execute<{ redirect_uris: string[] }>(
      sql`SELECT redirect_uris FROM oauth_clients WHERE client_id = ${clientId}`,
    );
    const row = rows[0];
    return !!row && Array.isArray(row.redirect_uris) && row.redirect_uris.includes(redirectUri);
  }

  private isCimdClientId(clientId: string): boolean {
    try {
      const url = new URL(clientId);
      return url.protocol === 'https:' &&
        url.pathname !== '/' &&
        url.username === '' &&
        url.password === '' &&
        url.search === '' &&
        url.hash === '';
    } catch {
      return false;
    }
  }

  private async fetchCimdMetadata(clientId: string): Promise<OAuthClientMetadata> {
    const url = new URL(clientId);
    if (!this.isCimdClientId(clientId)) throw new Error('Invalid CIMD client_id');

    const addresses = await lookup(url.hostname, { all: true });
    if (addresses.length === 0 || addresses.some(({ address }) => this.isPrivateIp(address))) {
      throw new Error('CIMD client_id resolves to a private address');
    }

    let current = url;
    for (let redirects = 0; redirects <= 3; redirects += 1) {
      const response = await fetch(current, {
        headers: { accept: 'application/json' },
        redirect: 'manual',
        signal: AbortSignal.timeout(5000),
      });

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location || redirects === 3) throw new Error('Invalid CIMD redirect');
        const next = new URL(location, current);
        if (!this.isCimdClientId(next.toString())) throw new Error('Invalid CIMD redirect');
        const nextAddresses = await lookup(next.hostname, { all: true });
        if (nextAddresses.length === 0 || nextAddresses.some(({ address }) => this.isPrivateIp(address))) {
          throw new Error('CIMD redirect resolves to a private address');
        }
        current = next;
        continue;
      }

      if (!response.ok) throw new Error('Unable to fetch CIMD document');
      const contentLength = response.headers.get('content-length');
      if (contentLength && Number(contentLength) > 64 * 1024) throw new Error('CIMD document is too large');

      let metadata: unknown;
      try {
        metadata = JSON.parse(await response.text());
      } catch {
        throw new Error('Invalid CIMD document');
      }

      if (!metadata || typeof metadata !== 'object') throw new Error('Invalid CIMD document');
      const value = metadata as Record<string, unknown>;
      if (value.client_id !== clientId ||
          typeof value.client_name !== 'string' ||
          !Array.isArray(value.redirect_uris) ||
          value.redirect_uris.some((uri) => typeof uri !== 'string')) {
        throw new Error('Invalid CIMD document');
      }

      return {
        client_id: clientId,
        client_name: value.client_name,
        redirect_uris: value.redirect_uris as string[],
        ...(Array.isArray(value.grant_types)
          ? { grant_types: value.grant_types.filter((v): v is string => typeof v === 'string') }
          : {}),
        ...(Array.isArray(value.response_types)
          ? { response_types: value.response_types.filter((v): v is string => typeof v === 'string') }
          : {}),
        ...(typeof value.token_endpoint_auth_method === 'string'
          ? { token_endpoint_auth_method: value.token_endpoint_auth_method }
          : {}),
        ...(typeof value.application_type === 'string'
          ? { application_type: value.application_type }
          : {}),
      };
    }

    throw new Error('Unable to fetch CIMD document');
  }

  private isPrivateIp(address: string): boolean {
    if (address.includes(':')) {
      const normalized = address.toLowerCase();
      return normalized === '::1' ||
        normalized.startsWith('fc') ||
        normalized.startsWith('fd') ||
        normalized.startsWith('fe8') ||
        normalized.startsWith('fe9') ||
        normalized.startsWith('fea') ||
        normalized.startsWith('feb');
    }

    const octets = address.split('.').map(Number);
    if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return true;
    const [a, b] = octets;
    if (a === undefined || b === undefined) return true;
    return a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a === 0;
  }

  async createTenantSelectionToken(userId: string, request: AuthorizationRequest): Promise<string> {
    return new SignJWT({
      kind: 'tenant_selection',
      client_id: request.clientId,
      redirect_uri: request.redirectUri,
      code_challenge: request.codeChallenge,
      scope: request.scope,
      ...(request.state ? { state: request.state } : {}),
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(userId)
      .setIssuer(this.issuer)
      .setAudience(this.resource)
      .setIssuedAt()
      .setExpirationTime('10m')
      .sign(Buffer.from(this.jwtSecret, 'base64'));
  }

  async verifyTenantSelectionToken(token: string) {
    const { payload } = await jwtVerify(token, Buffer.from(this.jwtSecret, 'base64'), {
      algorithms: ['HS256'],
      issuer: this.issuer,
      audience: this.resource,
    });
    if (
      payload.kind !== 'tenant_selection' ||
      typeof payload.sub !== 'string' ||
      typeof payload.client_id !== 'string' ||
      typeof payload.redirect_uri !== 'string' ||
      typeof payload.code_challenge !== 'string' ||
      typeof payload.scope !== 'string'
    ) {
      throw new Error('invalid_selection');
    }
    return {
      userId: payload.sub,
      clientId: payload.client_id,
      redirectUri: payload.redirect_uri,
      codeChallenge: payload.code_challenge,
      scope: payload.scope,
      ...(typeof payload.state === 'string' ? { state: payload.state } : {}),
    };
  }

  async createAuthorizationCode(userId: string, request: AuthorizationRequest): Promise<string> {
    if (!request.tenantId || !request.environment || !request.apiVersion) throw new Error('Invalid authorization selection');
    if (!(await this.validateClient(request.clientId, request.redirectUri))) {
      throw new Error('Invalid client or redirect_uri');
    }
    const code = generateOpaqueToken();
    await this.db.execute(sql`
      INSERT INTO oauth_authorization_codes
        (code_hash, client_id, redirect_uri, code_challenge, user_id, scope, tenant_id, environment, api_version, expires_at)
      VALUES
        (${hashToken(code)}, ${request.clientId}, ${request.redirectUri}, ${request.codeChallenge},
         ${userId}, ${request.scope}, ${request.tenantId}, ${request.environment}, ${request.apiVersion}, now() + interval '60 seconds')
    `);
    return code;
  }

  async exchangeCode(code: string, clientId: string, redirectUri: string, codeVerifier: string) {
    const rows = await this.db.execute<{
      id: string; client_id: string; redirect_uri: string; code_challenge: string;
      user_id: string; scope: string; tenant_id: string | null; environment: 'test' | 'production'; api_version: string; expires_at: Date; consumed_at: Date | null;
    }>(sql`SELECT * FROM oauth_authorization_codes WHERE code_hash = ${hashToken(code)}`);
    const row = rows[0];
    if (!row || row.consumed_at || new Date(row.expires_at) < new Date() ||
        row.client_id !== clientId || row.redirect_uri !== redirectUri ||
        !await this.verifyPkce(codeVerifier, row.code_challenge)) {
      throw new Error('invalid_grant');
    }
    await this.db.execute(sql`UPDATE oauth_authorization_codes SET consumed_at = now() WHERE id = ${row.id}::uuid AND consumed_at IS NULL`);
    if (!row.tenant_id) throw new Error('invalid_grant');
    const accessToken = await this.issueAccessToken(row.user_id, clientId, row.scope, row.tenant_id, row.environment, row.api_version);
    const refreshToken = generateOpaqueToken();
    await this.db.execute(sql`
      INSERT INTO oauth_refresh_tokens (token_hash, client_id, user_id, scope, tenant_id, environment, api_version, expires_at)
      VALUES (${hashToken(refreshToken)}, ${clientId}, ${row.user_id}, ${row.scope}, ${row.tenant_id}, ${row.environment}, ${row.api_version}, now() + interval '30 days')
    `);
    return { access_token: accessToken, token_type: 'Bearer', expires_in: ACCESS_TTL_SECONDS, refresh_token: refreshToken, scope: row.scope };
  }

  async refresh(refreshToken: string, clientId: string) {
    const rows = await this.db.execute<{ id: string; client_id: string; user_id: string; scope: string; tenant_id: string | null; environment: 'test' | 'production'; api_version: string; expires_at: Date; revoked_at: Date | null }>(
      sql`SELECT * FROM oauth_refresh_tokens WHERE token_hash = ${hashToken(refreshToken)}`,
    );
    const row = rows[0];
    if (!row || row.revoked_at || new Date(row.expires_at) < new Date() || row.client_id !== clientId) {
      throw new Error('invalid_grant');
    }
    if (!row.tenant_id) throw new Error('invalid_grant');
    const accessToken = await this.issueAccessToken(row.user_id, clientId, row.scope, row.tenant_id);
    return { access_token: accessToken, token_type: 'Bearer', expires_in: ACCESS_TTL_SECONDS, scope: row.scope };
  }

  async verifyAccessToken(token: string) {
    try {
      const { payload } = await jwtVerify(token, Buffer.from(this.jwtSecret, 'base64'), {
        algorithms: ['HS256'],
        issuer: this.issuer,
        audience: this.resource,
      });
      if (typeof payload.sub !== 'string') throw new Error('missing sub');
      return { sub: payload.sub, clientId: typeof payload.client_id === 'string' ? payload.client_id : undefined, scope: typeof payload.scope === 'string' ? payload.scope : '', tenantId: typeof payload.tenant_id === 'string' ? payload.tenant_id : undefined };
    } catch (err) {
      if (err instanceof errors.JOSEError || err instanceof Error) throw new Error('invalid_token');
      throw err;
    }
  }

  async issueAccessToken(userId: string, clientId: string, scope: string, tenantId: string): Promise<string> {
    return new SignJWT({ client_id: clientId, scope, tenant_id: tenantId })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(userId)
      .setIssuer(this.issuer)
      .setAudience(this.resource)
      .setIssuedAt()
      .setExpirationTime(`${ACCESS_TTL_SECONDS}s`)
      .sign(Buffer.from(this.jwtSecret, 'base64'));
  }

  private async verifyPkce(verifier: string, challenge: string) {
    const data = new TextEncoder().encode(verifier);
    const digest = await crypto.subtle.digest('SHA-256', data);
    const actual = Buffer.from(digest).toString('base64url');
    return actual === challenge;
  }
}
