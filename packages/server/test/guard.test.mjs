// Abuse protection: Origin allowlist, per-IP limits, owner key, TURN credential lifetime.
import { test, describe, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { Guard, ipMatches } from '../dist/guard.js';
import { startServer } from '../dist/server.js';

describe('ipMatches / clientIp', () => {
  test('exact IPs and IPv4 CIDRs', () => {
    assert.ok(ipMatches('203.0.113.7', '203.0.113.7'));
    assert.ok(ipMatches('203.0.113.7', '203.0.113.0/24'));
    assert.ok(!ipMatches('203.0.114.7', '203.0.113.0/24'));
    assert.ok(ipMatches('10.1.2.3', '0.0.0.0/0'));
    assert.ok(ipMatches('2001:db8::1', '2001:db8::1'));
    assert.ok(!ipMatches('garbage', '10.0.0.0/8'));
  });

  const req = (remote, headers = {}) => ({ socket: { remoteAddress: remote }, headers });

  test('X-Forwarded-For is used only behind a local proxy, right-most entry wins', () => {
    const g = new Guard({ trustProxy: true });
    assert.equal(g.clientIp(req('::ffff:172.18.0.1', { 'x-forwarded-for': '6.6.6.6, 198.51.100.9' })), '198.51.100.9');
    assert.equal(g.clientIp(req('127.0.0.1', { 'x-real-ip': '198.51.100.10' })), '198.51.100.10');
    // A public peer can't spoof its address with the header.
    assert.equal(g.clientIp(req('203.0.113.50', { 'x-forwarded-for': '1.1.1.1' })), '203.0.113.50');
    // Without trustProxy the header is ignored entirely.
    assert.equal(new Guard().clientIp(req('127.0.0.1', { 'x-forwarded-for': '1.1.1.1' })), '127.0.0.1');
  });
});

describe('server with limits', () => {
  let server;
  let base;
  const OWNER = 'tajny-klucz-wlasciciela';

  before(async () => {
    server = await startServer({
      host: '127.0.0.1',
      port: 0,
      clientDir: null,
      log: () => {},
      ice: { stunUrls: [], turnUrls: ['turn:example.com:3478'], turnSecret: 's', turnTtl: 3600, ownerTurnTtl: 86400 },
      guard: {
        allowedOrigins: ['https://o.example.com'],
        ownerKey: OWNER,
        maxConnectionsPerIp: 6,
        maxRoomsPerIp: 2,
        joinsPerMinute: 8,
      },
    });
    base = `ws://127.0.0.1:${server.httpPort}/ws`;
  });
  after(() => server.close());

  const open = (origin) =>
    new Promise((resolve) => {
      const ws = new WebSocket(base, origin ? { origin } : {});
      ws.once('open', () => resolve({ ws, status: 101 }));
      ws.once('unexpected-response', (_req, res) => resolve({ ws, status: res.statusCode }));
      ws.once('error', () => {});
    });

  const join = (ws, room, ownerKey) =>
    new Promise((resolve) => {
      ws.once('message', (d) => resolve(JSON.parse(d.toString())));
      ws.send(JSON.stringify({ type: 'join', room, name: 'X', ownerKey }));
    });

  const turnTtl = (welcome) => {
    const turn = welcome.iceServers.find((s) => [].concat(s.urls).some((u) => u.startsWith('turn:')));
    return Number(turn.username.split(':')[0]) - Math.floor(Date.now() / 1000);
  };

  test('foreign Origin is rejected with 403; own Origin and non-browser clients pass', async () => {
    const evil = await open('https://evil.example');
    assert.equal(evil.status, 403);
    const own = await open('https://o.example.com');
    assert.equal(own.status, 101);
    const script = await open();
    assert.equal(script.status, 101);
    own.ws.close();
    script.ws.close();
  });

  test('room limit per IP, owner key lifts it and gets long TURN credentials', async () => {
    const sockets = [];
    const conn = async () => {
      const { ws } = await open();
      sockets.push(ws);
      return ws;
    };
    const w1 = await join(await conn(), 'r1');
    assert.equal(w1.type, 'welcome');
    assert.equal(w1.privileged, false);
    assert.ok(Math.abs(turnTtl(w1) - 3600) < 5);
    assert.equal((await join(await conn(), 'r2')).type, 'welcome');
    const third = await join(await conn(), 'r3');
    assert.equal(third.type, 'error');
    assert.equal(third.code, 'room-limit');
    // Joining an existing room is still fine.
    assert.equal((await join(await conn(), 'r1')).type, 'welcome');

    const owner = await join(await conn(), 'r-owner', OWNER);
    assert.equal(owner.type, 'welcome');
    assert.equal(owner.privileged, true);
    assert.ok(Math.abs(turnTtl(owner) - 86400) < 5);

    const wrongKey = await join(await conn(), 'r-zly', 'zly-klucz');
    assert.equal(wrongKey.code, 'room-limit');

    // Connection limit (6 per IP): the next socket gets 429.
    const over = await open();
    assert.equal(over.status, 429);
    for (const ws of sockets) ws.close();
  });

  test('closing rooms frees the quota; join rate limit applies to others but not to the owner', async () => {
    await new Promise((r) => setTimeout(r, 200)); // previous sockets closed → rooms gone
    const { ws } = await open();
    // 8 joins/min per IP (earlier tests used some): keep joining fresh rooms until the limit hits.
    const results = [];
    for (let i = 0; i < 10; i++) {
      const { ws: s } = await open();
      const r = await join(s, `rr${i}`);
      results.push(r.type === 'welcome' ? 'welcome' : r.code);
      s.close();
      await new Promise((res) => setTimeout(res, 50)); // room closes → room quota is not what stops us
      if (r.code === 'rate-limited') break;
    }
    assert.equal(results.at(-1), 'rate-limited', results.join(','));
    assert.ok(!results.includes('room-limit'), 'closed rooms must free the room quota');
    const owner = await join(ws, 'owner-room', OWNER);
    assert.equal(owner.type, 'welcome');
    ws.close();
  });
});
