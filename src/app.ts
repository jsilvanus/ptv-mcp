import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import type { AppConfig } from './config.js';
import { AuthService } from './auth/authService.js';
import { LoggingMailer, type Mailer } from './auth/mailer.js';
import { createDatabase, type Database } from './db/client.js';
import { healthRoutes } from './routes/health.js';
import { authRoutes } from './routes/auth.js';

export interface BuildAppOptions {
  config: Pick<AppConfig, 'logLevel' | 'nodeEnv' | 'databaseUrl' | 'jwtSecret'>;
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

  await app.register(sensible);
  await app.register(healthRoutes);
  await app.register(authRoutes, { authService, jwtSecret: config.jwtSecret });

  return app;
}
