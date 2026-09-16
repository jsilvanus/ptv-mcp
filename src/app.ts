import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import type { AppConfig } from './config.js';
import { healthRoutes } from './routes/health.js';

export async function buildApp(
  config: Pick<AppConfig, 'logLevel' | 'nodeEnv'>,
): Promise<FastifyInstance> {
  const app: FastifyInstance = Fastify({
    logger:
      config.nodeEnv === 'production'
        ? { level: config.logLevel }
        : { level: config.logLevel, transport: { target: 'pino-pretty' } },
  });

  await app.register(sensible);
  await app.register(healthRoutes);

  return app;
}
