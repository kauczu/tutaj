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

test('picture-in-picture (browser): the others’ cameras on top, with mic, camera and hang-up buttons', async ({ browser }) => {
  // Real Document Picture-in-Picture (Chromium, Edge — headless too, on localhost).
  const bartek = await Participant.join(browser, srv.url, 'pip', 'Bartek');
  const ania = await Participant.join(browser, srv.url, 'pip', 'Ania');
  people.push(bartek, ania);
  await ania.expectVideoFrom('Bartek');
  await expect(ania.page.locator('#btn-pip')).toBeVisible();

  // P opens it (also the button); live video of Bartek, muted (audio stays in the tab).
  const [pip] = await Promise.all([ania.context.waitForEvent('page'), ania.page.keyboard.press('p')]);
  await expect(pip).toHaveTitle('Tutaj — obraz w obrazie');
  await expect(ania.page.locator('#btn-pip')).toHaveAttribute('aria-pressed', 'true');
  await expect(pip.locator('.tile .name')).toHaveText(['Bartek']);
  await expect.poll(() => pip.locator('.tile video').evaluate((v: HTMLVideoElement) => v.videoWidth > 0 && v.muted && !v.paused)).toBe(true);

  // Buttons act on the call.
  await pip.click('#pip-mic');
  await expect(ania.page.locator('#btn-mic')).toHaveAttribute('aria-pressed', 'false');
  await expect(pip.locator('#pip-mic')).toHaveClass(/off/);
  await expect(bartek.tile('Ania')).toHaveClass(/muted/);
  await pip.click('#pip-cam');
  await expect(ania.page.locator('#btn-cam')).toHaveAttribute('aria-pressed', 'false');
  await expect(bartek.tile('Ania')).toHaveClass(/no-video/);

  // The call shows up here: Bartek's reaction and muting.
  await bartek.page.click('#btn-react');
  await bartek.page.locator('#reaction-picker button', { hasText: '👏' }).click();
  await expect(pip.locator('.tile .reaction')).toHaveText('👏');
  await bartek.page.click('#btn-mic');
  await expect(pip.locator('.tile')).toHaveClass(/muted/);

  // Hang up from the mini window: back to the lobby, window closed.
  await pip.click('#pip-leave');
  await expect(ania.page.locator('#join-form')).toBeVisible();
  await expect.poll(() => pip.isClosed()).toBe(true);
  await expect(bartek.tile('Ania')).toHaveCount(0);
});

test('no picture-in-picture in the desktop app (it has the game overlay)', async ({ browser }) => {
  const ania = await Participant.open(browser, srv.url, 'pip-desk', 'Ania');
  people.push(ania);
  await ania.page.addInitScript(() => {
    (window as unknown as { tutaj: unknown }).tutaj = { isDesktop: true, info: async () => null, switchMode: async () => {} };
  });
  await ania.page.reload();
  await ania.page.fill('#name', 'Ania');
  await ania.submitJoin();
  await expect(ania.page.locator('#room-view')).toBeVisible();
  await expect(ania.page.locator('#btn-pip')).toBeHidden();
});
