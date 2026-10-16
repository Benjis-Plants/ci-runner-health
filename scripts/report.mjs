// Sentry error capture. Skipped silently when SENTRY_DSN is unset; never throws.
const SECRET_KEY = /SECRET|KEY|TOKEN|WEBHOOK|DSN|PASSWORD/i;

function scrub(text, env) {
  let out = String(text);
  for (const [k, v] of Object.entries(env || {})) {
    if (SECRET_KEY.test(k) && typeof v === 'string' && v.length >= 4) out = out.split(v).join('[redacted]');
  }
  return out
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[redacted]')
    .replace(/https?:\/\/\S+/g, '[url]')
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}/g, '[redacted]');
}

export async function captureError(error, { route, env = process.env, fetch: doFetch = globalThis.fetch } = {}) {
  try {
    const dsn = env.SENTRY_DSN;
    if (!dsn) return;
    const u = new URL(dsn);
    const projectId = u.pathname.replace(/^\/+/, '').split('/').pop();
    const url = `${u.protocol}//${u.host}/api/${projectId}/envelope/`;
    const eventId = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
    const now = new Date().toISOString();
    const release = env.GITHUB_SHA || 'unknown';
    const event = {
      event_id: eventId,
      timestamp: now,
      platform: 'node',
      level: 'error',
      release,
      environment: 'failover',
      message: scrub(error && error.message ? error.message : String(error), env),
      tags: { release, environment: 'failover', route },
    };
    const body = [
      JSON.stringify({ event_id: eventId, sent_at: now }),
      JSON.stringify({ type: 'event' }),
      JSON.stringify(event),
    ].join('\n');
    await doFetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-sentry-envelope',
        'X-Sentry-Auth': `Sentry sentry_version=7, sentry_key=${u.username}, sentry_client=ci-runner-health/1`,
      },
      body,
    });
  } catch {
    // capture must never mask the original failure
  }
}
