import type { TransformOptions, WorkerIn, WorkerOut } from './worker';
import { t } from '../i18n';

/** A participant's frame key, as sent to the others over the P2P DataChannel (never via the server). */
export interface KeyMessage {
  index: number;
  /** Raw AES-256 key, base64. */
  key: string;
}

/** After a rotation, how long we keep encrypting with the old key so the new one reaches everybody. */
const ROTATION_DELAY_MS = 1500;
/** How long a new sender may take to show its first frame in the worker (includes connecting to the SFU). */
const ACTIVE_TIMEOUT_MS = 8000;

const toBase64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const fromBase64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/**
 * End-to-end encryption of SFU media.
 *
 * Every participant encrypts its frames with its own random key and hands that key to each of the
 * others over the P2P DataChannels — DTLS-encrypted end to end and never touched by the server.
 * The SFU forwards frames it cannot read. When someone leaves, everybody switches to a new key,
 * so a former participant cannot follow the call any more. (P2P media needs none of this: WebRTC
 * encrypts it end to end by itself.)
 */
export class E2ee {
  static supported(): boolean {
    return typeof RTCRtpScriptTransform !== 'undefined' && typeof Worker !== 'undefined' && !!crypto?.subtle;
  }

  private readonly worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module', name: 'tutaj-e2ee' });
  private index = 0;
  private raw = new Uint8Array(0);
  private readonly peers = new Set<string>();
  private rotationTimer = 0;
  private nextId = 1;
  private readonly active = new Set<number>();
  private readonly waiting = new Map<number, () => void>();

  constructor(
    /** A participant's frames can't be decrypted (no key yet, or a wrong one). */
    private readonly onProblem: (peer: string, kind: 'missing-key' | 'decrypt-failed') => void,
  ) {
    this.worker.onmessage = (e: MessageEvent<WorkerOut>) => {
      const m = e.data;
      if (m.type === 'active') {
        this.active.add(m.id);
        this.waiting.get(m.id)?.();
      } else this.onProblem(m.peer, m.type);
    };
    this.newKey();
    this.post({ type: 'send-key', index: this.index, raw: this.raw });
  }

  /** Our current key, for a participant whose DataChannel just opened. */
  get localKey(): KeyMessage {
    return { index: this.index, key: toBase64(this.raw) };
  }

  /** Whether we hold a key for this participant. */
  hasKey(peer: string): boolean {
    return this.peers.has(peer);
  }

  setPeerKey(peer: string, msg: KeyMessage): void {
    const raw = fromBase64(msg.key);
    if (raw.length !== 32 || msg.index < 1 || msg.index > 255) return;
    this.peers.add(peer);
    this.post({ type: 'peer-key', peer, index: msg.index, raw });
  }

  forgetPeer(peer: string): void {
    this.peers.delete(peer);
    this.post({ type: 'forget-peer', peer });
  }

  /**
   * New key for our frames (someone left). Returns it at once, to be sent to the remaining
   * participants; frames switch to it shortly after, once it has reached them.
   */
  rotate(): KeyMessage {
    this.newKey();
    const next = { index: this.index, raw: this.raw };
    clearTimeout(this.rotationTimer);
    this.rotationTimer = window.setTimeout(() => this.post({ type: 'send-key', ...next }), ROTATION_DELAY_MS);
    return this.localKey;
  }

  /**
   * Attaches encryption. Must happen before the connection is negotiated (right after
   * addTransceiver): Chromium silently ignores a transform attached later and sends plaintext.
   * Returns an id for `whenActive`.
   */
  encrypt(sender: RTCRtpSender, kind: 'audio' | 'video', mime: string): number {
    return this.attach(sender, { op: 'encrypt', kind, mime });
  }

  /** Attaches decryption — likewise before negotiation completes (in the 'track' event). */
  decrypt(receiver: RTCRtpReceiver, kind: 'audio' | 'video', mime: string, peer: string): number {
    return this.attach(receiver, { op: 'decrypt', kind, mime, peer });
  }

  /**
   * Resolves once frames really pass through transform `id`; rejects if none did in time — then
   * the browser is not applying it and media must not be sent (it would leave unencrypted).
   */
  whenActive(id: number, timeoutMs = ACTIVE_TIMEOUT_MS): Promise<void> {
    if (this.active.has(id)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error(t('sfu.e2eeFailed')));
      }, timeoutMs);
      this.waiting.set(id, () => {
        clearTimeout(timer);
        this.waiting.delete(id);
        resolve();
      });
    });
  }

  close(): void {
    clearTimeout(this.rotationTimer);
    this.worker.terminate();
  }

  private attach(target: RTCRtpSender | RTCRtpReceiver, options: Omit<TransformOptions, 'id'>): number {
    const id = this.nextId++;
    target.transform = new RTCRtpScriptTransform(this.worker, { ...options, id } satisfies TransformOptions);
    return id;
  }

  private newKey(): void {
    this.raw = crypto.getRandomValues(new Uint8Array(32));
    // 1–255: the key index is the frame's last byte and must never be 0 (H.264 trailing zeros).
    this.index = (this.index % 255) + 1;
  }

  private post(msg: WorkerIn): void {
    this.worker.postMessage(msg);
  }
}

/** DTLS certificate fingerprint (sha-256) from a session description. */
function fingerprint(sdp: string | undefined): string | null {
  return sdp?.match(/^a=fingerprint:sha-256 (\S+)/im)?.[1].toUpperCase() ?? null;
}

/**
 * Safety code of a P2P connection: both sides compute it from the two DTLS fingerprints. Equal codes
 * mean nobody sits in between — so the keys sent over this connection reached the right person.
 */
export async function safetyCode(pc: RTCPeerConnection): Promise<string | null> {
  const a = fingerprint(pc.localDescription?.sdp);
  const b = fingerprint(pc.remoteDescription?.sdp);
  if (!a || !b) return null;
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode([a, b].sort().join('|'))));
  const n = ((digest[0] << 24) | (digest[1] << 16) | (digest[2] << 8) | digest[3]) >>> 0;
  const digits = String(n % 1_000_000).padStart(6, '0');
  return `${digits.slice(0, 3)} ${digits.slice(3)}`;
}
