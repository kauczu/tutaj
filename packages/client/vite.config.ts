import { defineConfig } from 'vite';

const server = process.env.TUTAJ_SERVER ?? 'http://localhost:3000';

export default defineConfig({
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
