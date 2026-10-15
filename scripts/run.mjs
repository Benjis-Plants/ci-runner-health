// Runner: reads fleet state, applies decide(), writes variables, alerts, re-queues.
import { decide } from './decide.mjs';
import { captureError as defaultCapture } from './report.mjs';

const REQUEUE_REPOS = ['scheduler', 'benjis-quoting-tool'];
const MIN_AGE_MS = 5 * 60_000;
const CAP = 50;

function parseCurrent(raw) {
  try {
    const v = JSON.parse(raw);
    return v === 'benjis-ci' || v === 'ubuntu-latest' ? v : null;
  } catch {
    return null;
  }
}

const RERUN_TRIES = 3;
const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Cancel then re-run each stuck run. A failed re-run is retried with backoff; a run
// that still fails is logged and counted. One repo erroring never skips the other.
async function requeue(client, now, { sleep }) {
  const failed = [];
  const errs = [];
  const warn = (m) => process.stderr.write(`${m}\n`);
  let requeued = 0;
  for (const repo of REQUEUE_REPOS) {
    try {
      const runs = (await client.listQueuedRuns(repo))
        .filter((r) => now.getTime() - Date.parse(r.created_at) > MIN_AGE_MS)
        .slice(0, CAP);
      for (const r of runs) {
        try {
          await client.cancelRun(repo, r.id);
        } catch (e) {
          errs.push(e);
          failed.push(`${repo}#${r.id}`);
          warn(`requeue failed (cancel): ${repo} run ${r.id}`);
          continue;
        }
        let ok = false;
        let lastErr;
        for (let i = 0; i < RERUN_TRIES && !ok; i++) {
          if (i > 0) await sleep(2000 * 2 ** (i - 1));
          try {
            await client.rerunRun(repo, r.id);
            ok = true;
          } catch (e) { lastErr = e; }
        }
        if (ok) requeued++;
        else {
          errs.push(lastErr);
          failed.push(`${repo}#${r.id}`);
          warn(`requeue failed (rerun): ${repo} run ${r.id}`);
        }
      }
    } catch (e) {
      errs.push(e);
      failed.push(`${repo}(list)`);
      warn(`requeue failed (list): ${repo}`);
    }
  }
  warn(`requeued=${requeued} failed=${failed.length}`);
  return { failed, firstErr: errs[0] };
}

export async function evaluate({ client, dryRun = false, now = new Date(), log = console.log, captureError = defaultCapture, sleep = defaultSleep }) {
  let route = 'health-check';
  try {
    const [rawState, rawCurrent, runners] = await Promise.all([
      client.getRepoVariable('HEALTH_STATE'),
      client.getOrgVariable('CI_RUNNER_JSON'),
      client.listRunners(),
    ]);
    const current = rawCurrent == null ? null : parseCurrent(rawCurrent);
    const online = runners.filter(
      (r) => r.status === 'online' && (r.labels || []).some((l) => l.name === 'benjis-ci'),
    ).length;
    const d = decide({ state: rawState, online, current, now });

    log(`online=${online}`);
    log(`misses=${d.state.misses}`);
    log(`healthy=${d.state.healthy}`);
    log(`decision=${d.decision}`);
    log(`flipped=${d.state.flipped}`);
    log(`dry_run=${dryRun}`);
    if (dryRun) return d;

    // Order so a failure between the two writes stays retryable: flip_hosted records
    // state (flipped=true) first; flip_back changes the org variable first, so state
    // keeps flipped=true and the next cycle retries.
    const writeState = () => client.setRepoVariable('HEALTH_STATE', JSON.stringify(d.state));
    if (d.decision === 'flip_hosted') {
      await writeState();
      if (d.writeVar) await client.setOrgVariable('CI_RUNNER_JSON', d.writeVar);
    } else {
      if (d.writeVar) await client.setOrgVariable('CI_RUNNER_JSON', d.writeVar);
      await writeState();
    }
    // Re-queue before alerting so a Slack outage cannot skip it; surface failures at the end.
    let failed = [];
    let firstErr;
    if (online < 1 && (d.decision === 'flip_hosted' || current === 'ubuntu-latest')) {
      route = 'requeue';
      ({ failed, firstErr } = await requeue(client, now, { sleep }));
      if (!failed.length) route = 'health-check';
    }
    let slackErr = null;
    if (d.alert) {
      try {
        await client.postSlack(
          d.decision === 'flip_hosted'
            ? 'CI runners unhealthy: failed over to GitHub-hosted runners.'
            : 'CI runners still unhealthy (reminder).',
        );
      } catch (e) {
        slackErr = e;
      }
    }
    if (failed.length) {
      try { await client.postSlack(`ci-runner-health: ${failed.length} queued run(s) could not be re-queued: ${failed.join(', ')}`); } catch { /* best effort */ }
      throw firstErr || new Error(`re-queue failed for ${failed.length} run(s)`);
    }
    if (slackErr) throw slackErr;
    return d;
  } catch (err) {
    if (!dryRun) {
      try { await client.postSlack(`ci-runner-health step failed (route: ${route}). See workflow run.`); } catch { /* best effort */ }
    }
    try { await captureError(err, { route, env: process.env, fetch: globalThis.fetch }); } catch { /* best effort */ }
    throw err;
  }
}

