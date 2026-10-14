import type { ClientMessage, SfuMethod, SignalData } from '@tutaj/shared';

const SFU_METHODS = new Set<SfuMethod>([
  'capabilities',
  'create-transport',
  'connect-transport',
  'produce',
  'close-producer',
  'producers',
  'consume',
  'resume-consumer',
  'request-keyframe',
  'leave',
]);

const ROOM_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
// Strip C0/C1 control characters and bidi overrides from display names.
const UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g;
const MAX_SDP = 100_000;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isString = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max;

export const normalizeRoom = (room: string) => room.trim().toLowerCase();

export function cleanName(name: string): string {
  return name.replace(UNSAFE_CHARS, '').trim().slice(0, 40);
}

function parseSignal(data: unknown): SignalData | null {
  if (!isObject(data)) return null;
  if (isObject(data.description)) {
    const { type, sdp } = data.description;
    if ((type === 'offer' || type === 'answer') && isString(sdp, MAX_SDP)) return { description: { type, sdp } };
    return null;
  }
  if (isObject(data.candidate)) {
    const c = data.candidate;
    if (!isString(c.candidate, 2048)) return null;
    return {
      candidate: {
        candidate: c.candidate,
        sdpMid: isString(c.sdpMid, 64) ? c.sdpMid : null,
        sdpMLineIndex: typeof c.sdpMLineIndex === 'number' ? c.sdpMLineIndex : null,
        usernameFragment: isString(c.usernameFragment, 256) ? c.usernameFragment : null,
      },
    };
  }
  return null;
}

/** Parses and validates a raw client frame. Returns null for anything malformed. */
export function parseClientMessage(raw: string): ClientMessage | null {
  let msg: unknown;
  try {
    msg = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObject(msg)) return null;

  switch (msg.type) {
    case 'join': {
      if (!isString(msg.room, 64) || !isString(msg.name, 200)) return null;
      const room = normalizeRoom(msg.room);
      const name = cleanName(msg.name);
      if (!ROOM_RE.test(room) || !name) return null;
      if (msg.password !== undefined && !isString(msg.password, 128)) return null;
      let resume: { id: string; token: string } | undefined;
      if (msg.resume !== undefined) {
        const r = msg.resume;
        if (!isObject(r) || !isString(r.id, 64) || !isString(r.token, 128)) return null;
        resume = { id: r.id, token: r.token };
      }
      if (msg.ownerKey !== undefined && !isString(msg.ownerKey, 256)) return null;
      return {
        type: 'join',
        room,
        name,
        password: (msg.password as string | undefined) || undefined,
        resume,
        ownerKey: (msg.ownerKey as string | undefined) || undefined,
        e2ee: msg.e2ee === true,
      };
    }
    case 'signal': {
      if (!isString(msg.to, 64) || !isString(msg.sid, 64)) return null;
      const data = parseSignal(msg.data);
      return data ? { type: 'signal', to: msg.to, sid: msg.sid, data } : null;
    }
    case 'relay': {
      if (msg.to !== undefined && !isString(msg.to, 64)) return null;
      return { type: 'relay', to: msg.to as string | undefined, payload: msg.payload };
    }
    case 'leave':
      return { type: 'leave' };
    case 'quality': {
      const r = msg.report;
      if (!isObject(r)) return null;
      const kbps = typeof r.uplinkKbps === 'number' && Number.isFinite(r.uplinkKbps) && r.uplinkKbps >= 0 ? r.uplinkKbps : null;
      return { type: 'quality', report: { bw: r.bw === true, cpu: r.cpu === true, relayed: r.relayed === true, uplinkKbps: kbps, hq: r.hq === true } };
    }
    case 'set-mode':
      return msg.pref === 'auto' || msg.pref === 'mesh' || msg.pref === 'sfu' ? { type: 'set-mode', pref: msg.pref } : null;
    case 'sfu': {
      if (typeof msg.id !== 'number' || !Number.isSafeInteger(msg.id)) return null;
      if (typeof msg.method !== 'string' || !SFU_METHODS.has(msg.method as SfuMethod)) return null;
      if (msg.data !== undefined && !isObject(msg.data)) return null;
      return { type: 'sfu', id: msg.id, method: msg.method as SfuMethod, data: msg.data as Record<string, unknown> | undefined };
    }
    default:
      return null;
  }
}
