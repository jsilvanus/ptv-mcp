import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Compiled output shouldn't be re-discovered as its own test suite
    // alongside the TypeScript sources it was built from.
    exclude: ['**/node_modules/**', '**/dist/**', '**/.git/**'],
  },
});
