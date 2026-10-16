import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide } from './decide.mjs';

// `now` is a Date; `current` is the PARSED CI_RUNNER_JSON value ('benjis-ci' | 'ubuntu-latest' | null).
// writeVar is the JSON string including quotes, e.g. '"ubuntu-latest"' (ticket: "Variable write").
const T0 = new Date('2026-10-15T12:00:00.000Z');
const ZERO = { misses: 0, healthy: 0, flipped: false, last_alert: null };
const st = (o) => ({ ...ZERO, ...o });
const noWrite = (r) => assert.equal(r.writeVar ?? null, null);

test('case 1: 1 miss -> no flip', () => {
  const r = decide({ state: ZERO, online: 0, current: 'benjis-ci', now: T0 });
  assert.equal(r.decision, 'none');
  noWrite(r);
  assert.equal(r.state.misses, 1);
  assert.equal(r.state.healthy, 0);
  assert.equal(r.state.flipped, false);
});

test('case 2: 2 misses with current benjis-ci -> flip_hosted', () => {
  const r = decide({ state: st({ misses: 1 }), online: 0, current: 'benjis-ci', now: T0 });
  assert.equal(r.decision, 'flip_hosted');
  assert.equal(r.writeVar, '"ubuntu-latest"');
  assert.equal(r.state.misses, 2);
  assert.equal(r.state.healthy, 0);
  assert.equal(r.state.flipped, true);
  assert.equal(r.alert, true);
});

test('case 3: 2 healthy then 1 miss -> no flip back, healthy reset', () => {
  let r = decide({ state: st({ flipped: true }), online: 1, current: 'ubuntu-latest', now: T0 });
  r = decide({ state: r.state, online: 1, current: 'ubuntu-latest', now: T0 });
  assert.equal(r.state.healthy, 2);
  r = decide({ state: r.state, online: 0, current: 'ubuntu-latest', now: T0 });
  assert.equal(r.decision, 'none');
  noWrite(r);
  assert.equal(r.state.healthy, 0);
  assert.equal(r.state.misses, 1);
  assert.equal(r.state.flipped, true);
});

test('case 4: 3 healthy with flipped=true -> flip_back', () => {
  const r = decide({ state: st({ healthy: 2, flipped: true }), online: 2, current: 'ubuntu-latest', now: T0 });
  assert.equal(r.decision, 'flip_back');
  assert.equal(r.writeVar, '"benjis-ci"');
  assert.equal(r.state.flipped, false);
  assert.equal(r.state.healthy, 3);
  assert.equal(r.state.misses, 0);
});

test('case 4b: 2 healthy with flipped=true -> not yet (boundary)', () => {
  const r = decide({ state: st({ healthy: 1, flipped: true }), online: 1, current: 'ubuntu-latest', now: T0 });
  assert.equal(r.decision, 'none');
  noWrite(r);
  assert.equal(r.state.flipped, true);
});

test('case 5: 3+ healthy with flipped=false -> never write', () => {
  for (const healthy of [2, 3, 10]) {
    const r = decide({ state: st({ healthy }), online: 1, current: 'benjis-ci', now: T0 });
    assert.equal(r.decision, 'none');
    noWrite(r);
    assert.equal(r.state.flipped, false);
    assert.equal(r.state.healthy, healthy + 1);
  }
});

test('case 6: cold start, healthy runners, current=null -> no write, zero counters persisted', () => {
  const r = decide({ state: null, online: 1, current: null, now: T0 });
  assert.equal(r.decision, 'none');
  noWrite(r);
  assert.deepEqual(r.state, { misses: 0, healthy: 1, flipped: false, last_alert: null });
});

test('case 7: 2 misses while already ubuntu-latest -> no write, flipped false; then 3 healthy -> still no write', () => {
  let r = decide({ state: st({ misses: 1 }), online: 0, current: 'ubuntu-latest', now: T0 });
  assert.equal(r.decision, 'none');
  noWrite(r);
  assert.equal(r.state.misses, 2);
  assert.equal(r.state.flipped, false);
  for (let i = 0; i < 3; i++) {
    r = decide({ state: r.state, online: 1, current: 'ubuntu-latest', now: T0 });
    assert.equal(r.decision, 'none');
    noWrite(r);
    assert.equal(r.state.flipped, false);
  }
  assert.equal(r.state.healthy, 3);
});

test('2 misses with current=null -> no write', () => {
  const r = decide({ state: st({ misses: 1 }), online: 0, current: null, now: T0 });
  assert.equal(r.decision, 'none');
  noWrite(r);
  assert.equal(r.state.flipped, false);
});

test('flipped=true but current changed away from ubuntu-latest -> clear flipped, no write', () => {
  const r = decide({ state: st({ flipped: true, healthy: 5 }), online: 1, current: 'benjis-ci', now: T0 });
  assert.equal(r.decision, 'none');
  noWrite(r);
  assert.equal(r.state.flipped, false);
});

test('case 8: alert at flip, none at 5h59m, alert at 6h', () => {
  const flip = decide({ state: st({ misses: 1 }), online: 0, current: 'benjis-ci', now: T0 });
  assert.equal(flip.alert, true);
  assert.equal(flip.state.last_alert, T0.toISOString());
  const min = 60_000;
  const at = (m) => new Date(T0.getTime() + m * min);
  const r1 = decide({ state: flip.state, online: 0, current: 'ubuntu-latest', now: at(5 * 60 + 59) });
  assert.equal(r1.alert, false);
  const r2 = decide({ state: flip.state, online: 0, current: 'ubuntu-latest', now: at(6 * 60) });
  assert.equal(r2.alert, true);
});

test('no alert while healthy', () => {
  const r = decide({ state: st({ last_alert: new Date(T0.getTime() - 7 * 3600_000).toISOString() }), online: 1, current: 'benjis-ci', now: T0 });
  assert.equal(r.alert, false);
});

for (const [label, bad] of [['empty string', ''], ['malformed JSON', '{bad'], ['wrong types', { misses: 'x' }]]) {
  test(`invalid HEALTH_STATE (${label}) -> zero state, no throw`, () => {
    const r = decide({ state: bad, online: 1, current: 'benjis-ci', now: T0 });
    assert.equal(r.decision, 'none');
    noWrite(r);
    assert.deepEqual(r.state, { misses: 0, healthy: 1, flipped: false, last_alert: null });
  });
}
