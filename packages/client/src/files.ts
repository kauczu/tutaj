import { parseFileControl, type FileControl } from './messages';
import { t } from './i18n';

const CHUNK = 16 * 1024;
const SLAB = 1024 * 1024;
const HIGH_WATER = 4 * 1024 * 1024;
const LOW_WATER = 1024 * 1024;
export const MAX_FILE_SIZE = 2 * 1024 * 1024 * 1024;

function waitForDrain(ch: RTCDataChannel): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = () => {
      ch.removeEventListener('bufferedamountlow', done);
      ch.removeEventListener('close', fail);
      resolve();
    };
    const fail = () => {
      ch.removeEventListener('bufferedamountlow', done);
      reject(new Error(t('file.channelClosed')));
    };
    ch.addEventListener('bufferedamountlow', done);
    ch.addEventListener('close', fail, { once: true });
  });
}

const sendControl = (ch: RTCDataChannel, msg: FileControl) => ch.send(JSON.stringify(msg));

/** Streams one file over an ordered DataChannel with backpressure. */
export async function sendFile(ch: RTCDataChannel, file: File, id: string, onProgress: (sent: number) => void): Promise<void> {
  if (ch.readyState !== 'open') throw new Error(t('file.noP2p'));
  ch.bufferedAmountLowThreshold = LOW_WATER;
  sendControl(ch, { t: 'file-start', id, name: file.name, size: file.size, mime: file.type });
  let offset = 0;
  try {
    while (offset < file.size) {
      const slab = await file.slice(offset, offset + SLAB).arrayBuffer();
      for (let pos = 0; pos < slab.byteLength; pos += CHUNK) {
        if (ch.readyState !== 'open') throw new Error(t('file.interrupted'));
        if (ch.bufferedAmount > HIGH_WATER) await waitForDrain(ch);
        ch.send(slab.slice(pos, pos + CHUNK));
      }
      offset += slab.byteLength;
      onProgress(offset);
    }
    sendControl(ch, { t: 'file-end', id });
  } catch (err) {
    if (ch.readyState === 'open') sendControl(ch, { t: 'file-cancel', id });
    throw err;
  }
}

export interface IncomingFile {
  id: string;
  name: string;
  size: number;
  mime: string;
}

export interface ReceiverEvents {
  start(file: IncomingFile): void;
  progress(file: IncomingFile, received: number): void;
  done(file: IncomingFile, blob: Blob): void;
  failed(file: IncomingFile, reason: string): void;
}

/** Reassembles files from one peer's "file" channel (transfers are sequential per channel). */
export class FileReceiver {
  private current: { meta: IncomingFile; chunks: ArrayBuffer[]; received: number; lastReport: number } | null = null;

  constructor(private readonly ev: ReceiverEvents) {}

  handle(e: MessageEvent): void {
    if (typeof e.data === 'string') {
      let ctrl: FileControl | null = null;
      try {
        ctrl = parseFileControl(JSON.parse(e.data));
      } catch {
        return;
      }
      if (!ctrl) return;
      if (ctrl.t === 'file-start') {
        if (this.current) this.fail(t('file.replaced'));
        if (ctrl.size > MAX_FILE_SIZE) return;
        const meta = { id: ctrl.id, name: ctrl.name, size: ctrl.size, mime: ctrl.mime };
        this.current = { meta, chunks: [], received: 0, lastReport: 0 };
        this.ev.start(meta);
      } else if (this.current?.meta.id === ctrl.id) {
        if (ctrl.t === 'file-cancel') this.fail('anulowano');
        else if (this.current.received !== this.current.meta.size) this.fail(t('file.incomplete'));
        else {
          const { meta, chunks } = this.current;
          this.current = null;
          this.ev.done(meta, new Blob(chunks, { type: meta.mime || 'application/octet-stream' }));
        }
      }
      return;
    }
    const cur = this.current;
    if (!cur || !(e.data instanceof ArrayBuffer)) return;
    cur.chunks.push(e.data);
    cur.received += e.data.byteLength;
    if (cur.received > cur.meta.size) return this.fail(t('file.tooLong'));
    if (cur.received - cur.lastReport > 256 * 1024 || cur.received === cur.meta.size) {
      cur.lastReport = cur.received;
      this.ev.progress(cur.meta, cur.received);
    }
  }

  /** Call when the connection drops mid-transfer. */
  abort(): void {
    if (this.current) this.fail(t('file.connLost'));
  }

  private fail(reason: string): void {
    const cur = this.current;
    this.current = null;
    if (cur) this.ev.failed(cur.meta, reason);
  }
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}
