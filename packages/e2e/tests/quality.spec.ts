import { expect, test, type Page } from '@playwright/test';
import { closeAll, Participant, startTestServer, type TestServer } from './helpers.js';

let srv: TestServer;
let people: Participant[] = [];
test.afterEach(async () => {
  await closeAll(...people, srv);
  people = [];
});

/** Joins and remembers the participant, so its browser context is closed after the test. */
async function join(room: string, name: string, browser: Parameters<typeof Participant.join>[0], quality?: object) {
  const p = await Participant.join(browser, srv.url, room, name, undefined, quality);
  people.push(p);
  return p;
}

const GAME = { audio: 'studio', resolution: 1080, uploadKbps: 4000, codec: 'auto' };

interface MediaInfo {
  sfu: boolean;
  audioMax: number | undefined;
  videoMax: number[];
  degradation: string | undefined;
  /** Opus parameters from the remote description: they configure our encoder. */
  audioFmtp: string;
  redFirst: boolean;
  echoCancellation: boolean | undefined;
  captureHeight: number | undefined;
  audioKbps: number;
  videoCodec: string | undefined;
}

/** What each live media connection of the page negotiates and sends (audio rate measured over 2 s). */
function mediaInfo(page: Page): Promise<MediaInfo[]> {
  return page.evaluate(async () => {
    const pcs = window.__pcs.filter((pc) => pc.connectionState === 'connected' && pc.getSenders().some((s) => s.track));
    const sample = async (pc: RTCPeerConnection) => {
      let bytes = 0;
      let codecId: string | undefined;
      const codecs = new Map<string, string>();
      (await pc.getStats()).forEach((s) => {
        if (s.type === 'outbound-rtp' && s.kind === 'audio') bytes += s.bytesSent;
        if (s.type === 'outbound-rtp' && s.kind === 'video') codecId = s.codecId;
        if (s.type === 'codec') codecs.set(s.id, s.mimeType);
      });
      return { bytes, videoCodec: codecId ? codecs.get(codecId) : undefined };
    };
    const before = await Promise.all(pcs.map(sample));
    await new Promise((r) => setTimeout(r, 2000));
    const after = await Promise.all(pcs.map(sample));
    return pcs.map((pc, i) => {
      const audio = pc.getSenders().find((s) => s.track?.kind === 'audio');
      const video = pc.getSenders().find((s) => s.track?.kind === 'video');
      const sdp = pc.localDescription?.sdp ?? '';
      const remote = pc.remoteDescription?.sdp ?? '';
      const remoteOpus = remote.match(/a=rtpmap:(\d+) opus\/48000\/2/)?.[1];
      const redPt = sdp.match(/a=rtpmap:(\d+) red\/48000\/2/)?.[1];
      const audioPts = sdp.match(/m=audio \S+ \S+ ([\d ]+)/)?.[1].split(' ') ?? [];
      return {
        sfu: !!pc.remoteDescription?.sdp.includes('a=ice-lite'),
        audioMax: audio?.getParameters().encodings?.[0]?.maxBitrate,
        videoMax: video?.getParameters().encodings?.map((e) => e.maxBitrate ?? 0) ?? [],
        degradation: (video?.getParameters() as { degradationPreference?: string } | undefined)?.degradationPreference,
        audioFmtp: remote.match(new RegExp(`a=fmtp:${remoteOpus} (.*)`))?.[1] ?? '',
        redFirst: !!redPt && audioPts[0] === redPt,
        echoCancellation: audio?.track?.getSettings().echoCancellation,
        captureHeight: video?.track?.getSettings().height,
        audioKbps: Math.round(((after[i].bytes - before[i].bytes) * 8) / 2000),
        videoCodec: after[i].videoCodec,
      };
    });
  });
}

