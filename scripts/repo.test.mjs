import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => (existsSync(join(ROOT, p)) ? readFileSync(join(ROOT, p), 'utf8') : '');
const health = read('.github/workflows/health.yml');
const keepalive = read('.github/workflows/keepalive.yml');
const readme = read('README.md');

function walk(dir, out = []) {
  for (const n of readdirSync(dir)) {
    if (n === '.git' || n === 'node_modules' || n === '.worktrees') continue;
    const p = join(dir, n);
    statSync(p).isDirectory() ? walk(p, out) : out.push(p);
  }
  return out;
}

test('health.yml exists with cron */5, dry_run input, and the exact step name', () => {
  assert.match(health, /cron:\s*['"]\*\/5 \* \* \* \*['"]/);
  assert.match(health, /workflow_dispatch:/);
  assert.match(health, /dry_run:/);
  assert.match(health, /type:\s*boolean/);
  assert.match(health, /^\s*-?\s*name:\s*Evaluate runners\s*$/m);
});

test('health.yml: top-level permissions {}, environment failover, concurrency group, no cancel-in-progress', () => {
  assert.match(health, /^permissions:\s*\{\}\s*$/m);
  assert.match(health, /environment:\s*failover\b/);
  assert.match(health, /group:\s*ci-runner-health\b/);
  assert.match(health, /cancel-in-progress:\s*false/);
});

test('secrets are referenced only inside the job that declares environment: failover', () => {
  const jobsIdx = health.indexOf('\njobs:');
  assert.ok(jobsIdx >= 0, 'jobs: present');
  assert.ok(!/secrets\./.test(health.slice(0, jobsIdx)), 'no secrets before jobs');
  // single job file: environment declared at least once and every secrets.* use follows it
  const envIdx = health.search(/environment:\s*failover/);
  assert.ok(envIdx >= 0);
  for (const m of health.matchAll(/secrets\./g)) assert.ok(m.index > envIdx);
});

test('every `uses:` in both workflows is pinned to a 40-char commit SHA', () => {
  const uses = [...(health + '\n' + keepalive).matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)].map((m) => m[1]);
  assert.ok(uses.length > 0, 'workflows use at least one action (create-github-app-token)');
  for (const u of uses) assert.match(u, /@[0-9a-f]{40}$/, u);
  assert.ok(uses.some((u) => u.startsWith('actions/create-github-app-token@')));
});

test('keepalive.yml: monthly cron + workflow_dispatch, enables both workflows, actions: write on job only, no git commit/push', () => {
  assert.match(keepalive, /cron:/);
  assert.match(keepalive, /workflow_dispatch:/);
  assert.match(keepalive, /health\.yml/);
  assert.match(keepalive, /keepalive\.yml/);
  assert.match(keepalive, /\/enable/);
  assert.match(keepalive, /^permissions:\s*\{\}\s*$/m);
  assert.match(keepalive, /actions:\s*write/);
  assert.ok(!/git\s+(commit|push)\b/.test(keepalive));
  assert.ok(!/\bgit-auto-commit|stefanzweifel|EndBug\/add-and-commit/.test(keepalive));
});

test('no secret values in repo files (health.yml must exist so this scan is meaningful)', () => {
  assert.ok(health.length > 0, 'health.yml exists');
  const patterns = [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    /hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]+/,
    /\bgh[pousr]_[A-Za-z0-9]{20,}/,
    /https:\/\/[0-9a-f]{16,}@[^\s]*sentry\.io/,
  ];
  for (const f of walk(ROOT)) {
    const text = readFileSync(f, 'utf8');
    for (const p of patterns) assert.ok(!p.test(text), `${f} matches ${p}`);
  }
});

test('README documents permissions, keep-alive, failover environment and the re-run test result', () => {
  for (const s of ['Self-hosted runners', 'Variables', 'Actions', 'scheduler', 'benjis-quoting-tool',
                   'benjis-ci-health', 'failover', 'keepalive', 'HEALTH_STATE', 'SENTRY_DSN']) {
    assert.ok(readme.includes(s), `README missing: ${s}`);
  }
  assert.match(readme, /re-?run/i);
  assert.match(readme, /workflow_dispatch/);
  assert.match(readme, /fallback/i);
});
