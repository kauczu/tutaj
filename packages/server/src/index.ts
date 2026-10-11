#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { startServer, type ServerOptions } from './server.js';

const env = process.env;
const list = (v: string | undefined) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : undefined);
const int = (v: string | undefined) => (v ? Number.parseInt(v, 10) : undefined);

const options: ServerOptions = {
  host: env.HOST,
  port: int(env.PORT) ?? 3000,
  httpsPort: int(env.HTTPS_PORT),
  tls:
    env.TLS_KEY && env.TLS_CERT
      ? { key: readFileSync(env.TLS_KEY, 'utf8'), cert: readFileSync(env.TLS_CERT, 'utf8') }
      : { selfSigned: true, cacheDir: env.CERT_DIR ?? 'certs' },
  clientDir: env.CLIENT_DIR,
  maxPeers: int(env.MAX_PEERS),
  publicUrl: env.PUBLIC_URL,
  sessionSecret: env.SESSION_SECRET,
  sfu:
    env.SFU === '1' || env.SFU === 'true' || process.argv.includes('--sfu')
      ? { announcedAddress: env.SFU_ANNOUNCED_ADDRESS, listenIp: env.SFU_LISTEN_IP, port: int(env.SFU_PORT) }
      : false,
  ice: {
    ...(list(env.STUN_URLS) && { stunUrls: list(env.STUN_URLS) }),
    turnUrls: list(env.TURN_URLS) ?? [],
    turnUsername: env.TURN_USERNAME,
    turnCredential: env.TURN_CREDENTIAL,
    turnSecret: env.TURN_SECRET,
    ...(int(env.TURN_TTL) && { turnTtl: int(env.TURN_TTL) }),
  },
};

const server = await startServer(options);

const shutdown = async () => {
  await server.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
