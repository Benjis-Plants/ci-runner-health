import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captureError } from './report.mjs';

// Fake secrets assembled at runtime so no secret-shaped literal lives in the repo.
const WEBHOOK = 'https://hooks.' + 'slack.com/services/T000/B000/FAKEWEBHOOKSECRET';
const PRIVKEY = 'FAKE-PRIVATE-KEY-' + 'MATERIAL-12345';
const DSN = 'https://pubkey123@o42.ingest.sentry.io/777';
const SHA = '0123456789abcdef0123456789abcdef01234567';

function mockFetch() {
  const calls = [];
  const fn = async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200 }; };
  fn.calls = calls;
  return fn;
}
const envOf = (extra = {}) => ({
  GITHUB_SHA: SHA,
  SENTRY_DSN: DSN,
  SLACK_FAILOVER_WEBHOOK: WEBHOOK,
  HEALTH_APP_PRIVATE_KEY: PRIVKEY,
  ...extra,
});
const eventOf = (call) =>
  String(call.init.body).split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((o) => o && o.tags);

test('POSTs a Sentry envelope to the DSN host with release/environment/route tags', async () => {
  const fetch = mockFetch();
  await captureError(new Error('boom'), { route: 'requeue', env: envOf(), fetch });
  assert.equal(fetch.calls.length, 1);
  const { url, init } = fetch.calls[0];
  assert.equal(url, 'https://o42.ingest.sentry.io/api/777/envelope/');
  assert.equal(init.method, 'POST');
  const ev = eventOf(fetch.calls[0]);
  assert.ok(ev, 'envelope contains an event payload with tags');
  assert.equal(ev.tags.release, SHA);
  assert.equal(ev.tags.environment, 'failover');
  assert.equal(ev.tags.route, 'requeue');
});

for (const route of ['health-check', 'requeue', 'keepalive']) {
  test(`route tag accepted: ${route}`, async () => {
    const fetch = mockFetch();
    await captureError(new Error('x'), { route, env: envOf(), fetch });
    assert.equal(eventOf(fetch.calls[0]).tags.route, route);
  });
}

test('captured event carries no secret content (message or env values)', async () => {
  const fetch = mockFetch();
  const err = new Error(`failed calling ${WEBHOOK} with key ${PRIVKEY}`);
  await captureError(err, { route: 'health-check', env: envOf(), fetch });
  const body = String(fetch.calls[0].init.body);
  assert.ok(!body.includes(WEBHOOK), 'webhook leaked');
  assert.ok(!body.includes('FAKEWEBHOOKSECRET'), 'webhook secret part leaked');
  assert.ok(!body.includes(PRIVKEY), 'private key leaked');
});

test('SENTRY_DSN unset -> skipped silently (no fetch, no throw)', async () => {
  const fetch = mockFetch();
  const env = envOf();
  delete env.SENTRY_DSN;
  await captureError(new Error('boom'), { route: 'keepalive', env, fetch });
  assert.equal(fetch.calls.length, 0);
});
