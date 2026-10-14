// Messages exchanged between peers (over the "app" DataChannel, or relayed by the server as fallback).

export interface PeerState {
  name: string;
  audio: boolean;
  video: boolean;
  screen: boolean;
  hand: boolean;
}

export type AppMessage =
  | { t: 'state'; state: PeerState }
  | { t: 'chat'; id: string; text: string; ts: number }
  /** Sent just before leaving, so peers drop the tile immediately even without the server. */
  | { t: 'bye' }
  /** Our frame key for SFU media (end-to-end encryption). Only ever over the P2P DataChannel. */
  | { t: 'e2ee-key'; index: number; key: string }
  /** "Send me your current key" — after frames arrived that we could not decrypt. */
  | { t: 'e2ee-key-request' };

// Control frames on the "file" DataChannel; binary frames in between carry file chunks.
export type FileControl =
  | { t: 'file-start'; id: string; name: string; size: number; mime: string }
  | { t: 'file-end'; id: string }
  | { t: 'file-cancel'; id: string };

export const MAX_CHAT_LENGTH = 2000;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const str = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max;

/** Validates untrusted peer input. */
export function parseAppMessage(v: unknown): AppMessage | null {
  if (!isObj(v)) return null;
  if (v.t === 'state' && isObj(v.state)) {
    const s = v.state;
    if (!str(s.name, 40)) return null;
    return {
      t: 'state',
      state: { name: s.name, audio: s.audio === true, video: s.video === true, screen: s.screen === true, hand: s.hand === true },
    };
  }
  if (v.t === 'bye') return { t: 'bye' };
  if (v.t === 'e2ee-key' && Number.isInteger(v.index) && (v.index as number) >= 1 && (v.index as number) <= 255 && str(v.key, 64)) {
    return { t: 'e2ee-key', index: v.index as number, key: v.key };
  }
  if (v.t === 'e2ee-key-request') return { t: 'e2ee-key-request' };
  if (v.t === 'chat' && str(v.id, 64) && str(v.text, MAX_CHAT_LENGTH) && typeof v.ts === 'number') {
    return { t: 'chat', id: v.id, text: v.text, ts: v.ts };
  }
  return null;
}

export function parseFileControl(v: unknown): FileControl | null {
  if (!isObj(v) || !str(v.id, 64)) return null;
  if (v.t === 'file-start' && str(v.name, 255) && typeof v.size === 'number' && v.size >= 0 && str(v.mime, 255)) {
    return { t: 'file-start', id: v.id, name: v.name, size: v.size, mime: v.mime };
  }
  if (v.t === 'file-end' || v.t === 'file-cancel') return { t: v.t, id: v.id };
  return null;
}
