import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The API listens on PORT (environment first, then the repo root's .env, then 5999, as src/config.ts).
const rootEnvPath = fileURLToPath(new URL('../.env', import.meta.url));
const rootEnv = existsSync(rootEnvPath) ? parseEnv(readFileSync(rootEnvPath, 'utf8')) : {};
const api = `http://localhost:${process.env.PORT ?? rootEnv.PORT ?? '5999'}`;

// Dev-server proxy so the SPA can call the Fastify API with relative paths
// (e.g. `fetch('/auth/login')`) without CORS during `vite dev`. Production
// serves this build from Fastify (`src/routes/webUi.ts`) out of `web/dist`.
export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    allowedHosts: ['ptv.mcp.italeino.fi'],
    proxy: {
      '/auth': api,
      '/tenants': api,
      '/ptv-connections': api,
      '/health': api,
    },
  },
});
