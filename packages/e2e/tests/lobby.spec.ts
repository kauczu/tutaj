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

test('lobby remembers the last name and room; an invitation link still wins', async ({ browser }) => {
  const ania = await Participant.join(browser, srv.url, 'stala-ekipa', 'Ania');
  people.push(ania);
  await ania.page.click('#btn-leave');
  await expect(ania.page.locator('#join-form')).toBeVisible();

  // A fresh start of the app (no ?room= in the address).
  await ania.page.goto(srv.url);
  await expect(ania.page.locator('#name')).toHaveValue('Ania');
  await expect(ania.page.locator('#room')).toHaveValue('stala-ekipa');

  await ania.page.goto(`${srv.url}/?room=zaproszenie`);
  await expect(ania.page.locator('#room')).toHaveValue('zaproszenie');
});

test('help: from the lobby footer, with F1 and from the settings; desktop parts only in the app', async ({ browser }) => {
  const ania = await Participant.open(browser, srv.url, 'pomoc', 'Ania');
  people.push(ania);
  const page = ania.page;
  const help = page.locator('#help');

  await page.locator('#lobby-footer').getByRole('button', { name: 'Pomoc' }).click();
  await expect(help).toBeVisible();
  await expect(help.locator('h3')).toHaveText([
    'Jak zacząć',
    'W trakcie rozmowy',
    'Gospodarz pokoju 👑',
    'Jakość obrazu i dźwięku',
    'Prywatność i szyfrowanie',
    'Klucz właściciela serwera',
    'Gdy coś nie działa',
  ]);
  await expect(help.locator('ol.steps li')).toHaveCount(4);
  await expect(help).toContainText('deploy/.env');
  // Plain browser: no overlay section, no desktop menu hint.
  await expect(help).not.toContainText('nakładka');
  await help.getByRole('button', { name: 'Zamknij' }).click();
  await expect(help).toBeHidden();

  // The quiet pointer under "Join" opens the same guide.
  await page.getByRole('button', { name: 'Pierwszy raz? Jak zacząć' }).click();
  await expect(help.locator('h3').first()).toHaveText('Jak zacząć');
  await help.getByRole('button', { name: 'Zamknij' }).click();

  await ania.submitJoin();
  await expect(page.locator('#room-view')).toBeVisible();
  await page.keyboard.press('F1');
  await expect(help).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(help).toBeHidden();

  // From the settings dialog: help opens on top, closing it returns to the settings.
  await page.click('#btn-settings');
  await page.click('#open-help');
  await expect(help).toBeVisible();
  await help.getByRole('button', { name: 'Zamknij' }).click();
  await expect(page.locator('#settings')).toBeVisible();
});
