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
    listQueuedRuns: async (r) => (r === 'scheduler' ? [1, 2, 3].map((id) => ({ id, created_at: old })) : []),
    cancelRun: async (r, id) => calls.push(['cancel', r, id]),
    rerunRun: async (r, id) => calls.push(['rerun', r, id]),
    runUrl: (r, id) => `https://x/${r}/${id}`,
    ...over,
  };
  return { client, calls };
}
const opts = { log: () => {}, captureError: async () => {}, sleep: async () => {} };

test('past the deadline no further run is cancelled', async () => {
  let t = 0;
  const { client, calls } = mk({
    cancelRun: async (r, id) => { calls.push(['cancel', r, id]); t += 4 * 60_000; },
  });
  await evaluate({ client, ...opts, clock: () => t });
  const cancels = calls.filter((c) => c[0] === 'cancel').length;
  const reruns = calls.filter((c) => c[0] === 'rerun').length;
  assert.ok(cancels < 3);
  assert.equal(cancels, reruns); // every cancelled run was re-run
});

test('cancelled run whose re-run fails is reported by URL', async () => {
  const { client, calls } = mk({ rerunRun: async () => { throw new Error('409'); } });
  await assert.rejects(evaluate({ client, ...opts, clock: () => 0 }));
  assert.ok(calls.some((c) => c[0] === 'slack' && c[1].includes('https://x/scheduler/1')));
});
