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
    settings: { enabled: false, corner: 'top-right', size: 'm', opacity: 0.85, display: null, minimizeCall: false } as Record<string, unknown>,
  });
  const defaults: Record<string, string> = {
    overlay: 'CommandOrControl+Shift+O',
    mute: 'CommandOrControl+Shift+M',
    window: 'CommandOrControl+Shift+H',
  };
  let hotkeys = { ...defaults };
  (window as unknown as { tutaj: unknown }).tutaj = {
    isDesktop: true,
    info: async () => ({ appVersion: '9.9.9', mode: 'remote', serverUrl: location.origin, defaultServer: location.origin, lan: null }),
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
  // Desktop app: overlay button in the call bar, with its shortcut.
  await expect(ania.page.locator('#btn-overlay')).toBeVisible();
  await expect(ania.page.locator('#btn-overlay')).toHaveAttribute('title', 'Nakładka na grę (Ctrl+Shift+O)');

  // Turned on in the settings (the desktop app also toggles it with Ctrl+Shift+O).
  await ania.page.click('#btn-settings');
  await expect(ania.page.locator('#overlay-settings')).toBeVisible();
  // One monitor: no monitor choice.
  await expect(ania.page.locator('#overlay-display')).toHaveCount(0);
  const [overlay] = await Promise.all([ania.page.waitForEvent('popup'), ania.page.check('#overlay-enabled')]);
  await expect(overlay).toHaveTitle('Tutaj — nakładka');
  expect(await ania.page.evaluate(() => window.__ov.settings.enabled)).toBe(true);
  await expect(ania.page.locator('#btn-overlay')).toHaveAttribute('aria-pressed', 'true');

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

  // Overlay shortcut hides it, the button shows it again; leaving the call releases the shortcuts.
  await ania.page.evaluate(() => window.__ov.hotkey?.('overlay'));
  await expect.poll(() => overlay.isClosed()).toBe(true);
  expect(await ania.page.evaluate(() => window.__ov.settings.enabled)).toBe(false);
  await expect(ania.page.locator('#btn-overlay')).toHaveAttribute('aria-pressed', 'false');
  const [again] = await Promise.all([ania.page.waitForEvent('popup'), ania.page.click('#btn-overlay')]);
  await expect(again.locator('.tile .name')).toHaveText(['Bartek']);
  await ania.page.click('#btn-overlay');
  await expect.poll(() => again.isClosed()).toBe(true);

  // "Minimize the call window with the overlay" is the app's job; the page only stores the choice.
  await ania.page.click('#btn-settings');
  await ania.page.check('#overlay-minimize');
  await expect.poll(() => ania.page.evaluate(() => window.__ov.settings.minimizeCall)).toBe(true);
  await ania.page.getByRole('button', { name: 'Zamknij' }).click();
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
  await expect(page.locator('#hotkey-window')).toHaveText('Ctrl+Shift+H');

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

test('desktop lobby: server block collapsed, server and app versions in the footer', async ({ browser }) => {
  const ania = await Participant.open(browser, srv.url, 'lobby', 'Ania');
  people.push(ania);
  await ania.page.addInitScript(fakeDesktopBridge);
  await ania.page.reload();
  const details = ania.page.locator('#host-details');
  await expect(details).toBeVisible();
  await expect(ania.page.locator('#host-summary')).toHaveText('Serwer i sieć — 127.0.0.1:' + new URL(srv.url).port);
  await expect(details).not.toHaveAttribute('open', '');
  await expect(ania.page.getByRole('button', { name: 'Przełącz na tryb lokalny (sieć LAN)' })).toBeHidden();
  await ania.page.click('#host-summary');
  await expect(ania.page.getByRole('button', { name: 'Przełącz na tryb lokalny (sieć LAN)' })).toBeVisible();
  // Help in the app: the overlay section with the current shortcuts, and the Alt menu hint.
  await ania.page.keyboard.press('F1');
  await expect(ania.page.locator('#help h3')).toContainText(['Gra: nakładka i skróty']);
  await expect(ania.page.locator('#help')).toContainText('Ctrl+Shift+H');
  await expect(ania.page.locator('#help')).toContainText('pokazuje menu');
  await ania.page.keyboard.press('Escape');
  await expect(ania.page.locator('#lobby-footer')).toContainText(/serwer v\d+\.\d+\.\d+ · aplikacja v9\.9\.9/);
});
