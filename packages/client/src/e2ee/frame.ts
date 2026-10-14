// End-to-end encryption of encoded media frames (SFU mode).
//
// Frame layout after encryption:
//   [clear header][AES-GCM ciphertext + 16-byte tag][IV, 12 bytes][key index, 1 byte]
//
// The clear header is what the SFU and the RTP packetizer must still read: the VP8 payload header
// (key frame bit, size), H.264 NAL unit headers up to the first slice (key frame detection), the
// Opus TOC byte. It is authenticated as additional data, so it cannot be altered either.
// For H.264 everything after the clear header is escaped (emulation prevention, 0x03 after 00 00)
// so no start code appears inside the ciphertext and the packetizer keeps it in one NAL unit.

export type FrameCodec = 'vp8' | 'h264' | 'opus' | 'other';

export const IV_LENGTH = 12;
const TRAILER = IV_LENGTH + 1;

export function codecFromMime(mime: string | undefined): FrameCodec {
  const m = (mime ?? '').toLowerCase();
  if (m.endsWith('/vp8')) return 'vp8';
  if (m.endsWith('/h264')) return 'h264';
  if (m.endsWith('/opus')) return 'opus';
  return 'other';
}

/** Start offsets of NAL unit headers (right after each 00 00 01 start code) in an Annex B frame. */
function nalStarts(data: Uint8Array): number[] {
  const starts: number[] = [];
  for (let i = 0; i + 2 < data.length; i++) {
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) {
      starts.push(i + 3);
      i += 2;
    }
  }
  return starts;
}

/** How many leading bytes stay unencrypted. Must give the same answer on the encrypted frame. */
export function clearLength(data: Uint8Array, codec: FrameCodec, keyFrame: boolean): number {
  switch (codec) {
    case 'vp8':
      // Key frames: 3-byte frame tag + 7-byte start code/size; delta frames: the frame tag.
      return Math.min(data.length, keyFrame ? 10 : 3);
    case 'opus':
      return Math.min(data.length, 1);
    case 'h264': {
      // Everything up to and including the first slice's NAL header (+1 byte: first_mb/slice type bits).
      for (const start of nalStarts(data)) {
        const type = data[start] & 0x1f;
        if (type === 1 || type === 5) return Math.min(data.length, start + 2);
      }
      return 0;
    }
    default:
      return 0;
  }
}

/**
 * Emulation prevention: 00 00 0x (x ≤ 3) → 00 00 03 0x, so no start code can appear.
 * `zeros`: zero bytes right before `data` (the end of the clear header), so none forms across the boundary.
 */
export function escapeH264(data: Uint8Array, zeros = 0): Uint8Array {
  const out: number[] = [];
  for (const b of data) {
    if (zeros >= 2 && b <= 3) {
      out.push(3);
      zeros = 0;
    }
    out.push(b);
    zeros = b === 0 ? zeros + 1 : 0;
  }
  return Uint8Array.from(out);
}

export function unescapeH264(data: Uint8Array, zeros = 0): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < data.length; i++) {
    const b = data[i];
    if (zeros >= 2 && b === 3 && i + 1 < data.length && data[i + 1] <= 3) {
      zeros = 0;
      continue;
    }
    out.push(b);
    zeros = b === 0 ? zeros + 1 : 0;
  }
  return Uint8Array.from(out);
}

const trailingZeros = (b: Uint8Array) => (b.length > 0 && b[b.length - 1] === 0 ? (b.length > 1 && b[b.length - 2] === 0 ? 2 : 1) : 0);

/**
 * Encrypts one encoded frame. `keyIndex` (1–255, never 0: the last byte must not be zero for H.264)
 * tells the receiver which of the sender's keys to use.
 */
export async function encryptFrame(data: Uint8Array, codec: FrameCodec, keyFrame: boolean, key: CryptoKey, keyIndex: number): Promise<Uint8Array> {
  const clear = clearLength(data, codec, keyFrame);
  const header = data.subarray(0, clear);
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: header }, key, data.subarray(clear)));
  let tail = new Uint8Array(cipher.length + TRAILER);
  tail.set(cipher, 0);
  tail.set(iv, cipher.length);
  tail[tail.length - 1] = keyIndex;
  if (codec === 'h264') tail = escapeH264(tail, trailingZeros(header));
  const out = new Uint8Array(clear + tail.length);
  out.set(header, 0);
  out.set(tail, clear);
  return out;
}

/** Key index of an encrypted frame (last byte), or null if it cannot be one. */
export function frameKeyIndex(data: Uint8Array): number | null {
  return data.length > TRAILER ? data[data.length - 1] : null;
}

/** Decrypts one frame; throws if the key is wrong or anything was tampered with. */
export async function decryptFrame(data: Uint8Array, codec: FrameCodec, keyFrame: boolean, key: CryptoKey): Promise<Uint8Array> {
  const clear = clearLength(data, codec, keyFrame);
  const header = data.subarray(0, clear);
  let tail = data.subarray(clear);
  if (codec === 'h264') tail = unescapeH264(tail, trailingZeros(header));
  if (tail.length < TRAILER + 16) throw new Error('frame too short');
  const iv = tail.subarray(tail.length - TRAILER, tail.length - 1);
  const plain = new Uint8Array(
    await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: header }, key, tail.subarray(0, tail.length - TRAILER)),
  );
  const out = new Uint8Array(clear + plain.length);
  out.set(header, 0);
  out.set(plain, clear);
  return out;
}

export function importFrameKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
