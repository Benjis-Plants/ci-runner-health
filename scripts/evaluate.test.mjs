import { test } from 'node:test';
import assert from 'node:assert/strict';
import { main, requeue } from './evaluate.mjs';

const CONTRACT = /^(online|misses|healthy|decision|flipped|dry_run)=[A-Za-z0-9_.-]+$/;
const SECRET_NAME = 'runner-secret-host-01.internal.example';
const WEBHOOK = 'https://hooks.example.test/T000/B000/XXXXTOKEN';
const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });

// Stub GitHub API. `runners` = list returned by the org runners endpoint (single page).
function makeFetch({ runners, runnersStatus = 200, orgVar = '"benjis-ci"', state = { misses: 1, healthy: 0, flipped: false, lastAlert: null } }) {
  const calls = [];
  const fn = async (url, opts = {}) => {
    const method = (opts.method || 'GET').toUpperCase();
    const u = new URL(String(url));
    calls.push({ method, url: String(url), path: u.pathname, body: opts.body });
    if (method === 'GET' && /\/actions\/runners$/.test(u.pathname)) {
      return runnersStatus === 200
        ? json(200, { total_count: runners.length, runners })
        : json(runnersStatus, { message: `boom ${SECRET_NAME}` });
    }
    if (method === 'GET' && /variables\/CI_RUNNER_JSON$/.test(u.pathname)) return json(200, { name: 'CI_RUNNER_JSON', value: orgVar });
    if (method === 'GET' && /variables\/HEALTH_STATE$/.test(u.pathname)) return json(200, { name: 'HEALTH_STATE', value: JSON.stringify(state) });
    if (method === 'GET') return json(200, { workflow_runs: [], total_count: 0 });
    return json(200, {});
  };
  fn.calls = calls;
  return fn;
}

const env = (extra = {}) => ({
  GITHUB_REPOSITORY: 'Example-Org/ci-runner-health',
  GITHUB_REPOSITORY_OWNER: 'Example-Org',
  GITHUB_SHA: 'abc1234',
  GH_TOKEN: 'ghs_FAKE',
  SLACK_FAILOVER_WEBHOOK: WEBHOOK,
  ...extra,
});
const offlineRunners = [{ name: SECRET_NAME, status: 'offline', labels: [{ name: 'benjis-ci' }] }];
const GH_HOST = 'api.github.com';
const isGithubWrite = (c) => c.method !== 'GET' && new URL(c.url).host === GH_HOST;

test('dry_run=true: prints decision and makes zero non-GET calls (even when a flip is due)', async () => {
  const fetch = makeFetch({ runners: offlineRunners }); // misses 1 + this miss = 2, var benjis-ci => would flip
  const lines = [];
  const code = await main({ env: env({ DRY_RUN: 'true' }), fetch, out: (l) => lines.push(l) });
  assert.equal(code, 0);
  assert.deepEqual(fetch.calls.filter((c) => c.method !== 'GET'), []);
  assert.ok(lines.includes('decision=flip_to_hosted'), lines.join('|'));
  assert.ok(lines.includes('dry_run=true'));
  assert.ok(lines.includes('online=0'));
});

test('log contract: every line matches regex; runner names/hosts/webhook never printed (non-dry run, flip)', async () => {
  const fetch = makeFetch({ runners: offlineRunners });
  const lines = [];
  await main({ env: env({ DRY_RUN: 'false' }), fetch, out: (l) => lines.push(l) });
  assert.ok(lines.length > 0);
  for (const l of lines) assert.match(l, CONTRACT);
  const all = lines.join('\n');
  assert.ok(!all.includes(SECRET_NAME));
  assert.ok(!all.includes('XXXXTOKEN'));
  assert.ok(lines.includes('decision=flip_to_hosted'));
  assert.ok(lines.includes('dry_run=false'));
});

