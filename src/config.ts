import { existsSync } from 'node:fs';

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

  return {
    nodeEnv,
    host: env.HOST ?? '0.0.0.0',
    port,
    logLevel: env.LOG_LEVEL ?? 'info',
    databaseUrl: requireEnv('DATABASE_URL', env),
    masterEncryptionKey: requireEnv('MASTER_ENCRYPTION_KEY', env),
    jwtSecret: requireEnv('JWT_SECRET', env),
    ptvV11OAuthClientId: env.PTV_V11_OAUTH_CLIENT_ID ?? '',
    ptvV11OAuthClientSecret: env.PTV_V11_OAUTH_CLIENT_SECRET ?? '',
    ptvV11OAuthRedirectUri: env.PTV_V11_OAUTH_REDIRECT_URI ?? '',
  };
}
