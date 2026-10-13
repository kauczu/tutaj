import type { IceServer, MediaMode, ModePreference, ModeReason, QualityReport, ServerMessage } from '@tutaj/shared';
import { SpeakingDetector } from './audio';
import { FileReceiver, MAX_FILE_SIZE, formatBytes, sendFile } from './files';
import { LocalMedia, describeMediaError } from './media';
import { parseAppMessage, type AppMessage, type PeerState } from './messages';
import { RemotePeer, SendMeter, type SendStats } from './peer';
import { MIN_VIDEO_BITRATE, SCREEN_BITRATE, isHighQuality, prefersH264, videoBudget, videoCap } from './quality';
import { CallRecorder } from './recorder';
import type { SfuSession } from './sfu';
import { Signaling } from './signaling';
import { ChatPanel, type TransferHandle } from './ui/chat';
import { $, download, fillDeviceSelect, h } from './ui/dom';
import { Grid, Tile } from './ui/grid';
import { setIcon } from './ui/icons';
import { renderQualityForm } from './ui/quality-form';
import { StageWindow } from './ui/stage';
import { toast } from './ui/toast';

export interface RoomOptions {
  roomId: string;
  name: string;
  password?: string;
  /** Server owner's key: lifts the server's per-IP limits. */
  ownerKey?: string;
  signalingUrl: string;
  media: LocalMedia;
}

type Welcome = Extract<ServerMessage, { type: 'welcome' }>;

const LOCAL_ID = 'local';
const CONNECT_TIMEOUT_MS = 25_000;
/** How long a failed connection may stay down before its tile is dropped (when the peer is gone). */
const PEER_GONE_MS = 15_000;
const MAX_RECONNECTS = 10;
/** Quality reports to the server (mesh mode only), and how long connections must be up first. */
const REPORT_INTERVAL_MS = 5_000;
const REPORT_WARMUP_MS = 10_000;

const MODE_LABEL: Record<ModePreference, string> = { auto: 'Automatyczny', mesh: 'P2P', sfu: 'SFU (przez serwer)' };
const REASON_LABEL: Record<ModeReason, string> = {
  participants: 'liczba uczestników',
  bandwidth: 'za słabe łącze wysyłające u jednej z osób',
  cpu: 'przeciążony procesor u jednej z osób',
  relay: 'połączenia przez serwer TURN',
  manual: 'wybór ręczny',
  quality: 'wysoka jakość obrazu lub dźwięku',
  'sfu-unavailable': 'SFU niedostępne',
};

class JoinError extends Error {
  constructor(message: string, readonly fatal: boolean) {
    super(message);
  }
}

/** Connects to the signaling server and resolves with the welcome message (or throws the server's error). */
async function connectAndJoin(
  opts: RoomOptions,
  resume?: { id: string; token: string },
): Promise<{ signaling: Signaling; welcome: Welcome }> {
  const signaling = new Signaling(opts.signalingUrl);
  await signaling.connect();
  const welcome = await new Promise<Welcome>((resolve, reject) => {
    const timer = setTimeout(() => reject(new JoinError('Serwer nie odpowiada', false)), 8000);
    const off = signaling.on('message', (msg) => {
      if (msg.type === 'welcome') {
        clearTimeout(timer);
        off();
        resolve(msg);
      } else if (msg.type === 'error') {
        clearTimeout(timer);
        off();
        reject(new JoinError(msg.message, ['bad-password', 'room-full', 'room-limit'].includes(msg.code)));
      }
    });
    signaling.send({
      type: 'join',
      room: opts.roomId,
      name: opts.name,
      password: opts.password,
      resume,
      ownerKey: opts.ownerKey,
    });
  }).catch((err) => {
    signaling.close();
    throw err;
  });
  return { signaling, welcome };
}

export class Room {
  private signaling!: Signaling;
  private online = false;
  private selfId = '';
  private resumeToken = '';
  private iceServers: IceServer[] = [];
  private shareBase: string | null = null;
  /** Peers the server currently reports in the room (only meaningful while online). */
  private present = new Set<string>();
  private peers = new Map<string, RemotePeer>();
  private receivers = new Map<string, FileReceiver>();
  private fileQueues = new Map<string, Promise<void>>();
  private peerTimers = new Map<string, number>();
  private connectedAt = new Map<string, number>();
  private mode: MediaMode = 'mesh';
  private pref: ModePreference = 'auto';
  private sfuAvailable = false;
  private sfu: SfuSession | null = null;
  private sfuMeter = new SendMeter();
  private sfuSend: SendStats | null = null;
  /** Whether mesh connections carry media (false once our SFU upstream is running). */
  private meshMedia = true;
  private lastReport = 0;
  /** Prefer H.264 on new connections (hardware encoder available or chosen by the user). */
  private h264 = false;
  private hand = false;
  private leaving = false;
  private readonly media: LocalMedia;
  private readonly grid = new Grid($('grid'));
  private readonly localTile: Tile;
  private readonly chat: ChatPanel;
  private readonly speaking: SpeakingDetector;
  private readonly recorder: CallRecorder;
  private readonly stage: StageWindow;
  private readonly startedAt = Date.now();
  private readonly timers: number[] = [];
  private readonly cleanups: (() => void)[] = [];

