import { existsSync } from 'node:fs';
import { AUTH_MODES, normalizeEmail, type AuthMode } from './auth/signInMode.js';

export interface AppConfig {
  nodeEnv: 'development' | 'test' | 'production';
  host: string;
  port: number;
  logLevel: string;
  databaseUrl: string;
  masterEncryptionKey: string;
  /** Signs/verifies access-token JWTs (Phase 3 Stream A) — deliberately separate from
   * masterEncryptionKey, which wraps PTV credential data keys: different purposes,
   * different rotation schedules, and a JWT-signing leak shouldn't also expose stored
   * PTV credentials. */
  jwtSecret: string;
  /** `ALLOW_PRIVILEGED_DB_ROLE`: start in production even though the database role bypasses row-level security. Default false. */
  allowPrivilegedDbRole: boolean;
  /**
   * v11's per-user OAuth consent flow (docs/ptv-v11-notes.md). Registering a
   * real client with palveluhallinta.suomi.fi is an external, organization-level
   * prerequisite not available as of Phase 2/3 (see EXECUTION_LOG.md) — these
   * default to empty strings so the rest of the app runs without them; the
   * connect-PTV routes simply won't produce a usable flow until they're set.
   */
  ptvV11OAuthClientId: string;
  ptvV11OAuthClientSecret: string;
  ptvV11OAuthRedirectUri: string;
  mcpPublicUrl: string;
  /** Optional public URL path prefix; empty means the root installation. */
  domainPath: string;
  /**
   * Development: the Vite dev server (web/), whose index.html the API serves
   * for browser page loads under /tenants and /ptv-connections.
   */
  webDevUrl?: string;
  /**
   * OpenID Connect sign-in (this app is a Relying Party toward an IdP such as
   * authentik). Undefined when `OIDC_ISSUER` is unset: no SSO button, no
   * `/oidc/*` routes.
   */
  oidc?: OidcConfig;
  /**
   * `REQUIRE_VERIFIED_EMAIL`: sign-in and adding a member need an email the
   * owner has verified. Off by default, because there is no real mail
   * provider yet (LoggingMailer only logs); turn it on once one is configured.
   */
  requireVerifiedEmail: boolean;
  /**
   * `AUTH_MODE`: how people may sign in. `oidc` = single sign-on only, with
   * password sign-in kept for `breakGlassEmails`. Defaults to `both` when OIDC
   * is configured, else `local`.
   */
  authMode: AuthMode;
  /** `OIDC_BREAK_GLASS_EMAILS`, lowercased. Only used when `authMode` is `oidc`. */
  breakGlassEmails: string[];
  /**
   * `ALLOW_TENANT_CREATION`: whether `POST /tenants` creates tenants. Default
   * true (unchanged behaviour). When false the route answers 403; an operator
   * creates tenants with `npm run tenant:create` instead (src/tenants/createTenant.ts).
   */
  allowTenantCreation: boolean;
}

export interface OidcConfig {
  issuer: string;
  clientId: string;
  /** Unset = public client (PKCE only). */
  clientSecret?: string;
  scopes: string;
  buttonLabel: string;
  /** Create a local account for an IdP user who has none. */
  createUsers: boolean;
  /** Link to an existing account by email even when `email_verified` is not true. */
  trustEmail: boolean;
  /**
   * `OIDC_POST_LOGOUT_REDIRECT_URI`: where the IdP sends the browser after
   * sign-out. Undefined = `<MCP public URL>/login`. Must be registered at the IdP.
   */
  postLogoutRedirectUri?: string;
  /**
   * `OIDC_GROUP_SYNC=true`: groups in the IdP's groups claim grant tenant
   * memberships at sign-in (src/oidc/groupGrants.ts). Undefined = off.
   */
  groupSync?: OidcGroupSyncConfig;
}

export interface OidcGroupSyncConfig {
  /** `OIDC_GROUPS_CLAIM`: the claim (ID token, else userinfo) that lists the user's groups. */
  claim: string;
  /** `OIDC_GROUP_PREFIX`, always ending in `/`: group names are `<prefix><tenant-slug>[/<role>]`. */
  prefix: string;
}

/** Normalize DOMAIN_PATH. Empty and "/" both mean a root installation. */
export function normalizeDomainPath(value: string | undefined): string {
  const path = value?.trim() ?? '';
  if (path === '' || path === '/') return '';
  if (
    !path.startsWith('/') ||
    path.startsWith('//') ||
    /[?#\\\\\\s]/.test(path) ||
    path.includes('//') ||
    /%2f|%5c/i.test(path)
  ) {
    throw new Error('Invalid DOMAIN_PATH: use / or an absolute URL path such as /ptv-mcp');
  }
  const normalized = path.replace(/\\/+$/, '');
  if (
    normalized === '' ||
    normalized.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new Error('Invalid DOMAIN_PATH: empty, dot and dot-dot path segments are not allowed');
  }
  return normalized;
}

function parseBoolean(name: string, value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === '') return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1') return true;
  if (normalized === 'false' || normalized === '0') return false;
  throw new Error(`Invalid ${name}: expected true or false, got ${value}`);
}

