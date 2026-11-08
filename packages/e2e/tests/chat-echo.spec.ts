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

const GAME = { audio: 'studio', resolution: 720, uploadKbps: 0, codec: 'auto', echoCancel: false };
const micEcho = (page: Page) =>
  page.evaluate(() => {
    const track = window.__pcs.flatMap((pc) => pc.getSenders()).find((s) => s.track?.kind === 'audio')?.track;
    return track?.getSettings().echoCancellation;
  });

test('echo cancellation button: only with studio audio, toggles the mic (also with E), remembered', async ({ browser }) => {
  const bartek = await Participant.join(browser, srv.url, 'echo', 'Bartek');
  const ania = await Participant.join(browser, srv.url, 'echo', 'Ania', undefined, GAME);
  people.push(bartek, ania);
  await ania.expectVideoFrom('Bartek');

  // Voice audio always cancels echo: no button there.
  await expect(bartek.page.locator('#btn-echo')).toBeHidden();

  const btn = ania.page.locator('#btn-echo');
  await expect(btn).toBeVisible();
  await expect(btn).toHaveAttribute('aria-pressed', 'false');
  await expect(btn).toHaveAttribute('title', 'Usuwanie echa: wyłączone (E)');
  await expect.poll(() => micEcho(ania.page)).toBe(false);

  await btn.click();
  await expect(btn).toHaveAttribute('aria-pressed', 'true');
  await expect(ania.page.locator('.toast').last()).toHaveText('Usuwanie echa włączone');
  await expect.poll(() => micEcho(ania.page)).toBe(true);
  expect(await ania.page.evaluate(() => JSON.parse(localStorage.getItem('tutaj:quality')!).echoCancel)).toBe(true);
  // The same setting as in Settings → Quality.
  await ania.page.click('#btn-settings');
  await ania.page.click('#tab-quality');
  await expect(ania.page.locator('#quality-room-echo')).toBeChecked();
  await ania.page.getByRole('button', { name: 'Zamknij' }).click();

  await ania.page.keyboard.press('e');
  await expect(btn).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(() => micEcho(ania.page)).toBe(false);
  await bartek.expectVideoFrom('Ania');
});

test('chat notifications: a bubble with the message while the chat is closed, nothing while reading it', async ({ browser }) => {
  const bartek = await Participant.join(browser, srv.url, 'czat', 'Bartek');
  const ania = await Participant.join(browser, srv.url, 'czat', 'Ania');
  people.push(bartek, ania);
  await ania.expectVideoFrom('Bartek');
  // Counts the chimes (the sound is made with WebAudio oscillators).
  await ania.page.evaluate(() => {
    const w = window as unknown as { __chimes: number };
    w.__chimes = 0;
    const start = OscillatorNode.prototype.start;
    OscillatorNode.prototype.start = function (...a: Parameters<typeof start>) {
      w.__chimes++;
      return start.apply(this, a);
    };
  });
  const chimes = () => ania.page.evaluate(() => (window as unknown as { __chimes: number }).__chimes);
  const say = async (text: string) => {
    await bartek.page.click('#btn-chat');
    await bartek.page.fill('#chat-input', text);
    await bartek.page.keyboard.press('Enter');
    await bartek.page.click('#chat-close');
  };

  await say('Cześć, gramy o 20?');
  await expect(ania.page.locator('.toast', { hasText: 'Bartek: Cześć, gramy o 20?' })).toBeVisible();
  await expect(ania.page.locator('#chat-badge')).toHaveText('1');
  await expect.poll(chimes).toBe(2); // two notes

  // Reading the chat: no bubble, no sound.
  await ania.page.click('#btn-chat');
  await say('Jasne');
  await expect(ania.page.locator('#chat-list')).toContainText('Jasne');
  await expect(ania.page.locator('.toast', { hasText: 'Jasne' })).toHaveCount(0);
  expect(await chimes()).toBe(2);
  await ania.page.click('#chat-close');

  // Sound off in Settings → Devices: the bubble stays, the chime goes.
  await ania.page.click('#btn-settings');
  await ania.page.click('#tab-devices');
  await ania.page.uncheck('#set-chat-sound');
  await ania.page.getByRole('button', { name: 'Zamknij' }).click();
  await say('Bez dźwięku');
  await expect(ania.page.locator('.toast', { hasText: 'Bartek: Bez dźwięku' })).toBeVisible();
  expect(await chimes()).toBe(2);
  expect(await ania.page.evaluate(() => localStorage.getItem('tutaj:chat-sound'))).toBe('off');
});
