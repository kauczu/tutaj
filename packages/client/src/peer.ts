import type { IceServer, SignalData } from '@tutaj/shared';
import type { LocalMedia } from './media';
import type { PeerState } from './messages';

export type Quality = 'good' | 'fair' | 'poor' | 'unknown';

export interface PeerStats {
  rttMs: number | null;
  lossPct: number;
  outKbps: number | null;
  inKbps: number;
  relayed: boolean;
  /** Why outgoing video is being degraded (WebRTC `qualityLimitationReason`). */
  limitation: 'none' | 'bandwidth' | 'cpu' | 'other';
  quality: Quality;
}

export interface PeerCallbacks {
  signal(sid: string, data: SignalData): void;
  track(): void;
  appMessage(raw: unknown): void;
  appChannelOpen(): void;
  fileMessage(ev: MessageEvent): void;
  connectionState(state: RTCPeerConnectionState): void;
}

/**
 * One RTCPeerConnection to one remote participant (full mesh).
 *
 * Negotiation is deliberately one-sided to avoid glare: the newcomer ("initiator") creates the
 * transceivers and sends every offer, including ICE restarts. The other side only answers.
 * After the first exchange nothing renegotiates — device switches, camera toggle and screen share
 * all go through `replaceTrack`.
 */
export class RemotePeer {
  readonly pc: RTCPeerConnection;
  readonly stream = new MediaStream();
  readonly appChannel: RTCDataChannel;
  readonly fileChannel: RTCDataChannel;
  state: PeerState;
  stats: PeerStats | null = null;
  /** Identifies this RTCPeerConnection in signaling; the remote side's is `remoteSid`. */
  readonly sid = crypto.randomUUID();
  remoteSid: string | null = null;

  private audioTx: RTCRtpTransceiver | null = null;
  private videoTx: RTCRtpTransceiver | null = null;
  private ops: Promise<void> = Promise.resolve();
  private prev = { lost: 0, received: 0, bytesIn: 0, at: 0 };
  private maxBitrate = 0;

  constructor(
    readonly id: string,
    name: string,
    readonly initiator: boolean,
    iceServers: IceServer[],
    private readonly media: LocalMedia,
    private readonly cb: PeerCallbacks,
    /** False while the room uses the SFU: the connection then carries only DataChannels. */
    private mediaEnabled = true,
  ) {
    this.state = { name, audio: false, video: false, screen: false, hand: false };
    this.pc = new RTCPeerConnection({ iceServers, bundlePolicy: 'max-bundle' });

    // Pre-negotiated channels exist on both sides with fixed ids — no ondatachannel race.
    this.appChannel = this.pc.createDataChannel('app', { negotiated: true, id: 0 });
    this.fileChannel = this.pc.createDataChannel('file', { negotiated: true, id: 1 });
    this.fileChannel.binaryType = 'arraybuffer';
    this.appChannel.onopen = () => cb.appChannelOpen();
    this.appChannel.onmessage = (e) => {
      if (typeof e.data !== 'string') return;
      try {
        cb.appMessage(JSON.parse(e.data));
      } catch {
        /* ignore */
      }
    };
    this.fileChannel.onmessage = (e) => cb.fileMessage(e);

    if (initiator) {
      this.audioTx = this.pc.addTransceiver(this.outAudio ?? 'audio', { direction: 'sendrecv' });
      this.videoTx = this.pc.addTransceiver(this.outVideo ?? 'video', { direction: 'sendrecv' });
    }

    this.pc.ontrack = (e) => {
      if (!this.stream.getTracks().includes(e.track)) this.stream.addTrack(e.track);
      cb.track();
    };
    this.pc.onicecandidate = (e) => {
      if (!e.candidate) return;
      const c = e.candidate.toJSON();
      cb.signal(this.sid, {
        candidate: {
          candidate: c.candidate ?? '',
          sdpMid: c.sdpMid ?? null,
          sdpMLineIndex: c.sdpMLineIndex ?? null,
          usernameFragment: c.usernameFragment ?? null,
        },
      });
    };
    this.pc.onnegotiationneeded = () => {
      if (this.initiator) this.enqueue(() => this.sendOffer());
    };
    this.pc.onconnectionstatechange = () => {
      const s = this.pc.connectionState;
      if (s === 'failed' && this.initiator) this.pc.restartIce();
      if (s === 'connected') this.applyBitrate();
      cb.connectionState(s);
    };
  }

  get healthy(): boolean {
    return this.pc.connectionState === 'connected';
  }

  /** True if `sid` belongs to a different remote connection than the one we are talking to. */
  isForeign(sid: string): boolean {
    return this.remoteSid !== null && this.remoteSid !== sid;
  }

  handleSignal(sid: string, data: SignalData): void {
    if ('description' in data) this.remoteSid = sid;
    else if (this.isForeign(sid)) return; // stale candidate from an old connection
    this.enqueue(async () => {
      if ('description' in data) {
        const desc = data.description;
        if (desc.type === 'offer') {
          if (this.initiator) return; // never happens by design; ignore rather than glare
          await this.pc.setRemoteDescription(desc);
          await this.attachAnswererTracks();
          await this.pc.setLocalDescription();
          this.sendLocalDescription();
        } else if (this.pc.signalingState === 'have-local-offer') {
          await this.pc.setRemoteDescription(desc);
        }
      } else {
        try {
          await this.pc.addIceCandidate(data.candidate);
        } catch (err) {
          if (this.pc.remoteDescription) console.warn('addIceCandidate failed', err);
        }
      }
    });
  }

  get mediaActive(): boolean {
    return this.mediaEnabled;
  }

