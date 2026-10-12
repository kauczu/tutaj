// Integration test of the signaling protocol: node --test packages/server/test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { startServer } from '../dist/server.js';

let server;
let url;

before(async () => {
  server = await startServer({ host: '127.0.0.1', port: 0, clientDir: null, log: () => {} });
  url = `ws://127.0.0.1:${server.httpPort}/ws`;
});
after(() => server.close());

function client() {
  const ws = new WebSocket(url);
  const queue = [];
  const waiters = [];
  ws.on('message', (d) => {
    const msg = JSON.parse(d.toString());
    const w = waiters.shift();
    w ? w(msg) : queue.push(msg);
  });
  return {
    ws,
    open: () => new Promise((r) => ws.once('open', r)),
    send: (m) => ws.send(JSON.stringify(m)),
    next: () =>
      queue.length
        ? Promise.resolve(queue.shift())
        : new Promise((res, rej) => {
            const t = setTimeout(() => rej(new Error('timeout')), 2000);
            waiters.push((m) => (clearTimeout(t), res(m)));
          }),
    close: () => ws.close(),
  };
}

async function joined(room, name, password) {
  const c = client();
  await c.open();
  c.send({ type: 'join', room, name, password });
  return { c, msg: await c.next() };
}

test('join, peer-joined, signal relay, peer-left', async () => {
  const a = await joined('room1', 'Ania');
  assert.equal(a.msg.type, 'welcome');
  assert.deepEqual(a.msg.peers, []);
  assert.ok(a.msg.iceServers.length > 0);

  const b = await joined('ROOM1', 'Bartek'); // room names are case-insensitive
  assert.equal(b.msg.type, 'welcome');
  assert.deepEqual(b.msg.peers, [{ id: a.msg.selfId, name: 'Ania' }]);
  assert.deepEqual(await a.c.next(), { type: 'peer-joined', peer: { id: b.msg.selfId, name: 'Bartek' } });

  b.c.send({ type: 'signal', to: a.msg.selfId, sid: 's1', data: { description: { type: 'offer', sdp: 'v=0' } } });
  assert.deepEqual(await a.c.next(), { type: 'signal', from: b.msg.selfId, sid: 's1', data: { description: { type: 'offer', sdp: 'v=0' } } });

  a.c.send({ type: 'relay', payload: { t: 'chat', text: 'hej' } });
  assert.deepEqual(await b.c.next(), { type: 'relay', from: a.msg.selfId, payload: { t: 'chat', text: 'hej' } });

  b.c.close();
  assert.deepEqual(await a.c.next(), { type: 'peer-left', id: b.msg.selfId, reason: 'disconnect' });
  a.c.close();
});

test('room is limited to 4 participants', async () => {
  const members = [];
  for (let i = 0; i < 4; i++) {
    const m = await joined('full', `P${i}`);
    assert.equal(m.msg.type, 'welcome');
    members.push(m.c);
  }
  const fifth = await joined('full', 'P5');
  assert.equal(fifth.msg.type, 'error');
  assert.equal(fifth.msg.code, 'room-full');
  [...members, fifth.c].forEach((c) => c.close());
});

test('password set by first participant is enforced', async () => {
  const a = await joined('secret', 'A', 'tajne');
  const bad = await joined('secret', 'B', 'zle');
  assert.equal(bad.msg.code, 'bad-password');
  const none = await joined('secret', 'C');
  assert.equal(none.msg.code, 'bad-password');
  const good = await joined('secret', 'D', 'tajne');
  assert.equal(good.msg.type, 'welcome');
  [a, bad, none, good].forEach((x) => x.c.close());
});

test('rejects malformed messages and signals before join', async () => {
  const c = client();
  await c.open();
  c.ws.send('not json');
  assert.equal((await c.next()).code, 'invalid-message');
  c.send({ type: 'join', room: '../etc', name: 'X' });
  assert.equal((await c.next()).code, 'invalid-message');
  c.send({ type: 'signal', to: 'x', sid: 's', data: { candidate: { candidate: 'a' } } });
  assert.equal((await c.next()).code, 'not-joined');
  c.close();
});

test('names are sanitized', async () => {
  const a = await joined('names', '  Ola‮\u0007  ');
  const b = await joined('names', 'B');
  assert.equal(b.msg.peers[0].name, 'Ola');
  a.c.close();
  b.c.close();
});

test('explicit leave is reported as leave', async () => {
  const a = await joined('bye', 'A');
  const b = await joined('bye', 'B');
  await a.c.next(); // peer-joined
  b.c.send({ type: 'leave' });
  assert.deepEqual(await a.c.next(), { type: 'peer-left', id: b.msg.selfId, reason: 'leave' });
  a.c.close();
  b.c.close();
});

test('session resume keeps the identity, even while the stale socket lingers', async () => {
  const a = await joined('resume', 'A');
  const b = await joined('resume', 'B');
  await a.c.next(); // peer-joined B

  // B reconnects before the server noticed its old socket died.
  const b2 = client();
  await b2.open();
  b2.send({ type: 'join', room: 'resume', name: 'B', resume: { id: b.msg.selfId, token: b.msg.resumeToken } });
  const w = await b2.next();
  assert.equal(w.type, 'welcome');
  assert.equal(w.selfId, b.msg.selfId);
  assert.deepEqual(w.peers, [{ id: a.msg.selfId, name: 'A' }]);
  assert.deepEqual(await a.c.next(), { type: 'peer-joined', peer: { id: b.msg.selfId, name: 'B' } });

  // Signals reach the resumed session; the stale socket's close does not evict it.
  await new Promise((r) => setTimeout(r, 100));
  a.c.send({ type: 'signal', to: b.msg.selfId, sid: 'x', data: { candidate: { candidate: 'c' } } });
  assert.equal((await b2.next()).type, 'signal');

  // A forged token gets a fresh identity.
  const c = client();
  await c.open();
  c.send({ type: 'join', room: 'resume', name: 'C', resume: { id: a.msg.selfId, token: 'forged' } });
  const wc = await c.next();
  assert.equal(wc.type, 'welcome');
  assert.notEqual(wc.selfId, a.msg.selfId);
  [a.c, b2, c].forEach((x) => x.close());
});

test('/api/info identifies a Tutaj server (checked by the desktop app before switching servers)', async () => {
  const res = await fetch(url.replace(/^ws/, 'http').replace(/\/ws$/, '/api/info'));
  assert.equal(res.status, 200);
  const info = await res.json();
  assert.equal(info.app, 'tutaj');
  assert.match(info.version, /^\d+\.\d+\.\d+$/);
  assert.equal(info.protocol, 1);
});
