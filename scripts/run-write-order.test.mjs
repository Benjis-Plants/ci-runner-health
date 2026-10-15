import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate } from './run.mjs';

const NOW = new Date('2026-10-15T12:00:00.000Z');
const online = [{ name: 'r', status: 'online', labels: [{ name: 'benjis-ci' }] }];

function client({ state, current, runners, failState = false, failOrg = false }) {
  const s = { state, current };
  const c = {
    s,
    failState,
    failOrg,
    getRepoVariable: async () => (s.state == null ? null : JSON.stringify(s.state)),
    getOrgVariable: async () => s.current,
    listRunners: async () => runners,
    listQueuedRuns: async () => [],
    setRepoVariable: async (_n, v) => { if (c.failState) throw new Error('state 5xx'); s.state = JSON.parse(v); },
    setOrgVariable: async (_n, v) => { if (c.failOrg) throw new Error('org 5xx'); s.current = v; },
    postSlack: async () => {},
    cancelRun: async () => {},
    rerunRun: async () => {},
  };
  return c;
}
const ev = (c) => evaluate({ client: c, now: NOW, log: () => {}, captureError: async () => {} });

test('flip_hosted: failed org write rejects but state is recorded (flipped=true) so the next cycle retries', async () => {
  const c = client({ state: { misses: 2, healthy: 0, flipped: false, last_alert: null }, current: '"benjis-ci"', runners: [], failOrg: true });
  await assert.rejects(ev(c), /org 5xx/);
  assert.equal(c.s.state.flipped, true);
  assert.equal(c.s.current, '"benjis-ci"');
  c.failOrg = false;
  await ev(c);
  assert.equal(c.s.current, '"ubuntu-latest"');
});

test('flip_hosted: failed state write rejects and leaves org variable untouched', async () => {
  const c = client({ state: { misses: 2, healthy: 0, flipped: false, last_alert: null }, current: '"benjis-ci"', runners: [], failState: true });
  await assert.rejects(ev(c), /state 5xx/);
  assert.equal(c.s.current, '"benjis-ci"');
});

test('flip_back: failed org write rejects and keeps flipped=true so the fleet is not stranded', async () => {
  const c = client({ state: { misses: 0, healthy: 2, flipped: true, last_alert: null }, current: '"ubuntu-latest"', runners: online, failOrg: true });
  await assert.rejects(ev(c), /org 5xx/);
  assert.equal(c.s.state.flipped, true);
  assert.equal(c.s.current, '"ubuntu-latest"');
  c.failOrg = false;
  await ev(c);
  assert.equal(c.s.current, '"benjis-ci"');
  assert.equal(c.s.state.flipped, false);
});

test('flip_back: failed state write after org write rejects; next cycle recovers', async () => {
  const c = client({ state: { misses: 0, healthy: 2, flipped: true, last_alert: null }, current: '"ubuntu-latest"', runners: online, failState: true });
  await assert.rejects(ev(c), /state 5xx/);
  assert.equal(c.s.current, '"benjis-ci"');
  assert.equal(c.s.state.flipped, true);
  c.failState = false;
  await ev(c);
  assert.equal(c.s.state.flipped, false);
  assert.equal(c.s.current, '"benjis-ci"');
});
