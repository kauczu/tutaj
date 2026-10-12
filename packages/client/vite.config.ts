import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

const server = process.env.TUTAJ_SERVER ?? 'http://localhost:3000';
const { version } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(version) },
  server: {
    port: 5173,
    // Dev: signaling server runs separately; proxy keeps the client on a single origin.
    proxy: {
      '/ws': { target: server.replace(/^http/, 'ws'), ws: true },
      '/api': server,
    },
  },
  build: {
    target: 'es2022',
  },
});
