// Re-enables the scheduled workflows (GitHub disables schedules after 60 days of repo inactivity).
import { fileURLToPath } from 'node:url';
import { capture } from './capture.mjs';

export async function keepalive({ env = process.env, fetch = globalThis.fetch } = {}) {
  let failed = 0;
  for (const wf of ['health.yml', 'keepalive.yml']) {
    try {
      const r = await fetch(`https://api.github.com/repos/${env.GITHUB_REPOSITORY}/actions/workflows/${wf}/enable`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${env.GH_TOKEN}`, accept: 'application/vnd.github+json' },
      });
      if (!r.ok) throw new Error('enable');
    } catch (e) {
      failed += 1;
      await capture({ error: e, route: 'keepalive', env, fetch });
    }
  }
  return failed ? 1 : 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  keepalive().then((c) => { process.exitCode = c; }, () => { process.exitCode = 1; });
}
