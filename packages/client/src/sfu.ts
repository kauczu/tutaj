import { Device, type types } from 'mediasoup-client';
import type { IceServer, SfuMethod, SfuNotification, SfuProducerInfo } from '@tutaj/shared';
import { Emitter } from './emitter';
import type { LocalMedia } from './media';

type Request = <T>(method: SfuMethod, data?: Record<string, unknown>) => Promise<T>;

interface TransportInfo {
  id: string;
  iceParameters: types.IceParameters;
  iceCandidates: types.IceCandidate[];
  dtlsParameters: types.DtlsParameters;
}

interface ConsumeInfo {
  id: string;
  producerId: string;
  peerId: string;
  kind: 'audio' | 'video';
  rtpParameters: types.RtpParameters;
}

type SfuEvents = {
  /** Media from this peer changed (a consumer was added or removed). */
  change: string;
  failed: Error;
};

const SCREEN_ENCODINGS: RTCRtpEncodingParameters[] = [{ maxBitrate: 2_500_000 }];

/**
 * Camera simulcast: the SFU forwards the layer each receiver can handle. Browsers drop the
 * top layers when the source is small (e.g. only 2 layers below 540p), so size the ladder
 * to the actual capture height to keep full resolution available.
 */
function cameraEncodings(track: MediaStreamTrack): RTCRtpEncodingParameters[] {
  const height = track.getSettings().height ?? 720;
  if (height >= 540) {
    return [
      { scaleResolutionDownBy: 4, maxBitrate: 150_000 },
      { scaleResolutionDownBy: 2, maxBitrate: 500_000 },
      { scaleResolutionDownBy: 1, maxBitrate: 1_200_000 },
    ];
  }
  return [
    { scaleResolutionDownBy: 2, maxBitrate: 250_000 },
    { scaleResolutionDownBy: 1, maxBitrate: 800_000 },
  ];
}

/**
 * Media through the server's SFU (mediasoup): one upstream per track no matter how many
 * peers, and one downstream per remote track.
 */
export class SfuSession extends Emitter<SfuEvents> {
  private device: Device | null = null;
  private sendTransport: types.Transport | null = null;
  private recvTransport: types.Transport | null = null;
  private producers: { audio?: types.Producer; video?: types.Producer } = {};
  private consumers = new Map<string, { consumer: types.Consumer; peerId: string }>();
  private consumed = new Set<string>();
  private streams = new Map<string, MediaStream>();
  private ops: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(
    private readonly request: Request,
    private readonly media: LocalMedia,
    private readonly iceServers: IceServer[],
  ) {
    super();
  }

  /** Resolves once our tracks are being produced and existing remote producers are consumed. */
  async start(): Promise<void> {
    this.device = await Device.factory();
    const routerRtpCapabilities = await this.request<types.RtpCapabilities>('capabilities');
    await this.device.load({ routerRtpCapabilities });
    this.sendTransport = await this.createTransport('send');
    this.recvTransport = await this.createTransport('recv');
    await this.updateTracks();
    const existing = await this.request<SfuProducerInfo[]>('producers');
    await Promise.all(existing.map((p) => this.consume(p.producerId)));
  }

  /** Sends the current local tracks (camera/screen switch, device change, mute). */
  updateTracks(): Promise<void> {
    this.ops = this.ops.then(() => this.syncProducers()).catch((err) => console.error('SFU produce', err));
    return this.ops;
  }

  onNotify(n: SfuNotification): void {
    if (this.closed) return;
    if (n.method === 'producer-added') void this.consume(n.data.producerId);
    else if (n.method === 'producer-removed') {
      for (const [id, c] of this.consumers) if (c.consumer.producerId === n.data.producerId) this.closeConsumer(id);
    } else if (n.method === 'consumer-closed') this.closeConsumer(n.data.consumerId);
  }

  /** Remote peer's SFU stream, if any track of theirs is being received. */
  streamFor(peerId: string): MediaStream | null {
    const s = this.streams.get(peerId);
    return s && s.getTracks().length ? s : null;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    // Closing transports closes producers (local tracks are left running: stopTracks=false) and consumers.
    this.sendTransport?.close();
    this.recvTransport?.close();
    this.request('leave').catch(() => {});
    const peers = [...this.streams.keys()];
    this.streams.clear();
    this.consumers.clear();
    for (const id of peers) this.emit('change', id);
  }

  private async createTransport(direction: 'send' | 'recv'): Promise<types.Transport> {
    const info = await this.request<TransportInfo>('create-transport', { direction });
    const params = { ...info, iceServers: this.iceServers as RTCIceServer[] };
    const transport = direction === 'send' ? this.device!.createSendTransport(params) : this.device!.createRecvTransport(params);
    transport.on('connect', ({ dtlsParameters }, callback, errback) => {
      this.request('connect-transport', { transportId: transport.id, dtlsParameters }).then(() => callback(), errback);
    });
    if (direction === 'send') {
      transport.on('produce', ({ kind, rtpParameters }, callback, errback) => {
        this.request<{ id: string }>('produce', { transportId: transport.id, kind, rtpParameters }).then(callback, errback);
      });
    }
    transport.on('connectionstatechange', (state) => {
      if (state === 'failed' && !this.closed) this.emit('failed', new Error('Połączenie z SFU nieudane'));
    });
    return transport;
  }

  private async syncProducers(): Promise<void> {
    if (this.closed || !this.sendTransport) return;
    for (const kind of ['audio', 'video'] as const) {
      const track = kind === 'audio' ? this.media.outgoingAudio : this.media.outgoingVideo;
      const producer = this.producers[kind];
      if (producer) {
        if (producer.track !== track) await producer.replaceTrack({ track });
      } else if (track) {
        this.producers[kind] = await this.sendTransport.produce({
          track,
          stopTracks: false, // LocalMedia owns the tracks (also used by the preview and mesh)
          disableTrackOnPause: false,
          zeroRtpOnPause: true,
          ...(kind === 'audio'
            ? { codecOptions: { opusDtx: true, opusFec: true } }
            : { encodings: this.media.sharingScreen ? SCREEN_ENCODINGS : cameraEncodings(track) }),
        });
      }
    }
  }

  private async consume(producerId: string): Promise<void> {
    if (this.closed || !this.recvTransport || !this.device || this.consumed.has(producerId)) return;
    this.consumed.add(producerId);
    try {
      const info = await this.request<ConsumeInfo>('consume', { producerId, rtpCapabilities: this.device.recvRtpCapabilities });
      if (this.closed) return;
      const consumer = await this.recvTransport.consume(info);
      this.consumers.set(consumer.id, { consumer, peerId: info.peerId });
      let stream = this.streams.get(info.peerId);
      if (!stream) this.streams.set(info.peerId, (stream = new MediaStream()));
      for (const t of stream.getTracks()) if (t.kind === consumer.kind) stream.removeTrack(t);
      stream.addTrack(consumer.track);
      await this.request('resume-consumer', { consumerId: consumer.id });
      this.emit('change', info.peerId);
    } catch (err) {
      this.consumed.delete(producerId);
      if (!this.closed) console.warn('SFU consume failed', err);
    }
  }

  private closeConsumer(consumerId: string): void {
    const entry = this.consumers.get(consumerId);
    if (!entry) return;
    this.consumers.delete(consumerId);
    this.consumed.delete(entry.consumer.producerId);
    entry.consumer.close();
    this.streams.get(entry.peerId)?.removeTrack(entry.consumer.track);
    this.emit('change', entry.peerId);
  }
}