  /** Joins the room; throws (before any UI is shown) if the server rejects us. */
  static async join(opts: RoomOptions, onLeave: () => void): Promise<Room> {
    const h264 = await prefersH264(opts.media.quality);
    const { signaling, welcome } = await connectAndJoin(opts);
    const room = new Room(opts, onLeave);
    room.h264 = h264;
    room.attach(signaling, welcome);
    return room;
  }

  private constructor(
    private readonly opts: RoomOptions,
    private readonly onLeave: () => void,
  ) {
    this.media = opts.media;
    this.localTile = new Tile(LOCAL_ID, this.myState(), true);
    this.localTile.setStream(this.media.previewStream());
    this.grid.add(this.localTile);

    this.speaking = new SpeakingDetector((id, speaking) => this.grid.get(id)?.setSpeaking(speaking));
    this.speaking.watch(LOCAL_ID, this.media.audioTrack);

    this.chat = new ChatPanel(
      (text) => this.sendChat(text),
      (files) => this.sendFiles(files),
      (open) => $('btn-chat').classList.toggle('active', open),
    );

    this.recorder = new CallRecorder(
      () => this.grid.all().map((t) => ({ video: t.video, label: t.state.name, showVideo: t.state.video })),
      () =>
        [this.media.audioTrack, ...[...this.peers.keys()].flatMap((id) => this.streamFor(id)?.getAudioTracks() ?? [])].filter(
          (t): t is MediaStreamTrack => !!t,
        ),
    );

    this.stage = new StageWindow(this.grid, () => this.updateControls());

    this.cleanups.push(this.media.on('change', () => this.onLocalMediaChange()));
    this.bindControls();
    this.timers.push(window.setInterval(() => void this.pollStats(), 2000));
    this.timers.push(window.setInterval(() => this.updateClock(), 1000));

    $('room-name').textContent = opts.roomId;
    $('lobby').hidden = true;
    $('room-view').hidden = false;
    document.body.classList.add('in-room');
    this.updateControls();
  }

  // --- Signaling -----------------------------------------------------------

  /**
   * Adopts a (re)established signaling session. On reconnect, P2P connections that are still
   * up are kept — once connected, the call no longer depends on the server.
   */
  private attach(signaling: Signaling, welcome: Welcome): void {
    const firstJoin = !this.selfId;
    const resumed = this.selfId === welcome.selfId;
    this.signaling = signaling;
    this.online = true;
    this.selfId = welcome.selfId;
    this.resumeToken = welcome.resumeToken;
    this.iceServers = welcome.iceServers;
    this.shareBase = welcome.shareBaseUrl;
    this.present = new Set(welcome.peers.map((p) => p.id));
    this.sfuAvailable = welcome.sfuAvailable;
    this.pref = welcome.pref;
    signaling.on('message', (msg) => this.onServerMessage(msg));
    signaling.on('close', () => void this.reconnect());

    // Other peers only know our old id if we could not resume it.
    for (const id of [...this.peers.keys()]) {
      if (!resumed || !this.present.has(id)) this.removePeer(id);
    }
    for (const p of welcome.peers) {
      if (!this.peers.get(p.id)?.healthy) this.addPeer(p.id, p.name, true);
    }
    this.relayState();
    void this.applyMode(welcome.mode);
    if (firstJoin && welcome.privileged) toast('Rozpoznano klucz właściciela — limity serwera Cię nie dotyczą.');
    if (welcome.peers.length === 0 && firstJoin) {
      this.chat.addSystem('Jesteś pierwszy w pokoju — skopiuj zaproszenie i wyślij je innym.');
    }
  }

