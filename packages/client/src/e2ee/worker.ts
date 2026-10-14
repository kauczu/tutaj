/// <reference lib="webworker" />
// Frame encryption worker: one per page, shared by all SFU senders and receivers (RTCRtpScriptTransform).
import { codecFromMime, decryptFrame, encryptFrame, frameKeyIndex, importFrameKey, type FrameCodec } from './frame';

export type WorkerIn =
  /** Our own key for outgoing frames. */
  | { type: 'send-key'; index: number; raw: Uint8Array }
  /** A participant's key for their frames (several indexes are kept during a rotation). */
  | { type: 'peer-key'; peer: string; index: number; raw: Uint8Array }
  | { type: 'forget-peer'; peer: string };

export type WorkerOut =
  | { type: 'missing-key'; peer: string }
  | { type: 'decrypt-failed'; peer: string }
  /** The first frame went through transform `id`: it is really in the media path. */
  | { type: 'active'; id: number };

export interface TransformOptions {
  /** Reported back with 'active'. */
  id: number;
  op: 'encrypt' | 'decrypt';
  kind: 'audio' | 'video';
  /** MIME type of the negotiated codec (frame metadata may tell more precisely). */
  mime: string;
  /** Receivers: whose frames these are. */
  peer?: string;
}

type EncodedFrame = RTCEncodedVideoFrame | RTCEncodedAudioFrame;

const scope = self as unknown as DedicatedWorkerGlobalScope;

interface Transformer {
  readable: ReadableStream<EncodedFrame>;
  writable: WritableStream<EncodedFrame>;
  options: TransformOptions;
}

let sendKey: { index: number; key: CryptoKey } | null = null;
const peerKeys = new Map<string, Map<number, CryptoKey>>();
/** Throttles notifications to the page (one per peer per second). */
const lastNotice = new Map<string, number>();

const notify = (msg: Extract<WorkerOut, { peer: string }>) => {
  const k = `${msg.type}:${msg.peer}`;
  const now = Date.now();
  if (now - (lastNotice.get(k) ?? 0) < 1000) return;
  lastNotice.set(k, now);
  scope.postMessage(msg);
};

scope.onmessage = async (e: MessageEvent<WorkerIn>) => {
  const m = e.data;
  if (m.type === 'send-key') sendKey = { index: m.index, key: await importFrameKey(m.raw) };
  else if (m.type === 'peer-key') {
    let keys = peerKeys.get(m.peer);
    if (!keys) peerKeys.set(m.peer, (keys = new Map()));
    keys.set(m.index, await importFrameKey(m.raw));
    // Keep the newest few: frames in flight during a rotation still use the previous key.
    while (keys.size > 3) keys.delete(keys.keys().next().value!);
  } else if (m.type === 'forget-peer') peerKeys.delete(m.peer);
};

const isKeyFrame = (frame: EncodedFrame) => 'type' in frame && frame.type === 'key';

function codecOf(frame: EncodedFrame, fallback: string): FrameCodec {
  const meta = frame.getMetadata() as { mimeType?: string };
  return codecFromMime(meta.mimeType || fallback);
}

scope.addEventListener('rtctransform', (event) => {
  const { readable, writable, options } = (event as Event & { transformer: Transformer }).transformer;
  let seen = false;
  const transform = new TransformStream<EncodedFrame, EncodedFrame>({
    async transform(frame, controller) {
      if (!seen) {
        seen = true;
        scope.postMessage({ type: 'active', id: options.id } satisfies WorkerOut);
      }
      const data = new Uint8Array(frame.data);
      const codec = codecOf(frame, options.mime);
      if (options.op === 'encrypt') {
        // No key yet: send nothing rather than plaintext.
        if (!sendKey) return;
        frame.data = (await encryptFrame(data, codec, isKeyFrame(frame), sendKey.key, sendKey.index)).buffer as ArrayBuffer;
        controller.enqueue(frame);
        return;
      }
      const peer = options.peer ?? '';
      const index = frameKeyIndex(data);
      const key = index === null ? undefined : peerKeys.get(peer)?.get(index);
      if (!key) return notify({ type: 'missing-key', peer });
      try {
        frame.data = (await decryptFrame(data, codec, isKeyFrame(frame), key)).buffer as ArrayBuffer;
        controller.enqueue(frame);
      } catch {
        // Wrong key or tampered: drop the frame (never feed garbage to the decoder).
        notify({ type: 'decrypt-failed', peer });
      }
    },
  });
  void readable.pipeThrough(transform).pipeTo(writable);
});
