import { expect, test } from '@playwright/test';
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
    __ov: { calls: unknown[][]; hotkey: ((name: string) => void) | null; settings: Record<string, unknown> };
  }
}

/**
 * Stand-in for the desktop app's bridge (preload): the overlay logic of the web client is tested
 * in a plain browser; window placement, click-through and global shortcuts are the app's part.
 */
function fakeDesktopBridge() {
  const ov = (window.__ov = {
    calls: [] as unknown[][],
    hotkey: null as ((name: string) => void) | null,
    settings: { enabled: false, corner: 'top-right', size: 'm', opacity: 0.85, display: null } as Record<string, unknown>,
  });
  (window as unknown as { tutaj: unknown }).tutaj = {
    isDesktop: true,
    info: async () => null,
    switchMode: async () => {},
    overlay: {
      get: async () => ({ ...ov.settings, displays: [{ id: 1, label: 'Monitor', width: 1920, height: 1080, primary: true }] }),
      set: async (patch: Record<string, unknown>) => ({ ...Object.assign(ov.settings, patch) }),
      resize: async (w: number, h: number) => void ov.calls.push(['resize', w, h]),
    },
    setInCall: async (on: boolean) => void ov.calls.push(['inCall', on]),
    onHotkey: (cb: (name: string) => void) => {
      ov.hotkey = cb;
      return () => (ov.hotkey = null);
    },
  };
}

test('game overlay: cameras of the others, muted badge, size reported to the app, shortcuts only during the call', async ({ browser }) => {
  const ania = await Participant.open(browser, srv.url, 'gra', 'Ania');
  people.push(ania);
  await ania.page.addInitScript(fakeDesktopBridge);
  await ania.page.reload();
  await ania.page.fill('#name', 'Ania');
  await ania.submitJoin();
  const bartek = await Participant.join(browser, srv.url, 'gra', 'Bartek');
  people.push(bartek);
  await ania.expectVideoFrom('Bartek');
  await expect.poll(() => ania.page.evaluate(() => window.__ov.calls)).toContainEqual(['inCall', true]);

  // Turned on in the settings (the desktop app also toggles it with Ctrl+Shift+O).
  await ania.page.click('#btn-settings');
  await expect(ania.page.locator('#overlay-settings')).toBeVisible();
  // One monitor: no monitor choice.
  await expect(ania.page.locator('#overlay-display')).toHaveCount(0);
  const [overlay] = await Promise.all([ania.page.waitForEvent('popup'), ania.page.check('#overlay-enabled')]);
  await expect(overlay).toHaveTitle('Tutaj — nakładka');
  expect(await ania.page.evaluate(() => window.__ov.settings.enabled)).toBe(true);

  // Only the others, live video, no badge while our mic is on.
  await expect(overlay.locator('.tile .name')).toHaveText(['Bartek']);
  await expect(overlay.locator('#muted-badge')).toBeHidden();
  const video = overlay.locator('.tile video');
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.videoWidth > 0 && v.muted && !v.paused)).toBe(true);
  // The app sizes the window to the content: one 280 px tile (+ padding).
  await expect.poll(() => ania.page.evaluate(() => window.__ov.calls.filter((c) => c[0] === 'resize').at(-1))).toEqual(['resize', 288, 166]);

  // Mute shortcut: mic off in the call, red badge in the overlay.
  await ania.page.getByRole('button', { name: 'Zamknij' }).click();
  await ania.page.evaluate(() => window.__ov.hotkey?.('mute'));
  await expect(ania.page.locator('#btn-mic')).toHaveAttribute('aria-pressed', 'false');
  await expect(overlay.locator('#muted-badge')).toBeVisible();
  await expect(bartek.tile('Ania')).toHaveClass(/muted/);

  // Others' state: camera off becomes a slim row, size follows.
  await bartek.page.click('#btn-cam');
  await expect(overlay.locator('.tile')).toHaveClass(/no-video/);
  await expect
    .poll(async () => (await ania.page.evaluate(() => window.__ov.calls.filter((c) => c[0] === 'resize').at(-1)))?.[2])
    .toBeLessThan(120);

  // Settings apply live.
  await ania.page.click('#btn-settings');
  await ania.page.selectOption('#overlay-size', 'l');
  await expect(overlay.locator('#root')).toHaveCSS('--w', '380px');
  await ania.page.getByRole('button', { name: 'Zamknij' }).click();

  // Overlay shortcut hides it; leaving the call releases the shortcuts.
  await ania.page.evaluate(() => window.__ov.hotkey?.('overlay'));
  await expect.poll(() => overlay.isClosed()).toBe(true);
  expect(await ania.page.evaluate(() => window.__ov.settings.enabled)).toBe(false);
  await ania.page.click('#btn-leave');
  // The page reloads to the lobby; the call ended with setInCall(false) before that.
  await expect(ania.page.locator('#join-form')).toBeVisible();
});
