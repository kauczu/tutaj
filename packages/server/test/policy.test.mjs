import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ModePolicy, STRIKES_TO_SWITCH } from '../dist/policy.js';

const ok = { bw: false, cpu: false, relayed: false, uplinkKbps: 5000 };
const limited = { ...ok, bw: true };

test('mesh by default; two people never switch, even with a weak uplink', () => {
  const p = new ModePolicy(true);
  assert.equal(p.mode, 'mesh');
  for (let i = 0; i < 10; i++) assert.equal(p.report('a', limited, 2), null);
  assert.equal(p.mode, 'mesh');
});

test('3+ people: sustained bandwidth limitation moves the room to SFU', () => {
  const p = new ModePolicy(true);
  for (let i = 1; i < STRIKES_TO_SWITCH; i++) assert.equal(p.report('a', limited, 3), null);
  assert.deepEqual(p.report('a', limited, 3), { mode: 'sfu', reason: 'bandwidth' });
});

test('a good report resets strikes (short dips are ignored)', () => {
  const p = new ModePolicy(true);
  for (let i = 0; i < 10; i++) {
    p.report('a', limited, 3);
    assert.equal(p.report('a', ok, 3), null);
  }
  assert.equal(p.mode, 'mesh');
});

test('uplink too small for N-1 streams counts as limitation; CPU is reported as cpu', () => {
  const p = new ModePolicy(true);
  let d = null;
  for (let i = 0; i < STRIKES_TO_SWITCH; i++) d = p.report('a', { ...ok, uplinkKbps: 600 }, 4);
  assert.deepEqual(d, { mode: 'sfu', reason: 'bandwidth' });

  const q = new ModePolicy(true);
  for (let i = 0; i < STRIKES_TO_SWITCH; i++) d = q.report('b', { ...ok, cpu: true }, 3);
  assert.deepEqual(d, { mode: 'sfu', reason: 'cpu' });
});

test('TURN-relayed mesh with 3 people switches right away', () => {
  const p = new ModePolicy(true);
  assert.deepEqual(p.report('a', { ...ok, relayed: true }, 3), { mode: 'sfu', reason: 'relay' });
});

test('stays on SFU while 3+, returns to mesh at 2', () => {
  const p = new ModePolicy(true);
  p.report('a', { ...ok, relayed: true }, 3);
  assert.equal(p.participantsChanged(4), null);
  assert.equal(p.report('b', ok, 4), null);
  assert.equal(p.participantsChanged(3, 'c'), null);
  assert.deepEqual(p.participantsChanged(2, 'a'), { mode: 'mesh', reason: 'participants' });
});

test('manual preference overrides, auto restores the automatic choice', () => {
  const p = new ModePolicy(true);
  assert.deepEqual(p.setPref('sfu', 2), { mode: 'sfu', reason: 'manual' });
  assert.deepEqual(p.setPref('auto', 2), { mode: 'mesh', reason: 'participants' });
  assert.equal(p.setPref('mesh', 2), null);
  p.report('a', { ...ok, relayed: true }, 3);
  assert.equal(p.mode, 'mesh');
});

test('without SFU everything stays mesh; losing the SFU falls back', () => {
  const p = new ModePolicy(false);
  assert.equal(p.setPref('sfu', 3), null);
  assert.equal(p.mode, 'mesh');

  const q = new ModePolicy(true);
  q.setPref('sfu', 3);
  assert.deepEqual(q.disableSfu(3), { mode: 'mesh', reason: 'sfu-unavailable' });
});

test('high-quality media (gaming profile): 3 people switch to SFU right away, 2 stay on mesh', () => {
  const p = new ModePolicy(true);
  assert.equal(p.report('a', { ...ok, hq: true }, 2), null);
  assert.equal(p.mode, 'mesh');
  assert.deepEqual(p.report('a', { ...ok, hq: true }, 3), { mode: 'sfu', reason: 'quality' });
});
