import * as mediasoup from 'mediasoup';
import type { types } from 'mediasoup';
import type { SfuMethod, SfuNotification } from '@tutaj/shared';
import { lanAddresses } from './net.js';

export interface SfuOptions {
  /** Interface to bind (default 0.0.0.0). */
  listenIp?: string;
  /** Address clients should connect to — the public IP/hostname behind NAT, or the LAN IP. */
  announcedAddress?: string;
  /** Single UDP+TCP port for all media (default 40000). */
  port?: number;
  /** Path to the mediasoup-worker binary (needed when it can't live in node_modules, e.g. a packaged app). */
  workerBin?: string;
}

const MEDIA_CODECS: types.RouterRtpCodecCapability[] = [
  { kind: 'audio', mimeType: 'audio/opus', clockRate: 48000, channels: 2 },
  { kind: 'video', mimeType: 'video/VP8', clockRate: 90000, parameters: { 'x-google-start-bitrate': 1000 } },
  {
    kind: 'video',
    mimeType: 'video/H264',
    clockRate: 90000,
    parameters: { 'packetization-mode': 1, 'profile-level-id': '42e01f', 'level-asymmetry-allowed': 1 },
  },
];

const MAX_TRANSPORTS_PER_PEER = 2;
const MAX_PRODUCERS_PER_PEER = 3;

interface SfuPeer {
  transports: Map<string, types.WebRtcTransport>;
  producers: Map<string, types.Producer>;
  consumers: Map<string, types.Consumer>;
}

interface SfuRoom {
  router: types.Router;
  peers: Map<string, SfuPeer>;
}

export class SfuError extends Error {}

type Notify = (roomId: string, peerId: string, n: SfuNotification) => void;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
function str(data: Record<string, unknown>, key: string): string {
  const v = data[key];
  if (typeof v !== 'string' || v.length > 128) throw new SfuError(`invalid ${key}`);
  return v;
}
function obj<T>(data: Record<string, unknown>, key: string): T {
  if (!isObj(data[key])) throw new SfuError(`invalid ${key}`);
  return data[key] as T;
}

/**
 * Selective Forwarding Unit on mediasoup. One worker, one WebRtcServer (all media on a single
 * port), one router per room. Rooms and peers are created lazily on the first request.
 */
export class Sfu {
  private rooms = new Map<string, SfuRoom>();
  private creating = new Map<string, Promise<SfuRoom>>();

  private constructor(
    private readonly worker: types.Worker,
    private readonly webRtcServer: types.WebRtcServer,
    private readonly notify: Notify,
  ) {}

  static async create(opts: SfuOptions, notify: Notify, onDied: (err: Error) => void): Promise<{ sfu: Sfu; address: string; port: number }> {
    const worker = await mediasoup.createWorker({ logLevel: 'warn', workerBin: opts.workerBin });
    const port = opts.port ?? 40000;
    const ip = opts.listenIp ?? '0.0.0.0';
    const address = opts.announcedAddress ?? lanAddresses()[0] ?? '127.0.0.1';
    const announce = ip === '0.0.0.0' || ip === '::' ? address : undefined;
    const webRtcServer = await worker.createWebRtcServer({
      listenInfos: [
        { protocol: 'udp', ip, announcedAddress: announce, port },
        { protocol: 'tcp', ip, announcedAddress: announce, port },
      ],
    });
    worker.on('died', onDied);
    return { sfu: new Sfu(worker, webRtcServer, notify), address, port };
  }

