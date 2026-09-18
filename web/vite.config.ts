import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

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
      '/auth': 'http://localhost:5999',
      '/tenants': 'http://localhost:5999',
      '/ptv-connections': 'http://localhost:5999',
      '/health': 'http://localhost:5999',
    },
  },
});
