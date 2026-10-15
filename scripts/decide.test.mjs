import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, countOnline } from './decide.mjs';

const NOW = Date.UTC(2026, 9, 15, 12, 0, 0);
const H = 3600 * 1000;
const DEFAULT = { misses: 0, healthy: 0, flipped: false, lastAlert: null };
const HOSTED = '"ubuntu-latest"';
const SELF = '"benjis-ci"';
const st = (o) => ({ ...DEFAULT, ...o });
const setVars = (r) => r.actions.filter((a) => a.type === 'set_var');
const slacks = (r) => r.actions.filter((a) => a.type === 'slack');

test('(a) 1 miss, var benjis-ci -> no flip', () => {
  const r = decide({ state: st({}), online: 0, currentVar: SELF, now: NOW });
  assert.equal(r.state.misses, 1);
  assert.equal(r.state.flipped, false);
  assert.deepEqual(r.actions, []);
});

test('(b) 2 misses, var benjis-ci -> set_var ubuntu-latest, flipped=true, slack flip, requeue', () => {
  const r = decide({ state: st({ misses: 1 }), online: 0, currentVar: SELF, now: NOW });
  assert.deepEqual(setVars(r), [{ type: 'set_var', value: HOSTED }]);
  assert.ok(slacks(r).some((a) => a.kind === 'flip'));
  assert.ok(r.actions.some((a) => a.type === 'requeue'));
  assert.equal(r.state.flipped, true);
  assert.equal(r.state.misses, 2);
  assert.equal(r.state.lastAlert, NOW);
});

test('(c) 2 healthy then 1 miss while flipped -> no flip back, healthy=0', () => {
  const r = decide({ state: st({ healthy: 2, flipped: true }), online: 0, currentVar: HOSTED, now: NOW });
  assert.equal(r.state.healthy, 0);
  assert.equal(r.state.misses, 1);
  assert.equal(r.state.flipped, true);
  assert.deepEqual(r.actions, []);
});

test('(d) 3 healthy, flipped=true, var ubuntu-latest -> set_var benjis-ci, flipped=false', () => {
  const r = decide({ state: st({ healthy: 2, flipped: true }), online: 1, currentVar: HOSTED, now: NOW });
  assert.deepEqual(setVars(r), [{ type: 'set_var', value: SELF }]);
  assert.ok(slacks(r).some((a) => a.kind === 'flip'));
  assert.equal(r.state.flipped, false);
  assert.equal(r.state.healthy, 3);
});

test('(e) 3+ healthy, flipped=false, var ubuntu-latest -> no write', () => {
  const r = decide({ state: st({ healthy: 3 }), online: 1, currentVar: HOSTED, now: NOW });
  assert.deepEqual(r.actions, []);
  assert.equal(r.state.flipped, false);
  assert.equal(r.state.healthy, 4);
});

// (f) resolution: rule 1 says healthy+1 on every healthy check, so decide() returns healthy=1.
// Rule 5 ("cold start with healthy runners writes nothing") is enforced at the writer: evaluate.test.mjs
// asserts no HEALTH_STATE write on cold start.
test('(f) cold start (state null), healthy runners -> no actions, state unchanged-equivalent', () => {
  const r = decide({ state: null, online: 2, currentVar: null, now: NOW });
  assert.deepEqual(r.actions, []);
  assert.equal(r.state.misses, 0);
  assert.equal(r.state.flipped, false);
  assert.equal(r.state.lastAlert, null);
  // healthy increments per rule 1 (0 -> 1); misses/flipped/lastAlert at default
  assert.equal(r.state.healthy, 1);
});

for (const v of [HOSTED, null]) {
  test(`(g) 2 misses with var ${v} -> no write, no requeue, flipped stays false`, () => {
    const r = decide({ state: st({ misses: 1 }), online: 0, currentVar: v, now: NOW });
    assert.deepEqual(setVars(r), []);
    assert.ok(!r.actions.some((a) => a.type === 'requeue'));
    assert.ok(!slacks(r).some((a) => a.kind === 'flip'));
    assert.equal(r.state.flipped, false);
  });
}

test('(h) flipped, 3 healthy, var changed by hand -> no write, flipped=false', () => {
  const r = decide({ state: st({ healthy: 2, flipped: true }), online: 1, currentVar: '"something-else"', now: NOW });
  assert.deepEqual(setVars(r), []);
  assert.equal(r.state.flipped, false);
});

test('(i) 6h throttle: 5h59m ago -> no slack', () => {
  const r = decide({ state: st({ misses: 5, lastAlert: NOW - (6 * H - 60000) }), online: 0, currentVar: HOSTED, now: NOW });
  assert.deepEqual(slacks(r), []);
});

test('(i) 6h throttle: exactly 6h ago -> unhealthy slack, lastAlert updated', () => {
  const r = decide({ state: st({ misses: 5, lastAlert: NOW - 6 * H }), online: 0, currentVar: HOSTED, now: NOW });
  assert.deepEqual(slacks(r), [{ type: 'slack', kind: 'unhealthy' }]);
  assert.equal(r.state.lastAlert, NOW);
});

test('unhealthy alert fires when lastAlert is null and misses>=2', () => {
  const r = decide({ state: st({ misses: 4 }), online: 0, currentVar: HOSTED, now: NOW });
  assert.deepEqual(slacks(r), [{ type: 'slack', kind: 'unhealthy' }]);
});

test('healthy check resets lastAlert to null and misses to 0', () => {
  const r = decide({ state: st({ misses: 3, lastAlert: NOW - H }), online: 1, currentVar: HOSTED, now: NOW });
  assert.equal(r.state.lastAlert, null);
  assert.equal(r.state.misses, 0);
});

test('invalid state value behaves as default', () => {
  const r = decide({ state: 'garbage', online: 0, currentVar: SELF, now: NOW });
  assert.equal(r.state.misses, 1);
  assert.deepEqual(r.actions, []);
});

const R = (status, ...labels) => ({ status, labels: labels.map((name) => ({ name })) });
test('(j) countOnline: empty list = 0', () => assert.equal(countOnline([]), 0));
test('(j) countOnline: benjis-ci but offline = 0', () => assert.equal(countOnline([R('offline', 'benjis-ci', 'self-hosted')]), 0));
test('(j) countOnline: online without the label = 0', () => assert.equal(countOnline([R('online', 'self-hosted', 'linux')]), 0));
test('(j) countOnline: counts only online+labelled', () =>
  assert.equal(countOnline([R('online', 'benjis-ci'), R('offline', 'benjis-ci'), R('online', 'x'), R('online', 'x', 'benjis-ci')]), 2));

test('boundary: healthy 1 -> 2 while flipped, var ubuntu-latest -> no flip back', () => {
  const r = decide({ state: st({ healthy: 1, flipped: true }), online: 1, currentVar: HOSTED, now: NOW });
  assert.equal(r.state.healthy, 2);
  assert.equal(r.state.flipped, true);
  assert.deepEqual(r.actions, []);
});

test('boundary: misses 2 -> 3, lastAlert 1h ago -> no Slack, lastAlert unchanged', () => {
  const r = decide({ state: st({ misses: 2, flipped: true, lastAlert: NOW - H }), online: 0, currentVar: HOSTED, now: NOW });
  assert.equal(r.state.misses, 3);
  assert.deepEqual(slacks(r), []);
  assert.equal(r.state.lastAlert, NOW - H);
});
