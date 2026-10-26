/// <reference types="vitest/config" />
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  // Only the port is read here; Plaid keys are never exposed to the client (no VITE_ prefix).
  const port = loadEnv(mode, '.', 'PLAID_SERVER_PORT').PLAID_SERVER_PORT || '8787';
  return {
    plugins: [react()],
    server: {
      // `npm run plaid-server` (server/plaid-server.mjs) handles these.
      proxy: { '/api/plaid': `http://127.0.0.1:${port}` },
    },
    test: {
      // Load the stylesheet for real, so tests can read the design tokens (`styles.css?raw`).
      css: { include: [/styles\.css/] },
      coverage: {
        provider: 'v8',
        // Every source file counts, tested or not; only tests, test helpers, type-only files and the entry point are left out.
        include: ['src/**/*.{ts,tsx}'],
        exclude: [
          '**/__tests__/**', '**/*.test.{ts,tsx}', 'src/test/**', '**/*.d.ts',
          // Interfaces only: no runtime code to cover.
          'src/lib/sync/types.ts',
          // Bootstrap: mounts <App /> into index.html; App itself is covered.
          'src/main.tsx',
        ],
        reporter: ['text-summary', 'text'],
        // Baseline for this scope (LIB-387), floored (lines to 90.9: 91 would leave no slack): raise these as coverage improves, never lower them.
        // src/lib keeps the 80% line floor it had when coverage covered only src/lib.
        thresholds: { statements: 89, branches: 84, functions: 85, lines: 90.9, 'src/lib/**': { lines: 80 } },
      },
    },
  };
});
