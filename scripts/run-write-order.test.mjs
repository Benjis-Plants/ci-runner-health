import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate } from './run.mjs';

const NOW = new Date('2026-10-15T12:00:00.000Z');
const online = Array.from({ length: 1 }, () => ({ name: 'r', status: 'online', labels: [{ name: 'benjis-ci' }] }));

function client({ state, current, runners, failState = false }) {
  const s = { state, current };
  return {
    s,
    getRepoVariable: async () => (s.state == null ? null : JSON.stringify(s.state)),
    getOrgVariable: async () => s.current,
    listRunners: async () => runners,
    listQueuedRuns: async () => [],
    setRepoVariable: async (_n, v) => { if (failState) throw new Error('5xx'); s.state = JSON.parse(v); },
    setOrgVariable: async (_n, v) => { s.current = v; },
    postSlack: async () => {},
    cancelRun: async () => {},
    rerunRun: async () => {},
  };
}
const run = (c) => evaluate({ client: c, now: NOW, log: () => {}, captureError: async () => {} }).catch(() => {});

test('flip_hosted: failed state write leaves org variable untouched (retryable)', async () => {
  const c = client({ state: { misses: 2, healthy: 0, flipped: false, last_alert: null }, current: '"benjis-ci"', runners: [], failState: true });
  await run(c);
  assert.equal(c.s.current, '"benjis-ci"');
});

test('flip_back: failed state write keeps flipped=true so next cycles still flip back', async () => {
  const c = client({ state: { misses: 0, healthy: 2, flipped: true, last_alert: null }, current: '"ubuntu-latest"', runners: online, failState: true });
  await run(c);
  assert.equal(c.s.state.flipped, true);
  c.failState = false;
  const c2 = client({ state: c.s.state, current: c.s.current, runners: online });
  await run(c2);
  await run(c2);
  assert.equal(c2.s.current, '"benjis-ci"');
});
