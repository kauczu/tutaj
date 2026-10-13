import { createHash } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { closeAll, Participant, startTestServer, type TestServer } from './helpers.js';

let srv: TestServer;
test.beforeEach(async () => {
  srv = await startTestServer();
});
test.afterEach(async () => {
  await closeAll(srv);
});

test('two people: P2P video both ways, chat and a file over DataChannel', async ({ browser }) => {
  const ania = await Participant.join(browser, srv.url, 'pokoj-a', 'Ania');
  const bartek = await Participant.join(browser, srv.url, 'pokoj-a', 'Bartek');

  await ania.expectVideoFrom('Bartek');
  await bartek.expectVideoFrom('Ania');
  await expect(ania.badge).toHaveText('P2P');
  await ania.expectMediaPath('mesh');
  // Plain browser: no desktop-only parts.
  await expect(ania.page.locator('#btn-overlay')).toBeHidden();
  await expect(ania.page.locator('#host-details')).toBeHidden();

  // Chat (HTML must be shown as text, links become links).
  await ania.sendChat('Cześć! <b>tu</b> https://example.com');
  await expect(bartek.chatMessages().last()).toHaveText('Cześć! <b>tu</b> https://example.com');
  await expect(bartek.chatMessages().last().locator('a')).toHaveAttribute('href', 'https://example.com');

  // File transfer, verified byte for byte.
  const data = Buffer.from(Array.from({ length: 700 * 1024 }, (_, i) => (i * 31) % 256));
  const digest = createHash('sha256').update(data).digest('hex');
  await ania.page.setInputFiles('#chat-file-input', { name: 'dane.bin', mimeType: 'application/octet-stream', buffer: data });
  await bartek.page.click('#btn-chat');
  const link = bartek.page.locator('#chat-list a[download="dane.bin"]');
  await expect(link).toBeVisible();
  const received = await link.evaluate(async (a: HTMLAnchorElement) => {
    const buf = await (await fetch(a.href)).arrayBuffer();
    const hash = await crypto.subtle.digest('SHA-256', buf);
    return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
  });
  expect(received).toBe(digest);

  await closeAll(ania, bartek);
});

test('three people: full mesh, mute and hand raise propagate, leaving removes the tile', async ({ browser }) => {
  const a = await Participant.join(browser, srv.url, 'pokoj-b', 'Ania');
  const b = await Participant.join(browser, srv.url, 'pokoj-b', 'Bartek');
  const c = await Participant.join(browser, srv.url, 'pokoj-b', 'Celina');

  for (const [p, others] of [
    [a, ['Bartek', 'Celina']],
    [b, ['Ania', 'Celina']],
    [c, ['Ania', 'Bartek']],
  ] as const) {
    for (const o of others) await p.expectVideoFrom(o);
  }

  await c.page.click('#btn-mic');
  await c.page.click('#btn-hand');
  await expect(a.tile('Celina')).toHaveClass(/muted/);
  await expect(a.tile('Celina')).toHaveClass(/hand-up/);

  await c.page.click('#btn-leave');
  await expect(a.tile('Celina')).toHaveCount(0);
  await expect(b.tile('Celina')).toHaveCount(0);
  await expect(a.systemMessages().last()).toHaveText('Celina opuszcza pokój');

  await closeAll(a, b, c);
});

test('camera off shows the avatar and stops video; on again restores it', async ({ browser }) => {
  const a = await Participant.join(browser, srv.url, 'pokoj-c', 'Ania');
  const b = await Participant.join(browser, srv.url, 'pokoj-c', 'Bartek');
  await b.expectVideoFrom('Ania');

  await a.page.click('#btn-cam');
  await expect(b.tile('Ania')).toHaveClass(/no-video/);
  await expect(b.tile('Ania').locator('.avatar')).toHaveText('A');

  await a.page.click('#btn-cam');
  await expect(b.tile('Ania')).not.toHaveClass(/no-video/);
  await b.expectVideoFrom('Ania');

  await closeAll(a, b);
});

test('lobby shows server errors: wrong password and full room', async ({ browser }) => {
  const owner = await Participant.join(browser, srv.url, 'tajny', 'Ania', 'haslo123');

  const intruder = await Participant.open(browser, srv.url, 'tajny', 'Ewa');
  await intruder.submitJoin('zle');
  await expect(intruder.page.locator('#lobby-error')).toHaveText('Nieprawidłowe hasło pokoju');
  await expect(intruder.page.locator('#room-view')).toBeHidden();

  await closeAll(owner, intruder);

  const small = await startTestServer({ maxPeers: 1 });
  const first = await Participant.join(browser, small.url, 'maly', 'Ania');
  const second = await Participant.open(browser, small.url, 'maly', 'Bartek');
  await second.submitJoin();
  await expect(second.page.locator('#lobby-error')).toContainText('Pokój jest pełny');
  await closeAll(first, second, small);
});
