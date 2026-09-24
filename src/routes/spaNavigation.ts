import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';

/**
 * Path prefixes that are both web UI pages and API routes
 * (e.g. /tenants/:id/proposals). The web app's own API calls use fetch's
 * default Accept (*\/*); a browser loading or reloading a page asks for
 * text/html. Same split as web/vite.config.ts's dev proxy.
 */
const SHARED_PREFIX = /^\/(tenants|ptv-connections)(\/|$)/;

export function isPageNavigation(request: FastifyRequest): boolean {
  const path = request.url.split('?')[0] ?? '';
  return (
    request.method === 'GET' &&
    SHARED_PREFIX.test(path) &&
    (request.headers.accept ?? '').includes('text/html')
  );
}

export interface SpaNavigationOptions {
  nodeEnv: 'development' | 'test' | 'production';
  /** Development: the Vite dev server whose index.html to serve. */
  webDevUrl: string;
}

/**
 * Answers a browser page load under a shared prefix with the web UI instead
 * of the API route of the same path (which would reply with JSON, e.g.
 * 404 for /tenants/:id/reviews or 401 for /tenants/:id/proposals). The
 * reverse proxy may send these paths straight to the API, so the API must
 * handle them itself. Production serves web/dist/index.html; development
 * fetches the Vite dev server's index.html (its /@vite and /src assets are
 * served by Vite). Tests skip it.
 */
export function registerSpaNavigation(app: FastifyInstance, options: SpaNavigationOptions): void {
  if (options.nodeEnv === 'test') return;
  const loadIndex =
    options.nodeEnv === 'production'
      ? () => readFile(resolve(process.cwd(), 'web/dist/index.html'), 'utf8')
      : async () => {
          const response = await fetch(new URL('/', options.webDevUrl), {
            headers: { accept: 'text/html' },
            signal: AbortSignal.timeout(3000),
          });
          if (!response.ok) throw new Error(`web dev server answered ${response.status}`);
          return response.text();
        };

  app.addHook('onRequest', async (request, reply) => {
    if (!isPageNavigation(request)) return;
    let html: string;
    try {
      html = await loadIndex();
    } catch (err) {
      // No web UI to serve: fall through to the API route.
      request.log.warn({ err }, 'web UI index not available for page load');
      return;
    }
    return reply.type('text/html; charset=utf-8').header('cache-control', 'no-cache').send(html);
  });
}
