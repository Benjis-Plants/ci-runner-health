import { test } from 'node:test';
import assert from 'node:assert/strict';
import { main, requeue } from './evaluate.mjs';

const CONTRACT = /^(online|misses|healthy|decision|flipped|dry_run)=[A-Za-z0-9_.-]+$/;
const SECRET_NAME = 'runner-secret-host-01.internal.example';
const WEBHOOK = 'https://hooks.example.test/T000/B000/XXXXTOKEN';
const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });

// Stub GitHub API. `runners` = list returned by the org runners endpoint (single page).
function makeFetch({ runners, pages = null, runnersStatus = 200, orgVar = '"benjis-ci"', state = { misses: 1, healthy: 0, flipped: false, lastAlert: null } }) {
  const calls = [];
  const fn = async (url, opts = {}) => {
    const method = (opts.method || 'GET').toUpperCase();
    const u = new URL(String(url));
    calls.push({ method, url: String(url), path: u.pathname, body: opts.body });
    if (method === 'GET' && /\/actions\/runners$/.test(u.pathname)) {
      if (runnersStatus === 200 && pages) {
        const page = Number(u.searchParams.get('page') || 1);
        return json(200, { total_count: pages.flat().length, runners: pages[page - 1] || [] });
      }
      return runnersStatus === 200
        ? json(200, { total_count: runners.length, runners })
        : json(runnersStatus, { message: `boom ${SECRET_NAME}` });
    }
    if (method === 'GET' && /variables\/CI_RUNNER_JSON$/.test(u.pathname)) return orgVar === null ? json(404, { message: 'Not Found' }) : json(200, { name: 'CI_RUNNER_JSON', value: orgVar });
    if (method === 'GET' && /variables\/HEALTH_STATE$/.test(u.pathname)) return state === null ? json(404, { message: 'Not Found' }) : json(200, { name: 'HEALTH_STATE', value: JSON.stringify(state) });
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

// ---------- review round 1 additions ----------
const DSN = 'https://pubkey@sentry.example.test/42';
const onlineRunner = (n = 'r') => ({ name: `${n}-${SECRET_NAME}`, status: 'online', labels: [{ name: 'benjis-ci' }] });
const run = async (opts, envExtra = {}) => {
  const fetch = makeFetch(opts);
  const lines = [];
  const code = await main({ env: env({ DRY_RUN: 'false', ...envExtra }), fetch, out: (l) => lines.push(l) });
  return { fetch, lines, code };
};
const orgVarWrites = (f) => f.calls.filter((c) => c.method !== 'GET' && /\/orgs\/Example-Org\/actions\/variables/.test(c.path));
const stateWrites = (f) => f.calls.filter((c) => c.method !== 'GET' && /\/repos\/Example-Org\/ci-runner-health\/actions\/variables/.test(c.path));
const slackPosts = (f) => f.calls.filter((c) => c.method === 'POST' && c.url.startsWith(WEBHOOK));
const sentryPosts = (f) => f.calls.filter((c) => c.method === 'POST' && new URL(c.url).host === 'sentry.example.test');
const sentryEvent = (c) => JSON.parse(c.body.split('\n')[2]);

test('flip (non-dry): writes org var "ubuntu-latest", writes HEALTH_STATE flipped=true, one Slack post, requeues both repos', async () => {
  const { fetch, code } = await run({ runners: offlineRunners }); // misses 1 -> 2, var benjis-ci
  assert.equal(code, 0);
  const vw = orgVarWrites(fetch);
  assert.equal(vw.length, 1);
  assert.equal(JSON.parse(vw[0].body).value, '"ubuntu-latest"');
  const sw = stateWrites(fetch);
  assert.equal(sw.length, 1);
  const saved = JSON.parse(JSON.parse(sw[0].body).value);
  assert.equal(saved.flipped, true);
  assert.equal(saved.misses, 2);
  assert.equal(JSON.parse(sw[0].body).name, 'HEALTH_STATE');
  assert.equal(slackPosts(fetch).length, 1);
  const listed = fetch.calls.filter((c) => c.method === 'GET' && /\/actions\/runs$/.test(c.path)).map((c) => c.path);
  assert.deepEqual(listed.sort(), ['/repos/Example-Org/benjis-quoting-tool/actions/runs', '/repos/Example-Org/scheduler/actions/runs']);
});

test('cold start (HEALTH_STATE and var missing), healthy runner: decision=none and NO writes of any kind (rule 5)', async () => {
  const { fetch, lines, code } = await run({ runners: [onlineRunner()], state: null, orgVar: null });
  assert.equal(code, 0);
  assert.ok(lines.includes('decision=none'), lines.join('|'));
  assert.deepEqual(fetch.calls.filter((c) => c.method !== 'GET'), []);
});

test('stored state identical to new state: HEALTH_STATE is not written (rule 5)', async () => {
  const same = { misses: 0, healthy: 0, flipped: false, lastAlert: null };
  const { fetch } = await run({ runners: [onlineRunner()], state: same });
  assert.deepEqual(stateWrites(fetch), []);
});

test('state changes (1 stored miss, now healthy): HEALTH_STATE is written with misses=0', async () => {
  const { fetch } = await run({ runners: [onlineRunner()], state: { misses: 1, healthy: 0, flipped: false, lastAlert: null } });
  const sw = stateWrites(fetch);
  assert.equal(sw.length, 1);
  assert.equal(JSON.parse(JSON.parse(sw[0].body).value).misses, 0);
});

test('flip back: flipped, 2 healthy stored + 1 now, var ubuntu-latest -> decision=flip_back, org var set to "benjis-ci", state flipped=false', async () => {
  const { fetch, lines } = await run({ runners: [onlineRunner()], orgVar: '"ubuntu-latest"', state: { misses: 0, healthy: 2, flipped: true, lastAlert: null } });
  assert.ok(lines.includes('decision=flip_back'), lines.join('|'));
  const vw = orgVarWrites(fetch);
  assert.equal(vw.length, 1);
  assert.equal(JSON.parse(vw[0].body).value, '"benjis-ci"');
  assert.equal(JSON.parse(JSON.parse(stateWrites(fetch)[0].body).value).flipped, false);
  assert.equal(slackPosts(fetch).length, 1);
});

test('healthy 1 -> 2 while flipped: no flip back (boundary), decision=none, no org var write', async () => {
  const { fetch, lines } = await run({ runners: [onlineRunner()], orgVar: '"ubuntu-latest"', state: { misses: 0, healthy: 1, flipped: true, lastAlert: null } });
  assert.ok(lines.includes('decision=none'), lines.join('|'));
  assert.deepEqual(orgVarWrites(fetch), []);
});

test('alert: misses reach 2 with var already ubuntu-latest, no lastAlert -> decision=alert, one Slack post, no org var write, lastAlert saved', async () => {
  const { fetch, lines } = await run({ runners: [], orgVar: '"ubuntu-latest"', state: { misses: 1, healthy: 0, flipped: false, lastAlert: null } });
  assert.ok(lines.includes('decision=alert'), lines.join('|'));
  assert.equal(slackPosts(fetch).length, 1);
  assert.deepEqual(orgVarWrites(fetch), []);
  assert.equal(typeof JSON.parse(JSON.parse(stateWrites(fetch)[0].body).value).lastAlert, 'number');
});

test('misses 2 -> 3 within 6h of lastAlert: no second Slack post, decision=none', async () => {
  const recent = Date.now() - 3600 * 1000;
  const { fetch, lines } = await run({ runners: [], orgVar: '"ubuntu-latest"', state: { misses: 2, healthy: 0, flipped: false, lastAlert: recent } });
  assert.deepEqual(slackPosts(fetch), []);
  assert.ok(lines.includes('decision=none'), lines.join('|'));
});

test('runners pagination: online runner on page 2 is counted; requests use per_page=100 and walk pages', async () => {
  const page1 = Array.from({ length: 100 }, (_, i) => ({ name: `x${i}`, status: 'online', labels: [{ name: 'other' }] }));
  const page2 = [onlineRunner()];
  const fetch = makeFetch({ pages: [page1, page2], runners: [] });
  const lines = [];
  await main({ env: env({ DRY_RUN: 'true' }), fetch, out: (l) => lines.push(l) });
  assert.ok(lines.includes('online=1'), lines.join('|'));
  const reqs = fetch.calls.filter((c) => /\/actions\/runners$/.test(c.path));
  for (const r of reqs) assert.equal(new URL(r.url).searchParams.get('per_page'), '100');
  assert.deepEqual(reqs.map((r) => new URL(r.url).searchParams.get('page')), ['1', '2']);
});

test('api_error: Sentry event sent with route=health, release=GITHUB_SHA, environment=production, no secrets/names; HEALTH_STATE not written', async () => {
  const { fetch, lines, code } = await run({ runners: [], runnersStatus: 500 }, { SENTRY_DSN: DSN });
  assert.notEqual(code, 0);
  assert.ok(lines.includes('decision=api_error'));
  assert.deepEqual(stateWrites(fetch), []);
  const sp = sentryPosts(fetch);
  assert.equal(sp.length, 1);
  const ev = sentryEvent(sp[0]);
  assert.equal(ev.tags.route, 'health');
  assert.equal(ev.release, 'abc1234');
  assert.equal(ev.environment, 'production');
  for (const bad of [SECRET_NAME, 'ghs_FAKE', 'XXXXTOKEN', 'boom']) assert.ok(!sp[0].body.includes(bad), `leaked ${bad}`);
});

test('write failure (org var PATCH 500) is captured to Sentry with route=health and the run exits non-zero', async () => {
  const base = makeFetch({ runners: offlineRunners });
  const fetch = async (url, opts = {}) => {
    const method = (opts.method || 'GET').toUpperCase();
    if (method !== 'GET' && /\/orgs\/Example-Org\/actions\/variables/.test(new URL(String(url)).pathname)) {
      base.calls.push({ method, url: String(url), path: new URL(String(url)).pathname, body: opts.body });
      return json(500, { message: 'x' });
    }
    return base(url, opts);
  };
  fetch.calls = base.calls;
  const code = await main({ env: env({ DRY_RUN: 'false', SENTRY_DSN: DSN }), fetch, out: () => {} });
  assert.notEqual(code, 0);
  const sp = sentryPosts(fetch);
  assert.ok(sp.length >= 1);
  assert.equal(sentryEvent(sp[0]).tags.route, 'health');
});

test('requeue boundary: run exactly 5 min old is NOT requeued; 5 min + 1 s is', async () => {
  const now = Date.UTC(2026, 9, 15, 12, 0, 0);
  const calls = [];
  const fetch = async (url, opts = {}) => {
    const method = (opts.method || 'GET').toUpperCase();
    const u = new URL(String(url));
    calls.push({ method, path: u.pathname });
    if (method === 'GET') return json(200, { workflow_runs: [
      { id: 31, workflow_id: 5, head_branch: 'main', status: 'queued', created_at: new Date(now - 300000).toISOString() },
      { id: 32, workflow_id: 5, head_branch: 'main', status: 'queued', created_at: new Date(now - 301000).toISOString() },
    ] });
    return json(200, {});
  };
  await requeue({ fetch, token: 'ghs_FAKE', owner: 'Example-Org', repos: ['scheduler'], now });
  const posts = calls.filter((c) => c.method === 'POST').map((c) => c.path);
  assert.deepEqual(posts, ['/repos/Example-Org/scheduler/actions/runs/32/cancel', '/repos/Example-Org/scheduler/actions/runs/32/rerun']);
});

test('token mint failure: entrypoint scripts/mint-token.mjs reports to Sentry (route=health), exits non-zero, prints no key material', async () => {
  const { generateKeyPairSync } = await import('node:crypto');
  const { mkdtempSync, writeFileSync, readFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join, dirname } = await import('node:path');
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath, pathToFileURL } = await import('node:url');
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const dir = mkdtempSync(join(tmpdir(), 'mint-'));
  const log = join(dir, 'calls.json');
  const preload = join(dir, 'preload.mjs');
  writeFileSync(preload, `import { appendFileSync } from 'node:fs';
globalThis.fetch = async (url, o = {}) => { appendFileSync(${JSON.stringify(log)}, JSON.stringify({ url: String(url), body: o.body || null }) + '\\n');
  return { ok: !/sentry\\.example\\.test/.test(String(url)) ? false : true, status: 500, json: async () => ({}), text: async () => '' }; };`);
  const script = join(dirname(fileURLToPath(import.meta.url)), 'mint-token.mjs');
  const r = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, script], {
    env: { PATH: process.env.PATH, HEALTH_APP_ID: '123', HEALTH_APP_PRIVATE_KEY: privateKey, GITHUB_REPOSITORY_OWNER: 'Example-Org', GITHUB_SHA: 'abc1234', SENTRY_DSN: DSN, GITHUB_OUTPUT: join(dir, 'out') },
    encoding: 'utf8',
  });
  assert.notEqual(r.status, 0);
  assert.ok(!(r.stdout + r.stderr).includes('BEGIN'), 'key material printed');
  const calls = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const s = calls.find((c) => c.url.includes('sentry.example.test'));
  assert.ok(s, 'no Sentry capture on mint failure: ' + JSON.stringify(calls.map((c) => c.url)));
  assert.equal(JSON.parse(s.body.split('\n')[2]).tags.route, 'health');
  assert.ok(!s.body.includes('BEGIN'));
});
