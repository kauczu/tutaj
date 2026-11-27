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

const studio = (micBoost: number) => ({ audio: 'studio', resolution: 720, uploadKbps: 0, codec: 'auto', echoCancel: false, micBoost });

/** Audio energy received so far (grows while sound arrives). */
const received = (page: Page) =>
  page.evaluate(async () => {
    let energy = 0;
    for (const pc of window.__pcs) (await pc.getStats()).forEach((s) => s.type === 'inbound-rtp' && s.kind === 'audio' && (energy += s.totalAudioEnergy ?? 0));
    return energy;
  });

const sentAudioId = (page: Page) =>
  page.evaluate(() => window.__pcs.flatMap((pc) => pc.getSenders()).find((s) => s.track?.kind === 'audio')?.track?.id ?? '');

async function energyOver(page: Page, ms: number): Promise<number> {
  const e0 = await received(page);
  await page.waitForTimeout(ms);
  return (await received(page)) - e0;
}

/**
 * A quiet microphone, as a real one is without automatic gain control (Chrome's fake one is a
 * full-scale beep, which no boost can raise).
 */
function fakeQuietMic() {
  const native = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = async (c?: MediaStreamConstraints) => {
    const stream = await native(c);
    if (!c?.audio) return stream;
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    osc.frequency.value = 300;
    const gain = ctx.createGain();
    gain.gain.value = 0.05;
    const dest = ctx.createMediaStreamDestination();
    osc.connect(gain).connect(dest);
    osc.start();
    const quiet = dest.stream.getAudioTracks()[0];
    const mic = stream.getAudioTracks()[0];
    quiet.addEventListener('ended', () => mic.stop());
    // Reports the real device, so switching modes re-opens it as with a real microphone.
    quiet.getSettings = () => mic.getSettings();
    (window as unknown as { __mic: string }).__mic = quiet.id;
    return new MediaStream([quiet, ...stream.getVideoTracks()]);
  };
}

test('studio audio: the microphone boost makes the voice louder; voice mode sends the bare mic', async ({ browser }) => {
  const bartek = await Participant.join(browser, srv.url, 'glosniej', 'Bartek');
  const ania = await Participant.open(browser, srv.url, 'glosniej', 'Ania', studio(0));
  people.push(bartek, ania);
  await ania.page.addInitScript(fakeQuietMic);
  await ania.page.reload();
  await ania.page.fill('#name', 'Ania');
  await ania.submitJoin();
  await bartek.expectVideoFrom('Ania');
  const bareMic = () => ania.page.evaluate(() => (window as unknown as { __mic: string }).__mic);
  await expect.poll(() => sentAudioId(ania.page)).toBe(await bareMic());
  await bartek.page.waitForTimeout(1500);
  const quiet = await energyOver(bartek.page, 2500);

  await ania.page.click('#btn-settings');
  await ania.page.click('#tab-quality');
  const boost = ania.page.locator('#quality-room-boost');
  await expect(boost).toBeVisible();
  await expect(boost).toHaveValue('0');
  await boost.selectOption('12');
  await ania.page.getByRole('button', { name: 'Zamknij' }).click();
  await expect.poll(async () => (await sentAudioId(ania.page)) !== (await bareMic())).toBe(true);
  expect(await ania.page.evaluate(() => JSON.parse(localStorage.getItem('tutaj:quality')!).micBoost)).toBe(12);
  await bartek.page.waitForTimeout(1500);
  const loud = await energyOver(bartek.page, 2500);
  expect(loud).toBeGreaterThan(quiet * 4);

  // Voice mode has automatic gain control of its own: no boost there, the field is hidden.
  await ania.page.click('#btn-settings');
  await ania.page.click('#tab-quality');
  await ania.page.selectOption('#quality-room-audio', 'voice');
  await expect(boost).toBeHidden();
  await ania.page.getByRole('button', { name: 'Zamknij' }).click();
  await expect.poll(async () => (await sentAudioId(ania.page)) === (await bareMic())).toBe(true);
  // Profiles keep the boost (a property of the setup, like echo cancellation).
  expect(await ania.page.evaluate(() => JSON.parse(localStorage.getItem('tutaj:quality')!).micBoost)).toBe(12);
});

/** A shared screen that is one flat colour, so the camera in its corner is easy to tell apart. */
function fakeFlatScreen() {
  navigator.mediaDevices.getDisplayMedia = async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 1280;
    canvas.height = 720;
    const g = canvas.getContext('2d')!;
    const paint = () => {
      g.fillStyle = 'rgb(200, 30, 30)';
      g.fillRect(0, 0, 1280, 720);
    };
    paint();
    setInterval(paint, 100);
    return canvas.captureStream(15);
  };
}

