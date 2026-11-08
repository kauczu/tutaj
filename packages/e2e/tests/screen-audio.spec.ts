import { expect, test, type Page } from '@playwright/test';
import { closeAll, Participant, startTestServer, type TestServer } from './helpers.js';

let srv: TestServer;
let people: Participant[] = [];
test.beforeEach(async () => {
  srv = await startTestServer();
});
test.afterEach(async () => {
  await closeAll(...people, srv);
  people = [];
});

/** A screen share that comes with sound (a tone), as when "share the sound too" is ticked. */
function fakeScreenWithSound() {
  navigator.mediaDevices.getDisplayMedia = async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 360;
    const g = canvas.getContext('2d')!;
    setInterval(() => {
      g.fillStyle = `hsl(${Date.now() / 20 % 360} 60% 50%)`;
      g.fillRect(0, 0, 640, 360);
    }, 50);
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    osc.frequency.value = 440;
    const dest = ctx.createMediaStreamDestination();
    osc.connect(dest);
    osc.start();
    return new MediaStream([...canvas.captureStream(15).getVideoTracks(), ...dest.stream.getAudioTracks()]);
  };
}

/** Audio energy Bartek has received from Ania so far (grows while sound arrives). */
const received = (page: Page) =>
  page.evaluate(async () => {
    let energy = 0;
    for (const pc of window.__pcs) (await pc.getStats()).forEach((s) => s.type === 'inbound-rtp' && s.kind === 'audio' && (energy += s.totalAudioEnergy ?? 0));
    return energy;
  });

const sentAudio = (page: Page) =>
  page.evaluate(() => {
    const sender = window.__pcs.flatMap((pc) => pc.getSenders()).find((s) => s.track?.kind === 'audio');
    return { label: sender?.track?.label ?? '', max: sender?.getParameters().encodings?.[0]?.maxBitrate };
  });

test('screen with sound: mixed into the call audio, also with the mic muted; back to the mic alone after', async ({ browser }) => {
  const bartek = await Participant.join(browser, srv.url, 'dzwiek', 'Bartek');
  const ania = await Participant.open(browser, srv.url, 'dzwiek', 'Ania');
  people.push(bartek, ania);
  await ania.page.addInitScript(fakeScreenWithSound);
  await ania.page.reload();
  await ania.page.fill('#name', 'Ania');
  await ania.submitJoin();
  await bartek.expectVideoFrom('Ania');
  const mic = await sentAudio(ania.page);

  // Muted mic: Bartek gets (almost) no sound.
  await ania.page.click('#btn-mic');
  await bartek.page.waitForTimeout(1500);
  const quiet0 = await received(bartek.page);
  await bartek.page.waitForTimeout(2000);
  const quiet = (await received(bartek.page)) - quiet0;

  // Share the screen with its sound: the tone reaches Bartek though the mic stays muted.
  await ania.page.click('#btn-screen');
  await expect(ania.page.locator('.toast', { hasText: 'Udostępniasz ekran razem z dźwiękiem' })).toBeVisible();
  await expect.poll(async () => (await sentAudio(ania.page)).label).not.toBe(mic.label);
  await expect.poll(async () => (await sentAudio(ania.page)).max).toBeGreaterThanOrEqual(128_000);
  await bartek.page.waitForTimeout(1000);
  const loud0 = await received(bartek.page);
  await bartek.page.waitForTimeout(2000);
  const loud = (await received(bartek.page)) - loud0;
  expect(loud).toBeGreaterThan(quiet * 10 + 0.01);
  // The mic stays muted for the others.
  await expect(bartek.tile('Ania')).toHaveClass(/muted/);

  // Stop sharing: back to the bare microphone and the usual bitrate.
  await ania.page.click('#btn-screen');
  await expect.poll(async () => (await sentAudio(ania.page)).label).toBe(mic.label);
  await expect.poll(async () => (await sentAudio(ania.page)).max).toBe(mic.max);
});

test('screen with sound through the SFU (encrypted): the others hear it', async ({ browser }) => {
  await srv.server.close();
  srv = await startTestServer({ sfu: true });
  const bartek = await Participant.join(browser, srv.url, 'sfu-dzwiek', 'Bartek');
  const ania = await Participant.open(browser, srv.url, 'sfu-dzwiek', 'Ania');
  people.push(bartek, ania);
  await ania.page.addInitScript(fakeScreenWithSound);
  await ania.page.reload();
  await ania.page.fill('#name', 'Ania');
  await ania.submitJoin();
  await bartek.expectVideoFrom('Ania');
  await ania.setMode('sfu');
  await expect(ania.badge).toHaveText('SFU');
  await expect(bartek.badge).toHaveText('SFU');
  await bartek.expectVideoFrom('Ania');
  await ania.page.click('#btn-mic');

  await ania.page.click('#btn-screen');
  await expect(ania.page.locator('.toast', { hasText: 'Udostępniasz ekran razem z dźwiękiem' })).toBeVisible();
  await bartek.page.waitForTimeout(2000);
  const e0 = await received(bartek.page);
  await bartek.page.waitForTimeout(2000);
  expect((await received(bartek.page)) - e0).toBeGreaterThan(0.01);
});
