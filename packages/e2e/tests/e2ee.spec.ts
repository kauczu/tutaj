import { expect, test, type Page } from '@playwright/test';
import { Bot, closeAll, Participant, startTestServer, type TestServer } from './helpers.js';

let srv: TestServer;
let people: Participant[] = [];
test.beforeEach(async () => {
  srv = await startTestServer({ sfu: true });
});
test.afterEach(async () => {
  await closeAll(...people, srv);
  people = [];
});

async function join(browser: Parameters<typeof Participant.join>[0], room: string, name: string, debug?: string) {
  const p = await Participant.open(browser, srv.url, room, name);
  if (debug) {
    await p.page.addInitScript((d) => localStorage.setItem('tutaj:e2ee-debug', d), debug);
    await p.page.reload();
    await p.page.fill('#name', name);
  }
  await p.submitJoin();
  await expect(p.page.locator('#room-view')).toBeVisible();
  people.push(p);
  return p;
}

/** Every SFU sender and receiver of the page has an encryption transform attached. */
function transforms(page: Page) {
  return page.evaluate(() =>
    window.__pcs
      .filter((pc) => pc.connectionState === 'connected' && pc.remoteDescription?.sdp.includes('a=ice-lite'))
      .flatMap((pc) =>
        pc
          .getTransceivers()
          // Media transceivers only: not the receive side of send-only ones, not mediasoup's "probator" (padding for bandwidth probing).
          .filter((t) => t.mid !== 'probator' && (t.direction === 'sendonly' ? !!t.sender.track : t.direction === 'recvonly'))
          .map((t) => (t.direction === 'sendonly' ? `send:${t.sender.track!.kind}:${!!t.sender.transform}` : `recv:${t.receiver.track.kind}:${!!t.receiver.transform}`)),
      ),
  );
}

test('SFU media is end-to-end encrypted: frames decrypt only with the keys exchanged over P2P', async ({ browser }) => {
  const a = await join(browser, 'szyfr', 'Ania');
  const b = await join(browser, 'szyfr', 'Bartek');
  // Celina throws away every key she receives.
  const c = await join(browser, 'szyfr', 'Celina', 'ignore-keys');
  await a.expectVideoFrom('Celina');

  await a.setMode('sfu');
  for (const p of [a, b, c]) await expect(p.badge).toHaveText('SFU');
  await expect(a.page.locator('#e2ee-badge')).toBeVisible();
  await expect(a.page.locator('#e2ee-badge')).toHaveAttribute('title', /szyfrowane end-to-end/);
  await a.expectMediaPath('sfu');

  // With keys: video through the SFU. Receivers drop every frame that isn't encrypted with the
  // sender's key (AES-GCM authentication) — Celina below shows the receivers really do decrypt —
  // so video that plays here was encrypted end to end.
  await a.expectVideoFrom('Bartek');
  await b.expectVideoFrom('Celina');
  await expect.poll(() => transforms(a.page)).toEqual(expect.arrayContaining(['send:audio:true', 'send:video:true', 'recv:video:true', 'recv:audio:true']));
  expect((await transforms(a.page)).every((t) => t.endsWith(':true'))).toBe(true);

  // Without keys: frames arrive (the SFU forwards them) but cannot be read. Chromium silently skips
  // a transform attached too late — this is what catches that (frames would play).
  await expect(c.tile('Ania').locator('.status')).toHaveText('Czekam na klucz szyfrowania…');
  const video = c.tile('Ania').locator('video');
  await c.page.waitForTimeout(3000);
  expect(await video.evaluate((v: HTMLVideoElement) => v.videoWidth)).toBe(0);
  const inKB = (await c.traffic()).filter((t) => t.sfu).reduce((s, t) => s + t.inKB, 0);
  expect(inKB).toBeGreaterThan(5);
});

test('keys change when someone leaves; the call goes on for the others', async ({ browser }) => {
  const a = await join(browser, 'rotacja', 'Ania');
  const b = await join(browser, 'rotacja', 'Bartek');
  const c = await join(browser, 'rotacja', 'Celina');
  await a.setMode('sfu');
  for (const p of [a, b, c]) await expect(p.badge).toHaveText('SFU');
  await a.expectVideoFrom('Bartek');

  await c.page.click('#btn-leave');
  // Manual SFU: the room stays on the SFU with 2 people; everyone switched to a new key.
  await expect(a.tile('Celina')).toHaveCount(0);
  await a.page.waitForTimeout(2500);
  await a.expectVideoFrom('Bartek');
  await b.expectVideoFrom('Ania');
  await expect(a.badge).toHaveText('SFU');
});

test('a client that cannot encrypt keeps the room on P2P (which WebRTC encrypts end to end)', async ({ browser }) => {
  const a = await join(browser, 'bez-e2ee', 'Ania');
  const b = await join(browser, 'bez-e2ee', 'Bartek');
  const bot = await Bot.join(srv.url, 'bez-e2ee', 'Stary klient', false);
  await a.setMode('sfu');
  await expect(a.systemMessages().last()).toContainText('ustawia tryb mediów');
  await a.page.waitForTimeout(1000);
  await expect(a.badge).toHaveText('P2P');
  await a.expectVideoFrom('Bartek');

  // Once it leaves, the manual choice applies.
  bot.leave();
  await expect(a.badge).toHaveText('SFU');
  await expect(a.systemMessages().last()).toContainText('Przełączam media na serwer SFU');
  await b.expectVideoFrom('Ania');
});

test('safety codes: both sides of a connection see the same code', async ({ browser }) => {
  const a = await join(browser, 'kody', 'Ania');
  const b = await join(browser, 'kody', 'Bartek');
  await a.expectVideoFrom('Bartek');
  const code = async (p: Participant) => {
    await p.page.click('#btn-settings');
    await p.page.click('#tab-connection');
    const cell = p.page.locator('#peer-stats td.code');
    await expect(cell).toHaveText(/^\d{3} \d{3}$/);
    const text = await cell.innerText();
    await p.page.getByRole('button', { name: 'Zamknij' }).click();
    return text;
  };
  const [ca, cb] = [await code(a), await code(b)];
  expect(ca).toBe(cb);
});

test('if encryption does not work in the browser, nothing is sent to the SFU and the room goes back to P2P', async ({ browser }) => {
  const a = await join(browser, 'awaria', 'Ania');
  const b = await join(browser, 'awaria', 'Bartek');
  // Bartek's browser "silently ignores" encryption: his sending transforms go to a worker that does nothing.
  await b.page.evaluate(() => {
    const Native = window.RTCRtpScriptTransform;
    const idle = new Worker(URL.createObjectURL(new Blob(['/* ignores rtctransform */'], { type: 'text/javascript' })));
    window.RTCRtpScriptTransform = class extends Native {
      constructor(worker: Worker, options?: { op?: string }) {
        super(options?.op === 'encrypt' ? idle : worker, options);
      }
    } as typeof RTCRtpScriptTransform;
  });
  await a.expectVideoFrom('Bartek');
  await a.setMode('sfu');
  // Bartek gives up on the SFU (no frame went through his encryption) and asks the room back to P2P.
  await expect(b.page.locator('.toast').last()).toContainText('Szyfrowanie end-to-end nie działa', { timeout: 20_000 });
  for (const p of [a, b]) await expect(p.badge).toHaveText('P2P');
  await a.expectVideoFrom('Bartek');
});
