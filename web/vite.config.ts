import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Dev-server proxy so the SPA can call the Fastify API with relative paths
// (e.g. `fetch('/auth/login')`) without CORS during `vite dev`. Production
// serves this build from Fastify (`src/routes/webUi.ts`) out of `web/dist`.
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
