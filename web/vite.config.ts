import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import react from '@vitejs/plugin-react';
import { defineConfig, type ProxyOptions } from 'vite';

// The API listens on PORT (environment first, then the repo root's .env, then 5999, as src/config.ts).
const rootEnvPath = fileURLToPath(new URL('../.env', import.meta.url));
const rootEnv = existsSync(rootEnvPath) ? parseEnv(readFileSync(rootEnvPath, 'utf8')) : {};
const target = `http://127.0.0.1:${process.env.PORT ?? rootEnv.PORT ?? '5999'}`;

// /tenants and /ptv-connections are both SPA routes and API routes: a browser page load
// (Accept: text/html) gets the SPA, everything else goes to the API.
const spaOrApi: ProxyOptions = {
  target,
  bypass: (req) =>
    req.method === 'GET' && req.headers.accept?.includes('text/html') ? '/index.html' : undefined,
};

// Dev-server proxy so the SPA can call the Fastify API with relative paths (e.g. `fetch('/auth/login')`)
// without CORS during `vite dev`; in dev a reverse proxy can send everything to Vite. Production
// serves this build from Fastify (`src/routes/webUi.ts`) out of `web/dist`.
export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    allowedHosts: ['ptv.mcp.italeino.fi'],
    proxy: {
      '/auth': target,
      '/tenants': spaOrApi,
      '/ptv-connections': spaOrApi,
      '/health': target,
      // MCP endpoint and its OAuth (the consent page is served by the API itself).
      '/mcp': target,
      '/oauth': target,
      '/.well-known': target,
    },
  },
});
