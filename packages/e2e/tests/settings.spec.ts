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

test('settings: topics on the left, one at a time; the last one opens again; keyboard works', async ({ browser }) => {
  const ania = await Participant.join(browser, srv.url, 'ustawienia', 'Ania');
  people.push(ania);
  const page = ania.page;
  const tabs = page.locator('#settings .settings-tab:visible');

  await page.click('#btn-settings');
  // No overlay topic in the browser (desktop app only).
  await expect(tabs).toHaveText(['Urządzenia', 'Jakość', 'Połączenie', 'Pokój', 'O aplikacji']);
  await expect(page.locator('#tab-devices')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#set-audio-input')).toBeVisible();
  await expect(page.locator('#quality-room-profile')).toBeHidden();

  await page.click('#tab-room');
  await expect(page.locator('#panel-room h3')).toHaveText('Pokój');
  await expect(page.locator('#host-lock')).toBeVisible();
  await expect(page.locator('#set-audio-input')).toBeHidden();

  // Arrow keys move between topics.
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('#tab-about')).toBeFocused();
  await expect(page.locator('#about')).toBeVisible();
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('#tab-devices')).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('End');
  await page.keyboard.press('ArrowUp');
  await expect(page.locator('#tab-room')).toHaveAttribute('aria-selected', 'true');

  await page.click('#settings button[value="close"]');
  await expect(page.locator('#settings')).not.toHaveAttribute('open', '');
  await page.click('#btn-settings');
  await expect(page.locator('#tab-room')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#host-lock')).toBeVisible();
});
