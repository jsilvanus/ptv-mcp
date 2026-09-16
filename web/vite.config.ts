import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Dev-server proxy so the SPA can call the Fastify API with relative paths
// (e.g. `fetch('/auth/login')`) without CORS during `vite dev`. Production
// static-file serving for this build (Fastify serving `web/dist` instead of
// a proxy) is deferred to Phase 6 (deployment) — see docs/phase-plan.md.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/auth': 'http://localhost:3000',
      '/tenants': 'http://localhost:3000',
      '/ptv-connections': 'http://localhost:3000',
      '/health': 'http://localhost:3000',
    },
  },
});
