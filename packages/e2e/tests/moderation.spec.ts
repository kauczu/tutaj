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

test('host moderation: mute, lock, kick (kept out), hand over the host role', async ({ browser }) => {
  const join = async (name: string) => {
    const p = await Participant.join(browser, srv.url, 'moderacja', name);
    people.push(p);
    return p;
  };
  const ania = await join('Ania');
  const bartek = await join('Bartek');
  const celina = await join('Celina');
  await ania.expectVideoFrom('Celina');

  // Ania created the room: she hosts (👑 for everyone); only she gets the ⋮ menu.
  await expect(bartek.tile('Ania')).toHaveClass(/host/);
  await expect(ania.page.locator('.tile.local')).toHaveClass(/host/);
  await expect(bartek.page.locator('.tile-menu-btn')).toHaveCount(0);
  await expect(ania.page.locator('.tile-menu-btn')).toHaveCount(2);

  // Mute from the tile menu: Bartek's mic goes off (he could turn it on again).
  await ania.tile('Bartek').hover();
  await ania.tile('Bartek').locator('.tile-menu-btn').click();
  await ania.page.getByRole('menuitem', { name: 'Wycisz mikrofon' }).click();
  await expect(bartek.page.locator('#btn-mic')).toHaveAttribute('aria-pressed', 'false');
  await expect(bartek.page.locator('.toast').last()).toContainText('wyciszył(a) Twój mikrofon');
  await expect(ania.tile('Bartek')).toHaveClass(/muted/);

  // Lock: nobody new gets in; everyone sees 🔒.
  await ania.page.click('#btn-settings');
  await ania.page.check('#host-lock');
  await ania.page.getByRole('button', { name: 'Zamknij' }).click();
  await expect(bartek.page.locator('#locked-badge')).toBeVisible();
  const daria = await Participant.open(browser, srv.url, 'moderacja', 'Daria');
  people.push(daria);
  await daria.submitJoin();
  await expect(daria.page.locator('#lobby-error')).toContainText('zablokowany');
  await ania.page.click('#btn-settings');
  await ania.page.uncheck('#host-lock');
  await ania.page.getByRole('button', { name: 'Zamknij' }).click();
  await expect(bartek.page.locator('#locked-badge')).toBeHidden();

  // Kick (after confirming): Celina is back in the lobby with a message, and kept out.
  ania.page.once('dialog', (d) => void d.accept());
  await ania.tile('Celina').hover();
  await ania.tile('Celina').locator('.tile-menu-btn').click();
  await ania.page.getByRole('menuitem', { name: 'Usuń z pokoju…' }).click();
  await expect(celina.page.locator('#lobby-error')).toContainText('usunął(-ęła) Cię z pokoju');
  await expect(ania.tile('Celina')).toHaveCount(0);
  await expect(bartek.tile('Celina')).toHaveCount(0);
  await celina.page.fill('#name', 'Celina');
  await celina.submitJoin();
  await expect(celina.page.locator('#lobby-error')).toContainText('możesz wrócić za 10 min');

  // Hand over: Bartek hosts now.
  await ania.tile('Bartek').hover();
  await ania.tile('Bartek').locator('.tile-menu-btn').click();
  await ania.page.getByRole('menuitem', { name: 'Przekaż rolę gospodarza' }).click();
  await expect(bartek.page.locator('.tile.local')).toHaveClass(/host/);
  await expect(bartek.page.locator('.toast').last()).toContainText('Jesteś teraz gospodarzem');
  await expect(ania.page.locator('.tile-menu-btn')).toHaveCount(0);
  await expect(bartek.page.locator('.tile-menu-btn')).toHaveCount(1);
});