  /** Pushes the current local tracks to the remote side (no renegotiation). */
  async updateTracks(): Promise<void> {
    await Promise.all([this.audioTx?.sender.replaceTrack(this.outAudio), this.videoTx?.sender.replaceTrack(this.outVideo)]);
    await this.applyBitrate();
  }

  /** Stops or resumes sending media on this connection; DataChannels stay up either way. */
  setMediaEnabled(on: boolean): Promise<void> {
    this.mediaEnabled = on;
    return this.updateTracks();
  }

  private get outAudio(): MediaStreamTrack | null {
    return this.mediaEnabled ? this.media.outgoingAudio : null;
  }

  private get outVideo(): MediaStreamTrack | null {
    return this.mediaEnabled ? this.media.outgoingVideo : null;
  }

  /** Caps outgoing video bitrate — in a mesh our upload is shared by every peer. */
  async setMaxBitrate(bps: number): Promise<void> {
    this.maxBitrate = bps;
    await this.applyBitrate();
  }

  sendApp(msg: unknown): boolean {
    if (this.appChannel.readyState !== 'open') return false;
    this.appChannel.send(JSON.stringify(msg));
    return true;
  }

  async sampleStats(): Promise<PeerStats | null> {
    if (this.pc.connectionState === 'closed') return null;
    const report = await this.pc.getStats();
    let pairId: string | undefined;
    let lost = 0;
    let received = 0;
    let bytesIn = 0;
    let limitation: PeerStats['limitation'] = 'none';
    report.forEach((s) => {
      if (s.type === 'outbound-rtp' && s.kind === 'video' && s.qualityLimitationReason && s.qualityLimitationReason !== 'none') {
        limitation = s.qualityLimitationReason === 'bandwidth' || s.qualityLimitationReason === 'cpu' ? s.qualityLimitationReason : 'other';
      }
      if (s.type === 'transport' && s.selectedCandidatePairId) pairId = s.selectedCandidatePairId;
      if (s.type === 'inbound-rtp') {
        lost += s.packetsLost ?? 0;
        received += s.packetsReceived ?? 0;
        bytesIn += s.bytesReceived ?? 0;
      }
    });
    let pair: any;
    if (pairId) pair = report.get(pairId);
    else report.forEach((s) => {
      if (s.type === 'candidate-pair' && (s.nominated || s.selected) && s.state === 'succeeded') pair = s;
    });

    const now = performance.now();
    const dLost = Math.max(0, lost - this.prev.lost);
    const dRecv = Math.max(0, received - this.prev.received);
    const dt = this.prev.at ? (now - this.prev.at) / 1000 : 0;
    const inKbps = dt > 0 ? Math.max(0, ((bytesIn - this.prev.bytesIn) * 8) / 1000 / dt) : 0;
    this.prev = { lost, received, bytesIn, at: now };

    const rttMs = typeof pair?.currentRoundTripTime === 'number' ? Math.round(pair.currentRoundTripTime * 1000) : null;
    const lossPct = dLost + dRecv > 0 ? (dLost / (dLost + dRecv)) * 100 : 0;
    const local = pair?.localCandidateId ? report.get(pair.localCandidateId) : undefined;
    const outKbps = typeof pair?.availableOutgoingBitrate === 'number' ? Math.round(pair.availableOutgoingBitrate / 1000) : null;

    let quality: Quality = 'unknown';
    if (pair) {
      quality = 'good';
      if (lossPct > 3 || (rttMs ?? 0) > 250) quality = 'fair';
      if (lossPct > 8 || (rttMs ?? 0) > 500) quality = 'poor';
    }
    this.stats = { rttMs, lossPct, outKbps, inKbps: Math.round(inKbps), relayed: local?.candidateType === 'relay', limitation, quality };
    return this.stats;
  }

  close(): void {
    this.pc.onconnectionstatechange = null;
    this.pc.close();
    for (const t of this.stream.getTracks()) t.stop();
  }

  private enqueue(op: () => Promise<void>): void {
    this.ops = this.ops.then(op).catch((err) => console.error(`peer ${this.id}:`, err));
  }

  private async sendOffer(): Promise<void> {
    await this.pc.setLocalDescription();
    this.sendLocalDescription();
  }

  private sendLocalDescription(): void {
    const d = this.pc.localDescription;
    if (d && (d.type === 'offer' || d.type === 'answer')) this.cb.signal(this.sid, { description: { type: d.type, sdp: d.sdp } });
  }

  /** On the answering side, adopt the transceivers created by the remote offer and start sending on them. */
  private async attachAnswererTracks(): Promise<void> {
    for (const t of this.pc.getTransceivers()) {
      const kind = t.receiver.track.kind;
      if (kind === 'audio' && !this.audioTx) this.audioTx = t;
      else if (kind === 'video' && !this.videoTx) this.videoTx = t;
      else continue;
      t.direction = 'sendrecv';
    }
    await Promise.all([this.audioTx?.sender.replaceTrack(this.outAudio), this.videoTx?.sender.replaceTrack(this.outVideo)]);
  }

  private async applyBitrate(): Promise<void> {
    const sender = this.videoTx?.sender;
    if (!sender || !this.maxBitrate) return;
    const params = sender.getParameters();
    if (!params.encodings?.length) return; // not negotiated yet; re-applied on 'connected'
    const target = this.media.sharingScreen ? Math.round(this.maxBitrate * 1.5) : this.maxBitrate;
    if (params.encodings[0].maxBitrate === target) return;
    params.encodings[0].maxBitrate = target;
    try {
      await sender.setParameters(params);
    } catch (err) {
      console.warn('setParameters failed', err);
    }
  }
}