  private onServerMessage(msg: ServerMessage): void {
    switch (msg.type) {
      case 'peer-joined': {
        this.present.add(msg.peer.id);
        const existing = this.peers.get(msg.peer.id);
        if (existing?.healthy) break; // a resumed session — the P2P link never dropped
        this.addPeer(msg.peer.id, msg.peer.name, false);
        this.relayState(msg.peer.id);
        if (!existing) {
          this.chat.addSystem(`${msg.peer.name} dołącza`);
          toast(`${msg.peer.name} dołącza do rozmowy`);
        }
        break;
      }
      case 'peer-left': {
        this.present.delete(msg.id);
        const peer = this.peers.get(msg.id);
        // Only its server connection dropped: keep talking P2P; it will resume or time out.
        if (!peer || (msg.reason === 'disconnect' && peer.healthy)) break;
        this.removePeer(msg.id);
        this.chat.addSystem(`${peer.state.name} opuszcza pokój`);
        break;
      }
      case 'signal': {
        let peer = this.peers.get(msg.from);
        const isOffer = 'description' in msg.data && msg.data.description.type === 'offer';
        // A fresh connection from the remote side replaces whatever we had.
        if (!peer || (isOffer && (peer.initiator || peer.isForeign(msg.sid)))) {
          peer = this.addPeer(msg.from, peer?.state.name ?? '…', false);
        }
        peer.handleSignal(msg.sid, msg.data);
        break;
      }
      case 'relay':
        this.onAppMessage(msg.from, msg.payload);
        break;
      case 'mode': {
        this.pref = msg.pref;
        if (msg.by) this.chat.addSystem(`${msg.by} ustawia tryb mediów: ${MODE_LABEL[msg.pref]}`);
        if (msg.mode !== this.mode) {
          this.chat.addSystem(
            msg.mode === 'sfu'
              ? `Przełączam media na serwer SFU (${REASON_LABEL[msg.reason]})`
              : `Przełączam media na połączenia bezpośrednie P2P (${REASON_LABEL[msg.reason]})`,
          );
        }
        void this.applyMode(msg.mode);
        break;
      }
      case 'sfu-notify':
        this.sfu?.onNotify(msg);
        break;
      case 'error':
        if (msg.code !== 'unknown-peer') toast(msg.message, 'error');
        break;
    }
  }

  private async reconnect(): Promise<void> {
    if (this.leaving) return;
    this.online = false;
    // The SFU lives on the server we just lost: carry on peer-to-peer.
    if (this.mode === 'sfu') void this.applyMode('mesh');
    const banner = $('reconnecting');
    const setBanner = (text: string) => {
      banner.textContent = text;
      banner.hidden = false;
    };
    setBanner('Brak połączenia z serwerem — rozmowa trwa P2P, ponowne łączenie…');

    for (let attempt = 0; attempt < MAX_RECONNECTS && !this.leaving; attempt++) {
      await new Promise((r) => setTimeout(r, Math.min(1000 * 2 ** attempt, 10_000)));
      if (this.leaving) return;
      try {
        const { signaling, welcome } = await connectAndJoin(this.opts, { id: this.selfId, token: this.resumeToken });
        if (this.leaving) return signaling.close();
        banner.hidden = true;
        this.attach(signaling, welcome);
        toast('Połączono ponownie z serwerem');
        return;
      } catch (err) {
        if (err instanceof JoinError && err.fatal) return setBanner(err.message);
      }
    }
    setBanner('Nie udało się połączyć z serwerem. Trwające połączenia P2P działają, ale nowe osoby nie dołączą.');
  }

  // --- Peers ---------------------------------------------------------------

  private addPeer(id: string, name: string, initiator: boolean): RemotePeer {
    const previous = this.peers.get(id)?.state;
    this.removePeer(id);
    const tile = new Tile(id, previous ?? { name, audio: false, video: false, screen: false, hand: false }, false);
    const handles = new Map<string, TransferHandle>();
    const receiver = new FileReceiver({
      start: (f) => handles.set(f.id, this.chat.addTransfer(peer.state.name, f.name, f.size, false)),
      progress: (f, n) => handles.get(f.id)?.progress(n),
      done: (f, blob) => {
        handles.get(f.id)?.complete(blob);
        handles.delete(f.id);
        if (!this.chat.open) toast(`${peer.state.name} wysyła plik: ${f.name}`);
      },
      failed: (f, reason) => {
        handles.get(f.id)?.fail(reason);
        handles.delete(f.id);
      },
    });

    const watchdog = (ms: number, check: () => void) => {
      clearTimeout(this.peerTimers.get(id));
      this.peerTimers.set(id, window.setTimeout(check, ms));
    };

    const peer: RemotePeer = new RemotePeer(id, name, initiator, this.iceServers, this.media, {
      signal: (sid, data) => this.signaling.send({ type: 'signal', to: id, sid, data }),
      track: () => this.refreshTile(id),
      appMessage: (raw) => this.onAppMessage(id, raw),
      appChannelOpen: () => peer.sendApp({ t: 'state', state: this.myState() } satisfies AppMessage),
      fileMessage: (e) => receiver.handle(e),
      connectionState: (s) => {
        if (s === 'connected') {
          clearTimeout(this.peerTimers.get(id));
          this.connectedAt.set(id, Date.now());
          tile.setStatus(null);
        } else if (s === 'disconnected') {
          tile.setStatus('Problem z połączeniem…');
        } else if (s === 'failed') {
          this.connectedAt.delete(id);
          tile.setStatus('Połączenie przerwane — ponawianie…');
          receiver.abort();
          watchdog(PEER_GONE_MS, () => {
            if (this.peers.get(id) !== peer || peer.healthy) return;
            if (this.online && this.present.has(id)) {
              tile.setStatus('Nie można nawiązać połączenia P2P (sieć może wymagać serwera TURN)');
            } else {
              this.removePeer(id);
              this.chat.addSystem(`Utracono połączenie z: ${peer.state.name}`);
            }
          });
        }
      },
    }, this.meshMedia, this.h264);

    tile.setStatus('Łączenie…');
    watchdog(CONNECT_TIMEOUT_MS, () => {
      if (!peer.healthy) tile.setStatus('Nie można nawiązać połączenia P2P (sieć może wymagać serwera TURN)');
    });

    this.peers.set(id, peer);
    this.receivers.set(id, receiver);
    this.grid.add(tile);
    this.applyBitrate();
    return peer;
  }

