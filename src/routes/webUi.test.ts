import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { webUiRoutes } from './webUi.js';

describe('webUiRoutes', () => {
  const originalCwd = process.cwd();
  let dir: string;
  let app: FastifyInstance;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ptv-webui-'));
    await mkdir(join(dir, 'web/dist/assets'), { recursive: true });
    await writeFile(join(dir, 'web/dist/index.html'), '<html>index</html>');
    await writeFile(join(dir, 'secret.txt'), 'outside dist');
    process.chdir(dir);
    app = Fastify();
    await app.register(webUiRoutes, { nodeEnv: 'production' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    process.chdir(originalCwd);
    await rm(dir, { recursive: true, force: true });
  });

  it('serves assets built after startup (a redeploy without restart)', async () => {
    await writeFile(join(dir, 'web/dist/assets/index-abc123.js'), 'console.log(1)');
    const res = await app.inject({ method: 'GET', url: '/assets/index-abc123.js' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('console.log(1)');
  });

  it('falls back to index.html for SPA routes and unknown files', async () => {
    for (const url of ['/tenants-page', '/assets/missing.js']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.body).toBe('<html>index</html>');
    }
  });

  it('never serves files outside web/dist', async () => {
    const res = await app.inject({ method: 'GET', url: '/..%2F..%2Fsecret.txt' });
    expect(res.body).not.toContain('outside dist');
  });
});
