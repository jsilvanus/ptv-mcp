import { randomUUID } from 'node:crypto';
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
    const rows = await this.db.execute<{ redirect_uris: string[] }>(
      sql`SELECT redirect_uris FROM oauth_clients WHERE client_id = ${clientId}`,
    );
    const row = rows[0];
    return !!row && Array.isArray(row.redirect_uris) && row.redirect_uris.includes(redirectUri);
  }

  async createAuthorizationCode(userId: string, request: AuthorizationRequest): Promise<string> {
    if (!(await this.validateClient(request.clientId, request.redirectUri))) {
      throw new Error('Invalid client or redirect_uri');
    }
    const code = generateOpaqueToken();
    await this.db.execute(sql`
      INSERT INTO oauth_authorization_codes
        (code_hash, client_id, redirect_uri, code_challenge, user_id, scope, expires_at)
      VALUES
        (${hashToken(code)}, ${request.clientId}, ${request.redirectUri}, ${request.codeChallenge},
         ${userId}, ${request.scope}, now() + interval '60 seconds')
    `);
    return code;
  }

  async exchangeCode(code: string, clientId: string, redirectUri: string, codeVerifier: string) {
    const rows = await this.db.execute<{
      id: string; client_id: string; redirect_uri: string; code_challenge: string;
      user_id: string; scope: string; expires_at: Date; consumed_at: Date | null;
    }>(sql`SELECT * FROM oauth_authorization_codes WHERE code_hash = ${hashToken(code)}`);
    const row = rows[0];
    if (!row || row.consumed_at || new Date(row.expires_at) < new Date() ||
        row.client_id !== clientId || row.redirect_uri !== redirectUri ||
        !await this.verifyPkce(codeVerifier, row.code_challenge)) {
      throw new Error('invalid_grant');
    }
    await this.db.execute(sql`UPDATE oauth_authorization_codes SET consumed_at = now() WHERE id = ${row.id}::uuid AND consumed_at IS NULL`);
    const accessToken = await this.signAccessToken(row.user_id, clientId, row.scope);
    const refreshToken = generateOpaqueToken();
    await this.db.execute(sql`
      INSERT INTO oauth_refresh_tokens (token_hash, client_id, user_id, scope, expires_at)
      VALUES (${hashToken(refreshToken)}, ${clientId}, ${row.user_id}, ${row.scope}, now() + interval '30 days')
    `);
    return { access_token: accessToken, token_type: 'Bearer', expires_in: ACCESS_TTL_SECONDS, refresh_token: refreshToken, scope: row.scope };
  }

  async refresh(refreshToken: string, clientId: string) {
    const rows = await this.db.execute<{ id: string; client_id: string; user_id: string; scope: string; expires_at: Date; revoked_at: Date | null }>(
      sql`SELECT * FROM oauth_refresh_tokens WHERE token_hash = ${hashToken(refreshToken)}`,
    );
    const row = rows[0];
    if (!row || row.revoked_at || new Date(row.expires_at) < new Date() || row.client_id !== clientId) {
      throw new Error('invalid_grant');
    }
    const accessToken = await this.signAccessToken(row.user_id, clientId, row.scope);
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
      return { sub: payload.sub, clientId: typeof payload.client_id === 'string' ? payload.client_id : undefined, scope: typeof payload.scope === 'string' ? payload.scope : '' };
    } catch (err) {
      if (err instanceof errors.JOSEError || err instanceof Error) throw new Error('invalid_token');
      throw err;
    }
  }

  private async signAccessToken(userId: string, clientId: string, scope: string) {
    return new SignJWT({ client_id: clientId, scope })
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