  private removePeer(id: string): void {
    const peer = this.peers.get(id);
    if (!peer) return;
    clearTimeout(this.peerTimers.get(id));
    this.peerTimers.delete(id);
    this.receivers.get(id)?.abort();
    this.receivers.delete(id);
    this.fileQueues.delete(id);
    this.speaking.unwatch(id);
    this.connectedAt.delete(id);
    peer.close();
    this.peers.delete(id);
    this.grid.remove(id);
    this.applyBitrate();
  }

  /** Splits our video upload across the mesh: one stream per peer, within the upload limit. */
  private applyBitrate(): void {
    const n = Math.max(1, this.peers.size);
    // RED roughly doubles the audio we send.
    const budget = videoBudget(this.media.quality, n * this.media.audioBitrate * 2);
    const cap = this.media.sharingScreen ? SCREEN_BITRATE : videoCap(this.media.outgoingVideo?.getSettings().height);
    const bps = Math.max(MIN_VIDEO_BITRATE, Math.min(cap, Math.floor(budget / n)));
    for (const p of this.peers.values()) void p.setMaxBitrate(bps);
  }

  private onAppMessage(from: string, raw: unknown): void {
    const peer = this.peers.get(from);
    const msg = parseAppMessage(raw);
    if (!peer || !msg) return;
    if (msg.t === 'bye') {
      this.removePeer(from);
      this.chat.addSystem(`${peer.state.name} opuszcza pokój`);
    } else if (msg.t === 'state') {
      if (msg.state.hand && !peer.state.hand) toast(`✋ ${msg.state.name} podnosi rękę`);
      peer.state = msg.state;
      this.grid.get(from)?.setState(msg.state);
    } else if (msg.t === 'chat') {
      this.chat.addMessage(peer.state.name, msg.text, msg.ts, false);
    }
  }

  /** Sends over DataChannels, falling back to the server relay for peers whose channel isn't open yet. */
  private sendApp(msg: AppMessage, to?: string): void {
    const targets = to ? [to] : [...this.peers.keys()];
    for (const id of targets) {
      if (!this.peers.get(id)?.sendApp(msg)) this.signaling.send({ type: 'relay', to: id, payload: msg });
    }
  }

  private relayState(to?: string): void {
    this.signaling.send({ type: 'relay', to, payload: { t: 'state', state: this.myState() } satisfies AppMessage });
  }

  // --- Media mode (mesh ⇄ SFU) ----------------------------------------------

  /** The stream to show for a peer: its SFU stream once that carries media, otherwise the mesh one. */
  private streamFor(id: string): MediaStream | null {
    return (this.mode === 'sfu' && this.sfu?.streamFor(id)) || this.peers.get(id)?.stream || null;
  }

  private refreshTile(id: string): void {
    const stream = this.streamFor(id);
    const tile = this.grid.get(id);
    if (!stream || !tile) return;
    tile.setStream(stream);
    this.speaking.watch(id, stream.getAudioTracks()[0]);
  }