  async handle(roomId: string, peerId: string, method: SfuMethod, data: Record<string, unknown> = {}): Promise<unknown> {
    if (method === 'leave') {
      this.closePeer(roomId, peerId);
      return null;
    }
    const room = await this.room(roomId);
    let peer = room.peers.get(peerId);
    if (!peer) {
      peer = { transports: new Map(), producers: new Map(), consumers: new Map() };
      room.peers.set(peerId, peer);
    }

    switch (method) {
      case 'capabilities':
        return room.router.rtpCapabilities;

      case 'create-transport': {
        const direction = data.direction === 'send' ? 'send' : 'recv';
        if (peer.transports.size >= MAX_TRANSPORTS_PER_PEER) throw new SfuError('too many transports');
        const transport = await room.router.createWebRtcTransport({
          webRtcServer: this.webRtcServer,
          enableUdp: true,
          enableTcp: true,
          preferUdp: true,
          initialAvailableOutgoingBitrate: 1_000_000,
          appData: { direction },
        });
        peer.transports.set(transport.id, transport);
        transport.observer.on('close', () => peer.transports.delete(transport.id));
        return {
          id: transport.id,
          iceParameters: transport.iceParameters,
          iceCandidates: transport.iceCandidates,
          dtlsParameters: transport.dtlsParameters,
        };
      }

      case 'connect-transport': {
        const transport = this.transport(peer, str(data, 'transportId'));
        await transport.connect({ dtlsParameters: obj<types.DtlsParameters>(data, 'dtlsParameters') });
        return null;
      }

      case 'produce': {
        const transport = this.transport(peer, str(data, 'transportId'));
        if (transport.appData.direction !== 'send') throw new SfuError('not a send transport');
        if (peer.producers.size >= MAX_PRODUCERS_PER_PEER) throw new SfuError('too many producers');
        const kind = data.kind === 'audio' ? 'audio' : 'video';
        const producer = await transport.produce({
          kind,
          rtpParameters: obj<types.RtpParameters>(data, 'rtpParameters'),
          appData: { peerId },
        });
        peer.producers.set(producer.id, producer);
        producer.observer.on('close', () => {
          peer.producers.delete(producer.id);
          this.broadcast(roomId, peerId, { method: 'producer-removed', data: { peerId, producerId: producer.id } });
        });
        this.broadcast(roomId, peerId, { method: 'producer-added', data: { peerId, producerId: producer.id, kind } });
        return { id: producer.id };
      }

      case 'close-producer': {
        peer.producers.get(str(data, 'producerId'))?.close();
        return null;
      }

      case 'producers': {
        const list = [];
        for (const [otherId, other] of room.peers) {
          if (otherId === peerId) continue;
          for (const p of other.producers.values()) list.push({ peerId: otherId, producerId: p.id, kind: p.kind });
        }
        return list;
      }

      case 'consume': {
        const producerId = str(data, 'producerId');
        const rtpCapabilities = obj<types.RtpCapabilities>(data, 'rtpCapabilities');
        if (!room.router.canConsume({ producerId, rtpCapabilities })) throw new SfuError('cannot consume');
        const transport = [...peer.transports.values()].find((t) => t.appData.direction === 'recv');
        if (!transport) throw new SfuError('no receive transport');
        const ownerId = this.ownerOf(room, producerId);
        const consumer = await transport.consume({ producerId, rtpCapabilities, paused: true });
        peer.consumers.set(consumer.id, consumer);
        consumer.observer.on('close', () => peer.consumers.delete(consumer.id));
        consumer.on('producerclose', () => {
          consumer.close();
          this.notify(roomId, peerId, { method: 'consumer-closed', data: { consumerId: consumer.id } });
        });
        return { id: consumer.id, producerId, peerId: ownerId, kind: consumer.kind, rtpParameters: consumer.rtpParameters };
      }

      case 'resume-consumer': {
        await peer.consumers.get(str(data, 'consumerId'))?.resume();
        return null;
      }
    }
  }

  closePeer(roomId: string, peerId: string): void {
    const room = this.rooms.get(roomId);
    const peer = room?.peers.get(peerId);
    if (!room || !peer) return;
    room.peers.delete(peerId);
    // Closing transports closes their producers/consumers; producer observers notify the others.
    for (const t of peer.transports.values()) t.close();
    if (room.peers.size === 0) this.closeRoom(roomId);
  }

  closeRoom(roomId: string): void {
    const room = this.rooms.get(roomId);
    if (!room) return;
    this.rooms.delete(roomId);
    room.router.close();
  }

  close(): void {
    this.worker.close();
  }

  private async room(roomId: string): Promise<SfuRoom> {
    const existing = this.rooms.get(roomId);
    if (existing) return existing;
    let pending = this.creating.get(roomId);
    if (!pending) {
      pending = this.worker.createRouter({ mediaCodecs: MEDIA_CODECS }).then((router) => {
        const room = { router, peers: new Map() };
        this.rooms.set(roomId, room);
        this.creating.delete(roomId);
        return room;
      });
      this.creating.set(roomId, pending);
    }
    return pending;
  }

  private transport(peer: SfuPeer, id: string): types.WebRtcTransport {
    const t = peer.transports.get(id);
    if (!t) throw new SfuError('unknown transport');
    return t;
  }

  private ownerOf(room: SfuRoom, producerId: string): string {
    for (const [id, peer] of room.peers) if (peer.producers.has(producerId)) return id;
    throw new SfuError('unknown producer');
  }

  private broadcast(roomId: string, fromId: string, n: SfuNotification): void {
    const room = this.rooms.get(roomId);
    if (!room) return;
    for (const id of room.peers.keys()) if (id !== fromId) this.notify(roomId, id, n);
  }
}
