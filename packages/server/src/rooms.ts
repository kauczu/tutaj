import { createHash, timingSafeEqual } from 'node:crypto';
import type { WebSocket } from 'ws';
import type { PeerInfo } from '@tutaj/shared';

export interface Client {
  id: string;
  name: string;
  ws: WebSocket;
  roomId: string | null;
}

interface Room {
  id: string;
  passwordHash: Buffer | null;
  clients: Map<string, Client>;
}

export type JoinResult = { ok: true; peers: PeerInfo[] } | { ok: false; code: 'room-full' | 'bad-password' };

const sha256 = (value: string) => createHash('sha256').update(value).digest();

export const peerInfo = (c: Client): PeerInfo => ({ id: c.id, name: c.name });

/** In-memory rooms. A room exists while it has at least one client; the first joiner sets its password. */
export class RoomRegistry {
  private rooms = new Map<string, Room>();

  constructor(private readonly maxPeers: number) {}

  join(client: Client, roomId: string, password: string | undefined): JoinResult {
    const hash = password ? sha256(password) : null;
    let room = this.rooms.get(roomId);
    if (!room) {
      room = { id: roomId, passwordHash: hash, clients: new Map() };
      this.rooms.set(roomId, room);
    } else {
      if (room.passwordHash && (!hash || !timingSafeEqual(room.passwordHash, hash))) {
        return { ok: false, code: 'bad-password' };
      }
      if (room.clients.size >= this.maxPeers) return { ok: false, code: 'room-full' };
    }
    const peers = [...room.clients.values()].map(peerInfo);
    room.clients.set(client.id, client);
    client.roomId = roomId;
    return { ok: true, peers };
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
    return [...room.clients.values()];
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
