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

declare global {
  interface Window {
    __tracks: MediaStreamTrack[];
  }
}

/** Records every track the page captures, so a test can see what is still live. */
async function watchCapture(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.__tracks = [];
    const md = navigator.mediaDevices;
    const native = md.getUserMedia.bind(md);
    md.getUserMedia = async (c) => {
      const stream = await native(c);
      window.__tracks.push(...stream.getTracks());
      return stream;
    };
  });
  await page.reload();
}

const live = (page: Page) => page.evaluate(() => window.__tracks.filter((t) => t.readyState === 'live').map((t) => t.kind).sort());

function hide(page: Page, hidden: boolean): Promise<void> {
  return page.evaluate((h) => {
    Object.defineProperty(document, 'visibilityState', { value: h ? 'hidden' : 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);
}

test('camera and microphone: nothing captured in the lobby or after hanging up, only in the call', async ({ browser }) => {
  const bartek = await Participant.join(browser, srv.url, 'zasoby', 'Bartek');
  const ania = await Participant.open(browser, srv.url, 'zasoby', 'Ania');
  people.push(bartek, ania);
  await watchCapture(ania.page);
  await ania.page.fill('#name', 'Ania');
  await expect(ania.page.locator('#preview-note')).toHaveText('Kamera i mikrofon włączą się dopiero po dołączeniu do rozmowy.');
  await ania.page.waitForTimeout(500);
  expect(await live(ania.page)).toEqual([]);

  await ania.submitJoin();
  await expect(ania.page.locator('#room-view')).toBeVisible();
  await bartek.expectVideoFrom('Ania');
  expect(await live(ania.page)).toEqual(['audio', 'video']);
  // In the call a background tab keeps everything (you are still talking).
  await hide(ania.page, true);
  await ania.page.waitForTimeout(300);
  expect(await live(ania.page)).toEqual(['audio', 'video']);
  await hide(ania.page, false);

  await ania.page.click('#btn-leave');
  await expect(ania.page.locator('#join-form')).toBeVisible();
  await ania.page.waitForTimeout(500);
  expect(await live(ania.page)).toEqual([]);
});

test('preview on demand: stops in a background tab and comes back; join choices are remembered', async ({ browser }) => {
  const bartek = await Participant.join(browser, srv.url, 'podglad', 'Bartek');
  const ania = await Participant.open(browser, srv.url, 'podglad', 'Ania');
  people.push(bartek, ania);
  await watchCapture(ania.page);
  const page = ania.page;

  await page.click('#preview-toggle');
  await expect(page.locator('#preview-toggle')).toHaveText('Wyłącz podgląd');
  await expect.poll(() => live(page)).toEqual(['audio', 'video']);
  await expect.poll(() => page.locator('#preview-video').evaluate((v: HTMLVideoElement) => v.videoWidth > 0)).toBe(true);

  await hide(page, true);
  await expect.poll(() => live(page)).toEqual([]);
  await hide(page, false);
  await expect.poll(() => live(page)).toEqual(['audio', 'video']);

  // Camera off in the preview releases it; the choice holds after a reload (preview off again).
  await page.click('#preview-cam');
  await expect.poll(() => live(page)).toEqual(['audio']);
  await page.click('#preview-toggle');
  await expect.poll(() => live(page)).toEqual([]);
  await page.reload();
  await expect(page.locator('#preview-cam')).toHaveClass(/off/);
  await expect(page.locator('#preview-mic')).not.toHaveClass(/off/);
  await expect(page.locator('#preview-toggle')).toHaveText('Włącz podgląd');

  // Joining without the camera never opens it; muted mic is open but silent.
  await page.click('#preview-mic');
  await page.fill('#name', 'Ania');
  await ania.submitJoin();
  await expect(page.locator('#room-view')).toBeVisible();
  await expect(bartek.tile('Ania')).toHaveClass(/no-video/);
  await expect(bartek.tile('Ania')).toHaveClass(/muted/);
  expect(await live(page)).toEqual(['audio']);
  await expect(page.locator('#btn-mic')).toHaveAttribute('aria-pressed', 'false');
});
