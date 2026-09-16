import { access, readdir } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';

export interface WebUiRoutesOptions {
  nodeEnv: 'development' | 'test' | 'production';
}

const API_PREFIXES = ['auth', 'tenants', 'ptv-connections', 'health', 'mcp'];

async function listStaticFiles(root: string, currentDir = root): Promise<string[]> {
  const entries = await readdir(currentDir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = resolve(currentDir, entry.name);
      if (entry.isDirectory()) {
        return listStaticFiles(root, fullPath);
      }
      if (!entry.isFile()) {
        return [] as string[];
      }
      return [relative(root, fullPath).replaceAll('\\', '/')];
    }),
  );
  return files.flat();
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
  const staticFiles = new Set(await listStaticFiles(webDistRoot));

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

    if (path.includes('.') && !path.includes('..') && staticFiles.has(path)) {
      return reply.sendFile(path);
    }

    return reply.type('text/html; charset=utf-8').sendFile('index.html');
  });
}