/** `OIDC_*` variables; undefined when `OIDC_ISSUER` is unset or empty (OIDC off). */
export function loadOidcConfig(
  env: NodeJS.ProcessEnv,
  nodeEnv: AppConfig['nodeEnv'],
): OidcConfig | undefined {
  const issuer = env.OIDC_ISSUER?.trim();
  if (!issuer) return undefined;

  let issuerUrl: URL;
  try {
    issuerUrl = new URL(issuer);
  } catch {
    throw new Error(`Invalid OIDC_ISSUER: not an absolute URL: ${issuer}`);
  }
  if (issuerUrl.protocol !== 'https:' && issuerUrl.protocol !== 'http:') {
    throw new Error(`Invalid OIDC_ISSUER: must be an http(s) URL: ${issuer}`);
  }
  if (nodeEnv === 'production' && issuerUrl.protocol !== 'https:') {
    throw new Error('Invalid OIDC_ISSUER: https is required in production');
  }

  const clientId = env.OIDC_CLIENT_ID?.trim();
  if (!clientId) {
    throw new Error('OIDC_CLIENT_ID is required when OIDC_ISSUER is set');
  }

  const scopes = (env.OIDC_SCOPES?.trim() || 'openid email profile').split(/\s+/).join(' ');
  if (!scopes.split(' ').includes('openid')) {
    throw new Error('Invalid OIDC_SCOPES: must include openid');
  }

  const clientSecret = env.OIDC_CLIENT_SECRET?.trim();

  const postLogout = env.OIDC_POST_LOGOUT_REDIRECT_URI?.trim();
  if (postLogout) {
    let postLogoutUrl: URL;
    try {
      postLogoutUrl = new URL(postLogout);
    } catch {
      throw new Error(`Invalid OIDC_POST_LOGOUT_REDIRECT_URI: not an absolute URL: ${postLogout}`);
    }
    if (postLogoutUrl.protocol !== 'https:' && postLogoutUrl.protocol !== 'http:') {
      throw new Error(
        `Invalid OIDC_POST_LOGOUT_REDIRECT_URI: must be an http(s) URL: ${postLogout}`,
      );
    }
    if (nodeEnv === 'production' && postLogoutUrl.protocol !== 'https:') {
      throw new Error('Invalid OIDC_POST_LOGOUT_REDIRECT_URI: https is required in production');
    }
  }

  const groupSync = loadGroupSyncConfig(env);

  return {
    issuer,
    clientId,
    ...(clientSecret ? { clientSecret } : {}),
    scopes,
    buttonLabel: env.OIDC_BUTTON_LABEL?.trim() || 'Sign in with single sign-on',
    createUsers: parseBoolean('OIDC_CREATE_USERS', env.OIDC_CREATE_USERS, false),
    trustEmail: parseBoolean('OIDC_TRUST_EMAIL', env.OIDC_TRUST_EMAIL, false),
    ...(postLogout ? { postLogoutRedirectUri: postLogout } : {}),
    ...(groupSync ? { groupSync } : {}),
  };
}

/** `OIDC_GROUP_SYNC` and its claim and prefix; undefined when off. */
function loadGroupSyncConfig(env: NodeJS.ProcessEnv): OidcGroupSyncConfig | undefined {
  if (!parseBoolean('OIDC_GROUP_SYNC', env.OIDC_GROUP_SYNC, false)) return undefined;
  const claim = env.OIDC_GROUPS_CLAIM?.trim() || 'groups';
  const rawPrefix = (env.OIDC_GROUP_PREFIX ?? '').trim() || 'ptv/';
  if (/\s/.test(rawPrefix)) {
    throw new Error('Invalid OIDC_GROUP_PREFIX: must not contain whitespace');
  }
  const prefix = rawPrefix.endsWith('/') ? rawPrefix : `${rawPrefix}/`;
  return { claim, prefix };
}

/** `AUTH_MODE`. Throws when it conflicts with whether OIDC is configured. */
export function loadAuthMode(env: NodeJS.ProcessEnv, oidc: OidcConfig | undefined): AuthMode {
  const raw = env.AUTH_MODE?.trim().toLowerCase();
  if (!raw) return oidc ? 'both' : 'local';
  if (!(AUTH_MODES as readonly string[]).includes(raw)) {
    throw new Error(`Invalid AUTH_MODE: expected one of ${AUTH_MODES.join(', ')}, got ${raw}`);
  }
  const mode = raw as AuthMode;
  if (mode === 'local' && oidc) {
    throw new Error('Invalid AUTH_MODE=local: OIDC_ISSUER is set; use both or oidc');
  }
  if (mode !== 'local' && !oidc) {
    throw new Error(`Invalid AUTH_MODE=${mode}: OIDC_ISSUER must be set`);
  }
  return mode;
}

