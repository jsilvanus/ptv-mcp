import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import type { AppConfig } from './config.js';
import { AuthService } from './auth/authService.js';
import { LoggingMailer, type Mailer } from './auth/mailer.js';
import { createDatabase, type Database } from './db/client.js';
import { UserPtvConnectionService } from './credentials/userPtvConnectionService.js';
import { TenantService } from './tenants/tenantService.js';
import { healthRoutes } from './routes/health.js';
import { authRoutes } from './routes/auth.js';
import { tenantRoutes } from './routes/tenants.js';
import { ptvConnectionRoutes } from './routes/ptvConnections.js';

export interface BuildAppOptions {
  config: Pick<
    AppConfig,
    | 'logLevel'
    | 'nodeEnv'
    | 'databaseUrl'
    | 'jwtSecret'
    | 'masterEncryptionKey'
    | 'ptvV11OAuthClientId'
    | 'ptvV11OAuthClientSecret'
    | 'ptvV11OAuthRedirectUri'
  >;
  /** Injectable for tests against an already-open connection; defaults to a fresh one from `config.databaseUrl`. */
  db?: Database;
  /** Injectable for tests; defaults to logging the link instead of sending real email (see mailer.ts). */
  mailer?: Mailer;
}

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const { config } = options;
  const app: FastifyInstance = Fastify({
    logger:
      config.nodeEnv === 'production'
        ? { level: config.logLevel }
        : { level: config.logLevel, transport: { target: 'pino-pretty' } },
  });

  const db = options.db ?? createDatabase(config.databaseUrl);
  const mailer = options.mailer ?? new LoggingMailer((message) => app.log.info(message));
  const authService = new AuthService({ db, jwtSecret: config.jwtSecret, mailer });
  const tenantService = new TenantService(db);
  const connectionService = new UserPtvConnectionService(db, config.masterEncryptionKey);

  await app.register(sensible);
  await app.register(healthRoutes);
  await app.register(authRoutes, { authService, jwtSecret: config.jwtSecret });
  await app.register(tenantRoutes, { tenantService, jwtSecret: config.jwtSecret, db });
  await app.register(ptvConnectionRoutes, {
    connectionService,
    jwtSecret: config.jwtSecret,
    oauth: {
      clientId: config.ptvV11OAuthClientId,
      clientSecret: config.ptvV11OAuthClientSecret,
      redirectUri: config.ptvV11OAuthRedirectUri,
    },
  });

  return app;
}
