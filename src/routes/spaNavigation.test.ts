import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerSpaNavigation } from './spaNavigation.js';

describe('registerSpaNavigation', () => {
  let web: Server;
  let webUrl: string;

  beforeAll(async () => {
    web = createServer((_req, res) => {
      res.setHeader('content-type', 'text/html');
      res.end('<!doctype html><title>ptv-mcp web</title>');
    });
    await new Promise<void>((done) => web.listen(0, '127.0.0.1', done));
    webUrl = `http://127.0.0.1:${(web.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((done) => web.close(done));
  });

  async function app(webDevUrl = webUrl) {
    const instance = Fastify();
    registerSpaNavigation(instance, { nodeEnv: 'development', webDevUrl });
    instance.get('/tenants/:id/proposals', async () => ({ api: true }));
    await instance.ready();
    return instance;
  }

  it('serves the web UI for a browser page load of a shared path', async () => {
    const instance = await app();
    for (const url of ['/tenants/t-1/reviews', '/tenants/t-1/proposals?status=approved']) {
      const response = await instance.inject({
        method: 'GET',
        url,
        headers: { accept: 'text/html,application/xhtml+xml,*/*;q=0.8' },
      });
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('ptv-mcp web');
    }
    await instance.close();
  });

  it('leaves the web app’s own API calls and other paths to the API', async () => {
    const instance = await app();
    const api = await instance.inject({
      method: 'GET',
      url: '/tenants/t-1/proposals',
      headers: { accept: '*/*' },
    });
    expect(api.json()).toEqual({ api: true });
    const other = await instance.inject({
      method: 'GET',
      url: '/mcp',
      headers: { accept: 'text/html' },
    });
    expect(other.statusCode).toBe(404);
    await instance.close();
  });

  it('falls through to the API when the web UI is unavailable', async () => {
    const instance = await app('http://127.0.0.1:1');
    const response = await instance.inject({
      method: 'GET',
      url: '/tenants/t-1/proposals',
      headers: { accept: 'text/html' },
    });
    expect(response.json()).toEqual({ api: true });
    await instance.close();
  });
});
