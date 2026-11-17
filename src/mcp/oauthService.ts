import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { generateOpaqueToken, hashToken } from '../auth/tokens.js';
import { SignJWT, jwtVerify } from 'jose';
import { fetchPinned } from './safeFetch.js';

const ACCESS_TTL_SECONDS = 3600;
const MAX_REDIRECT_URIS = 10;
const MAX_REDIRECT_URI_LENGTH = 2000;
const MAX_CLIENT_NAME_LENGTH = 200;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
/** Schemes that could run script or read local files; custom app schemes stay allowed. */
const REJECTED_REDIRECT_SCHEMES = new Set(['javascript:', 'data:', 'file:', 'vbscript:', 'blob:']);

/**
 * Why a registered redirect URI is refused, or null when it is acceptable:
 * https, http only to a loopback host, or a custom app scheme (cursor://, vscode://).
 */
export function redirectUriError(value: unknown): string | null {
  if (typeof value !== 'string') return 'redirect_uris entries must be strings';
  if (value.length > MAX_REDIRECT_URI_LENGTH) {
    return `redirect_uris entries must be at most ${MAX_REDIRECT_URI_LENGTH} characters`;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'redirect_uris entries must be absolute URLs';
  }
  if (url.hash !== '') return 'redirect_uris entries must not contain a fragment';
  if (REJECTED_REDIRECT_SCHEMES.has(url.protocol)) {
    return `redirect_uris entries must not use the ${url.protocol} scheme`;
  }
  if (url.protocol === 'https:') return null;
  if (url.protocol === 'http:') {
    return LOOPBACK_HOSTS.has(url.hostname)
      ? null
      : 'http redirect_uris entries are allowed only for localhost, 127.0.0.1 or [::1]';
  }
  return null;
}

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
  tenantId?: string;
  environment?: 'test' | 'production';
  readApiVersion?: string;
  writeApiVersion?: string | null;
}

/** An authorization code or refresh token row: what an access token is issued for. */
type Grant = {
  user_id: string;
  scope: string;
  tenant_id: string | null;
  environment: 'test' | 'production';
  read_api_version: string;
  write_api_version: string | null;
};

function stringList(value: unknown[]): string[] {
  return value.filter((v): v is string => typeof v === 'string');
}

/**
 * Keeps the string-typed fields of client metadata (a registration request
 * body or a CIMD document); non-string list entries are dropped.
 */
export function parseClientMetadata(value: Record<string, unknown>): OAuthClientMetadata {
  return {
    ...(typeof value.client_id === 'string' ? { client_id: value.client_id } : {}),
    ...(typeof value.client_name === 'string' ? { client_name: value.client_name } : {}),
    redirect_uris: Array.isArray(value.redirect_uris) ? stringList(value.redirect_uris) : [],
    ...(Array.isArray(value.grant_types) ? { grant_types: stringList(value.grant_types) } : {}),
    ...(Array.isArray(value.response_types)
      ? { response_types: stringList(value.response_types) }
      : {}),
    ...(typeof value.token_endpoint_auth_method === 'string'
      ? { token_endpoint_auth_method: value.token_endpoint_auth_method }
      : {}),
    ...(typeof value.application_type === 'string'
      ? { application_type: value.application_type }
      : {}),
  };
}

/**
 * A connection without an organisation reads public, published PTV data
 * only: v11 reads and no writes.
 */
export function isAllowedWithoutTenant(
  readApiVersion: string | undefined,
  writeApiVersion: string | null | undefined,
): boolean {
  return readApiVersion === 'v11' && !writeApiVersion;
}

export class OAuthService {
  private readonly secretKey: Uint8Array;

  constructor(
    private readonly db: Database,
    jwtSecret: string,
    private readonly issuer: string,
    private readonly resource: string,
  ) {
    this.secretKey = Buffer.from(jwtSecret, 'base64');
  }