  /**
   * Make-before-break switching. To SFU: start producing/consuming there, and only then stop
   * sending media over the mesh. To mesh: resume mesh media first, then drop the SFU session.
   * Mesh connections stay up in both modes — they carry chat and files.
   */
  private async applyMode(mode: MediaMode): Promise<void> {
    this.mode = mode;
    this.updateModeBadge();
    if (mode === 'sfu') {
      if (this.sfu) return;
      // mediasoup-client is only downloaded when a room actually uses the SFU.
      let SfuSession: typeof import('./sfu').SfuSession;
      try {
        ({ SfuSession } = await import('./sfu'));
      } catch {
        toast('Nie udało się wczytać modułu SFU — zostaję przy P2P', 'error');
        return;
      }
      if (this.mode !== 'sfu' || this.sfu || this.leaving) return; // superseded while loading
      const session = new SfuSession((m, d) => this.signaling.request(m, d), this.media, this.iceServers, this.h264);
      this.sfu = session;
      session.on('change', (id) => this.refreshTile(id));
      session.on('failed', (err) => this.onSfuFailure(session, err));
      try {
        await session.start();
      } catch (err) {
        this.onSfuFailure(session, err instanceof Error ? err : new Error(String(err)));
        return;
      }
      if (this.sfu === session) this.setMeshMedia(false);
    } else {
      this.setMeshMedia(true);
      const session = this.sfu;
      this.sfu = null;
      session?.close();
      for (const id of this.peers.keys()) this.refreshTile(id);
    }
  }

  private onSfuFailure(session: SfuSession, err: Error): void {
    if (this.sfu !== session) return;
    console.error(err);
    toast(`${err.message} — wracam do P2P`, 'error');
    this.sfu = null;
    session.close();
    this.setMeshMedia(true);
    this.mode = 'mesh';
    this.updateModeBadge();
    for (const id of this.peers.keys()) this.refreshTile(id);
    // Others route our media through the SFU too; ask the room to go back to P2P.
    if (this.online) this.signaling.send({ type: 'set-mode', pref: 'mesh' });
  }

  private setMeshMedia(on: boolean): void {
    this.meshMedia = on;
    for (const p of this.peers.values()) void p.setMediaEnabled(on);
  }

  private updateModeBadge(): void {
    const badge = $('mode-badge');
    badge.textContent = this.mode === 'sfu' ? 'SFU' : 'P2P';
    badge.className = `mode-badge ${this.mode}`;
    badge.title = this.mode === 'sfu' ? 'Media przez serwer SFU' : 'Media bezpośrednio między uczestnikami';
  }

  /** Tells the server how our uplink copes with the mesh, so it can move the room to the SFU. */
  private sendQualityReport(): void {
    if (!this.online || this.mode !== 'mesh' || !this.sfuAvailable || this.pref !== 'auto' || this.peers.size < 2) return;
    const now = Date.now();
    if (now - this.lastReport < REPORT_INTERVAL_MS) return;
    const hq = isHighQuality(this.media.quality);
    if (hq) {
      // N−1 high-quality streams would saturate the uplink: no need to wait for measurements.
      this.lastReport = now;
      this.signaling.send({ type: 'quality', report: { bw: false, cpu: false, relayed: false, uplinkKbps: null, hq } });
      return;
    }
    const peers = [...this.peers.values()];
    // Skip while connections are new: bandwidth estimation reports "limited" during ramp-up.
    if (!peers.every((p) => p.healthy && now - (this.connectedAt.get(p.id) ?? now) >= REPORT_WARMUP_MS)) return;
    const stats = peers.map((p) => p.stats).filter((s) => !!s);
    if (stats.length !== peers.length) return;
    const known = stats.filter((s) => s.outKbps !== null);
    const report: QualityReport = {
      bw: stats.some((s) => s.limitation === 'bandwidth'),
      cpu: stats.some((s) => s.limitation === 'cpu'),
      relayed: stats.some((s) => s.relayed),
      uplinkKbps: known.length === stats.length ? known.reduce((sum, s) => sum + (s.outKbps ?? 0), 0) : null,
    };
    this.lastReport = now;
    this.signaling.send({ type: 'quality', report });
  }

  // --- Local state ---------------------------------------------------------

  private myState(): PeerState {
    return {
      name: this.opts.name,
      audio: !!this.media.audioTrack && this.media.audioEnabled,
      video: !!this.media.outgoingVideo,
      screen: this.media.sharingScreen,
      hand: this.hand,
    };
  }

  private broadcastState(): void {
    this.localTile.setState(this.myState());
    this.sendApp({ t: 'state', state: this.myState() });
    this.updateControls();
  }

  private onLocalMediaChange(): void {
    this.localTile.setStream(this.media.previewStream());
    this.speaking.watch(LOCAL_ID, this.media.audioTrack);
    void prefersH264(this.media.quality).then((v) => {
      this.h264 = v;
      for (const p of this.peers.values()) void p.setPreferH264(v);
    });
    this.applyBitrate();
    for (const p of this.peers.values()) void p.updateTracks();
    void this.sfu?.updateTracks();
    this.broadcastState();
  }

  private sendChat(text: string): void {
    const msg: AppMessage = { t: 'chat', id: crypto.randomUUID(), text, ts: Date.now() };
    this.chat.addMessage(this.opts.name, text, msg.ts, true);
    this.sendApp(msg);
  }