/** Colour of Ania's picture at Bartek's, at (x, y) as parts of its width and height. */
const pixel = (page: Page, x: number, y: number) =>
  page.evaluate(
    ([x, y]) => {
      const tile = [...document.querySelectorAll('.tile')].find((t) => t.textContent?.includes('Ania'))!;
      const v = tile.querySelector('video')!;
      const c = document.createElement('canvas');
      c.width = v.videoWidth;
      c.height = v.videoHeight;
      const g = c.getContext('2d')!;
      g.drawImage(v, 0, 0);
      const d = g.getImageData(Math.round(x * c.width), Math.round(y * c.height), 1, 1).data;
      return [d[0], d[1], d[2]];
    },
    [x, y],
  );

const isScreen = async (page: Page, x: number, y: number) => {
  const [r, g, b] = await pixel(page, x, y);
  return r > 150 && g < 80 && b < 80;
};

async function shareFlatScreen(ania: Participant): Promise<void> {
  await ania.page.addInitScript(fakeFlatScreen);
  await ania.page.reload();
  await ania.page.fill('#name', 'Ania');
  await ania.submitJoin();
}

test('screen share: the camera shows in a corner of the shared screen, where chosen, or not at all', async ({ browser }) => {
  const bartek = await Participant.join(browser, srv.url, 'kamera', 'Bartek');
  const ania = await Participant.open(browser, srv.url, 'kamera', 'Ania');
  people.push(bartek, ania);
  await shareFlatScreen(ania);
  await bartek.expectVideoFrom('Ania');

  await ania.page.click('#btn-screen');
  await expect.poll(() => isScreen(bartek.page, 0.3, 0.3), { timeout: 15_000 }).toBe(true);
  await expect.poll(() => isScreen(bartek.page, 0.9, 0.88)).toBe(false); // the camera, bottom right
  expect(await isScreen(bartek.page, 0.1, 0.12)).toBe(true);

  // Another corner, right away.
  await ania.page.click('#btn-settings');
  await ania.page.click('#tab-devices');
  const where = ania.page.locator('#set-screen-camera');
  await expect(where).toBeVisible();
  await expect(where).toHaveValue('bottom-right');
  await where.selectOption('top-left');
  await expect.poll(() => isScreen(bartek.page, 0.1, 0.12)).toBe(false);
  await expect.poll(() => isScreen(bartek.page, 0.9, 0.88)).toBe(true);

  // Not at all: the bare screen, as before.
  await where.selectOption('off');
  await ania.page.getByRole('button', { name: 'Zamknij' }).click();
  await expect.poll(() => isScreen(bartek.page, 0.1, 0.12)).toBe(true);
  expect(await isScreen(bartek.page, 0.9, 0.88)).toBe(true);
  expect(await ania.page.evaluate(() => localStorage.getItem('tutaj:screen-camera'))).toBe('off');

  // Back on; turning the camera off mid-share leaves the bare screen, turning it on brings it back.
  await ania.page.click('#btn-settings');
  await ania.page.click('#tab-devices');
  await where.selectOption('bottom-right');
  await ania.page.getByRole('button', { name: 'Zamknij' }).click();
  await expect.poll(() => isScreen(bartek.page, 0.9, 0.88)).toBe(false);
  await ania.page.click('#btn-cam');
  await expect.poll(() => isScreen(bartek.page, 0.9, 0.88)).toBe(true);
  await ania.page.click('#btn-cam');
  await expect.poll(() => isScreen(bartek.page, 0.9, 0.88)).toBe(false);

  // Stop sharing: the camera alone again.
  await ania.page.click('#btn-screen');
  await expect.poll(() => isScreen(bartek.page, 0.3, 0.3)).toBe(false);
});

test('screen share with the camera through the SFU (encrypted)', async ({ browser }) => {
  await srv.server.close();
  srv = await startTestServer({ sfu: true });
  const bartek = await Participant.join(browser, srv.url, 'sfu-kamera', 'Bartek');
  const ania = await Participant.open(browser, srv.url, 'sfu-kamera', 'Ania');
  people.push(bartek, ania);
  await shareFlatScreen(ania);
  await bartek.expectVideoFrom('Ania');
  await ania.setMode('sfu');
  await expect(ania.badge).toHaveText('SFU');
  await expect(bartek.badge).toHaveText('SFU');
  await bartek.expectVideoFrom('Ania');

  await ania.page.click('#btn-screen');
  await expect.poll(() => isScreen(bartek.page, 0.3, 0.3), { timeout: 15_000 }).toBe(true);
  await expect.poll(() => isScreen(bartek.page, 0.9, 0.88)).toBe(false);
});
