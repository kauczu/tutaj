import { createHash, timingSafeEqual } from 'node:crypto';
import type { WebSocket } from 'ws';
import type { PeerInfo, RoomState } from '@tutaj/shared';

export interface Client {
  id: string;
  name: string;
  ws: WebSocket;
  roomId: string | null;
  /** Can encrypt SFU media end to end (declared at join). */
  e2ee?: boolean;
}

interface Room {
  id: string;
  passwordHash: Buffer | null;
  clients: Map<string, Client>;
  /** Moderates the room: the first participant; passes on when they leave. */
  hostId: string | null;
  /** No new participants (members may still reconnect). */
  locked: boolean;
  /** Kicked participants (by client id and by IP) → until when they are kept out. */
  bans: Map<string, number>;
}

export type JoinResult =
  | { ok: true; peers: PeerInfo[] }
  | { ok: false; code: 'room-full' | 'bad-password' | 'room-locked' | 'kicked'; minutes?: number };

/** How long a kicked participant cannot come back. */
export const KICK_BAN_MS = 10 * 60_000;

const sha256 = (value: string) => createHash('sha256').update(value).digest();

export const peerInfo = (c: Client): PeerInfo => ({ id: c.id, name: c.name });

/** In-memory rooms. A room exists while it has at least one client; the first joiner sets its password. */
export class RoomRegistry {
  private rooms = new Map<string, Room>();

  constructor(private readonly maxPeers: number) {}

  /** `ip`: for bans; `resuming`: a member reconnecting (allowed into a locked room). */
  join(client: Client, roomId: string, password: string | undefined, ip = '', resuming = false): JoinResult {
    const hash = password ? sha256(password) : null;
    let room = this.rooms.get(roomId);
    if (!room) {
      room = { id: roomId, passwordHash: hash, clients: new Map(), hostId: client.id, locked: false, bans: new Map() };
      this.rooms.set(roomId, room);
    } else {
      const now = Date.now();
      for (const [key, until] of room.bans) if (until <= now) room.bans.delete(key);
      const ban = Math.max(room.bans.get(`id:${client.id}`) ?? 0, ip ? room.bans.get(`ip:${ip}`) ?? 0 : 0);
      if (ban > now) return { ok: false, code: 'kicked', minutes: Math.ceil((ban - now) / 60_000) };
      if (room.passwordHash && (!hash || !timingSafeEqual(room.passwordHash, hash))) {
        return { ok: false, code: 'bad-password' };
      }
      if (room.locked && !resuming) return { ok: false, code: 'room-locked' };
      if (room.clients.size >= this.maxPeers) return { ok: false, code: 'room-full' };
      room.hostId ??= client.id;
    }
    const peers = [...room.clients.values()].map(peerInfo);
    room.clients.set(client.id, client);
    client.roomId = roomId;
    return { ok: true, peers };
  }

  state(roomId: string): RoomState {
    const room = this.rooms.get(roomId);
    return { host: room?.hostId ?? null, locked: room?.locked ?? false };
  }

  isHost(client: Client): boolean {
    return !!client.roomId && this.rooms.get(client.roomId)?.hostId === client.id;
  }

  setLocked(roomId: string, locked: boolean): void {
    const room = this.rooms.get(roomId);
    if (room) room.locked = locked;
  }

  setHost(roomId: string, id: string): boolean {
    const room = this.rooms.get(roomId);
    if (!room?.clients.has(id)) return false;
    room.hostId = id;
    return true;
  }

  /** Keeps a kicked participant out (their id — no resuming — and their IP) for KICK_BAN_MS. */
  ban(roomId: string, client: Client, ip: string): void {
    const room = this.rooms.get(roomId);
    if (!room) return;
    const until = Date.now() + KICK_BAN_MS;
    room.bans.set(`id:${client.id}`, until);
    if (ip) room.bans.set(`ip:${ip}`, until);
  }

  /**
   * Removes the client from its room and returns the clients that remain there,
   * or null if the client was not (or no longer) the room's member for its id.
   */
  leave(client: Client): Client[] | null {
    if (!client.roomId) return null;
    const room = this.rooms.get(client.roomId);
    client.roomId = null;
    // A resumed session may already have taken over this id; never evict the new owner.
    if (!room || room.clients.get(client.id) !== client) return null;
    room.clients.delete(client.id);
    if (room.clients.size === 0) this.rooms.delete(room.id);
    // The host left: the longest-present participant takes over.
    else if (room.hostId === client.id) room.hostId = room.clients.keys().next().value ?? null;
    return [...room.clients.values()];
  }

  has(roomId: string): boolean {
    return this.rooms.has(roomId);
  }

  peer(roomId: string, id: string): Client | undefined {
    return this.rooms.get(roomId)?.clients.get(id);
  }

  members(roomId: string): Client[] {
    return [...(this.rooms.get(roomId)?.clients.values() ?? [])];
  }

  others(client: Client): Client[] {
    if (!client.roomId) return [];
    const room = this.rooms.get(client.roomId);
    return room ? [...room.clients.values()].filter((c) => c.id !== client.id) : [];
  }

  stats() {
    let clients = 0;
    for (const room of this.rooms.values()) clients += room.clients.size;
    return { rooms: this.rooms.size, clients };
  }
}