  /**
   * Dynamic client registration. Always mints a new client id: any `client_id`
   * in the metadata is ignored, and registration never updates an existing
   * client, so an unauthenticated caller cannot replace another client's
   * redirect URIs.
   */
  async registerClient(metadata: OAuthClientMetadata) {
    const redirectUris = metadata.redirect_uris;
    if (!Array.isArray(redirectUris) || redirectUris.length === 0) {
      throw new Error('redirect_uris is required');
    }
    if (redirectUris.length > MAX_REDIRECT_URIS) {
      throw new Error(`redirect_uris may list at most ${MAX_REDIRECT_URIS} entries`);
    }
    for (const uri of redirectUris) {
      const error = redirectUriError(uri);
      if (error) throw new Error(error);
    }
    const clientName = metadata.client_name
      ? Array.from(metadata.client_name.trim()).slice(0, MAX_CLIENT_NAME_LENGTH).join('') ||
        undefined
      : undefined;

    const clientId = `urn:ptv-mcp:client:${randomUUID()}`;
    await this.db.execute(sql`
      INSERT INTO oauth_clients (client_id, client_name, redirect_uris, grant_types, response_types, token_endpoint_auth_method, application_type)
      VALUES (${clientId}, ${clientName ?? null}, ${JSON.stringify(redirectUris)}::jsonb,
              ${JSON.stringify(metadata.grant_types ?? ['authorization_code', 'refresh_token'])}::jsonb,
              ${JSON.stringify(metadata.response_types ?? ['code'])}::jsonb,
              ${metadata.token_endpoint_auth_method ?? 'none'}, ${metadata.application_type ?? 'web'})
    `);
    return {
      client_id: clientId,
      client_name: clientName,
      redirect_uris: redirectUris,
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

  /**
   * Display info for the sign-in pages. A CIMD client id has no stored name
   * and is never fetched here, so rendering a page makes no outbound request.
   */
  async describeClient(clientId: string): Promise<{ name: string | null }> {
    if (this.isCimdClientId(clientId)) return { name: null };
    const rows = await this.db.execute<{ client_name: string | null }>(
      sql`SELECT client_name FROM oauth_clients WHERE client_id = ${clientId}`,
    );
    return { name: rows[0]?.client_name ?? null };
  }

  private isCimdClientId(clientId: string): boolean {
    try {
      const url = new URL(clientId);
      return (
        url.protocol === 'https:' &&
        url.pathname !== '/' &&
        url.username === '' &&
        url.password === '' &&
        url.search === '' &&
        url.hash === ''
      );
    } catch {
      return false;
    }
  }

  private async fetchCimdMetadata(clientId: string): Promise<OAuthClientMetadata> {
    const url = new URL(clientId);
    if (!this.isCimdClientId(clientId)) throw new Error('Invalid CIMD client_id');

    let current = url;
    for (let redirects = 0; redirects <= 3; redirects += 1) {
      // Resolves, checks and connects to one address, and caps the body while it streams.
      const response = await fetchPinned(current, { maxBytes: 64 * 1024, timeoutMs: 5000 });

      if (response.status >= 300 && response.status < 400) {
        if (!response.location || redirects === 3) throw new Error('Invalid CIMD redirect');
        const next = new URL(response.location, current);
        if (!this.isCimdClientId(next.toString())) throw new Error('Invalid CIMD redirect');
        current = next;
        continue;
      }

      if (response.status < 200 || response.status >= 300)
        throw new Error('Unable to fetch CIMD document');

      let metadata: unknown;
      try {
        metadata = JSON.parse(response.body);
      } catch {
        throw new Error('Invalid CIMD document');
      }

      if (!metadata || typeof metadata !== 'object') throw new Error('Invalid CIMD document');
      const value = metadata as Record<string, unknown>;
      if (
        value.client_id !== clientId ||
        typeof value.client_name !== 'string' ||
        !Array.isArray(value.redirect_uris) ||
        value.redirect_uris.some((uri) => typeof uri !== 'string')
      ) {
        throw new Error('Invalid CIMD document');
      }

      return parseClientMetadata(value);
    }

    throw new Error('Unable to fetch CIMD document');
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
      .sign(this.secretKey);
  }

  async verifyTenantSelectionToken(token: string) {
    const { payload } = await jwtVerify(token, this.secretKey, {
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
    if (!request.environment || !request.readApiVersion)
      throw new Error('Invalid authorization selection');
    if (
      !request.tenantId &&
      !isAllowedWithoutTenant(request.readApiVersion, request.writeApiVersion)
    )
      throw new Error('A connection without an organisation is v11 read-only');
    if (!(await this.validateClient(request.clientId, request.redirectUri))) {
      throw new Error('Invalid client or redirect_uri');
    }
    const code = generateOpaqueToken();
    await this.db.execute(sql`
      INSERT INTO oauth_authorization_codes
        (code_hash, client_id, redirect_uri, code_challenge, user_id, scope, tenant_id, environment, api_version, read_api_version, write_api_version, expires_at)
      VALUES
        (${hashToken(code)}, ${request.clientId}, ${request.redirectUri}, ${request.codeChallenge},
         ${userId}, ${request.scope}, ${request.tenantId ?? null}, ${request.environment}, ${request.readApiVersion}, ${request.readApiVersion}, ${request.writeApiVersion ?? null}, now() + interval '60 seconds')
    `);
    return code;
  }

  async exchangeCode(code: string, clientId: string, redirectUri: string, codeVerifier: string) {
    const rows = await this.db.execute<
      Grant & {
        id: string;
        client_id: string;
        redirect_uri: string;
        code_challenge: string;
        expires_at: Date;
        consumed_at: Date | null;
      }
    >(sql`SELECT * FROM oauth_authorization_codes WHERE code_hash = ${hashToken(code)}`);
    const row = rows[0];
    if (
      !row ||
      row.consumed_at ||
      new Date(row.expires_at) < new Date() ||
      row.client_id !== clientId ||
      row.redirect_uri !== redirectUri ||
      !(await this.verifyPkce(codeVerifier, row.code_challenge))
    ) {
      throw new Error('invalid_grant');
    }
    // One guarded UPDATE decides which of two concurrent exchanges wins.
    const claimed = await this.db.execute<{ id: string }>(
      sql`UPDATE oauth_authorization_codes SET consumed_at = now() WHERE id = ${row.id}::uuid AND consumed_at IS NULL RETURNING id`,
    );
    if (claimed.length === 0) throw new Error('invalid_grant');
    this.requireAllowedGrant(row);
    const refreshToken = await this.issueRefreshToken(clientId, row);
    return this.tokenResponse(row, clientId, refreshToken);
  }

  private async issueRefreshToken(clientId: string, grant: Grant): Promise<string> {
    const refreshToken = generateOpaqueToken();
    await this.db.execute(sql`
      INSERT INTO oauth_refresh_tokens (token_hash, client_id, user_id, scope, tenant_id, environment, api_version, read_api_version, write_api_version, expires_at)
      VALUES (${hashToken(refreshToken)}, ${clientId}, ${grant.user_id}, ${grant.scope}, ${grant.tenant_id}, ${grant.environment}, ${grant.read_api_version}, ${grant.read_api_version}, ${grant.write_api_version}, now() + interval '30 days')
    `);
    return refreshToken;
  }

  /** Rotates: the presented refresh token is revoked and a new one is issued with the access token. */
  async refresh(refreshToken: string, clientId: string) {
    const rows = await this.db.execute<
      Grant & {
        id: string;
        client_id: string;
        expires_at: Date;
        revoked_at: Date | null;
      }
    >(sql`SELECT * FROM oauth_refresh_tokens WHERE token_hash = ${hashToken(refreshToken)}`);
    const row = rows[0];
    if (
      !row ||
      row.revoked_at ||
      new Date(row.expires_at) < new Date() ||
      row.client_id !== clientId
    ) {
      throw new Error('invalid_grant');
    }
    this.requireAllowedGrant(row);
    // Only one of two concurrent uses of the same token may revoke it.
    const revoked = await this.db.execute<{ id: string }>(
      sql`UPDATE oauth_refresh_tokens SET revoked_at = now() WHERE id = ${row.id}::uuid AND revoked_at IS NULL RETURNING id`,
    );
    if (revoked.length === 0) throw new Error('invalid_grant');
    const newRefreshToken = await this.issueRefreshToken(clientId, row);
    return this.tokenResponse(row, clientId, newRefreshToken);
  }

  private requireAllowedGrant(grant: Grant): void {
    if (
      !grant.tenant_id &&
      !isAllowedWithoutTenant(grant.read_api_version, grant.write_api_version)
    )
      throw new Error('invalid_grant');
  }

  /** The token endpoint's response; `refresh_token` only when a new one was issued. */
  private async tokenResponse(grant: Grant, clientId: string, refreshToken?: string) {
    const accessToken = await this.issueAccessToken(
      grant.user_id,
      clientId,
      grant.scope,
      grant.tenant_id,
      grant.environment,
      grant.read_api_version,
      grant.write_api_version,
    );
    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: ACCESS_TTL_SECONDS,
      ...(refreshToken ? { refresh_token: refreshToken } : {}),
      scope: grant.scope,
    };
  }

  async verifyAccessToken(token: string) {
    try {
      const { payload } = await jwtVerify(token, this.secretKey, {
        algorithms: ['HS256'],
        issuer: this.issuer,
        audience: this.resource,
      });
      if (typeof payload.sub !== 'string') throw new Error('missing sub');
      return {
        sub: payload.sub,
        clientId: typeof payload.client_id === 'string' ? payload.client_id : undefined,
        scope: typeof payload.scope === 'string' ? payload.scope : '',
        tenantId: typeof payload.tenant_id === 'string' ? payload.tenant_id : undefined,
        environment:
          payload.environment === 'test' || payload.environment === 'production'
            ? payload.environment
            : undefined,
        readApiVersion:
          typeof payload.read_api_version === 'string' ? payload.read_api_version : undefined,
        writeApiVersion:
          typeof payload.write_api_version === 'string' ? payload.write_api_version : undefined,
      };
    } catch (err) {
      // jose's JOSEError extends Error, so this covers every verification failure.
      if (err instanceof Error) throw new Error('invalid_token');
      throw err;
    }
  }

  async issueAccessToken(
    userId: string,
    clientId: string,
    scope: string,
    /** `null` for a public connection: PTV v11 published data only. */
    tenantId: string | null,
    environment: 'test' | 'production',
    readApiVersion: string,
    writeApiVersion: string | null,
  ): Promise<string> {
    return new SignJWT({
      client_id: clientId,
      scope,
      ...(tenantId ? { tenant_id: tenantId } : {}),
      environment,
      read_api_version: readApiVersion,
      ...(writeApiVersion ? { write_api_version: writeApiVersion } : {}),
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(userId)
      .setIssuer(this.issuer)
      .setAudience(this.resource)
      .setIssuedAt()
      .setExpirationTime(`${ACCESS_TTL_SECONDS}s`)
      .sign(this.secretKey);
  }

  private async verifyPkce(verifier: string, challenge: string) {
    const data = new TextEncoder().encode(verifier);
    const digest = await crypto.subtle.digest('SHA-256', data);
    const actual = Buffer.from(digest).toString('base64url');
    return actual === challenge;
  }
}
