import { expect, test, type Locator, type Page } from '@playwright/test';
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

const SHOTS = process.env.TUTAJ_SHOTS;

async function area(el: Locator): Promise<number> {
  const b = (await el.boundingBox())!;
  return b.width * b.height;
}

async function shot(page: Page, name: string): Promise<void> {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

test('phone: the other person fills the screen, own camera floats, the bar hides and comes back', async ({ browser }) => {
  const bartek = await Participant.join(browser, srv.url, 'telefon', 'Bartek');
  const ania = await Participant.open(browser, srv.url, 'telefon', 'Ania');
  people.push(bartek, ania);
  const page = ania.page;
  await page.setViewportSize({ width: 390, height: 844 });
  await ania.submitJoin();
  await ania.expectVideoFrom('Bartek');
  const screen = 390 * 844;

  // Bartek: the whole screen; Ania's own camera: a small window in the bottom-right corner, above the bar.
  const remote = ania.tile('Bartek');
  const self = page.locator('.tile.local');
  expect(await area(remote)).toBeGreaterThan(screen * 0.95);
  expect(await area(self)).toBeLessThan(screen * 0.1);
  const selfBox = (await self.boundingBox())!;
  const barBox = (await page.locator('.controls').boundingBox())!;
  expect(selfBox.x + selfBox.width).toBeGreaterThan(390 - 30);
  expect(selfBox.y + selfBox.height).toBeLessThanOrEqual(barBox.y);

  // One row: mic, camera, reaction, chat, more, hang up; the rest under "more".
  await expect(page.locator('.controls .buttons button:visible')).toHaveCount(6);
  expect(barBox.height).toBeLessThan(100);
  await shot(page, 'phone-call');

  // The bar hides by itself and a tap on the picture brings it back.
  await expect(page.locator('#room-view')).toHaveClass(/controls-hidden/, { timeout: 7000 });
  await expect(page.locator('#btn-mic')).not.toBeInViewport();
  await shot(page, 'phone-call-hidden');
  await remote.click({ position: { x: 100, y: 200 } });
  await expect(page.locator('#room-view')).not.toHaveClass(/controls-hidden/);
  await expect(page.locator('#btn-mic')).toBeInViewport();

  // "More": the hidden buttons and the invitation link.
  await page.click('#btn-more');
  const menu = page.locator('#more-menu');
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitem')).toContainText(['Podnieś rękę', 'Ustawienia', 'Kopiuj zaproszenie']);
  await shot(page, 'phone-more');
  await menu.getByRole('menuitem', { name: 'Podnieś rękę' }).click();
  await expect(bartek.tile('Ania')).toHaveClass(/hand-up/);
  // An open menu or dialog keeps the bar up.
  await page.click('#btn-more');
  await page.waitForTimeout(5000);
  await expect(page.locator('#room-view')).not.toHaveClass(/controls-hidden/);
  await page.keyboard.press('Escape');
  await page.mouse.click(200, 300);

  // Tap our own camera: it becomes the big picture; double tap goes back.
  await self.click();
  expect(await area(self)).toBeGreaterThan(screen * 0.5);
  await self.dblclick();
  expect(await area(self)).toBeLessThan(screen * 0.1);

  // Drag it to the top-left corner: it stays there.
  await page.waitForTimeout(400); // let it settle in its corner first
  const from = (await self.boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(60, 120, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => (await self.boundingBox())!.x).toBeLessThan(30);
  expect((await self.boundingBox())!.y).toBeLessThan(40);
  expect(await area(self)).toBeLessThan(screen * 0.1); // a drag is not a tap
  expect(await page.evaluate(() => localStorage.getItem('tutaj:selfview-corner'))).toBe('tl');

  // Landscape phone: same idea.
  await page.setViewportSize({ width: 844, height: 390 });
  expect(await area(remote)).toBeGreaterThan(844 * 390 * 0.95);
  expect(await area(self)).toBeLessThan(844 * 390 * 0.12);
  await shot(page, 'phone-landscape');

  // Desktop width: the usual grid and bar, nothing hidden.
  await page.setViewportSize({ width: 1280, height: 720 });
  await expect(page.locator('#btn-more')).toBeHidden();
  await expect(page.locator('#btn-settings')).toBeVisible();
  expect(await area(self)).toBeGreaterThan(1280 * 720 * 0.2);
});

test('phone with three: the two others share the screen', async ({ browser }) => {
  const bartek = await Participant.join(browser, srv.url, 'trojka', 'Bartek');
  const celina = await Participant.join(browser, srv.url, 'trojka', 'Celina');
  const ania = await Participant.open(browser, srv.url, 'trojka', 'Ania');
  people.push(bartek, celina, ania);
  await ania.page.setViewportSize({ width: 390, height: 844 });
  await ania.submitJoin();
  await ania.expectVideoFrom('Bartek');
  await ania.expectVideoFrom('Celina');
  // One above the other, each the full width.
  for (const name of ['Bartek', 'Celina']) {
    const box = (await ania.tile(name).boundingBox())!;
    expect(box.width).toBe(390);
    expect(box.height).toBeGreaterThan(844 * 0.45);
  }
  expect(await area(ania.page.locator('.tile.local'))).toBeLessThan(390 * 844 * 0.1);
  await shot(ania.page, 'phone-three');
});

test('iPhone: after the mic is re-opened (studio audio) the pictures are attached to their players again', async ({ browser }) => {
  // WebKit on iOS stops scaling the picture after an audio session change; re-attaching the stream fixes it.
  const IPHONE = {
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  };
  const bartek = await Participant.join(browser, srv.url, 'iphone', 'Bartek');
  const ania = await Participant.open(browser, srv.url, 'iphone', 'Ania', undefined, IPHONE);
  people.push(bartek, ania);
  await ania.submitJoin();
  await ania.expectVideoFrom('Bartek');
  await ania.page.evaluate(() => {
    (window as unknown as { __attached: number }).__attached = 0;
    document.addEventListener('loadstart', () => (window as unknown as { __attached: number }).__attached++, true);
  });
  await ania.page.locator('#btn-more').tap();
  await ania.page.locator('#more-menu').getByRole('menuitem', { name: 'Ustawienia' }).tap();
  await ania.page.locator('#tab-quality').tap();
  await ania.page.selectOption('#quality-room-audio', 'studio');
  // Both pictures (own and Bartek's), twice: once the audio session has settled.
  await expect.poll(() => ania.page.evaluate(() => (window as unknown as { __attached: number }).__attached), { timeout: 6000 }).toBeGreaterThanOrEqual(4);
  await ania.page.locator('#settings button[value="close"]').tap();
  await ania.expectVideoFrom('Bartek');
});
