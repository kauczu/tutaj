import type { IceServer, MediaMode, ModePreference, ModeReason, ModerationAction, QualityReport, RoomState, ServerMessage } from '@tutaj/shared';
import { SpeakingDetector, playCue } from './audio';
import { E2ee, safetyCode } from './e2ee';
import { locale, serverError, t, type Key } from './i18n';
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
import { acceleratorFromEvent, formatAccelerator, type HotkeyName } from './ui/hotkeys';
import { GameOverlay, type OverlaySettings } from './ui/overlay';
import { PipWindow } from './ui/pip';
import { settingsTabs } from './ui/settings-tabs';
import { CompactLayout } from './ui/compact';
import { videoDebug } from './ui/video-debug';
import { renderQualityForm } from './ui/quality-form';
import { REACTIONS, type Reaction } from './ui/reactions';
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

const modeLabel = (pref: ModePreference) => t(`mode.${pref}` as Key);
const reasonLabel = (reason: ModeReason) => t(`mode.reason.${reason}` as Key);

/** Test aid (E2E tests): drop the keys we receive — proves media can't be seen without them. */
function ignoreKeysForTests(): boolean {
  try {
    return localStorage.getItem('tutaj:e2ee-debug') === 'ignore-keys';
  } catch {
    return false;
  }
}

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
    const timer = setTimeout(() => reject(new JoinError(t('error.noResponse'), false)), 8000);
    const off = signaling.on('message', (msg) => {
      if (msg.type === 'welcome') {
        clearTimeout(timer);
        off();
        resolve(msg);
      } else if (msg.type === 'error') {
        clearTimeout(timer);
        off();
        reject(new JoinError(serverError(msg), ['bad-password', 'room-full', 'room-limit', 'room-locked', 'kicked'].includes(msg.code)));
      }
    });
    signaling.send({
      type: 'join',
      room: opts.roomId,
      name: opts.name,
      password: opts.password,
      resume,
      ownerKey: opts.ownerKey,
      e2ee: E2ee.supported(),
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
  /** Room moderation: who hosts, whether new people may join. */
  private hostId: string | null = null;
  private locked = false;
  private lastReactionSent = 0;
  private readonly lastReactionFrom = new Map<string, number>();
  private leaving = false;
  private readonly media: LocalMedia;
  private readonly grid = new Grid($('grid'));
  private readonly localTile: Tile;
  private readonly chat: ChatPanel;
  private readonly speaking: SpeakingDetector;
  private readonly recorder: CallRecorder;
  /** End-to-end encryption of SFU media (null: this browser can't — the room then stays on P2P). */
  private readonly e2ee: E2ee | null;
  /** Safety codes of the P2P connections (shown in the settings). */
  private readonly codes = new Map<string, string>();
  /** Desktop app only. */
  private overlay: GameOverlay | null = null;
  /** Phone layout: others full screen, our camera floating, auto-hiding controls. */
  private compact: CompactLayout | null = null;
  private cameras = 0;
  /** Browser only (the desktop app has the overlay): an always-on-top mini window. */
  private readonly pip: PipWindow | null;
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

    this.e2ee = E2ee.supported() ? new E2ee((peer, problem) => this.onE2eeProblem(peer, problem)) : null;

    this.pip = PipWindow.supported()
      ? new PipWindow(
          this.grid,
          {
            toggleMic: () => void this.toggleMic(),
            toggleCam: () => void this.toggleCam(),
            leave: () => void this.leave(),
            micOn: () => !!this.media.audioTrack && this.media.audioEnabled,
            camOn: () => this.media.cameraOn,
          },
          () => this.updateControls(),
        )
      : null;
    this.registerAutoPip();

    this.cleanups.push(this.media.on('change', () => this.onLocalMediaChange()));
    void this.initOverlay();
    this.bindControls();
    this.timers.push(window.setInterval(() => void this.pollStats(), 2000));
    this.timers.push(window.setInterval(() => this.updateClock(), 1000));

    $('room-name').textContent = opts.roomId;
    $('lobby').hidden = true;
    $('room-view').hidden = false;
    document.documentElement.classList.add('in-room');
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
      if (!resumed || !this.present.has(id)) this.peerGone(id);
    }
    for (const p of welcome.peers) {
      if (!this.peers.get(p.id)?.healthy) this.addPeer(p.id, p.name, true);
    }
    this.relayState();
    this.setRoomState(welcome.roomState, false);
    void this.applyMode(welcome.mode);
    if (firstJoin && welcome.privileged) toast(t('room.ownerKey'));
    if (welcome.peers.length === 0 && firstJoin) {
      this.chat.addSystem(t('room.firstHere'));
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
          this.chat.addSystem(t('room.joins', { name: msg.peer.name }));
          toast(t('room.joinsCall', { name: msg.peer.name }));
        }
        break;
      }
      case 'peer-left': {
        this.present.delete(msg.id);
        const peer = this.peers.get(msg.id);
        // Only its server connection dropped: keep talking P2P; it will resume or time out.
        if (!peer || (msg.reason === 'disconnect' && peer.healthy)) break;
        // Kicked: drop the P2P link too (they could otherwise keep it up), with a new key for the rest.
        this.peerGone(msg.id);
        this.chat.addSystem(t(msg.reason === 'kicked' ? 'room.removed' : 'room.leaves', { name: peer.state.name }));
        break;
      }
      case 'room-state':
        this.setRoomState(msg, true);
        break;
      case 'moderated':
        this.onModerated(msg.action, msg.by);
        break;
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
        this.onAppMessage(msg.from, msg.payload, true);
        break;
      case 'mode': {
        this.pref = msg.pref;
        if (msg.by) this.chat.addSystem(t('mode.setBy', { name: msg.by, mode: modeLabel(msg.pref) }));
        if (msg.mode !== this.mode) {
          this.chat.addSystem(t(msg.mode === 'sfu' ? 'mode.toSfu' : 'mode.toMesh', { reason: reasonLabel(msg.reason) }));
        }
        void this.applyMode(msg.mode);
        break;
      }
      case 'sfu-notify':
        this.sfu?.onNotify(msg);
        break;
      case 'error':
        if (msg.code !== 'unknown-peer') toast(serverError(msg), 'error');
        break;
    }
  }

  // --- Moderation -------------------------------------------------------------

  get isHost(): boolean {
    return this.hostId !== null && this.hostId === this.selfId;
  }

  private setRoomState(state: RoomState, announce: boolean): void {
    const hostChanged = state.host !== this.hostId;
    const lockChanged = state.locked !== this.locked;
    this.hostId = state.host;
    this.locked = state.locked;
    if (announce && hostChanged) {
      const name = this.isHost ? t('room.you') : this.peers.get(state.host ?? '')?.state.name;
      if (name) this.chat.addSystem(this.isHost ? t('mod.youHostNow') : t('mod.hostNow', { name }));
      if (this.isHost) toast(t('mod.youHostNowToast'));
    }
    if (announce && lockChanged) this.chat.addSystem(t(state.locked ? 'mod.locked' : 'mod.unlocked'));
    for (const tile of this.grid.all()) tile.setHost(tile.local ? this.isHost : tile.id === this.hostId);
    $('locked-badge').hidden = !state.locked;
    this.updateTileMenus();
    if ($<HTMLDialogElement>('settings').open) this.renderHostSettings();
  }

  /** Something the host did to us. */
  private onModerated(action: 'mute' | 'kick', by: string): void {
    if (action === 'mute') {
      if (this.media.audioEnabled) {
        this.media.setAudioEnabled(false);
        this.broadcastState();
      }
      toast(t('mod.mutedYou', { name: by }));
      return;
    }
    try {
      sessionStorage.setItem('tutaj:notice', t('mod.kickedYou', { name: by, room: this.opts.roomId }));
    } catch {
      /* no storage */
    }
    void this.leave();
  }

  private moderate(action: ModerationAction, target?: string): void {
    this.signaling.send({ type: 'moderate', action, target });
  }

  /** Host: a ⋮ menu on every other participant's tile. */
  private updateTileMenus(): void {
    for (const tile of this.grid.all()) {
      let btn = tile.el.querySelector<HTMLButtonElement>('.tile-menu-btn');
      const want = this.isHost && !tile.local;
      if (!want) {
        btn?.remove();
        continue;
      }
      if (btn) continue;
      btn = h('button', { class: 'tile-menu-btn', title: t('mod.menu'), text: '⋮' });
      btn.type = 'button';
      btn.onclick = (e) => {
        e.stopPropagation(); // not the tile's click (pin)
        this.openTileMenu(tile.id, btn!);
      };
      tile.el.append(btn);
    }
  }

  private openTileMenu(peerId: string, anchor: HTMLElement): void {
    const menu = $('tile-menu');
    const name = this.peers.get(peerId)?.state.name ?? '';
    const item = (text: string, fn: () => void, danger = false) => {
      const b = h('button', { text, class: danger ? 'danger' : '' });
      b.type = 'button';
      b.setAttribute('role', 'menuitem');
      b.onclick = () => {
        menu.hidden = true;
        fn();
      };
      return b;
    };
    menu.replaceChildren(
      h('div', { class: 'tile-menu-title', text: name }),
      item(t('mod.mute'), () => this.moderate('mute', peerId)),
      item(t('mod.makeHost'), () => this.moderate('make-host', peerId)),
      item(
        t('mod.kick'),
        () => {
          if (confirm(t('mod.kickConfirm', { name }))) this.moderate('kick', peerId);
        },
        true,
      ),
    );
    menu.hidden = false;
    const r = anchor.getBoundingClientRect();
    menu.style.top = `${Math.min(window.innerHeight - menu.offsetHeight - 8, r.bottom + 4)}px`;
    menu.style.left = `${Math.max(8, Math.min(window.innerWidth - menu.offsetWidth - 8, r.right - menu.offsetWidth))}px`;
  }

  /** Settings dialog: lock / mute all for the host, who hosts for everyone else. */
  private renderHostSettings(): void {
    const box = $('host-settings');
    const hostName = this.isHost ? t('room.you') : this.peers.get(this.hostId ?? '')?.state.name ?? '–';
    if (!this.isHost) {
      box.replaceChildren(h('p', { class: 'muted small', text: t('mod.hostIs', { name: hostName }) + (this.locked ? t('mod.lockedSuffix') : '') }));
      return;
    }
    const lock = h('input');
    lock.type = 'checkbox';
    lock.id = 'host-lock';
    lock.checked = this.locked;
    lock.onchange = () => this.moderate(lock.checked ? 'lock' : 'unlock');
    const muteAll = h('button', { class: 'ghost', text: t('mod.muteAll') });
    muteAll.type = 'button';
    muteAll.id = 'host-mute-all';
    muteAll.onclick = () => {
      this.moderate('mute-all');
      toast(t('mod.mutedAll'));
    };
    box.replaceChildren(
      h('legend', { text: t('mod.youAreHost') }),
      h('label', { class: 'check' }, lock, t('mod.lock')),
      muteAll,
      h('p', { class: 'muted small', text: t('mod.tileHint') }),
    );
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
    setBanner(t('room.reconnecting'));

    for (let attempt = 0; attempt < MAX_RECONNECTS && !this.leaving; attempt++) {
      await new Promise((r) => setTimeout(r, Math.min(1000 * 2 ** attempt, 10_000)));
      if (this.leaving) return;
      try {
        const { signaling, welcome } = await connectAndJoin(this.opts, { id: this.selfId, token: this.resumeToken });
        if (this.leaving) return signaling.close();
        banner.hidden = true;
        this.attach(signaling, welcome);
        toast(t('room.reconnected'));
        return;
      } catch (err) {
        if (err instanceof JoinError && err.fatal) return setBanner(err.message);
      }
    }
    setBanner(t('room.reconnectFailed'));
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
        if (!this.chat.open) toast(t('room.sendsFile', { name: peer.state.name, file: f.name }));
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
      appMessage: (raw) => this.onAppMessage(id, raw, false),
      appChannelOpen: () => {
        peer.sendApp({ t: 'state', state: this.myState() } satisfies AppMessage);
        this.sendKey(peer);
      },
      fileMessage: (e) => receiver.handle(e),
      connectionState: (s) => {
        if (s === 'connected') {
          clearTimeout(this.peerTimers.get(id));
          this.connectedAt.set(id, Date.now());
          tile.setStatus(null);
        } else if (s === 'disconnected') {
          tile.setStatus(t('room.connProblem'));
        } else if (s === 'failed') {
          this.connectedAt.delete(id);
          tile.setStatus(t('room.connRetry'));
          receiver.abort();
          watchdog(PEER_GONE_MS, () => {
            if (this.peers.get(id) !== peer || peer.healthy) return;
            if (this.online && this.present.has(id)) {
              tile.setStatus(t('room.p2pFailed'));
            } else {
              this.peerGone(id);
              this.chat.addSystem(t('room.lostConnection', { name: peer.state.name }));
            }
          });
        }
      },
    }, this.meshMedia, this.h264);

    tile.setStatus(t('room.connecting'));
    watchdog(CONNECT_TIMEOUT_MS, () => {
      if (!peer.healthy) tile.setStatus(t('room.p2pFailed'));
    });

    this.peers.set(id, peer);
    this.receivers.set(id, receiver);
    this.grid.add(tile);
    tile.setHost(id === this.hostId);
    this.updateTileMenus();
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

  /** `viaServer`: relayed by the signaling server (DataChannel not open yet) — never trusted with keys. */
  private onAppMessage(from: string, raw: unknown, viaServer: boolean): void {
    const peer = this.peers.get(from);
    const msg = parseAppMessage(raw);
    if (!peer || !msg) return;
    if (msg.t === 'e2ee-key' || msg.t === 'e2ee-key-request') {
      if (viaServer || !this.e2ee || ignoreKeysForTests()) return;
      if (msg.t === 'e2ee-key-request') return this.sendKey(peer);
      this.e2ee.setPeerKey(from, msg);
      this.grid.get(from)?.setStatus(null);
      this.sfu?.requestKeyFrames(from);
      return;
    }
    if (msg.t === 'bye') {
      this.peerGone(from);
      this.chat.addSystem(t('room.leaves', { name: peer.state.name }));
    } else if (msg.t === 'state') {
      if (msg.state.hand && !peer.state.hand) toast(t('room.handUp', { name: msg.state.name }));
      peer.state = msg.state;
      this.grid.get(from)?.setState(msg.state);
    } else if (msg.t === 'chat') {
      this.chat.addMessage(peer.state.name, msg.text, msg.ts, false);
    } else if (msg.t === 'reaction') {
      // No floods: at most ~4 per second per participant.
      const now = Date.now();
      if (now - (this.lastReactionFrom.get(from) ?? 0) < 250) return;
      this.lastReactionFrom.set(from, now);
      this.grid.get(from)?.react(msg.e);
    }
  }

  // --- End-to-end encryption (SFU) ----------------------------------------------

  /** Our frame key to one participant — over the DataChannel only, never through the server. */
  private sendKey(peer: RemotePeer): void {
    if (this.e2ee) peer.sendApp({ t: 'e2ee-key', ...this.e2ee.localKey } satisfies AppMessage);
  }

  /** A participant really left (not just a refreshed connection): forget them and change our key. */
  private peerGone(id: string): void {
    this.removePeer(id);
    this.codes.delete(id);
    if (!this.e2ee) return;
    this.e2ee.forgetPeer(id);
    const key = this.e2ee.rotate();
    for (const p of this.peers.values()) p.sendApp({ t: 'e2ee-key', ...key } satisfies AppMessage);
  }

  private onE2eeProblem(peerId: string, problem: 'missing-key' | 'decrypt-failed'): void {
    const peer = this.peers.get(peerId);
    if (!peer || this.mode !== 'sfu') return;
    if (problem === 'missing-key' && !this.e2ee?.hasKey(peerId)) this.grid.get(peerId)?.setStatus(t('room.waitingKey'));
    // Lost a key (e.g. sent while our channel was reconnecting): ask for the current one.
    peer.sendApp({ t: 'e2ee-key-request' } satisfies AppMessage);
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
        toast(t('mode.sfuLoadFailed'), 'error');
        return;
      }
      if (this.mode !== 'sfu' || this.sfu || this.leaving) return; // superseded while loading
      // The server never picks the SFU for a room with a client that can't encrypt — defensive anyway.
      if (!this.e2ee) return void this.onSfuUnavailable();
      const session = new SfuSession((m, d) => this.signaling.request(m, d), this.media, this.iceServers, this.e2ee, this.h264);
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

  private onSfuUnavailable(): void {
    this.mode = 'mesh';
    this.updateModeBadge();
    if (this.online) this.signaling.send({ type: 'set-mode', pref: 'mesh' });
  }

  private onSfuFailure(session: SfuSession, err: Error): void {
    if (this.sfu !== session) return;
    console.error(err);
    toast(t('mode.backToP2p', { error: err.message }), 'error');
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
    badge.title =
      this.mode === 'sfu'
        ? t('mode.sfuTitle')
        : t('mode.meshTitle');
    // In P2P WebRTC encrypts end to end by itself; in SFU mode our frame encryption does.
    const lock = $('e2ee-badge');
    lock.hidden = false;
    lock.title = badge.title;
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
    this.grid.refitSoon();
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
    if (this.peers.size === 0) return toast(t('room.nobody'), 'error');
    for (const file of files) {
      if (file.size > MAX_FILE_SIZE) {
        toast(t('room.fileTooBig', { file: file.name, max: formatBytes(MAX_FILE_SIZE) }), 'error');
        continue;
      }
      for (const peer of this.peers.values()) {
        const handle = this.chat.addTransfer(t('room.youTo', { name: peer.state.name }), file.name, file.size, true);
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
    on('btn-react', () => this.toggleReactionPicker());
    on('btn-pip', () => void this.pip?.toggle());
    this.buildReactionPicker();
    on('btn-chat', () => this.chat.toggle());
    on('btn-record', () => void this.toggleRecording());
    on('btn-overlay', () => void this.setOverlay(!this.overlay?.isOpen));
    on('btn-settings', () => void this.openSettings());
    on('btn-leave', () => void this.leave());
    on('btn-invite', () => void this.copyInvite());
    const closeDebug = videoDebug(this.grid);
    if (closeDebug) this.cleanups.push(closeDebug);
    this.compact = new CompactLayout(this.grid, () => this.phoneItems());
    this.cleanups.push(this.grid.onChange(() => this.compact?.refresh()));
    this.cleanups.push(() => this.compact?.close());
    void LocalMedia.devices('videoinput').then((cams) => (this.cameras = cams.length));

    if (!navigator.mediaDevices?.getDisplayMedia) $('btn-screen').hidden = true;
    if (!CallRecorder.supported()) $('btn-record').hidden = true;

    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.ctrlKey || e.metaKey || e.altKey || t.closest('input, textarea, select, dialog')) return;
      // Reaction picker open: 1–6 pick, Esc closes.
      if (!$('reaction-picker').hidden) {
        const n = Number(e.key);
        if (n >= 1 && n <= REACTIONS.length) {
          e.preventDefault();
          this.sendReaction(REACTIONS[n - 1]);
          return this.toggleReactionPicker(false);
        }
        if (e.key === 'Escape') return this.toggleReactionPicker(false);
      }
      const actions: Record<string, () => void> = {
        r: () => this.toggleReactionPicker(),
        p: () => void this.pip?.toggle(),
        m: () => void this.toggleMic(),
        v: () => void this.toggleCam(),
        s: () => void this.toggleScreen(),
        h: () => this.toggleHand(),
        c: () => this.chat.toggle(),
      };
      const action = actions[e.key.toLowerCase()];
      if (action) {
        e.preventDefault();
        action();
      }
    };
    document.addEventListener('keydown', onKey);
    this.cleanups.push(() => document.removeEventListener('keydown', onKey));

    // iOS re-creates video layers when the audio route changes (headphones, Bluetooth) or the tab returns.
    const refit = () => this.grid.refitSoon();
    navigator.mediaDevices?.addEventListener?.('devicechange', refit);
    document.addEventListener('visibilitychange', refit);
    this.cleanups.push(() => {
      navigator.mediaDevices?.removeEventListener?.('devicechange', refit);
      document.removeEventListener('visibilitychange', refit);
    });

    const onHide = () => this.signaling.send({ type: 'leave' });
    window.addEventListener('pagehide', onHide);
    this.cleanups.push(() => window.removeEventListener('pagehide', onHide));
  }

  /** "More" menu extras on a phone: front/back camera. */
  private phoneItems(): { label: string; run: () => void }[] {
    if (!this.media.cameraOn || this.cameras < 2) return [];
    return [{ label: t('ctl.flip'), run: () => void this.flipCamera() }];
  }

  private async flipCamera(): Promise<void> {
    try {
      await this.media.flipCamera();
    } catch (e) {
      toast(t('media.cameraProblem', { error: describeMediaError(e) }), 'error');
    }
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
    setIcon($('btn-more'), 'more');
    if (this.localTile.mirrorSelf !== (this.media.facing !== 'environment')) {
      this.localTile.mirrorSelf = this.media.facing !== 'environment';
      this.localTile.setState(this.myState());
    }
    setIcon($('btn-react'), 'react');
    setIcon($('btn-pip'), 'pip');
    $('btn-pip').hidden = !this.pip;
    $('btn-pip').classList.toggle('active', !!this.pip?.isOpen);
    $('btn-pip').setAttribute('aria-pressed', String(!!this.pip?.isOpen));
    this.pip?.refreshControls();
    setIcon($('btn-overlay'), 'overlay');
    $('btn-overlay').classList.toggle('active', !!this.overlay?.isOpen);
    $('btn-overlay').setAttribute('aria-pressed', String(!!this.overlay?.isOpen));
    setIcon($('btn-leave'), 'leave');
  }

  // --- Game overlay (desktop app) ------------------------------------------------

  /** Global shortcuts (also while a game has focus) and the overlay window, if the app supports them. */
  private async initOverlay(): Promise<void> {
    const bridge = window.tutaj;
    if (!bridge?.overlay || !bridge.setInCall || !bridge.onHotkey) return;
    const settings = await bridge.overlay.get().catch(() => null);
    if (!settings || this.leaving) return;
    this.overlay = new GameOverlay(this.grid, settings, (w, h) => void bridge.overlay!.resize(w, h));
    this.setOverlayButton(settings.hotkeys);
    await bridge.setInCall(true);
    const off = bridge.onHotkey((name) => {
      if (name === 'overlay') void this.setOverlay(!this.overlay?.isOpen);
      else if (name === 'mute') void this.toggleMic().then(() => playCue(this.media.audioEnabled && !!this.media.audioTrack));
    });
    this.cleanups.push(off, () => {
      this.overlay?.close();
      void bridge.setInCall!(false);
    });
    if (settings.enabled) this.overlay.open();
    this.updateControls();
  }

  private setOverlayButton(hotkeys?: Record<string, string>): void {
    const btn = $('btn-overlay');
    btn.hidden = !this.overlay;
    btn.title = t('ctl.overlay') + (hotkeys?.overlay ? ` (${formatAccelerator(hotkeys.overlay)})` : '');
  }

  private async setOverlay(on: boolean): Promise<void> {
    const bridge = window.tutaj;
    if (!this.overlay || !bridge?.overlay) return;
    if (on) this.overlay.open();
    else this.overlay.close();
    this.updateControls();
    await bridge.overlay.set({ enabled: on });
    if ($<HTMLDialogElement>('settings').open) void this.renderOverlaySettings();
  }

  private async renderOverlaySettings(): Promise<void> {
    const box = $('overlay-settings');
    const bridge = window.tutaj;
    const current = await bridge?.overlay?.get().catch(() => null);
    box.hidden = !this.overlay || !current;
    settingsTabs.setAvailable('overlay', !box.hidden);
    if (!this.overlay || !current || !bridge?.overlay) return;
    const select = (id: string, value: string, options: [string, string][], onChange: (v: string) => void) => {
      const el = h('select');
      el.id = id;
      for (const [v, text] of options) {
        const o = h('option', { text });
        o.value = v;
        o.selected = v === value;
        el.append(o);
      }
      el.onchange = () => onChange(el.value);
      return el;
    };
    const apply = async (patch: Partial<OverlaySettings>) => {
      const next = await bridge.overlay!.set(patch);
      this.overlay?.update(next);
    };
    const show = h('input');
    show.type = 'checkbox';
    show.id = 'overlay-enabled';
    show.checked = this.overlay.isOpen;
    show.onchange = () => void this.setOverlay(show.checked);
    const minimize = h('input');
    minimize.type = 'checkbox';
    minimize.id = 'overlay-minimize';
    minimize.checked = current.minimizeCall;
    minimize.onchange = () => void apply({ minimizeCall: minimize.checked });
    const displays = current.displays.map((d, i): [string, string] => [
      String(d.id),
      t('ov.screen', { n: i + 1, label: d.label || 'monitor', size: `${d.width}×${d.height}` }) + (d.primary ? t('ov.screenPrimary') : ''),
    ]);
    const label = (text: string, control: HTMLElement) => h('label', {}, text, control);
    box.replaceChildren(
      h('label', { class: 'check' }, show, t('ov.show')),
      h('label', { class: 'check' }, minimize, t('ov.minimize')),
      ...(displays.length > 1
        ? [label(t('ov.monitor'), select('overlay-display', String(current.display ?? ''), [['', t('ov.primary')], ...displays], (v) => void apply({ display: v ? Number(v) : null })))]
        : []),
      label(
        t('ov.position'),
        select('overlay-corner', current.corner, [
          ['top-left', t('ov.topLeft')],
          ['top-right', t('ov.topRight')],
          ['bottom-left', t('ov.bottomLeft')],
          ['bottom-right', t('ov.bottomRight')],
        ], (v) => void apply({ corner: v as OverlaySettings['corner'] })),
      ),
      label(t('ov.size'), select('overlay-size', current.size, [['s', t('ov.small')], ['m', t('ov.medium')], ['l', t('ov.large')]], (v) => void apply({ size: v as OverlaySettings['size'] }))),
      label(
        t('ov.opacity'),
        select('overlay-opacity', String(current.opacity), [['1', '100%'], ['0.85', '85%'], ['0.7', '70%'], ['0.5', '50%']], (v) => void apply({ opacity: Number(v) })),
      ),
      ...(bridge.setHotkey ? [this.hotkeyEditor(current.hotkeys)] : []),
      h('p', {
        class: 'muted small',
        text: t('ov.hint'),
      }),
    );
  }

  /** Global shortcuts: click a shortcut, press the new combination (Esc cancels). */
  private hotkeyEditor(initial: Record<HotkeyName, string>): HTMLElement {
    const bridge = window.tutaj!;
    let hotkeys = initial;
    const error = h('p', { class: 'error small' });
    error.hidden = true;
    const labels: [HotkeyName, string][] = [
      ['overlay', t('hk.overlay')],
      ['mute', t('hk.mute')],
      ['window', t('hk.window')],
    ];
    const buttons = new Map<HotkeyName, HTMLButtonElement>();
    let stopRecording: (() => void) | null = null;
    const showAll = () => {
      for (const [name, b] of buttons) b.textContent = formatAccelerator(hotkeys[name]);
    };
    const save = async (name: HotkeyName, accelerator: string | null) => {
      const res = await bridge.setHotkey!(name, accelerator);
      if (res.ok && res.hotkeys) {
        hotkeys = res.hotkeys;
        this.setOverlayButton(hotkeys);
      }
      error.textContent = res.ok ? '' : `${accelerator ? formatAccelerator(accelerator) : ''}: ${res.error ?? t('hk.saveFailed')}`;
      error.hidden = res.ok;
      showAll();
    };
    const record = (name: HotkeyName, button: HTMLButtonElement) => {
      stopRecording?.();
      error.hidden = true;
      button.textContent = t('hk.press');
      button.classList.add('recording');
      void bridge.pauseHotkeys?.(true);
      const onKey = (e: KeyboardEvent) => {
        e.preventDefault();
        e.stopPropagation(); // Esc must not close the settings dialog
        if (e.key === 'Escape') return stop();
        const r = acceleratorFromEvent(e);
        if (!r) return;
        if ('error' in r) {
          error.textContent = r.error;
          error.hidden = false;
          return;
        }
        stop();
        void save(name, r.accelerator);
      };
      const stop = () => {
        document.removeEventListener('keydown', onKey, true);
        button.removeEventListener('blur', stop);
        button.classList.remove('recording');
        stopRecording = null;
        void bridge.pauseHotkeys?.(false);
        showAll();
      };
      document.addEventListener('keydown', onKey, true);
      button.addEventListener('blur', stop);
      stopRecording = stop;
    };
    const rows = labels.map(([name, text]) => {
      const b = h('button', { class: 'ghost hotkey' });
      b.type = 'button';
      b.id = `hotkey-${name}`;
      b.title = t('hk.clickToChange');
      b.onclick = () => record(name, b);
      buttons.set(name, b);
      return h('div', { class: 'hotkey-row' }, h('span', { text }), b);
    });
    const reset = h('button', { class: 'ghost small', text: t('hk.reset') });
    reset.type = 'button';
    reset.onclick = async () => {
      stopRecording?.();
      for (const [name] of labels) await save(name, null);
    };
    showAll();
    return h('div', { class: 'hotkeys' }, h('span', { class: 'hotkeys-title', text: t('hk.title') }), ...rows, error, reset);
  }

  private async toggleMic(): Promise<void> {
    if (!this.media.audioTrack) {
      try {
        await this.media.setMicrophone(this.media.audioDeviceId);
        this.media.setAudioEnabled(true);
      } catch (e) {
        toast(t('media.micProblem', { error: describeMediaError(e) }), 'error');
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
      toast(t('media.cameraProblem', { error: describeMediaError(e) }), 'error');
    }
  }

  private async toggleScreen(): Promise<void> {
    if (this.media.sharingScreen) return this.media.stopScreen();
    try {
      await this.media.startScreen();
    } catch (e) {
      if (!(e instanceof DOMException && e.name === 'NotAllowedError')) toast(t('media.screenProblem', { error: describeMediaError(e) }), 'error');
    }
  }

  // --- Picture-in-picture (browser) ----------------------------------------------

  /** Chrome/Edge open the mini window by themselves when you switch to another tab mid-call. */
  private registerAutoPip(): void {
    if (!this.pip || !('mediaSession' in navigator)) return;
    try {
      navigator.mediaSession.setActionHandler('enterpictureinpicture' as MediaSessionAction, () => void this.pip?.open());
      this.cleanups.push(() => {
        try {
          navigator.mediaSession.setActionHandler('enterpictureinpicture' as MediaSessionAction, null);
        } catch {
          /* ignore */
        }
      });
    } catch {
      /* not supported: the button and P still work */
    }
  }

  // --- Reactions ------------------------------------------------------------

  private buildReactionPicker(): void {
    const picker = $('reaction-picker');
    picker.replaceChildren(
      ...REACTIONS.map((emoji, i) => {
        const b = h('button', { title: t('ctl.reaction', { emoji, n: i + 1 }) }, emoji, h('kbd', { text: String(i + 1) }));
        b.type = 'button';
        b.setAttribute('role', 'menuitem');
        b.onclick = () => {
          this.sendReaction(emoji);
          this.toggleReactionPicker(false);
        };
        return b;
      }),
    );
    const outside = (e: PointerEvent) => {
      const target = e.target as Node;
      if (!picker.hidden && !picker.contains(target) && !$('btn-react').contains(target)) this.toggleReactionPicker(false);
      const menu = $('tile-menu');
      if (!menu.hidden && !menu.contains(target) && !(target as HTMLElement).closest?.('.tile-menu-btn')) menu.hidden = true;
    };
    document.addEventListener('pointerdown', outside);
    this.cleanups.push(() => document.removeEventListener('pointerdown', outside));
  }

  /** Opens the picker above its button (or closes it). */
  private toggleReactionPicker(open?: boolean): void {
    const picker = $('reaction-picker');
    const btn = $('btn-react');
    const show = open ?? picker.hidden !== false;
    picker.hidden = !show;
    btn.setAttribute('aria-expanded', String(show));
    btn.classList.toggle('active', show);
    if (!show) return;
    const r = btn.getBoundingClientRect();
    const w = picker.offsetWidth;
    picker.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, r.left + r.width / 2 - w / 2))}px`;
    picker.style.bottom = `${window.innerHeight - r.top + 10}px`;
  }

  private sendReaction(emoji: Reaction): void {
    const now = Date.now();
    if (now - this.lastReactionSent < 300) return;
    this.lastReactionSent = now;
    this.localTile.react(emoji);
    this.sendApp({ t: 'reaction', e: emoji });
  }

  private toggleHand(): void {
    this.hand = !this.hand;
    this.broadcastState();
  }

  private async toggleRecording(): Promise<void> {
    if (!this.recorder.active) {
      try {
        this.recorder.start();
        toast(t('room.recording'));
        this.sendApp({ t: 'chat', id: crypto.randomUUID(), text: t('room.recordingChat'), ts: Date.now() });
      } catch (e) {
        toast(t('media.recordProblem', { error: describeMediaError(e) }), 'error');
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
      toast(t('room.linkCopied'));
    } catch {
      window.prompt(t('room.copyLink'), link);
    }
  }

  private async openSettings(): Promise<void> {
    const dialog = $<HTMLDialogElement>('settings');
    const audioIn = $<HTMLSelectElement>('set-audio-input');
    const videoIn = $<HTMLSelectElement>('set-video-input');
    const audioOut = $<HTMLSelectElement>('set-audio-output');
    fillDeviceSelect(audioIn, await LocalMedia.devices('audioinput'), this.media.audioDeviceId, t('set.mic'));
    fillDeviceSelect(videoIn, await LocalMedia.devices('videoinput'), this.media.videoDeviceId, t('set.camera'));
    const sinkSupported = 'setSinkId' in HTMLMediaElement.prototype;
    $('set-audio-output-wrap').hidden = !sinkSupported;
    if (sinkSupported) fillDeviceSelect(audioOut, await LocalMedia.devices('audiooutput'), undefined, t('set.speaker'));

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
      ? t('mode.info', { mode: this.mode === 'sfu' ? 'SFU' : 'P2P' })
      : t('mode.noSfu');
    modeSelect.onchange = () => this.signaling.send({ type: 'set-mode', pref: modeSelect.value as ModePreference });
    this.renderHostSettings();
    renderQualityForm($('quality-room'), this.media, (msg) => toast(msg, 'error'));
    await this.renderOverlaySettings(); // decides whether the overlay topic is there at all
    this.renderStats();
    settingsTabs.select();
    dialog.showModal();
  }

  private async pollStats(): Promise<void> {
    await Promise.all(
      [...this.peers.values()].map(async (p) => {
        const stats = await p.sampleStats().catch(() => null);
        this.grid.get(p.id)?.setStats(stats);
      }),
    );
    for (const p of this.peers.values()) {
      if (!p.healthy) continue;
      const code = await safetyCode(p.pc).catch(() => null);
      if (code) this.codes.set(p.id, code);
    }
    const report = await this.sfu?.sendStats().catch(() => null);
    this.sfuSend = report ? this.sfuMeter.sample(report) : null;
    this.updateEncoderBadge();
    this.sendQualityReport();
    if ($<HTMLDialogElement>('settings').open) this.renderStats();
  }

  /** GPU/CPU next to P2P/SFU: which encoder our camera video actually uses right now. */
  private updateEncoderBadge(): void {
    const send =
      this.mode === 'sfu' ? this.sfuSend : [...this.peers.values()].map((p) => p.stats?.send).find((s) => s?.hardware != null && s.resolution);
    const badge = $('encoder-badge');
    const known = !!send?.resolution && send.hardware != null;
    badge.hidden = !known;
    if (!known) return;
    badge.textContent = send!.hardware ? 'GPU' : 'CPU';
    badge.className = `mode-badge ${send!.hardware ? 'gpu' : 'cpu'}`;
    badge.title = send!.hardware
      ? t('enc.gpu', { codec: send!.codec ?? t('enc.video') })
      : t('enc.cpu', { codec: send!.codec ?? t('enc.video') });
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
    const rate = (kbps: number) => (kbps >= 1000 ? `${(kbps / 1000).toLocaleString(locale, { maximumFractionDigits: 1 })} Mb/s` : `${kbps} kb/s`);
    const parts: string[] = [];
    if (s.resolution) parts.push(`${s.resolution}${s.fps ? ` @ ${s.fps} kl/s` : ''}`);
    if (s.codec) parts.push(`${s.codec}${s.hardware === true ? t('set.hw') : s.hardware === false ? t('set.sw') : ''}`);
    if (s.resolution) parts.push(t('set.video', { rate: rate(video) }));
    if (s.audioChannels) parts.push(t('set.audio', { channels: s.audioChannels === 2 ? 'stereo' : 'mono', rate: rate(audio) }));
    el.textContent = t('set.sending', { parts: parts.join(' · ') });
  }

  private renderStats(): void {
    this.renderSendSummary();
    const box = $('peer-stats');
    if (this.peers.size === 0) {
      box.replaceChildren(h('p', { class: 'muted', text: t('set.noOthers') }));
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
        h('td', { class: 'code', text: this.codes.get(p.id) ?? '–' }),
      );
    });
    const head = h('tr', {}, ...[t('set.col.name'), 'RTT', t('set.col.loss'), t('set.col.in'), t('set.col.route'), t('set.col.code')].map((c) => h('th', { text: c })));
    box.replaceChildren(
      h('table', {}, h('thead', {}, head), h('tbody', {}, ...rows)),
      h('p', {
        class: 'muted small',
        text: t('set.codeHint'),
      }),
    );
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
    this.pip?.close();
    this.signaling.send({ type: 'leave' });
    this.signaling.close();
    for (const id of [...this.peers.keys()]) this.removePeer(id);
    this.timers.forEach(clearInterval);
    this.cleanups.forEach((fn) => fn());
    this.speaking.destroy();
    this.e2ee?.close();
    this.media.stop();
    this.onLeave();
  }
}
