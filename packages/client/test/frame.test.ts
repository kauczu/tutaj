import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  clearLength,
  codecFromMime,
  decryptFrame,
  encryptFrame,
  escapeH264,
  frameKeyIndex,
  importFrameKey,
  unescapeH264,
} from '../src/e2ee/frame.ts';

const key = await importFrameKey(crypto.getRandomValues(new Uint8Array(32)));
const otherKey = await importFrameKey(crypto.getRandomValues(new Uint8Array(32)));

const bytes = (...parts: (number[] | Uint8Array)[]) => Uint8Array.from(parts.flatMap((p) => [...p]));
const random = (n: number, zeroBias = 0) =>
  Uint8Array.from({ length: n }, () => (Math.random() < zeroBias ? 0 : Math.floor(Math.random() * 256)));

/** NAL start code positions, as the RTP packetizer would split the frame. */
function startCodes(data: Uint8Array): number[] {
  const at: number[] = [];
  for (let i = 0; i + 2 < data.length; i++) if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) at.push(i);
  return at;
}

test('codec from MIME type', () => {
  assert.equal(codecFromMime('video/VP8'), 'vp8');
  assert.equal(codecFromMime('video/H264'), 'h264');
  assert.equal(codecFromMime('audio/opus'), 'opus');
  assert.equal(codecFromMime('video/AV1'), 'other');
});

test('VP8: key and delta frames round-trip, the payload header stays readable for the SFU', async () => {
  for (const keyFrame of [true, false]) {
    const frame = random(5000);
    const enc = await encryptFrame(frame, 'vp8', keyFrame, key, 7);
    const clear = keyFrame ? 10 : 3;
    assert.deepEqual(enc.subarray(0, clear), frame.subarray(0, clear));
    assert.notDeepEqual(enc.subarray(clear, clear + 64), frame.subarray(clear, clear + 64));
    assert.equal(frameKeyIndex(enc), 7);
    assert.deepEqual(await decryptFrame(enc, 'vp8', keyFrame, key), frame);
  }
});

test('Opus: TOC byte in clear, the rest encrypted', async () => {
  const frame = random(120);
  const enc = await encryptFrame(frame, 'opus', false, key, 1);
  assert.equal(enc[0], frame[0]);
  assert.deepEqual(await decryptFrame(enc, 'opus', false, key), frame);
});

test('H.264: NAL headers up to the first slice stay in clear, no start code appears inside the ciphertext', async () => {
  const aud = [0, 0, 0, 1, 0x09, 0xf0];
  const sps = [0, 0, 0, 1, 0x67, 0x42, 0xc0, 0x1f, 0xda, 0x01];
  const pps = [0, 0, 0, 1, 0x68, 0xce, 0x3c, 0x80];
  for (let round = 0; round < 200; round++) {
    // IDR slice, then a second slice; payloads full of zeros to provoke start-code look-alikes.
    const slice = bytes([0, 0, 0, 1, 0x65], random(1 + Math.floor(Math.random() * 3000), 0.4));
    const second = bytes([0, 0, 1, 0x41], random(500, 0.4));
    const frame = bytes(aud, sps, pps, slice, second);
    const clear = clearLength(frame, 'h264', true);
    assert.equal(clear, aud.length + sps.length + pps.length + 4 + 2);

    const enc = await encryptFrame(frame, 'h264', true, key, 200);
    assert.deepEqual(enc.subarray(0, clear), frame.subarray(0, clear));
    // Only the start codes of the clear part (AUD, SPS, PPS, first slice) — the packetizer keeps the rest in one NAL.
    assert.deepEqual(startCodes(enc), startCodes(frame.subarray(0, clear)));
    assert.equal(clearLength(enc, 'h264', true), clear);
    assert.deepEqual(await decryptFrame(enc, 'h264', true, key), frame);
  }
});

test('H.264: a zero at the end of the clear header cannot form a start code with the ciphertext', async () => {
  // Slice header byte after the NAL header is 0x00 → clear part ends with a zero.
  for (let i = 0; i < 300; i++) {
    const frame = bytes([0, 0, 0, 1, 0x41, 0x00], random(64, 0.5));
    const enc = await encryptFrame(frame, 'h264', false, key, 3);
    assert.deepEqual(startCodes(enc), startCodes(frame.subarray(0, 6)));
    assert.deepEqual(await decryptFrame(enc, 'h264', false, key), frame);
  }
});

test('emulation prevention escape/unescape is lossless and removes every start code', () => {
  for (let i = 0; i < 2000; i++) {
    const data = random(Math.floor(Math.random() * 64), 0.6);
    for (const zeros of [0, 1, 2]) {
      const esc = escapeH264(data, zeros);
      const withPrefix = bytes(new Array(zeros).fill(0), esc);
      for (let j = 0; j + 2 < withPrefix.length; j++) {
        assert.ok(!(withPrefix[j] === 0 && withPrefix[j + 1] === 0 && withPrefix[j + 2] <= 2), `start code-like at ${j}`);
      }
      assert.deepEqual(unescapeH264(esc, zeros), data);
    }
  }
});

test('wrong key, a changed header and a changed ciphertext are all rejected', async () => {
  const frame = random(800);
  const enc = await encryptFrame(frame, 'vp8', true, key, 9);
  await assert.rejects(decryptFrame(enc, 'vp8', true, otherKey));
  const header = enc.slice();
  header[5] ^= 1; // authenticated as additional data
  await assert.rejects(decryptFrame(header, 'vp8', true, key));
  const body = enc.slice();
  body[200] ^= 1;
  await assert.rejects(decryptFrame(body, 'vp8', true, key));
  await assert.rejects(decryptFrame(frame, 'vp8', true, key)); // plaintext is not accepted
});

test('every frame gets a fresh IV (same input, different output)', async () => {
  const frame = random(300);
  const a = await encryptFrame(frame, 'opus', false, key, 1);
  const b = await encryptFrame(frame, 'opus', false, key, 1);
  assert.notDeepEqual(a, b);
});
