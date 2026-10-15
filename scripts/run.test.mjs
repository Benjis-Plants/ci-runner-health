import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate } from './run.mjs';

// ---- Client contract (defined by this test file; the implementer builds the real client to match) ----
// READ  : getRepoVariable(name) -> string|null (raw), getOrgVariable(name) -> string|null (raw JSON, e.g. '"benjis-ci"'),
//         listRunners() -> [{name, status, labels:[{name}]}], listQueuedRuns(repo) -> [{id, created_at}]
// WRITE : setRepoVariable(name, value), setOrgVariable(name, value), postSlack(text), cancelRun(repo, id), rerunRun(repo, id)
// evaluate({client, dryRun, now, log, captureError}); `log(line)` receives every stdout line of the "Evaluate runners" step.

const NOW = new Date('2026-10-15T12:00:00.000Z');
const WHITELIST = /^(online|misses|healthy|decision|flipped|dry_run)=[A-Za-z0-9_.-]+$/;
const ZERO = { misses: 0, healthy: 0, flipped: false, last_alert: null };

const runner = (name, status, label = 'benjis-ci') => ({ name, status, labels: [{ name: 'self-hosted' }, { name: label }] });
const minsAgo = (m) => new Date(NOW.getTime() - m * 60_000).toISOString();

function makeClient({ state = ZERO, current = '"benjis-ci"', runners = [], queued = {} } = {}) {
  const writes = [];
  const rec = (kind) => async (...args) => { writes.push([kind, ...args]); };
  return {
    writes,
    getRepoVariable: async () => (state === null ? null : typeof state === 'string' ? state : JSON.stringify(state)),
    getOrgVariable: async () => current,
    listRunners: async () => runners,
    listQueuedRuns: async (repo) => queued[repo] ?? [],
    setRepoVariable: rec('setRepoVariable'),
    setOrgVariable: rec('setOrgVariable'),
    postSlack: rec('postSlack'),
    cancelRun: rec('cancelRun'),
    rerunRun: rec('rerunRun'),
  };
}
const throwingOnWrite = (base) => {
  const boom = (n) => async () => { throw new Error(`non-GET call: ${n}`); };
  return { ...base, setRepoVariable: boom('setRepoVariable'), setOrgVariable: boom('setOrgVariable'),
           postSlack: boom('postSlack'), cancelRun: boom('cancelRun'), rerunRun: boom('rerunRun') };
};
const go = async (client, extra = {}) => {
  const lines = [];
  await evaluate({ client, dryRun: false, now: NOW, log: (l) => lines.push(l), captureError: async () => {}, ...extra });
  return lines;
};
const of = (client, kind) => client.writes.filter((w) => w[0] === kind);

test('counts only online runners carrying label benjis-ci', async () => {
  const c = makeClient({ runners: [runner('a', 'online'), runner('b', 'online'), runner('c', 'offline'), runner('d', 'online', 'other')] });
  const lines = await go(c);
  assert.ok(lines.includes('online=2'), lines.join('|'));
});

test('flip: writes org var with quoted JSON, persists state, alerts, re-queues', async () => {
  const c = makeClient({ state: { ...ZERO, misses: 1 }, current: '"benjis-ci"', runners: [] });
  const lines = await go(c);
  assert.deepEqual(of(c, 'setOrgVariable'), [['setOrgVariable', 'CI_RUNNER_JSON', '"ubuntu-latest"']]);
  const stateWrites = of(c, 'setRepoVariable').filter((w) => w[1] === 'HEALTH_STATE');
  assert.equal(stateWrites.length, 1);
  const saved = JSON.parse(stateWrites[0][2]);
  assert.equal(saved.misses, 2);
  assert.equal(saved.flipped, true);
  assert.equal(of(c, 'postSlack').length, 1);
  assert.ok(lines.includes('decision=flip_hosted'));
  assert.ok(lines.includes('flipped=true'));
});

test('state is persisted even when nothing flips (cold start, current=null)', async () => {
  const c = makeClient({ state: null, current: null, runners: [runner('a', 'online')] });
  await go(c);
  assert.equal(of(c, 'setOrgVariable').length, 0);
  const w = of(c, 'setRepoVariable');
  assert.equal(w.length, 1);
  assert.equal(w[0][1], 'HEALTH_STATE');
  assert.deepEqual(JSON.parse(w[0][2]), { misses: 0, healthy: 1, flipped: false, last_alert: null });
});

