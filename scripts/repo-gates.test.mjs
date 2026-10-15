import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => {
  assert.ok(existsSync(join(ROOT, p)), `${p} must exist`);
  return readFileSync(join(ROOT, p), 'utf8');
};
const WF = '.github/workflows';
const jobsOf = (text) => text.split(/^jobs:\s*$/m)[1]?.split(/^  (?=[A-Za-z0-9_-]+:\s*$)/m).slice(1) ?? [];

test('test.yml: pull_request trigger, node --test, permissions contents: read, no secrets/environment', () => {
  const t = read(`${WF}/test.yml`);
  assert.match(t, /^\s*pull_request:/m);
  assert.match(t, /node --test/);
  assert.match(t, /^permissions:\s*\n\s+contents:\s*read\s*$/m);
  assert.ok(!/secrets\./.test(t));
  assert.ok(!/^\s*environment:/m.test(t));
});

test('health.yml: schedule */5, dispatch dry_run boolean default false, concurrency, permissions {}, step Evaluate runners', () => {
  const t = read(`${WF}/health.yml`);
  assert.match(t, /cron:\s*['"]\*\/5 \* \* \* \*['"]/);
  assert.match(t, /workflow_dispatch:/);
  assert.match(t, /dry_run:[\s\S]*?type:\s*boolean[\s\S]*?default:\s*false/);
  assert.match(t, /concurrency:/);
  assert.match(t, /group:\s*ci-runner-health/);
  assert.match(t, /cancel-in-progress:\s*false/);
  assert.match(t, /^permissions:\s*\{\}\s*$/m);
  assert.match(t, /name:\s*Evaluate runners\s*$/m);
});

test('keepalive.yml: monthly cron, workflow_dispatch, enable API, no git push/commit', () => {
  const t = read(`${WF}/keepalive.yml`);
  assert.match(t, /cron:/);
  assert.match(t, /workflow_dispatch:/);
  assert.match(t, /^permissions:\s*\{\}\s*$/m);
  assert.match(t, /enable/);
  assert.ok(!/git (push|commit)/.test(t));
});

test('every workflow job referencing secrets. declares environment: failover', () => {
  const files = existsSync(join(ROOT, WF)) ? readdirSync(join(ROOT, WF)).filter((f) => /\.ya?ml$/.test(f)) : [];
  assert.ok(files.length >= 3, 'expected the three workflows');
  for (const f of files) {
    for (const job of jobsOf(read(`${WF}/${f}`))) {
      if (/secrets\./.test(job)) assert.match(job, /environment:\s*failover\b/, `${f}: job uses secrets without environment: failover`);
    }
  }
});

test('no webhook URL or private key material anywhere in tracked-style files', () => {
  const walk = (d) => readdirSync(join(ROOT, d), { withFileTypes: true }).flatMap((e) => {
    if (e.name === '.git' || e.name === '.worktrees' || e.name === 'node_modules') return [];
    const p = join(d, e.name);
    return e.isDirectory() ? walk(p) : [p];
  });
  for (const p of walk('.')) {
    if (p.endsWith('.test.mjs')) continue; // fixtures use fake example hosts only
    const txt = readFileSync(join(ROOT, p), 'utf8');
    assert.ok(!/hooks\.slack\.com|BEGIN .*PRIVATE KEY/.test(txt), `${p} contains a forbidden pattern`);
  }
});

test('README documents permissions, environment, keep-alive, state, log contract, re-run result', () => {
  const r = read('README.md');
  for (const re of [/Self-hosted runners/i, /Variables/, /Actions/, /`failover`/, /enable/i, /no commits/i, /HEALTH_STATE/, /misses/, /lastAlert/, /log contract/i, /result: pending/]) {
    assert.match(r, re, `README missing ${re}`);
  }
});

test('capture is wired: workflows post Slack on failure using the existing SLACK_FAILOVER_WEBHOOK only', () => {
  const t = read(`${WF}/health.yml`);
  assert.match(t, /failure\(\)/);
  assert.match(t, /SLACK_FAILOVER_WEBHOOK/);
  assert.match(t, /SENTRY_DSN/);
});