/** `OIDC_BREAK_GLASS_EMAILS`: comma-separated; empty when unset. */
export function loadBreakGlassEmails(env: NodeJS.ProcessEnv): string[] {
  const raw = env.OIDC_BREAK_GLASS_EMAILS ?? '';
  return [
    ...new Set(
      raw
        .split(',')
        .map(normalizeEmail)
        .filter((email) => email.length > 0),
    ),
  ];
}

const MIN_JWT_SECRET_BYTES = 32;

/** JWT_SECRET is base64 (see .env.example); a value that decodes to fewer than 32 bytes is a weak signing key. */
function requireJwtSecret(env: NodeJS.ProcessEnv): string {
  const value = requireEnv('JWT_SECRET', env);
  if (Buffer.from(value, 'base64').length < MIN_JWT_SECRET_BYTES) {
    throw new Error(
      `JWT_SECRET must be base64 that decodes to at least ${MIN_JWT_SECRET_BYTES} bytes. Generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`,
    );
  }
  return value;
}

function requireEnv(name: string, env: NodeJS.ProcessEnv): string {
  let value = env[name];

  if (value === undefined || value === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  // Be tolerant of deployment scripts that accidentally write the variable
  // name into the value (for example, DATABASE_URL=DATABASE_URL=postgres://...).
  // This keeps local/dev startup usable while still rejecting unrelated values.
  const accidentalPrefix = `${name}=`;
  if (value.startsWith(accidentalPrefix)) {
    value = value.slice(accidentalPrefix.length);
  }

  return value;
}

/**
 * Load the local .env file for developer-facing entry points.
 *
 * Production can provide environment variables directly and does not need
 * a .env file. Explicit env objects used by tests are left untouched.
 */
function loadDotEnv(env: NodeJS.ProcessEnv): void {
  if (env !== process.env) return;
  if (existsSync('.env')) process.loadEnvFile('.env');
}

/**
 * Loads and validates process.env into a typed config object.
 * Fails fast at startup rather than surfacing missing config as a
 * confusing runtime error deep in a request handler.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  loadDotEnv(env);

  const nodeEnv = (env.NODE_ENV ?? 'development') as AppConfig['nodeEnv'];
  if (!['development', 'test', 'production'].includes(nodeEnv)) {
    throw new Error(`Invalid NODE_ENV: ${nodeEnv}`);
  }

  const port = Number(env.PORT ?? '5999');
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`Invalid PORT: ${env.PORT}`);
  }

  const oidc = loadOidcConfig(env, nodeEnv);
  const authMode = loadAuthMode(env, oidc);
  const breakGlassEmails = loadBreakGlassEmails(env);

  return {
    nodeEnv,
    // Loopback by default: outside a container the API sits behind a reverse proxy. Containers set HOST=0.0.0.0.
    host: env.HOST ?? '127.0.0.1',
    port,
    logLevel: env.LOG_LEVEL ?? 'info',
    databaseUrl: requireEnv('DATABASE_URL', env),
    masterEncryptionKey: requireEnv('MASTER_ENCRYPTION_KEY', env),
    jwtSecret: requireJwtSecret(env),
    allowPrivilegedDbRole: parseBoolean(
      'ALLOW_PRIVILEGED_DB_ROLE',
      env.ALLOW_PRIVILEGED_DB_ROLE,
      false,
    ),
    ptvV11OAuthClientId: env.PTV_V11_OAUTH_CLIENT_ID ?? '',
    ptvV11OAuthClientSecret: env.PTV_V11_OAUTH_CLIENT_SECRET ?? '',
    ptvV11OAuthRedirectUri: env.PTV_V11_OAUTH_REDIRECT_URI ?? '',
    mcpPublicUrl: env.MCP_PUBLIC_URL ?? `http://localhost:${port}`,
    domainPath: normalizeDomainPath(env.DOMAIN_PATH),
    webDevUrl: env.WEB_DEV_URL ?? 'http://127.0.0.1:5173',
    requireVerifiedEmail: parseBoolean('REQUIRE_VERIFIED_EMAIL', env.REQUIRE_VERIFIED_EMAIL, false),
    authMode,
    breakGlassEmails,
    allowTenantCreation: parseBoolean('ALLOW_TENANT_CREATION', env.ALLOW_TENANT_CREATION, true),
    ...(oidc ? { oidc } : {}),
  };
}
