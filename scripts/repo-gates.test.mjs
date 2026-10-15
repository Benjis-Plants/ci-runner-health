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

test('keepalive.yml: monthly cron, workflow_dispatch, enable API for both workflows, Sentry + Slack wiring, no git push/commit', () => {
  const t = read(`${WF}/keepalive.yml`);
  assert.match(t, /cron:\s*['"][^'"]+\s+[^'"]+\s+\d+\s+\*\s+\*['"]/, 'monthly cron: fixed day-of-month');
  assert.match(t, /CAPTURE_ROUTE:\s*keepalive|route:\s*keepalive/);
  assert.match(t, /SENTRY_DSN/);
  assert.match(t, /failure\(\)/);
  assert.match(t, /SLACK_FAILOVER_WEBHOOK/);
  const code = ['keepalive.mjs', ...(readdirSync(join(ROOT, 'scripts')))].filter((f, i, a) => a.indexOf(f) === i && /\.mjs$/.test(f) && !/test/.test(f)).map((f) => read(`scripts/${f}`)).join('\n') + t;
  assert.match(code, /actions\/workflows\/[^\n]*\/enable/);
  assert.match(code, /method:\s*['"]PUT['"]|-X PUT/);
  assert.match(code, /health\.yml/);
  assert.match(code, /keepalive\.yml/);
  assert.match(t, /cron:/);
  assert.match(t, /workflow_dispatch:/);
  assert.match(t, /^permissions:\s*\{\}\s*$/m);
  assert.match(t, /enable/);
  assert.ok(!/git (push|commit)/.test(t));
});

test('every workflow job referencing secrets. declares environment: failover', () => {
  const files = existsSync(join(ROOT, WF)) ? readdirSync(join(ROOT, WF)).filter((f) => /\.ya?ml$/.test(f)) : [];
  assert.ok(files.length >= 3, 'expected the three workflows');
  let secretJobs = 0;
  for (const f of files) {
    const jobs = jobsOf(read(`${WF}/${f}`));
    assert.ok(jobs.length > 0, `${f}: parser found no jobs (check would be vacuous)`);
    for (const job of jobs) {
      if (/secrets\./.test(job)) { secretJobs += 1; assert.match(job, /environment:\s*failover\b/, `${f}: job uses secrets without environment: failover`); }
    }
  }
  assert.ok(secretJobs >= 2, 'health and keepalive jobs read secrets');
  const evalJob = jobsOf(read(`${WF}/health.yml`)).find((j) => /name:\s*Evaluate runners\s*$/m.test(j));
  assert.ok(evalJob, 'Evaluate runners step must be inside a job of health.yml');
  assert.match(evalJob, /environment:\s*failover\b/);
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

const section = (md, titleRe) => {
  const parts = md.split(/^(?=#{1,3} )/m);
  const s = parts.find((p) => titleRe.test(p.split('\n')[0]));
  assert.ok(s, `README section ${titleRe} missing`);
  return s;
};

test('README permissions section lists the exact permissions from the runbook', () => {
  const s = section(read('README.md'), /permission/i);
  assert.match(s, /Self-hosted runners[^\n]*read/i);
  assert.match(s, /Variables[^\n]*read[^\n]*write/i);
  assert.match(s, /scheduler[^\n]*benjis-quoting-tool[^\n]*Actions[^\n]*write|Actions[^\n]*write[^\n]*scheduler[^\n]*benjis-quoting-tool/i);
  assert.match(s, /(this repo|ci-runner-health)[^\n]*Variables[^\n]*write[^\n]*Actions[^\n]*write/i);
  assert.match(s, /operator[^\n]*confirm|confirm[^\n]*operator/i, 'marked line for operator to confirm exact keys');
});

test('README: failover environment, keep-alive (enable API, no commits), state shape, log contract sections', () => {
  const r = read('README.md');
  assert.match(section(r, /failover/i), /HEALTH_APP_ID[\s\S]*HEALTH_APP_PRIVATE_KEY[\s\S]*SLACK_FAILOVER_WEBHOOK[\s\S]*SENTRY_DSN|branch `?main`?/);
  const ka = section(r, /keep-?alive/i);
  assert.match(ka, /actions\/workflows\/[^\n]*enable/);
  assert.match(ka, /no commits/i);
  const state = section(r, /state/i);
  assert.ok(state.includes('{"misses":0,"healthy":0,"flipped":false,"lastAlert":null}'));
  const lc = section(r, /log contract/i);
  assert.ok(lc.includes('^(online|misses|healthy|decision|flipped|dry_run)=[A-Za-z0-9_.-]+$'));
  for (const d of ['none', 'flip_to_hosted', 'flip_back', 'alert', 'api_error']) assert.ok(lc.includes(d), `decision value ${d}`);
});

test('README re-run section carries "result: pending" and describes the dispatch fallback', () => {
  const s = section(read('README.md'), /re-?queue|re-?run/i);
  assert.match(s, /result: pending/);
  assert.match(s, /dispatch/i);
});

test('capture is wired: workflows post Slack on failure using the existing SLACK_FAILOVER_WEBHOOK only', () => {
  const t = read(`${WF}/health.yml`);
  assert.match(t, /failure\(\)/);
  assert.match(t, /SLACK_FAILOVER_WEBHOOK/);
  assert.match(t, /SENTRY_DSN/);
});
