import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import type { TLSSocket } from 'node:tls';
import { fileURLToPath } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';
import type { ErrorCode, ModeReason, ModerationAction, ServerMessage } from '@tutaj/shared';
import { selfSignedCert, type TlsMaterial } from './cert.js';
import { Guard, type GuardOptions } from './guard.js';
import { DEFAULT_ICE, iceServersFor, type IceConfig } from './ice.js';
import { lanAddresses } from './net.js';
import { ModePolicy } from './policy.js';
import { peerInfo, RoomRegistry, type Client } from './rooms.js';
import type { Sfu, SfuOptions } from './sfu.js';
import { serveStatic } from './static.js';
import { parseClientMessage } from './validate.js';

export type { GuardOptions } from './guard.js';
export type { IceConfig } from './ice.js';
export type { SfuOptions } from './sfu.js';
export { lanAddresses } from './net.js';

export interface ServerOptions {
  host?: string;
  /** Plain HTTP port (0 = random). */
  port?: number;
  /** HTTPS port; omit to disable HTTPS. Needed when browsers on other machines connect directly over LAN. */
  httpsPort?: number;
  /** TLS material, or `{ selfSigned: true }` to generate a certificate for LAN hosting. */
  tls?: TlsMaterial | { selfSigned: true; cacheDir?: string };
  /** Directory with the built web client; `null` runs signaling only. */
  clientDir?: string | null;
  maxPeers?: number;
  /**
   * Public base URL of the web client, used for invite links (e.g. https://meet.example.com).
   * `'lan'` uses this machine's first LAN address (desktop host mode).
   */
  publicUrl?: string | null;
  ice?: Partial<IceConfig>;
  /** Secret for session-resume tokens. Set it to let clients resume across server restarts. */
  sessionSecret?: string;
  /** Enable the mediasoup SFU (used automatically when a mesh can't cope). Omit or `false` for P2P only. */
  sfu?: SfuOptions | false;
  /** Abuse protection for a public server (Origin allowlist, per-IP limits, owner key). Off by default. */
  guard?: GuardOptions;
  log?: (msg: string) => void;
}

export interface RunningServer {
  httpPort: number;
  httpsPort: number | null;
  /** HTTPS (or HTTP when HTTPS is off) URLs under which other machines on the LAN can reach this server. */
  lanUrls: string[];
  sfuEnabled: boolean;
  close(): Promise<void>;
}

const HEARTBEAT_MS = 15_000;
const RATE_WINDOW_MS = 1_000;
const RATE_MAX = 200;

const defaultClientDir = () => join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'client', 'dist');

/** Version of this server package (reported by /api/info). */
const SERVER_VERSION: string = (() => {
  try {
    return JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8')).version;
  } catch {
    return 'unknown';
  }
})();
/** Signaling protocol generation; bump on incompatible changes. */
const PROTOCOL_VERSION = 1;