test('gaming profile over P2P: studio stereo audio with redundancy, 1080p capture, upload limit', async ({ browser }) => {
  srv = await startTestServer();
  const ania = await join('gra', 'Ania', browser, GAME);
  const bartek = await join('gra', 'Bartek', browser);
  await ania.expectVideoFrom('Bartek');
  await bartek.expectVideoFrom('Ania');

  const [a] = await mediaInfo(ania.page);
  expect(a.sfu).toBe(false);
  expect(a.audioMax).toBe(160_000);
  expect(a.echoCancellation).toBe(false);
  expect(a.audioFmtp).toContain('stereo=1');
  expect(a.redFirst).toBe(true);
  // 160 kb/s Opus + its redundant copy (RED).
  expect(a.audioKbps).toBeGreaterThan(200);
  expect(a.captureHeight).toBe(1080);
  // Video stays within the 4 Mb/s limit, minus the audio (with RED) sent alongside.
  expect(a.videoMax[0]).toBeLessThanOrEqual(4_000_000 - 2 * 160_000);
  expect(a.degradation).toBe('maintain-framerate');
  // No hardware encoder in the test browser: automatic choice stays on VP8.
  expect(a.videoCodec).toBe('video/VP8');

  // Default profile on the other side: voice processing on, lower audio bitrate.
  const [b] = await mediaInfo(bartek.page);
  expect(b.audioMax).toBe(64_000);
  expect(b.echoCancellation).toBe(true);
  expect(b.captureHeight).toBe(720);

  // Switching the profile mid-call re-opens the mic and camera and retunes the senders — no renegotiation.
  await bartek.page.click('#btn-settings');
  await bartek.page.selectOption('#quality-room-profile', 'game');
  await expect(bartek.page.locator('#quality-room-audio')).toHaveValue('studio');
  await expect(bartek.page.locator('#send-stats')).toContainText('stereo');
  await expect.poll(async () => (await mediaInfo(bartek.page))[0]).toMatchObject({ audioMax: 160_000, echoCancellation: false, captureHeight: 1080 });
  await bartek.page.getByRole('button', { name: 'Zamknij' }).click();
  await ania.expectVideoFrom('Bartek');
});

test('gaming profile with 3 people goes to the SFU right away, with studio audio there too', async ({ browser }) => {
  srv = await startTestServer({ sfu: true });
  const ania = await join('gra3', 'Ania', browser, { ...GAME, codec: 'h264' });
  await join('gra3', 'Bartek', browser);
  await expect(ania.badge).toHaveText('P2P');
  const celina = await join('gra3', 'Celina', browser);

  // No waiting for bandwidth trouble: a high-quality sender switches the room at once.
  await expect(celina.badge).toHaveText('SFU', { timeout: 10_000 });
  await expect(ania.systemMessages().last()).toContainText('wysoka jakość');
  await ania.expectMediaPath('sfu');
  await celina.expectVideoFrom('Ania');

  const upstream = (await mediaInfo(ania.page)).find((m) => m.sfu)!;
  expect(upstream.audioMax).toBe(160_000);
  expect(upstream.audioFmtp).toContain('stereo=1');
  // Simulcast ladder fits the upload limit.
  expect(upstream.videoMax.reduce((s, x) => s + x, 0)).toBeLessThanOrEqual(4_000_000 - 160_000 + 1);
  expect(upstream.captureHeight).toBe(1080);
  expect(upstream.videoCodec).toBe('video/H264');
  await expect(ania.page.locator('#mode-badge')).toHaveText('SFU');
});

test('video codec is chosen per sender: H.264 on one side, VP8 on the other', async ({ browser }) => {
  srv = await startTestServer();
  // Codec choice only; 720p keeps software H.264 encoding light for the test machine.
  const h264 = { audio: 'voice', resolution: 720, uploadKbps: 0, codec: 'h264' };
  // Ania joins first, so she answers Bartek's offer (which lists VP8 first) — and still sends H.264.
  const ania = await join('h264', 'Ania', browser, h264);
  const bartek = await join('h264', 'Bartek', browser);
  await bartek.expectVideoFrom('Ania');
  await ania.expectVideoFrom('Bartek');
  await expect.poll(async () => (await mediaInfo(ania.page))[0].videoCodec).toBe('video/H264');
  expect((await mediaInfo(bartek.page))[0].videoCodec).toBe('video/VP8');

  // Switching the codec mid-call needs no renegotiation.
  await ania.page.click('#btn-settings');
  await ania.page.selectOption('#quality-room-codec', 'vp8');
  await expect.poll(async () => (await mediaInfo(ania.page))[0].videoCodec).toBe('video/VP8');
  await ania.page.getByRole('button', { name: 'Zamknij' }).click();
  await bartek.expectVideoFrom('Ania');
});
