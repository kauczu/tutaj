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
    ...(int(env.OWNER_TURN_TTL) && { ownerTurnTtl: int(env.OWNER_TURN_TTL) }),
  },
  guard: guardOptions(),
};

/**
 * Abuse protection. Per-IP limits are on by default in production (NODE_ENV=production, as in the
 * Docker image) and can be tuned or switched off (LIMITS=0). The owner (OWNER_KEY / TRUSTED_IPS) is exempt.
 */
function guardOptions(): ServerOptions['guard'] {
  const limits = env.LIMITS ? env.LIMITS !== '0' : env.NODE_ENV === 'production';
  // Default allowlist: the server's own public origin. "*" disables the check.
  const origins = list(env.ALLOWED_ORIGINS) ?? (env.PUBLIC_URL ? [new URL(env.PUBLIC_URL).origin] : undefined);
  return {
    allowedOrigins: origins?.includes('*') ? undefined : origins?.map((o) => o.replace(/\/+$/, '')),
    trustProxy: env.TRUST_PROXY === '1' || env.TRUST_PROXY === 'true',
    trustedIps: list(env.TRUSTED_IPS),
    ownerKey: env.OWNER_KEY || undefined,
    maxConnectionsPerIp: limits ? (int(env.MAX_CONNECTIONS_PER_IP) ?? 20) : undefined,
    maxRoomsPerIp: limits ? (int(env.MAX_ROOMS_PER_IP) ?? 5) : undefined,
    joinsPerMinute: limits ? (int(env.JOINS_PER_MINUTE) ?? 30) : undefined,
  };
}

const server = await startServer(options);

const shutdown = async () => {
  await server.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
