export interface AppConfig {
  nodeEnv: 'development' | 'test' | 'production';
  host: string;
  port: number;
  logLevel: string;
  databaseUrl: string;
  masterEncryptionKey: string;
}

function requireEnv(name: string, env: NodeJS.ProcessEnv): string {
  const value = env[name];
  if (value === undefined || value === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

/**
 * Loads and validates process.env into a typed config object.
 * Fails fast at startup rather than surfacing missing config as a
 * confusing runtime error deep in a request handler.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const nodeEnv = (env.NODE_ENV ?? 'development') as AppConfig['nodeEnv'];
  if (!['development', 'test', 'production'].includes(nodeEnv)) {
    throw new Error(`Invalid NODE_ENV: ${nodeEnv}`);
  }

  const port = Number(env.PORT ?? '3000');
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`Invalid PORT: ${env.PORT}`);
  }

  return {
    nodeEnv,
    host: env.HOST ?? '0.0.0.0',
    port,
    logLevel: env.LOG_LEVEL ?? 'info',
    databaseUrl: requireEnv('DATABASE_URL', env),
    masterEncryptionKey: env.MASTER_ENCRYPTION_KEY ?? '',
  };
}
