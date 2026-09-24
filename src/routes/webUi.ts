import { access, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';

export interface WebUiRoutesOptions {
  nodeEnv: 'development' | 'test' | 'production';
}

const API_PREFIXES = ['auth', 'tenants', 'ptv-connections', 'health', 'mcp'];

/**
 * Whether `path` is a file inside `root`. Checked per request rather than
 * listed once at startup, because a redeploy rebuilds web/dist (new hashed
 * asset names) without necessarily restarting the server.
 */
async function isStaticFile(root: string, path: string): Promise<boolean> {
  const fullPath = resolve(root, path);
  const rel = relative(root, fullPath);
  if (rel.startsWith('..') || isAbsolute(rel)) return false;
  try {
    return (await stat(fullPath)).isFile();
  } catch {
    return false;
  }
}

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

  app.get('/', async (_request, reply) =>
    reply.type('text/html; charset=utf-8').sendFile('index.html'),
  );

  app.get('/*', async (request, reply) => {
    const wildcard = (request.params as { '*': string | undefined })['*'] ?? '';
    const path = wildcard.replace(/^\/+/, '');
    if (path === '') {
      return reply.type('text/html; charset=utf-8').sendFile('index.html');
    }

    if (API_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) {
      return reply.notFound();
    }

    if (path.includes('.') && (await isStaticFile(webDistRoot, path))) {
      return reply.sendFile(path);
    }

    return reply.type('text/html; charset=utf-8').sendFile('index.html');
  });
}
