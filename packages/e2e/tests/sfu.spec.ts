import { expect, test } from '@playwright/test';
import { Bot, closeAll, Participant, startTestServer, type TestServer } from './helpers.js';

let srv: TestServer;
test.beforeEach(async () => {
  srv = await startTestServer({ sfu: true });
  expect(srv.server.sfuEnabled).toBe(true);
});
test.afterEach(async () => {
  await closeAll(srv);
});

test('manual switch to SFU moves media to the server, chat stays P2P, and back to mesh', async ({ browser }) => {
  const a = await Participant.join(browser, srv.url, 'sfu-a', 'Ania');
  const b = await Participant.join(browser, srv.url, 'sfu-a', 'Bartek');
  const c = await Participant.join(browser, srv.url, 'sfu-a', 'Celina');
  await a.expectVideoFrom('Celina');

  await c.setMode('sfu');
  for (const p of [a, b, c]) await expect(p.badge).toHaveText('SFU');
  await expect(a.systemMessages().last()).toHaveText('Przełączam media na serwer SFU (wybór ręczny)');

  for (const p of [a, b, c]) await p.expectMediaPath('sfu');
  await a.expectVideoFrom('Bartek');
  await b.expectVideoFrom('Celina');
  await c.expectVideoFrom('Ania');

  // DataChannels of the (now media-less) mesh still carry chat.
  await b.sendChat('czat w trybie SFU');
  await expect(a.chatMessages().last()).toHaveText('czat w trybie SFU');

  await a.setMode('mesh');
  for (const p of [a, b, c]) await expect(p.badge).toHaveText('P2P');
  for (const p of [a, b, c]) await p.expectMediaPath('mesh');
  await c.expectVideoFrom('Bartek');

  await closeAll(a, b, c);
});

test('auto mode: a TURN-relayed participant moves 3+ people to SFU; at 2 people the room returns to mesh', async ({ browser }) => {
  const a = await Participant.join(browser, srv.url, 'sfu-auto', 'Ania');
  const b = await Participant.join(browser, srv.url, 'sfu-auto', 'Bartek');
  await a.expectVideoFrom('Bartek');
  await expect(a.badge).toHaveText('P2P');

  // A third participant reports that its connections go through TURN.
  const bot = await Bot.join(srv.url, 'sfu-auto');
  bot.send({ type: 'quality', report: { bw: false, cpu: false, relayed: true, uplinkKbps: 4000 } });

  await expect(a.badge).toHaveText('SFU');
  await expect(b.badge).toHaveText('SFU');
  await expect(a.systemMessages().last()).toHaveText('Przełączam media na serwer SFU (połączenia przez serwer TURN)');
  await a.expectMediaPath('sfu');
  await a.expectVideoFrom('Bartek');

  bot.leave();
  await expect(a.badge).toHaveText('P2P');
  await expect(a.systemMessages().last()).toHaveText('Przełączam media na połączenia bezpośrednie P2P (liczba uczestników)');
  await a.expectMediaPath('mesh');
  await b.expectVideoFrom('Ania');

  await closeAll(a, b);
});

test('server outage during an SFU call: media falls back to P2P, clients rejoin when it is back', async ({ browser }) => {
  const a = await Participant.join(browser, srv.url, 'awaria', 'Ania');
  const b = await Participant.join(browser, srv.url, 'awaria', 'Bartek');
  await a.setMode('sfu');
  await expect(b.badge).toHaveText('SFU');
  await b.expectMediaPath('sfu');

  await srv.server.close();
  for (const p of [a, b]) {
    await expect(p.badge).toHaveText('P2P');
    await expect(p.banner).toBeVisible();
  }
  await a.expectMediaPath('mesh');
  await a.expectVideoFrom('Bartek');
  await b.expectVideoFrom('Ania');

  // Same port again: clients reconnect on their own.
  srv = await startTestServer({ sfu: true, port: srv.port });
  for (const p of [a, b]) await expect(p.banner).toBeHidden({ timeout: 30_000 });
  await expect.poll(async () => (await (await fetch(`${srv.url}/api/health`)).json()).clients).toBe(2);
  await a.expectVideoFrom('Bartek');
  await b.expectVideoFrom('Ania');

  await closeAll(a, b);
});