test('re-queue: >5 min old only, cap 50 per repo, cancel then re-run, both repos', async () => {
  const old = (n, p) => Array.from({ length: n }, (_, i) => ({ id: p + i, created_at: minsAgo(10) }));
  const c = makeClient({
    state: { ...ZERO, misses: 1 }, runners: [],
    queued: {
      scheduler: [...old(60, 1000), { id: 1, created_at: minsAgo(2) }, { id: 2, created_at: minsAgo(5) }],
      'benjis-quoting-tool': [{ id: 5000, created_at: minsAgo(5.02) }],
    },
  });
  await go(c);
  const sched = (k) => of(c, k).filter((w) => w[1] === 'scheduler');
  assert.equal(sched('cancelRun').length, 50);
  assert.equal(sched('rerunRun').length, 50);
  assert.ok(!c.writes.some((w) => ['cancelRun', 'rerunRun'].includes(w[0]) && [1, 2].includes(w[2])), 'runs <=5 min old untouched');
  assert.deepEqual(of(c, 'cancelRun').filter((w) => w[1] === 'benjis-quoting-tool').map((w) => w[2]), [5000]);
  // cancel precedes re-run for the same run
  const seq = c.writes.filter((w) => w[2] === 5000).map((w) => w[0]);
  assert.deepEqual(seq, ['cancelRun', 'rerunRun']);
});

test('re-queue repeats on every unhealthy run while current is ubuntu-latest, without re-writing the var', async () => {
  const c = makeClient({
    state: { ...ZERO, misses: 3, flipped: true, last_alert: minsAgo(30) }, current: '"ubuntu-latest"', runners: [],
    queued: { scheduler: [{ id: 9, created_at: minsAgo(20) }] },
  });
  await go(c);
  assert.equal(of(c, 'setOrgVariable').length, 0);
  assert.deepEqual(of(c, 'cancelRun'), [['cancelRun', 'scheduler', 9]]);
  assert.deepEqual(of(c, 'rerunRun'), [['rerunRun', 'scheduler', 9]]);
});

test('healthy fleet: no re-queue', async () => {
  const c = makeClient({ runners: [runner('a', 'online')], queued: { scheduler: [{ id: 9, created_at: minsAgo(20) }] } });
  await go(c);
  assert.equal(of(c, 'cancelRun').length, 0);
  assert.equal(of(c, 'rerunRun').length, 0);
});

test('log contract: every stdout line matches the whitelist; no runner names/hosts leak', async () => {
  const scenarios = [
    makeClient({ state: { ...ZERO, misses: 1 }, runners: [runner('host-secret-01.internal.example', 'offline')] }),
    makeClient({ runners: [runner('host-secret-02.internal.example', 'online')] }),
    makeClient({ state: '{bad', current: null, runners: [] }),
  ];
  for (const c of scenarios) {
    const lines = await go(c);
    assert.ok(lines.length >= 5, 'prints online/misses/healthy/decision/flipped');
    for (const k of ['online', 'misses', 'healthy', 'decision', 'flipped']) {
      assert.ok(lines.some((l) => l.startsWith(`${k}=`)), `missing ${k}=`);
    }
    for (const l of lines) assert.match(l, WHITELIST);
  }
});

test('dry_run=true: prints decision + dry_run=true and makes no non-GET call', async () => {
  const c = throwingOnWrite(makeClient({
    state: { ...ZERO, misses: 1 }, runners: [],
    queued: { scheduler: [{ id: 9, created_at: minsAgo(20) }] },
  }));
  const lines = await go(c, { dryRun: true });
  assert.ok(lines.includes('decision=flip_hosted'));
  assert.ok(lines.includes('dry_run=true'));
  for (const l of lines) assert.match(l, WHITELIST);
});

test('step failure: posts Slack alert once, captures error with route health-check, and rethrows', async () => {
  const c = makeClient();
  c.listRunners = async () => { throw new Error('api down'); };
  const captured = [];
  await assert.rejects(
    go(c, { captureError: async (e, o) => { captured.push([e.message, o.route]); } }),
    /api down/,
  );
  assert.equal(of(c, 'postSlack').length, 1);
  assert.deepEqual(captured, [['api down', 'health-check']]);
});

test('step failure in re-queue is captured with route requeue', async () => {
  const c = makeClient({ state: { ...ZERO, misses: 1 }, runners: [], queued: { scheduler: [{ id: 9, created_at: minsAgo(20) }] } });
  c.cancelRun = async () => { throw new Error('cancel failed'); };
  const captured = [];
  await assert.rejects(go(c, { captureError: async (e, o) => { captured.push(o.route); } }), /cancel failed/);
  assert.deepEqual(captured, ['requeue']);
});
