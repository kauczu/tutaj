import type { ClientMessage, ServerMessage, SfuMethod } from '@tutaj/shared';
import { Emitter } from './emitter';
import { t } from './i18n';

type SignalingEvents = {
  message: ServerMessage;
  close: { code: number };
};

/**
 * Turns the user's "server" setting into a WebSocket URL.
 * Empty → same origin as the page. Bare host:port → same security as the page.
 */
export function signalingUrl(server: string): string {
  const input = server.trim();
  if (!input) return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
  let url: URL;
  if (/^wss?:\/\//i.test(input)) url = new URL(input);
  else if (/^https?:\/\//i.test(input)) url = new URL(input.replace(/^http/i, 'ws'));
  else url = new URL(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${input}`);
  if (url.pathname === '/' || url.pathname === '') url.pathname = '/ws';
  return url.toString();
}

const REQUEST_TIMEOUT_MS = 10_000;

interface Pending {
  resolve(data: unknown): void;
  reject(err: Error): void;
  timer: number;
}

export class Signaling extends Emitter<SignalingEvents> {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();

  constructor(readonly url: string) {
    super();
  }

  connect(timeoutMs = 8000): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      let settled = false;
      const timer = setTimeout(() => fail(new Error(t('error.connectTimeout'))), timeoutMs);
      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        ws.close();
        reject(err);
      };
      ws.onopen = () => {
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      ws.onerror = () => fail(new Error(t('error.cannotConnect', { url: this.url })));
      ws.onmessage = (e) => {
        if (typeof e.data !== 'string') return;
        let msg: ServerMessage;
        try {
          msg = JSON.parse(e.data) as ServerMessage;
        } catch {
          return; // ignore malformed frame
        }
        if (msg.type === 'sfu-response') this.settle(msg);
        else this.emit('message', msg);
      };
      ws.onclose = (e) => {
        this.rejectAll();
        if (!settled) fail(new Error(t('error.cannotConnect', { url: this.url })));
        else if (this.ws === ws) this.emit('close', { code: e.code });
      };
    });
  }

  send(msg: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  /** Request/response call to the server's SFU. */
  request<T>(method: SfuMethod, data?: Record<string, unknown>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (this.ws?.readyState !== WebSocket.OPEN) return reject(new Error(t('error.notConnected')));
      const id = this.nextId++;
      const timer = window.setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(t('error.sfuTimeout', { method })));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve: resolve as (d: unknown) => void, reject, timer });
      this.send({ type: 'sfu', id, method, data });
    });
  }

  /** Closes without emitting `close` (intentional disconnect). */
  close(): void {
    const ws = this.ws;
    this.ws = null;
    this.rejectAll();
    ws?.close(1000);
  }

  private settle(msg: Extract<ServerMessage, { type: 'sfu-response' }>): void {
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.ok) p.resolve(msg.data);
    else p.reject(new Error(`SFU: ${msg.error}`));
  }

  private rejectAll(): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error(t('error.notConnected')));
    }
    this.pending.clear();
  }
}
