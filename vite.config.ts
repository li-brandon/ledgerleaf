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
        include: ['src/lib/**'],
        exclude: ['src/lib/**/__tests__/**'],
        reporter: ['text-summary', 'text'],
        thresholds: { lines: 80 },
      },
    },
  };
});
