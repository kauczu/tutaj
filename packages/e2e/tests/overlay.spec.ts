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
  const defaults: Record<string, string> = { overlay: 'CommandOrControl+Shift+O', mute: 'CommandOrControl+Shift+M' };
  let hotkeys = { ...defaults };
  (window as unknown as { tutaj: unknown }).tutaj = {
    isDesktop: true,
    info: async () => null,
    switchMode: async () => {},
    overlay: {
      get: async () => ({ ...ov.settings, hotkeys, displays: [{ id: 1, label: 'Monitor', width: 1920, height: 1080, primary: true }] }),
      set: async (patch: Record<string, unknown>) => ({ ...Object.assign(ov.settings, patch) }),
      resize: async (w: number, h: number) => void ov.calls.push(['resize', w, h]),
    },
    setInCall: async (on: boolean) => void ov.calls.push(['inCall', on]),
    setHotkey: async (name: string, accelerator: string | null) => {
      ov.calls.push(['setHotkey', name, accelerator]);
      if (accelerator === 'Ctrl+Alt+T') return { ok: false, error: 'zajęty' };
      hotkeys = { ...hotkeys, [name]: accelerator ?? defaults[name] };
      return { ok: true, hotkeys };
    },
    pauseHotkeys: async (paused: boolean) => void ov.calls.push(['pause', paused]),
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

test('shortcuts can be redefined: recorded from a key press, validated, restored to defaults', async ({ browser }) => {
  const ania = await Participant.open(browser, srv.url, 'skroty', 'Ania');
  people.push(ania);
  await ania.page.addInitScript(fakeDesktopBridge);
  await ania.page.reload();
  await ania.page.fill('#name', 'Ania');
  await ania.submitJoin();
  await expect(ania.page.locator('#room-view')).toBeVisible();
  const page = ania.page;
  const calls = () => page.evaluate(() => window.__ov.calls);

  await page.click('#btn-settings');
  await expect(page.locator('#hotkey-overlay')).toHaveText('Ctrl+Shift+O');
  await expect(page.locator('#hotkey-mute')).toHaveText('Ctrl+Shift+M');

  await page.click('#hotkey-mute');
  await expect(page.locator('#hotkey-mute')).toContainText('Naciśnij skrót');
  expect(await calls()).toContainEqual(['pause', true]);
  // A plain letter would take typing keys from games: refused, still recording.
  await page.keyboard.press('k');
  await expect(page.locator('#overlay-settings .error')).toContainText('Użyj Ctrl, Alt lub Win');
  // Esc cancels recording without closing the dialog.
  await page.keyboard.press('Escape');
  await expect(page.locator('#settings')).toHaveAttribute('open', '');
  await expect(page.locator('#hotkey-mute')).toHaveText('Ctrl+Shift+M');
  expect(await calls()).toContainEqual(['pause', false]);

  await page.click('#hotkey-mute');
  await page.keyboard.press('Control+Alt+K');
  await expect(page.locator('#hotkey-mute')).toHaveText('Ctrl+Alt+K');
  expect(await calls()).toContainEqual(['setHotkey', 'mute', 'Ctrl+Alt+K']);
  // M in the room no longer matters while the dialog is open; F keys work alone.
  await page.click('#hotkey-overlay');
  await page.keyboard.press('F9');
  await expect(page.locator('#hotkey-overlay')).toHaveText('F9');

  // Taken by another program: the app refuses, the old shortcut stays.
  await page.click('#hotkey-overlay');
  await page.keyboard.press('Control+Alt+T');
  await expect(page.locator('#overlay-settings .error')).toContainText('zajęty');
  await expect(page.locator('#hotkey-overlay')).toHaveText('F9');

  await page.getByRole('button', { name: 'Przywróć domyślne skróty' }).click();
  await expect(page.locator('#hotkey-overlay')).toHaveText('Ctrl+Shift+O');
  await expect(page.locator('#hotkey-mute')).toHaveText('Ctrl+Shift+M');
});