export async function startServer(options: ServerOptions = {}): Promise<RunningServer> {
  const log = options.log ?? ((msg: string) => console.log(`[tutaj] ${msg}`));
  const maxPeers = options.maxPeers ?? 4;
  const ice: IceConfig = { ...DEFAULT_ICE, ...options.ice };
  const clientDir = options.clientDir === undefined ? defaultClientDir() : options.clientDir;
  const serveClient = clientDir !== null && existsSync(join(clientDir, 'index.html'));
  const rooms = new RoomRegistry(maxPeers);
  const guard = new Guard(options.guard);
  const secret = options.sessionSecret || randomBytes(32);
  const resumeToken = (room: string, id: string) => createHmac('sha256', secret).update(`${room}:${id}`).digest('base64url');
  const validResume = (room: string, r: { id: string; token: string }) => {
    const expected = Buffer.from(resumeToken(room, r.id));
    const given = Buffer.from(r.token);
    return expected.length === given.length && timingSafeEqual(expected, given);
  };

  const send = (ws: WebSocket, msg: ServerMessage) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  };
  const sendError = (ws: WebSocket, code: ErrorCode, message: string) => send(ws, { type: 'error', code, message });

  let publicUrl = options.publicUrl === 'lan' ? null : options.publicUrl;
  const shareBaseUrl = (req: IncomingMessage): string | null => {
    if (publicUrl) return publicUrl.replace(/\/+$/, '');
    if (!serveClient || !req.headers.host) return null;
    const forwarded = req.headers['x-forwarded-proto'];
    const proto = (req.socket as TLSSocket).encrypted ? 'https' : typeof forwarded === 'string' ? forwarded : 'http';
    return `${proto}://${req.headers.host}`;
  };

  // --- Media mode & SFU -----------------------------------------------------
  let sfu: Sfu | null = null;
  const policies = new Map<string, ModePolicy>();
  const policyFor = (roomId: string) => {
    let p = policies.get(roomId);
    if (!p) policies.set(roomId, (p = new ModePolicy(!!sfu)));
    return p;
  };
  const broadcastRoomState = (roomId: string) => {
    const state = rooms.state(roomId);
    for (const c of rooms.members(roomId)) send(c.ws, { type: 'room-state', ...state });
  };

  /** The SFU only carries end-to-end encrypted media: everyone in the room must support it. */
  const allE2ee = (roomId: string) => rooms.members(roomId).every((c) => c.e2ee);
  const announceMode = (roomId: string, reason: ModeReason, by?: string) => {
    const p = policyFor(roomId);
    for (const c of rooms.members(roomId)) send(c.ws, { type: 'mode', mode: p.mode, pref: p.pref, reason, by });
    if (p.mode === 'mesh' && sfu) {
      // Clients leave the SFU themselves once mesh media is back; this only sweeps leftovers.
      setTimeout(() => {
        if (policies.get(roomId)?.mode !== 'sfu') sfu?.closeRoom(roomId);
      }, 10_000);
    }
  };

  if (options.sfu) {
    try {
      const { Sfu } = await import('./sfu.js');
      const created = await Sfu.create(
        options.sfu,
        (roomId, peerId, n) => {
          const c = rooms.peer(roomId, peerId);
          if (c) send(c.ws, { type: 'sfu-notify', ...n });
        },
        (err) => {
          log(`SFU worker died (${err.message}) — falling back to P2P`);
          sfu = null;
          for (const [roomId, p] of policies) {
            const d = p.disableSfu(rooms.members(roomId).length);
            if (d) announceMode(roomId, d.reason);
          }
        },
      );
      sfu = created.sfu;
      log(`SFU   ${created.address}:${created.port} (udp+tcp)`);
    } catch (err) {
      log(`SFU disabled: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // --- HTTP ----------------------------------------------------------------
  const onRequest = (req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url ?? '/').split('?')[0];
    if (path === '/api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true, ...rooms.stats() }));
      return;
    }
    // Identifies a Tutaj server — the desktop app checks it before switching to a server address.
    if (path === '/api/info') {
      res
        .writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
        .end(JSON.stringify({ app: 'tutaj', version: SERVER_VERSION, protocol: PROTOCOL_VERSION, sfu: !!sfu }));
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end();
      return;
    }
    if (serveClient && clientDir) serveStatic(req, res, clientDir);
    else res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Tutaj signaling server\n');
  };

  // --- WebSocket signaling -------------------------------------------------
  const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
  const alive = new WeakSet<WebSocket>();
  /** For moderation across connections: a client's IP (bans) and how to throw it out (kick). */
  const clientIps = new WeakMap<Client, string>();
  const kickers = new WeakMap<Client, () => void>();

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const client: Client = { id: randomUUID(), name: '', ws, roomId: null };
    const ip = guard.clientIp(req);
    clientIps.set(client, ip);
    kickers.set(client, () => {
      leave('kicked');
      // The 'moderated' message goes out first; then the connection closes.
      setTimeout(() => ws.close(4001, 'kicked'), 200);
    });
    let privileged = false;
    let windowStart = Date.now();
    let count = 0;
    alive.add(ws);
    ws.on('pong', () => alive.add(ws));

    const leave = (reason: 'leave' | 'disconnect' | 'kicked') => {
      const roomId = client.roomId;
      const wasHost = rooms.isHost(client);
      const remaining = rooms.leave(client);
      if (!roomId || !remaining) return;
      sfu?.closePeer(roomId, client.id);
      for (const other of remaining) send(other.ws, { type: 'peer-left', id: client.id, reason });
      if (wasHost && remaining.length) broadcastRoomState(roomId);
      if (remaining.length === 0) {
        guard.roomClosed(roomId);
        policies.delete(roomId);
        sfu?.closeRoom(roomId);
        return;
      }
      const d = policyFor(roomId).participantsChanged(remaining.length, client.id, allE2ee(roomId));
      if (d) announceMode(roomId, d.reason);
    };

    /** Host actions. The server enforces kicks and the lock; mutes are requests the client carries out. */
    const moderate = (action: ModerationAction, targetId?: string) => {
      const roomId = client.roomId;
      if (!roomId) return;
      if (!rooms.isHost(client)) return sendError(ws, 'not-host', 'Tylko gospodarz pokoju może to zrobić');
      const target = targetId ? rooms.peer(roomId, targetId) : undefined;
      switch (action) {
        case 'lock':
        case 'unlock':
          rooms.setLocked(roomId, action === 'lock');
          return broadcastRoomState(roomId);
        case 'mute-all':
          for (const other of rooms.others(client)) send(other.ws, { type: 'moderated', action: 'mute', by: client.name });
          return;
      }
      if (!target || target === client) return sendError(ws, 'unknown-peer', 'Uczestnik nie istnieje');
      if (action === 'mute') return send(target.ws, { type: 'moderated', action: 'mute', by: client.name });
      if (action === 'make-host') {
        rooms.setHost(roomId, target.id);
        return broadcastRoomState(roomId);
      }
      // kick: out of the room now, and kept out for a while (also from resuming the session).
      rooms.ban(roomId, target, clientIps.get(target) ?? '');
      send(target.ws, { type: 'moderated', action: 'kick', by: client.name });
      kickers.get(target)?.();
    };

    ws.on('message', (data, isBinary) => {
      const now = Date.now();
      if (now - windowStart > RATE_WINDOW_MS) {
        windowStart = now;
        count = 0;
      }
      if (++count > RATE_MAX) {
        sendError(ws, 'rate-limited', 'Za dużo wiadomości');
        ws.close(1008, 'rate limited');
        return;
      }

      const msg = isBinary ? null : parseClientMessage(data.toString());
      if (!msg) return sendError(ws, 'invalid-message', 'Nieprawidłowa wiadomość');

      if (msg.type === 'join') {
        if (client.roomId) return sendError(ws, 'already-joined', 'Już jesteś w pokoju');
        privileged = guard.isOwnerKey(msg.ownerKey) || guard.isTrustedIp(ip);
        if (!guard.allowJoin(ip, privileged)) {
          return sendError(ws, 'rate-limited', 'Za dużo prób dołączenia — spróbuj ponownie za minutę');
        }
        client.name = msg.name;
        const resuming = !!msg.resume && validResume(msg.room, msg.resume);
        let resumedHost = false;
        if (msg.resume && resuming) {
          // Take over the previous identity; a stale socket still holding it is dropped silently.
          const stale = rooms.peer(msg.room, msg.resume.id);
          if (stale) {
            resumedHost = rooms.isHost(stale);
            if (rooms.leave(stale)?.length === 0) guard.roomClosed(msg.room);
            sfu?.closePeer(msg.room, stale.id);
            stale.ws.terminate();
          }
          client.id = msg.resume.id;
        }
        client.e2ee = msg.e2ee === true;
        const creating = !rooms.has(msg.room);
        if (creating && !guard.canCreateRoom(ip, privileged)) {
          return sendError(ws, 'room-limit', 'Masz już otwartą maksymalną liczbę pokoi — zamknij któryś albo dołącz do istniejącego');
        }
        const result = rooms.join(client, msg.room, msg.password, ip, resuming);
        if (!result.ok) {
          const messages = {
            'room-full': `Pokój jest pełny (max ${maxPeers} osoby)`,
            'bad-password': 'Nieprawidłowe hasło pokoju',
            'room-locked': 'Pokój jest zablokowany przez gospodarza — nowe osoby nie mogą dołączyć',
            kicked: `Gospodarz usunął Cię z tego pokoju — możesz wrócić za ${result.minutes ?? 10} min`,
          };
          return send(ws, { type: 'error', code: result.code, message: messages[result.code], minutes: result.minutes });
        }
        // A reconnecting host keeps the role.
        if (resumedHost) rooms.setHost(msg.room, client.id);
        if (creating) guard.roomCreated(msg.room, ip, privileged);
        const policy = policyFor(msg.room);
        send(ws, {
          type: 'welcome',
          selfId: client.id,
          room: msg.room,
          peers: result.peers,
          iceServers: iceServersFor(ice, client.id, privileged),
          maxPeers,
          shareBaseUrl: shareBaseUrl(req),
          resumeToken: resumeToken(msg.room, client.id),
          mode: policy.mode,
          pref: policy.pref,
          sfuAvailable: !!sfu,
          privileged,
          roomState: rooms.state(msg.room),
        });
        if (resumedHost) broadcastRoomState(msg.room);
        for (const other of rooms.others(client)) send(other.ws, { type: 'peer-joined', peer: peerInfo(client) });
        const d = policy.participantsChanged(result.peers.length + 1, undefined, allE2ee(msg.room));
        if (d) announceMode(msg.room, d.reason);
        return;
      }

      if (!client.roomId) return sendError(ws, 'not-joined', 'Najpierw dołącz do pokoju');

      switch (msg.type) {
        case 'signal': {
          const target = rooms.peer(client.roomId, msg.to);
          if (!target) return sendError(ws, 'unknown-peer', 'Uczestnik nie istnieje');
          send(target.ws, { type: 'signal', from: client.id, sid: msg.sid, data: msg.data });
          return;
        }
        case 'relay': {
          const targets = msg.to ? [rooms.peer(client.roomId, msg.to)].filter((c): c is Client => !!c) : rooms.others(client);
          for (const t of targets) send(t.ws, { type: 'relay', from: client.id, payload: msg.payload });
          return;
        }
        case 'leave':
          leave('leave');
          return;
        case 'moderate':
          return moderate(msg.action, msg.target);
        case 'quality': {
          const policy = policyFor(client.roomId);
          if (policy.mode !== 'mesh') return;
          const d = policy.report(client.id, msg.report, rooms.members(client.roomId).length);
          if (d) announceMode(client.roomId, d.reason);
          return;
        }
        case 'set-mode': {
          const d = policyFor(client.roomId).setPref(msg.pref, rooms.members(client.roomId).length);
          announceMode(client.roomId, d?.reason ?? 'manual', client.name);
          return;
        }
        case 'sfu': {
          const roomId = client.roomId;
          const reply = (r: { ok: true; data: unknown } | { ok: false; error: string }) => send(ws, { type: 'sfu-response', id: msg.id, ...r });
          if (msg.method === 'leave') {
            sfu?.closePeer(roomId, client.id);
            return reply({ ok: true, data: null });
          }
          if (!sfu || policyFor(roomId).mode !== 'sfu') return reply({ ok: false, error: 'SFU nieaktywne' });
          const active = sfu;
          active.handle(roomId, client.id, msg.method, msg.data).then(
            (data) => {
              // The client may have left while the request was in flight.
              if (client.roomId !== roomId) active.closePeer(roomId, client.id);
              else reply({ ok: true, data });
            },
            (err: unknown) => reply({ ok: false, error: err instanceof Error ? err.message : String(err) }),
          );
          return;
        }
      }
    });

    ws.on('close', () => {
      leave('disconnect');
      guard.disconnect(ip);
    });
    ws.on('error', () => ws.terminate());
  });

  const heartbeat = setInterval(() => {
    guard.sweep();
    for (const ws of wss.clients) {
      if (!alive.has(ws)) {
        ws.terminate();
        continue;
      }
      alive.delete(ws);
      ws.ping();
    }
  }, HEARTBEAT_MS);

  const attach = (server: Server) => {
    server.on('upgrade', (req, socket, head) => {
      if ((req.url ?? '').split('?')[0] !== '/ws') {
        socket.destroy();
        return;
      }
      const reject = (status: string) => {
        socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      };
      if (!guard.originAllowed(req)) return reject('403 Forbidden');
      // Counted here, released when the socket closes (see 'close' above).
      if (!guard.connect(guard.clientIp(req))) return reject('429 Too Many Requests');
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    });
  };

  const listen = (server: Server, port: number) =>
    new Promise<number>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, options.host ?? '0.0.0.0', () => {
        server.off('error', reject);
        resolve((server.address() as AddressInfo).port);
      });
    });

  const httpServer = createHttpServer(onRequest);
  attach(httpServer);
  const httpPort = await listen(httpServer, options.port ?? 3000);

  let httpsServer: Server | null = null;
  let httpsPort: number | null = null;
  if (options.httpsPort !== undefined) {
    const tlsOpt = options.tls;
    const tls = !tlsOpt || 'selfSigned' in tlsOpt ? await selfSignedCert(tlsOpt?.cacheDir) : tlsOpt;
    httpsServer = createHttpsServer({ key: tls.key, cert: tls.cert }, onRequest);
    attach(httpsServer);
    try {
      httpsPort = await listen(httpsServer, options.httpsPort);
    } catch (err) {
      await new Promise<void>((r) => httpServer.close(() => r()));
      throw err;
    }
  }

  const lanUrls = lanAddresses().map((ip) => (httpsPort ? `https://${ip}:${httpsPort}` : `http://${ip}:${httpPort}`));
  if (options.publicUrl === 'lan') publicUrl = lanUrls[0] ?? null;
  log(`HTTP  http://localhost:${httpPort}${serveClient ? '' : ' (signaling only — client not built)'}`);
  if (httpsPort) log(`HTTPS https://localhost:${httpsPort}`);
  for (const url of lanUrls) log(`LAN   ${url}`);

  return {
    httpPort,
    httpsPort,
    lanUrls,
    sfuEnabled: !!sfu,
    close: async () => {
      sfu?.close();
      clearInterval(heartbeat);
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      await Promise.all(
        [httpServer, httpsServer].filter((s): s is Server => !!s).map((s) => new Promise<void>((r) => s.close(() => r()))),
      );
    },
  };
}
