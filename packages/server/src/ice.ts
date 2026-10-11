import { createHmac } from 'node:crypto';
import type { IceServer } from '@tutaj/shared';

export interface IceConfig {
  stunUrls: string[];
  turnUrls: string[];
  /** Static TURN credentials (simple setups). */
  turnUsername?: string;
  turnCredential?: string;
  /** Shared secret for coturn `use-auth-secret` (TURN REST API) — preferred over static credentials. */
  turnSecret?: string;
  /** Lifetime of generated TURN credentials, in seconds. */
  turnTtl: number;
}

export const DEFAULT_ICE: IceConfig = {
  stunUrls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'],
  turnUrls: [],
  turnTtl: 6 * 3600,
};

export function iceServersFor(cfg: IceConfig, clientId: string): IceServer[] {
  const servers: IceServer[] = [];
  if (cfg.stunUrls.length) servers.push({ urls: cfg.stunUrls });
  if (cfg.turnUrls.length) {
    if (cfg.turnSecret) {
      const username = `${Math.floor(Date.now() / 1000) + cfg.turnTtl}:${clientId}`;
      const credential = createHmac('sha1', cfg.turnSecret).update(username).digest('base64');
      servers.push({ urls: cfg.turnUrls, username, credential });
    } else if (cfg.turnUsername && cfg.turnCredential) {
      servers.push({ urls: cfg.turnUrls, username: cfg.turnUsername, credential: cfg.turnCredential });
    }
  }
  return servers;
}
