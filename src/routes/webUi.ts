import { access } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';

export interface WebUiRoutesOptions {
  nodeEnv: 'development' | 'test' | 'production';
}

const API_PREFIXES = ['auth', 'tenants', 'ptv-connections', 'health', 'mcp'];

export async function webUiRoutes(
  app: FastifyInstance,
  options: WebUiRoutesOptions,
): Promise<void> {
  if (options.nodeEnv !== 'production') {
    return;
  }

  const webDistRoot = resolve(process.cwd(), 'web/dist');
  try {
    await access(resolve(webDistRoot, 'index.html'));
  } catch {
    app.log.warn({ webDistRoot }, 'web/dist not found; SPA routes disabled');
    return;
  }

  await app.register(fastifyStatic, {
    root: webDistRoot,
    wildcard: false,
    index: false,
  });

  app.get('/', async (_request, reply) => reply.type('text/html; charset=utf-8').sendFile('index.html'));

  app.get('/*', async (request, reply) => {
    const wildcard = (request.params as { '*': string | undefined })['*'] ?? '';
    const path = wildcard.replace(/^\/+/, '');
    if (path === '') {
      return reply.type('text/html; charset=utf-8').sendFile('index.html');
    }

    if (API_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) {
      return reply.notFound();
    }

    if (path.includes('.')) {
      const candidate = resolve(webDistRoot, path);
      if (candidate === webDistRoot || candidate.startsWith(`${webDistRoot}${sep}`)) {
        try {
          await access(candidate);
          return reply.sendFile(path);
        } catch {
          // Fall through to index.html below so unknown deep-link assets
          // and client-side routes both get consistent SPA fallback behavior.
        }
      }
    }

    return reply.type('text/html; charset=utf-8').sendFile('index.html');
  });
}
