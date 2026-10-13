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

/** Asserts that the camera window shows live video for `name` (decoding, frames advancing). */
async function expectLiveTile(stage: Page, name: string): Promise<void> {
  const video = stage.locator('.tile', { has: stage.locator('.name', { hasText: new RegExp(`^${name}$`) }) }).locator('video');
  await expect
    .poll(async () => {
      const t0 = await video.evaluate((v: HTMLVideoElement) => v.currentTime);
      await stage.waitForTimeout(400);
      return video.evaluate((v: HTMLVideoElement, t: number) => v.videoWidth > 0 && v.muted && v.currentTime - t > 0.15, t0);
    })
    .toBe(true);
}

test('camera window: remote cameras in their own window, kept in sync with the call', async ({ browser }) => {
  const ania = await Participant.join(browser, srv.url, 'ekran', 'Ania');
  const bartek = await Participant.join(browser, srv.url, 'ekran', 'Bartek');
  const celina = await Participant.join(browser, srv.url, 'ekran', 'Celina');
  people.push(ania, bartek, celina);
  await ania.expectVideoFrom('Celina');

  const [stage] = await Promise.all([ania.page.waitForEvent('popup'), ania.page.click('#btn-stage')]);
  await expect(ania.page.locator('#btn-stage')).toHaveAttribute('aria-pressed', 'true');
  await expect(stage).toHaveTitle('Tutaj — kamery');
  // Others only by default: our own camera stays in the call window.
  await expect(stage.locator('.tile .name')).toHaveText(['Bartek', 'Celina']);
  await expectLiveTile(stage, 'Bartek');
  await expectLiveTile(stage, 'Celina');

  await stage.click('#stage-self');
  await expect(stage.locator('.tile .name')).toHaveText(['Ania (Ty)', 'Bartek', 'Celina']);
  await expect(stage.locator('#grid')).toHaveAttribute('data-count', '3');

  // State changes in the call show up here: mute, speaking (fake mic beeps), leaving.
  await bartek.page.click('#btn-mic');
  await expect(stage.locator('.tile', { hasText: 'Bartek' })).toHaveClass(/muted/);
  await expect(stage.locator('.tile.speaking', { hasText: 'Celina' })).toHaveCount(1);
  await celina.page.click('#btn-leave');
  await expect(stage.locator('.tile .name')).toHaveText(['Ania (Ty)', 'Bartek']);

  // Closing the window from its own toolbar updates the call's button.
  await stage.click('text=Zamknij');
  await expect(ania.page.locator('#btn-stage')).toHaveAttribute('aria-pressed', 'false');

  // Keyboard shortcut reopens it; leaving the call closes it.
  const [again] = await Promise.all([ania.page.waitForEvent('popup'), ania.page.keyboard.press('k')]);
  // "Show me" is remembered.
  await expect(again.locator('#stage-self')).toHaveAttribute('aria-pressed', 'true');
  await expect(again.locator('.tile .name')).toHaveText(['Ania (Ty)', 'Bartek']);
  await expectLiveTile(again, 'Bartek');
  await ania.page.click('#btn-leave');
  await expect.poll(() => again.isClosed()).toBe(true);
});
