import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate } from './run.mjs';

const old = new Date(Date.now() - 3_600_000).toISOString();
function mk(over = {}) {
  const calls = [];
  const client = {
    getRepoVariable: async () => null,
    getOrgVariable: async () => JSON.stringify('ubuntu-latest'),
    listRunners: async () => [],
    setRepoVariable: async () => {},
    setOrgVariable: async () => {},
    postSlack: async (t) => calls.push(['slack', t]),
    listQueuedRuns: async (r) => [{ id: 1, created_at: old }],
    cancelRun: async (r, id) => calls.push(['cancel', r, id]),
    rerunRun: async (r, id) => calls.push(['rerun', r, id]),
    ...over,
  };
  return { client, calls };
}
const opts = { log: () => {}, captureError: async () => {}, sleep: async () => {} };

test('failed rerun is retried and succeeds', async () => {
  let n = 0;
  const { client, calls } = mk({
    rerunRun: async (r, id) => { if (r === 'scheduler' && n++ < 2) throw new Error('409'); calls.push(['rerun', r, id]); },
  });
  await evaluate({ client, ...opts });
  assert.equal(calls.filter((c) => c[0] === 'rerun').length, 2);
});

test('rerun failure in one repo does not skip the other and fails the run', async () => {
  const { client, calls } = mk({
    rerunRun: async (r, id) => { if (r === 'scheduler') throw new Error('409'); calls.push(['rerun', r, id]); },
  });
  await assert.rejects(evaluate({ client, ...opts }));
  assert.ok(calls.some((c) => c[0] === 'rerun' && c[1] === 'benjis-quoting-tool'));
});

test('list failure in one repo does not skip the other', async () => {
  const { client, calls } = mk({
    listQueuedRuns: async (r) => { if (r === 'scheduler') throw new Error('500'); return [{ id: 2, created_at: old }]; },
  });
  await assert.rejects(evaluate({ client, ...opts }));
  assert.ok(calls.some((c) => c[0] === 'rerun' && c[1] === 'benjis-quoting-tool'));
});

test('slack failure still re-queues, then throws', async () => {
  const { client, calls } = mk({
    getRepoVariable: async () => JSON.stringify({ misses: 1, healthy: 0, flipped: false, last_alert: null }),
    getOrgVariable: async () => JSON.stringify('benjis-ci'),
    postSlack: async () => { throw new Error('down'); },
  });
  await assert.rejects(evaluate({ client, ...opts, now: new Date() }));
  assert.ok(calls.some((c) => c[0] === 'rerun'));
});
