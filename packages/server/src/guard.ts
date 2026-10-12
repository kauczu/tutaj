import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

export interface GuardOptions {
  /** Origins allowed to open the signaling WebSocket. Empty/undefined = no check. Requests without Origin (non-browser) pass. */
  allowedOrigins?: string[];
  /** Read the client IP from X-Forwarded-For / X-Real-IP when the request comes from a local proxy. */
  trustProxy?: boolean;
  /** IPs or IPv4 CIDRs exempt from limits (e.g. the owner's home connection). */
  trustedIps?: string[];
  /** Secret that marks the owner: no room/join limits, long-lived TURN credentials. */
  ownerKey?: string;
  /** Simultaneous WebSocket connections per IP (trusted IPs exempt). */
  maxConnectionsPerIp?: number;
  /** Rooms created by one IP that may be open at the same time (owner exempt). */
  maxRoomsPerIp?: number;
  /** Join attempts per IP per minute (owner exempt). */
  joinsPerMinute?: number;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest();

const ipv4ToInt = (ip: string): number | null => {
  const m = ip.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((p) => p > 255)) return null;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
};

/** Strips IPv4-mapped IPv6 prefixes ("::ffff:1.2.3.4" → "1.2.3.4"). */
export const normalizeIp = (ip: string) => ip.trim().replace(/^::ffff:/i, '');

const isLocalAddress = (ip: string) =>
  ip === '127.0.0.1' || ip === '::1' || /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip) || /^f[cd]/i.test(ip);

export function ipMatches(ip: string, rule: string): boolean {
  const [base, bitsStr] = rule.trim().split('/');
  if (bitsStr === undefined) return normalizeIp(base) === ip;
  const a = ipv4ToInt(ip);
  const b = ipv4ToInt(base);
  const bits = Number(bitsStr);
  if (a === null || b === null || !(bits >= 0 && bits <= 32)) return false;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (a & mask) === (b & mask);
}

/**
 * Abuse protection for a public server: Origin allowlist, per-IP connection/room/join limits,
 * and recognition of the owner (owner key or trusted IP), who is never limited.
 * Every limit is off unless configured, so tests, development and the desktop LAN host are unaffected.
 */
export class Guard {
  private readonly ownerHash: Buffer | null;
  private readonly connections = new Map<string, number>();
  private readonly joins = new Map<string, number[]>();
  /** roomId → IP of the client that created it (only for rooms counted against a limit). */
  private readonly roomCreators = new Map<string, string>();

  constructor(private readonly opts: GuardOptions = {}) {
    this.ownerHash = opts.ownerKey ? sha256(opts.ownerKey) : null;
  }

  clientIp(req: IncomingMessage): string {
    const direct = normalizeIp(req.socket.remoteAddress ?? '');
    if (!this.opts.trustProxy || !isLocalAddress(direct)) return direct;
    const xff = req.headers['x-forwarded-for'];
    const forwarded = (Array.isArray(xff) ? xff.join(',') : xff ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    // The right-most entry was added by our own proxy; anything left of it is client-controlled.
    const fromProxy = forwarded.at(-1) ?? (typeof req.headers['x-real-ip'] === 'string' ? req.headers['x-real-ip'] : '');
    return fromProxy ? normalizeIp(fromProxy) : direct;
  }

  originAllowed(req: IncomingMessage): boolean {
    const allowed = this.opts.allowedOrigins;
    if (!allowed?.length) return true;
    const origin = req.headers.origin;
    if (!origin) return true; // non-browser client: the per-IP limits apply instead
    return allowed.includes(origin.replace(/\/+$/, ''));
  }

  isTrustedIp(ip: string): boolean {
    return (this.opts.trustedIps ?? []).some((rule) => ipMatches(ip, rule));
  }

  isOwnerKey(key: string | undefined): boolean {
    if (!this.ownerHash || !key) return false;
    return timingSafeEqual(this.ownerHash, sha256(key));
  }

  /** Registers a new connection; false if this IP already has too many. */
  connect(ip: string): boolean {
    const max = this.opts.maxConnectionsPerIp;
    const n = this.connections.get(ip) ?? 0;
    if (max && n >= max && !this.isTrustedIp(ip)) return false;
    this.connections.set(ip, n + 1);
    return true;
  }

  disconnect(ip: string): void {
    const n = (this.connections.get(ip) ?? 1) - 1;
    if (n <= 0) this.connections.delete(ip);
    else this.connections.set(ip, n);
  }

  /** Rate-limits join attempts. Privileged clients are never limited. */
  allowJoin(ip: string, privileged: boolean): boolean {
    const max = this.opts.joinsPerMinute;
    if (!max || privileged) return true;
    const now = Date.now();
    const recent = (this.joins.get(ip) ?? []).filter((t) => now - t < 60_000);
    if (recent.length >= max) {
      this.joins.set(ip, recent);
      return false;
    }
    recent.push(now);
    this.joins.set(ip, recent);
    return true;
  }

  canCreateRoom(ip: string, privileged: boolean): boolean {
    const max = this.opts.maxRoomsPerIp;
    if (!max || privileged) return true;
    let open = 0;
    for (const creator of this.roomCreators.values()) if (creator === ip) open++;
    return open < max;
  }

  roomCreated(roomId: string, ip: string, privileged: boolean): void {
    if (this.opts.maxRoomsPerIp && !privileged) this.roomCreators.set(roomId, ip);
  }

  roomClosed(roomId: string): void {
    this.roomCreators.delete(roomId);
  }

  /** Drops join history older than a minute (called periodically). */
  sweep(): void {
    const now = Date.now();
    for (const [ip, times] of this.joins) {
      if (!times.some((t) => now - t < 60_000)) this.joins.delete(ip);
    }
  }
}
