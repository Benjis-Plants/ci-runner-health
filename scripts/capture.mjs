// Minimal Sentry envelope capture (built-in fetch, no SDK). Never throws.
// Payload is scrubbed: error message/stack are never sent, only the error class name.
import { randomBytes } from 'node:crypto';

export async function capture({ error, route, env = process.env, fetch: f = globalThis.fetch }) {
  try {
    const dsn = env.SENTRY_DSN;
    if (!dsn) return;
    const u = new URL(dsn);
    const project = u.pathname.replace(/^\/+/, '');
    const event = {
      event_id: randomBytes(16).toString('hex'),
      timestamp: Date.now() / 1000,
      platform: 'node',
      level: 'error',
      release: env.GITHUB_SHA,
      environment: 'production',
      tags: { route },
      exception: { values: [{ type: (error && error.name) || 'Error', value: 'redacted' }] },
    };
    const body = [{ dsn, sent_at: new Date().toISOString() }, { type: 'event' }, event]
      .map((x) => JSON.stringify(x))
      .join('\n');
    await f(`${u.protocol}//${u.host}/api/${project}/envelope/`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-sentry-envelope' },
      body,
    });
  } catch {
    // capture must never break the caller
  }
}