  private sendFiles(files: File[]): void {
    if (this.peers.size === 0) return toast('Nikogo nie ma w pokoju', 'error');
    for (const file of files) {
      if (file.size > MAX_FILE_SIZE) {
        toast(`${file.name}: plik większy niż ${formatBytes(MAX_FILE_SIZE)}`, 'error');
        continue;
      }
      for (const peer of this.peers.values()) {
        const handle = this.chat.addTransfer(`Ty → ${peer.state.name}`, file.name, file.size, true);
        const prev = this.fileQueues.get(peer.id) ?? Promise.resolve();
        const next = prev.then(() =>
          sendFile(peer.fileChannel, file, crypto.randomUUID(), (n) => handle.progress(n)).then(
            () => handle.complete(),
            (err: Error) => handle.fail(err.message),
          ),
        );
        this.fileQueues.set(peer.id, next);
      }
    }
  }

  // --- Controls ------------------------------------------------------------

  private bindControls(): void {
    const on = (id: string, fn: () => void) => {
      const el = $(id);
      el.addEventListener('click', fn);
      this.cleanups.push(() => el.removeEventListener('click', fn));
    };
    on('btn-mic', () => void this.toggleMic());
    on('btn-cam', () => void this.toggleCam());
    on('btn-screen', () => void this.toggleScreen());
    on('btn-hand', () => this.toggleHand());
    on('btn-chat', () => this.chat.toggle());
    on('btn-record', () => void this.toggleRecording());
    on('btn-stage', () => this.toggleStage());
    on('btn-settings', () => void this.openSettings());
    on('btn-leave', () => void this.leave());
    on('btn-invite', () => void this.copyInvite());

    if (!navigator.mediaDevices?.getDisplayMedia) $('btn-screen').hidden = true;
    if (!CallRecorder.supported()) $('btn-record').hidden = true;

    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.ctrlKey || e.metaKey || e.altKey || t.closest('input, textarea, select, dialog')) return;
      const actions: Record<string, () => void> = {
        m: () => void this.toggleMic(),
        v: () => void this.toggleCam(),
        s: () => void this.toggleScreen(),
        h: () => this.toggleHand(),
        c: () => this.chat.toggle(),
        k: () => this.toggleStage(),
      };
      const action = actions[e.key.toLowerCase()];
      if (action) {
        e.preventDefault();
        action();
      }
    };
    document.addEventListener('keydown', onKey);
    this.cleanups.push(() => document.removeEventListener('keydown', onKey));

    const onHide = () => this.signaling.send({ type: 'leave' });
    window.addEventListener('pagehide', onHide);
    this.cleanups.push(() => window.removeEventListener('pagehide', onHide));
  }

  private updateControls(): void {
    const set = (id: string, active: boolean, iconOn: Parameters<typeof setIcon>[1], iconOff = iconOn, offIsBad = true) => {
      const btn = $(id);
      setIcon(btn, active ? iconOn : iconOff);
      btn.setAttribute('aria-pressed', String(active));
      btn.classList.toggle('off', offIsBad && !active);
    };
    set('btn-mic', !!this.media.audioTrack && this.media.audioEnabled, 'mic', 'micOff');
    set('btn-cam', this.media.cameraOn, 'cam', 'camOff');
    set('btn-screen', this.media.sharingScreen, 'screen', 'screen', false);
    $('btn-screen').classList.toggle('active', this.media.sharingScreen);
    set('btn-hand', this.hand, 'hand', 'hand', false);
    $('btn-hand').classList.toggle('active', this.hand);
    setIcon($('btn-chat'), 'chat');
    setIcon($('btn-record'), 'record');
    $('btn-record').classList.toggle('recording', this.recorder.active);
    setIcon($('btn-settings'), 'settings');
    setIcon($('btn-stage'), 'monitor');
    $('btn-stage').classList.toggle('active', this.stage?.isOpen ?? false);
    $('btn-stage').setAttribute('aria-pressed', String(this.stage?.isOpen ?? false));
    setIcon($('btn-leave'), 'leave');
  }

  private async toggleMic(): Promise<void> {
    if (!this.media.audioTrack) {
      try {
        await this.media.setMicrophone(this.media.audioDeviceId);
        this.media.setAudioEnabled(true);
      } catch (e) {
        toast(`Mikrofon: ${describeMediaError(e)}`, 'error');
      }
    } else {
      this.media.setAudioEnabled(!this.media.audioEnabled);
    }
    this.broadcastState();
  }

  private async toggleCam(): Promise<void> {
    try {
      await this.media.setCamera(!this.media.cameraOn);
    } catch (e) {
      toast(`Kamera: ${describeMediaError(e)}`, 'error');
    }
  }

  private async toggleScreen(): Promise<void> {
    if (this.media.sharingScreen) return this.media.stopScreen();
    try {
      await this.media.startScreen();
    } catch (e) {
      if (!(e instanceof DOMException && e.name === 'NotAllowedError')) toast(`Ekran: ${describeMediaError(e)}`, 'error');
    }
  }

  /** Camera view in its own window — for a second monitor while gaming. */
  private toggleStage(): void {
    // Desktop app older than 0.3.0: its main process blocks this window.
    if (window.tutaj && !window.tutaj.displays) {
      return toast('Okno kamer wymaga nowszej aplikacji desktopowej (0.3.0 lub nowszej) — zaktualizuj Tutaj', 'error');
    }
    if (!this.stage.toggle()) toast('Przeglądarka zablokowała okno — zezwól na wyskakujące okna dla tej strony', 'error');
    this.updateControls();
  }

  private toggleHand(): void {
    this.hand = !this.hand;
    this.broadcastState();
  }

  private async toggleRecording(): Promise<void> {
    if (!this.recorder.active) {
      try {
        this.recorder.start();
        toast('Nagrywanie rozpoczęte (zapisywane tylko lokalnie)');
        this.sendApp({ t: 'chat', id: crypto.randomUUID(), text: '🔴 rozpoczyna nagrywanie rozmowy', ts: Date.now() });
      } catch (e) {
        toast(`Nagrywanie: ${describeMediaError(e)}`, 'error');
      }
    } else {
      await this.saveRecording();
    }
    this.updateControls();
  }

  private async saveRecording(): Promise<void> {
    const blob = await this.recorder.stop();
    const ext = blob.type.includes('mp4') ? 'mp4' : 'webm';
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    download(blob, `tutaj-${this.opts.roomId}-${stamp}.${ext}`);
  }

  inviteLink(): string {
    const url = new URL(`${this.shareBase ?? location.origin}/`);
    url.searchParams.set('room', this.opts.roomId);
    return url.toString();
  }

  private async copyInvite(): Promise<void> {
    const link = this.inviteLink();
    try {
      await navigator.clipboard.writeText(link);
      toast('Link skopiowany do schowka');
    } catch {
      window.prompt('Skopiuj link zaproszenia:', link);
    }
  }

  private async openSettings(): Promise<void> {
    const dialog = $<HTMLDialogElement>('settings');
    const audioIn = $<HTMLSelectElement>('set-audio-input');
    const videoIn = $<HTMLSelectElement>('set-video-input');
    const audioOut = $<HTMLSelectElement>('set-audio-output');
    fillDeviceSelect(audioIn, await LocalMedia.devices('audioinput'), this.media.audioDeviceId, 'Mikrofon');
    fillDeviceSelect(videoIn, await LocalMedia.devices('videoinput'), this.media.videoDeviceId, 'Kamera');
    const sinkSupported = 'setSinkId' in HTMLMediaElement.prototype;
    $('set-audio-output-wrap').hidden = !sinkSupported;
    if (sinkSupported) fillDeviceSelect(audioOut, await LocalMedia.devices('audiooutput'), undefined, 'Głośnik');

    audioIn.onchange = () => this.media.setMicrophone(audioIn.value).catch((e) => toast(describeMediaError(e), 'error'));
    videoIn.onchange = () => this.media.setCamera(true, videoIn.value).catch((e) => toast(describeMediaError(e), 'error'));
    audioOut.onchange = () => {
      for (const t of this.grid.all()) {
        if (!t.local) void (t.video as HTMLVideoElement & { setSinkId(id: string): Promise<void> }).setSinkId(audioOut.value);
      }
    };
    const modeSelect = $<HTMLSelectElement>('set-mode');
    modeSelect.value = this.pref;
    modeSelect.disabled = !this.sfuAvailable;
    $('mode-info').textContent = this.sfuAvailable
      ? `Teraz: ${this.mode === 'sfu' ? 'SFU' : 'P2P'}. Tryb automatyczny przełącza na SFU przy 3+ osobach, gdy łącze lub procesor nie nadąża.`
      : 'Serwer nie ma włączonego SFU — media zawsze płyną P2P.';
    modeSelect.onchange = () => this.signaling.send({ type: 'set-mode', pref: modeSelect.value as ModePreference });
    renderQualityForm($('quality-room'), this.media, (msg) => toast(msg, 'error'));
    void this.renderStageDisplays();
    this.renderStats();
    dialog.showModal();
  }

  /** Desktop app with 2+ monitors: which one gets the camera window. */
  private async renderStageDisplays(): Promise<void> {
    const wrap = $('set-stage-display-wrap');
    const select = $<HTMLSelectElement>('set-stage-display');
    const bridge = window.tutaj;
    const info = await bridge?.displays?.().catch(() => null);
    wrap.hidden = !bridge?.setStageDisplay || !info || info.displays.length < 2;
    if (wrap.hidden || !info) return;
    const option = (value: string, text: string) => {
      const o = h('option', { text });
      o.value = value;
      o.selected = value === String(info.selected ?? '');
      return o;
    };
    select.replaceChildren(
      option('', 'Automatycznie — inny niż okno rozmowy'),
      ...info.displays.map((d, i) =>
        option(String(d.id), `Ekran ${i + 1}: ${d.label || 'monitor'} — ${d.width}×${d.height}${d.primary ? ' (główny)' : ''}${d.current ? ' (tu jest Tutaj)' : ''}`),
      ),
    );
    select.onchange = () => void bridge!.setStageDisplay!(select.value ? Number(select.value) : null);
  }

  private async pollStats(): Promise<void> {
    await Promise.all(
      [...this.peers.values()].map(async (p) => {
        const stats = await p.sampleStats().catch(() => null);
        this.grid.get(p.id)?.setStats(stats);
      }),
    );
    const report = await this.sfu?.sendStats().catch(() => null);
    this.sfuSend = report ? this.sfuMeter.sample(report) : null;
    this.sendQualityReport();
    if ($<HTMLDialogElement>('settings').open) this.renderStats();
  }

  /** "What am I sending": resolution, codec/encoder and bitrates, for checking quality during a game. */
  private renderSendSummary(): void {
    const list = (this.mode === 'sfu' ? [this.sfuSend] : [...this.peers.values()].map((p) => p.stats?.send ?? null)).filter(
      (s): s is SendStats => !!s,
    );
    const el = $('send-stats');
    el.hidden = list.length === 0;
    if (!list.length) return;
    const s = list[0];
    const video = list.reduce((sum, x) => sum + x.videoKbps, 0);
    const audio = list.reduce((sum, x) => sum + x.audioKbps, 0);
    const rate = (kbps: number) => (kbps >= 1000 ? `${(kbps / 1000).toLocaleString('pl-PL', { maximumFractionDigits: 1 })} Mb/s` : `${kbps} kb/s`);
    const parts: string[] = [];
    if (s.resolution) parts.push(`${s.resolution}${s.fps ? ` @ ${s.fps} kl/s` : ''}`);
    if (s.codec) parts.push(`${s.codec}${s.hardware === true ? ' (sprzętowo)' : s.hardware === false ? ' (programowo)' : ''}`);
    if (s.resolution) parts.push(`obraz ${rate(video)}`);
    if (s.audioChannels) parts.push(`dźwięk ${s.audioChannels === 2 ? 'stereo' : 'mono'} ${rate(audio)}`);
    el.textContent = `Wysyłasz: ${parts.join(' · ')}`;
  }

  private renderStats(): void {
    this.renderSendSummary();
    const box = $('peer-stats');
    if (this.peers.size === 0) {
      box.replaceChildren(h('p', { class: 'muted', text: 'Brak innych uczestników.' }));
      return;
    }
    const rows = [...this.peers.values()].map((p) => {
      const s = p.stats;
      return h(
        'tr',
        {},
        h('td', { text: p.state.name }),
        h('td', { text: s ? `${s.rttMs ?? '–'} ms` : '–' }),
        h('td', { text: s ? `${s.lossPct.toFixed(1)}%` : '–' }),
        h('td', { text: s ? `${s.inKbps} kb/s` : '–' }),
        h('td', { text: this.mode === 'sfu' ? 'SFU' : s ? (s.relayed ? 'TURN' : 'P2P') : '–' }),
      );
    });
    const head = h('tr', {}, ...['Uczestnik', 'RTT', 'Straty', 'Odbiór', 'Trasa'].map((t) => h('th', { text: t })));
    box.replaceChildren(h('table', {}, h('thead', {}, head), h('tbody', {}, ...rows)));
  }

  private updateClock(): void {
    const s = Math.floor((Date.now() - this.startedAt) / 1000);
    const hh = Math.floor(s / 3600);
    const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
    const ss = String(s % 60).padStart(2, '0');
    $('timer').textContent = hh ? `${hh}:${mm}:${ss}` : `${mm}:${ss}`;
  }

  async leave(): Promise<void> {
    if (this.leaving) return;
    this.leaving = true;
    if (this.recorder.active) await this.saveRecording();
    for (const p of this.peers.values()) p.sendApp({ t: 'bye' } satisfies AppMessage);
    this.sfu?.close();
    this.stage.close();
    this.signaling.send({ type: 'leave' });
    this.signaling.close();
    for (const id of [...this.peers.keys()]) this.removePeer(id);
    this.timers.forEach(clearInterval);
    this.cleanups.forEach((fn) => fn());
    this.speaking.destroy();
    this.media.stop();
    this.onLeave();
  }
}
