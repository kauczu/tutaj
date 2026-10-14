// SFU signaling over WebSocket with a real mediasoup worker.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { startServer } from '../dist/server.js';

const SFU_PORT = 40123;
let server;
let url;

before(async () => {
  server = await startServer({
    host: '127.0.0.1',
    port: 0,
    clientDir: null,
    log: () => {},
    sfu: { listenIp: '127.0.0.1', port: SFU_PORT },
  });
  url = `ws://127.0.0.1:${server.httpPort}/ws`;
});
after(() => server.close());

function client() {
  const ws = new WebSocket(url);
  const queue = [];
  const waiters = [];
  ws.on('message', (d) => {
    const msg = JSON.parse(d.toString());
    const i = waiters.findIndex((w) => w.match(msg));
    if (i >= 0) waiters.splice(i, 1)[0].resolve(msg);
    else queue.push(msg);
  });
  let nextId = 1;
  const wait = (match) => {
    const i = queue.findIndex(match);
    if (i >= 0) return Promise.resolve(queue.splice(i, 1)[0]);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout')), 3000);
      waiters.push({ match, resolve: (m) => (clearTimeout(t), resolve(m)) });
    });
  };
  return {
    open: () => new Promise((r) => ws.once('open', r)),
    send: (m) => ws.send(JSON.stringify(m)),
    wait,
    request(method, data) {
      const id = nextId++;
      ws.send(JSON.stringify({ type: 'sfu', id, method, data }));
      return wait((m) => m.type === 'sfu-response' && m.id === id);
    },
    close: () => ws.close(),
  };
}

async function join(room, name) {
  const c = client();
  await c.open();
  // These clients claim end-to-end encryption: without it the room never uses the SFU.
  c.send({ type: 'join', room, name, e2ee: true });
  return { c, welcome: await c.wait((m) => m.type === 'welcome') };
}

test('welcome advertises SFU; requests are refused while the room is in mesh mode', async () => {
  assert.equal(server.sfuEnabled, true);
  const a = await join('sfu1', 'A');
  assert.equal(a.welcome.sfuAvailable, true);
  assert.equal(a.welcome.mode, 'mesh');
  const r = await a.c.request('capabilities');
  assert.equal(r.ok, false);
  a.c.close();
});

test('manual switch to SFU, transports on the single SFU port, back to mesh', async () => {
  const a = await join('sfu2', 'A');
  const b = await join('sfu2', 'B');
  a.c.send({ type: 'set-mode', pref: 'sfu' });
  const modeA = await a.c.wait((m) => m.type === 'mode');
  const modeB = await b.c.wait((m) => m.type === 'mode');
  assert.deepEqual(modeA, { type: 'mode', mode: 'sfu', pref: 'sfu', reason: 'manual', by: 'A' });
  assert.equal(modeB.mode, 'sfu');

  const caps = await a.c.request('capabilities');
  assert.equal(caps.ok, true);
  const mimes = caps.data.codecs.map((c) => c.mimeType);
  assert.ok(mimes.includes('audio/opus') && mimes.includes('video/VP8'));

  const t = await a.c.request('create-transport', { direction: 'send' });
  assert.equal(t.ok, true);
  assert.ok(t.data.iceCandidates.length >= 1);
  assert.ok(t.data.iceCandidates.every((c) => c.port === SFU_PORT));

  const producers = await b.c.request('producers');
  assert.deepEqual(producers, { type: 'sfu-response', id: producers.id, ok: true, data: [] });

  const bad = await a.c.request('connect-transport', { transportId: 'nope', dtlsParameters: {} });
  assert.equal(bad.ok, false);

  a.c.send({ type: 'set-mode', pref: 'auto' });
  const back = await b.c.wait((m) => m.type === 'mode' && m.pref === 'auto');
  assert.equal(back.mode, 'mesh');
  a.c.close();
  b.c.close();
});
