// Entrypoint for the "Evaluate runners" step. Prints only log-contract lines.
import { fileURLToPath } from 'node:url';
import { decide, countOnline, normalizeState } from './decide.mjs';
import { capture } from './capture.mjs';

const API = 'https://api.github.com';
const REQUEUE_REPOS = ['scheduler', 'benjis-quoting-tool'];
const FIVE_MIN = 5 * 60 * 1000;

const headers = (token) => ({
  authorization: `Bearer ${token}`,
  accept: 'application/vnd.github+json',
  'x-github-api-version': '2022-11-28',
});

export async function requeue({ fetch, token, owner, repos = REQUEUE_REPOS, now = Date.now() }) {
  const counts = { cancelled: 0, rerun: 0, dispatched: 0, failed: 0 };
  const call = (method, path, body) =>
    fetch(`${API}${path}`, { method, headers: headers(token), ...(body ? { body: JSON.stringify(body) } : {}) });
  for (const repo of repos) {
    try {
      const res = await call('GET', `/repos/${owner}/${repo}/actions/runs?status=queued&per_page=100`);
      if (!res.ok) { counts.failed += 1; continue; }
      const runs = ((await res.json()).workflow_runs || []).filter(
        (r) => r.status === 'queued' && now - Date.parse(r.created_at) > FIVE_MIN,
      );
      for (const run of runs) {
        const base = `/repos/${owner}/${repo}/actions`;
        const c = await call('POST', `${base}/runs/${run.id}/cancel`);
        if (c.ok) counts.cancelled += 1;
        const r = await call('POST', `${base}/runs/${run.id}/rerun`);
        if (r.ok) { counts.rerun += 1; continue; }
        const d = await call('POST', `${base}/workflows/${run.workflow_id}/dispatches`, { ref: run.head_branch });
        if (d.ok) counts.dispatched += 1; else counts.failed += 1;
      }
    } catch {
      counts.failed += 1;
    }
  }
  return counts;
}

async function listOnline(get, owner) {
  const runners = [];
  for (let page = 1; page < 100; page++) {
    const res = await get(`/orgs/${owner}/actions/runners?per_page=100&page=${page}`);
    if (!res.ok) throw new Error('runners_api');
    const data = await res.json();
    const list = data.runners || [];
    runners.push(...list);
    if (list.length < 100 || runners.length >= (data.total_count ?? 0)) break;
  }
  return countOnline(runners);
}

async function readVar(get, path) {
  const res = await get(path);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error('var_api');
  return (await res.json()).value ?? null;
}

const stateKey = (s) => JSON.stringify(s.flipped ? s : { ...s, healthy: 0 }); // healthy is irrelevant unless flipped

export async function main({ env = process.env, fetch = globalThis.fetch, out = (l) => console.log(l) } = {}) {
  const dry = String(env.DRY_RUN).toLowerCase() === 'true';
  const owner = env.GITHUB_REPOSITORY_OWNER;
  const repo = env.GITHUB_REPOSITORY;
  const token = env.GH_TOKEN;
  const get = (path) => fetch(`${API}${path}`, { headers: headers(token) });
  const write = (method, path, body) =>
    fetch(`${API}${path}`, { method, headers: headers(token), body: JSON.stringify(body) });
  let exit = 0;
  const fail = async (e, route) => {
    exit = 1;
    await capture({ error: e, route, env, fetch });
  };

  let online, currentVar, stored;
  try {
    online = await listOnline(get, owner);
    currentVar = await readVar(get, `/orgs/${owner}/actions/variables/CI_RUNNER_JSON`);
    stored = await readVar(get, `/repos/${repo}/actions/variables/HEALTH_STATE`);
  } catch (e) {
    out('decision=api_error');
    out(`dry_run=${dry}`);
    await fail(e, 'health');
    return 1;
  }
  let prev = null;
  try { prev = stored === null ? null : JSON.parse(stored); } catch { prev = null; }

  const { state, actions } = decide({ state: prev, online, currentVar, now: Date.now() });
  const setVar = actions.find((a) => a.type === 'set_var');
  const decision = setVar
    ? (setVar.value === '"ubuntu-latest"' ? 'flip_to_hosted' : 'flip_back')
    : actions.some((a) => a.type === 'slack') ? 'alert' : 'none';
  out(`online=${online}`);
  out(`misses=${state.misses}`);
  out(`healthy=${state.healthy}`);
  out(`flipped=${state.flipped}`);
  out(`decision=${decision}`);
  out(`dry_run=${dry}`);
  if (dry) return 0;

  for (const a of actions) {
    try {
      if (a.type === 'set_var') {
        const r = await write('PATCH', `/orgs/${owner}/actions/variables/CI_RUNNER_JSON`, { name: 'CI_RUNNER_JSON', value: a.value });
        if (!r.ok) throw new Error('set_var');
      } else if (a.type === 'slack') {
        if (env.SLACK_FAILOVER_WEBHOOK) {
          const text = a.kind === 'flip'
            ? `CI runner failover: CI_RUNNER_JSON is now ${actions.find((x) => x.type === 'set_var')?.value ?? 'unchanged'}`
            : 'CI runners are unhealthy (no online benjis-ci runner)';
          const r = await fetch(env.SLACK_FAILOVER_WEBHOOK, { method: 'POST', body: JSON.stringify({ text }) });
          if (!r.ok) throw new Error('slack');
        }
      } else if (a.type === 'requeue') {
        const counts = await requeue({ fetch, token, owner, now: Date.now() });
        if (counts.failed > 0) await fail(new Error('requeue'), 'requeue');
      }
    } catch (e) {
      await fail(e, a.type === 'requeue' ? 'requeue' : 'health');
    }
  }

  if (stateKey(state) !== stateKey(normalizeState(prev))) {
    try {
      const body = { name: 'HEALTH_STATE', value: JSON.stringify(state) };
      let r = stored === null
        ? await write('POST', `/repos/${repo}/actions/variables`, body)
        : await write('PATCH', `/repos/${repo}/actions/variables/HEALTH_STATE`, body);
      if (!r.ok) throw new Error('state_write');
    } catch (e) {
      await fail(e, 'health');
    }
  }
  return exit;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().then((c) => { process.exitCode = c; }, () => { process.exitCode = 1; });
}