test('log contract holds in dry run with a healthy runner returned with name/host', async () => {
  const runners = [{ name: SECRET_NAME, status: 'online', labels: [{ name: 'benjis-ci' }] }];
  const fetch = makeFetch({ runners, state: { misses: 0, healthy: 0, flipped: false, lastAlert: null } });
  const lines = [];
  await main({ env: env({ DRY_RUN: 'true' }), fetch, out: (l) => lines.push(l) });
  for (const l of lines) assert.match(l, CONTRACT);
  assert.ok(!lines.join('\n').includes(SECRET_NAME));
  assert.ok(lines.includes('online=1'));
  assert.ok(lines.includes('decision=none'));
});

test('runners API 500: decision=api_error, non-zero exit, no GitHub writes, no leaked body', async () => {
  const fetch = makeFetch({ runners: [], runnersStatus: 500 });
  const lines = [];
  const code = await main({ env: env({ DRY_RUN: 'false' }), fetch, out: (l) => lines.push(l) });
  assert.notEqual(code, 0);
  assert.ok(lines.includes('decision=api_error'), lines.join('|'));
  for (const l of lines) assert.match(l, CONTRACT);
  assert.ok(!lines.join('\n').includes(SECRET_NAME));
  assert.deepEqual(fetch.calls.filter(isGithubWrite), []);
});

test('requeue: cancels then re-runs queued runs older than 5 min; no dispatch when re-run succeeds', async () => {
  const now = Date.UTC(2026, 9, 15, 12, 0, 0);
  const old = new Date(now - 6 * 60000).toISOString();
  const fresh = new Date(now - 4 * 60000).toISOString();
  const calls = [];
  const fetch = async (url, opts = {}) => {
    const method = (opts.method || 'GET').toUpperCase();
    const u = new URL(String(url));
    calls.push({ method, path: u.pathname });
    if (method === 'GET' && /\/actions\/runs$/.test(u.pathname)) {
      return json(200, { workflow_runs: [
        { id: 11, workflow_id: 5, head_branch: 'main', status: 'queued', created_at: old },
        { id: 12, workflow_id: 5, head_branch: 'main', status: 'queued', created_at: fresh },
      ] });
    }
    return json(200, {});
  };
  const res = await requeue({ fetch, token: 'ghs_FAKE', owner: 'Example-Org', repos: ['scheduler'], now });
  const posts = calls.filter((c) => c.method === 'POST').map((c) => c.path);
  assert.deepEqual(posts, ['/repos/Example-Org/scheduler/actions/runs/11/cancel', '/repos/Example-Org/scheduler/actions/runs/11/rerun']);
  assert.equal(res.cancelled, 1);
  assert.equal(res.rerun, 1);
  assert.equal(res.dispatched, 0);
});

test('requeue: when re-run returns an error, falls back to workflow dispatch on head_branch', async () => {
  const now = Date.UTC(2026, 9, 15, 12, 0, 0);
  const old = new Date(now - 10 * 60000).toISOString();
  const calls = [];
  const fetch = async (url, opts = {}) => {
    const method = (opts.method || 'GET').toUpperCase();
    const u = new URL(String(url));
    calls.push({ method, path: u.pathname, body: opts.body });
    if (method === 'GET' && /\/actions\/runs$/.test(u.pathname)) {
      return json(200, { workflow_runs: [{ id: 21, workflow_id: 7, head_branch: 'feature-x', status: 'queued', created_at: old }] });
    }
    if (/\/rerun$/.test(u.pathname)) return json(403, { message: 'nope' });
    return json(200, {});
  };
  const res = await requeue({ fetch, token: 'ghs_FAKE', owner: 'Example-Org', repos: ['benjis-quoting-tool'], now });
  const d = calls.find((c) => c.method === 'POST' && /\/actions\/workflows\/7\/dispatches$/.test(c.path));
  assert.ok(d, 'dispatch fallback not called: ' + JSON.stringify(calls));
  assert.equal(d.path, '/repos/Example-Org/benjis-quoting-tool/actions/workflows/7/dispatches');
  assert.equal(JSON.parse(d.body).ref, 'feature-x');
  assert.equal(res.dispatched, 1);
  assert.equal(res.rerun, 0);
});