function realClient(env) {
  const owner = env.GITHUB_REPOSITORY_OWNER;
  const repo = env.GITHUB_REPOSITORY.split('/')[1];
  const api = 'https://api.github.com';
  const headers = {
    Authorization: `Bearer ${env.HEALTH_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  const call = async (method, path, body, okCodes = []) => {
    const res = await fetch(`${api}${path}`, {
      method,
      headers: { ...headers, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok && !okCodes.includes(res.status)) throw new Error(`GitHub API ${method} failed: ${res.status}`);
    return res;
  };
  const getVar = async (base, name) => {
    const res = await call('GET', `${base}/${name}`, null, [404]);
    return res.status === 404 ? null : (await res.json()).value;
  };
  const setVar = async (base, name, value) => {
    const res = await call('PATCH', `${base}/${name}`, { name, value }, [404]);
    if (res.status === 404) await call('POST', base, { name, value });
  };
  return {
    getRepoVariable: (n) => getVar(`/repos/${owner}/${repo}/actions/variables`, n),
    getOrgVariable: (n) => getVar(`/orgs/${owner}/actions/variables`, n),
    setRepoVariable: (n, v) => setVar(`/repos/${owner}/${repo}/actions/variables`, n, v),
    setOrgVariable: (n, v) => setVar(`/orgs/${owner}/actions/variables`, n, v),
    listRunners: async () => {
      const out = [];
      for (let page = 1; page <= 10; page++) {
        const j = await (await call('GET', `/orgs/${owner}/actions/runners?per_page=100&page=${page}`)).json();
        out.push(...j.runners);
        if (j.runners.length < 100) break;
      }
      return out;
    },
    listQueuedRuns: async (r) =>
      (await (await call('GET', `/repos/${owner}/${r}/actions/runs?status=queued&per_page=100`)).json()).workflow_runs,
    cancelRun: (r, id) => call('POST', `/repos/${owner}/${r}/actions/runs/${id}/cancel`),
    rerunRun: (r, id) => call('POST', `/repos/${owner}/${r}/actions/runs/${id}/rerun`),
    postSlack: async (text) => {
      const res = await fetch(env.SLACK_FAILOVER_WEBHOOK, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) throw new Error(`Slack post failed: ${res.status}`);
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  evaluate({
    client: realClient(process.env),
    dryRun: process.env.DRY_RUN === 'true',
    now: new Date(),
    log: (l) => process.stdout.write(`${l}\n`),
  }).catch((err) => {
    process.stderr.write(`ci-runner-health failed: ${err && err.message}\n`);
    process.exitCode = 1;
  });
}
