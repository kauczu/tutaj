import { expect, test } from '@playwright/test';
import { startTestServer, type TestServer } from './helpers.js';

let srv: TestServer;
test.beforeEach(async () => {
  srv = await startTestServer();
});
test.afterEach(async () => {
  await srv.server.close();
});

test('English interface for an English browser; the choice in the lobby wins and is remembered', async ({ browser }) => {
  const context = await browser.newContext({ locale: 'en-US', permissions: ['camera', 'microphone'] });
  const page = await context.newPage();
  await page.goto(`${srv.url}/?room=english`);

  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.locator('#join')).toHaveText('Join “english”');
  await expect(page.locator('#tagline')).toHaveText('A coherent communication platform.');
  await expect(page.locator('label', { hasText: 'Your name' })).toBeVisible();
  await expect(page.locator('#lobby-footer')).toContainText('Help');

  // Server errors arrive translated (by code): a wrong room name is checked locally, a wrong password by the server.
  await page.fill('#name', 'Anna');
  await page.click('#join');
  await expect(page.locator('#room-view')).toBeVisible();
  await expect(page.locator('#btn-invite')).toHaveText('Copy invitation');
  await expect(page.locator('#chat-list li.system').first()).toHaveText('You are the first one here — copy the invitation and send it to the others.');
  await page.keyboard.press('F1');
  await expect(page.locator('#help h3').first()).toHaveText('Starting a call');
  await page.keyboard.press('Escape');
  await page.click('#btn-settings');
  await expect(page.locator('#quality-room-profile option:checked')).toHaveText('Call');
  await expect(page.locator('#host-settings legend')).toHaveText('Room host (you)');
  await page.getByRole('button', { name: 'Close' }).click();

  // Someone else with a password-protected room… the server's (Polish) message is shown in English.
  const other = await (await browser.newContext({ locale: 'en-US', permissions: ['camera', 'microphone'] })).newPage();
  await other.goto(`${srv.url}/?room=locked-room`);
  await other.fill('#name', 'Ben');
  await other.click('details summary');
  await other.fill('#password', 'secret');
  await other.click('#join');
  await expect(other.locator('#room-view')).toBeVisible();
  const third = await (await browser.newContext({ locale: 'en-US', permissions: ['camera', 'microphone'] })).newPage();
  await third.goto(`${srv.url}/?room=locked-room`);
  await third.fill('#name', 'Cleo');
  await third.click('details summary');
  await third.fill('#password', 'wrong');
  await third.click('#join');
  await expect(third.locator('#lobby-error')).toHaveText('Wrong room password');

  // Switching to Polish in the lobby reloads in Polish and sticks.
  await third.selectOption('#language', 'pl');
  await expect(third.locator('html')).toHaveAttribute('lang', 'pl');
  await expect(third.locator('#join')).toHaveText('Dołącz do „locked-room”');
  await third.reload();
  await expect(third.locator('#tagline')).toHaveText('Spójna platforma komunikacyjna.');
  await third.click('details summary');
  await expect(third.locator('#language')).toHaveValue('pl');

  await context.close();
  await other.context().close();
  await third.context().close();
});
