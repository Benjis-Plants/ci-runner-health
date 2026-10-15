import { test } from 'node:test';
import assert from 'node:assert/strict';
import { capture } from './capture.mjs';

const DSN = 'https://publickey123@sentry.example.test/42';
const SECRETS = ['ghs_SECRETTOKEN', 'runner-host-01.internal.example', 'https://hooks.example.test/T0/B0/WEBHOOKSECRET'];
const mkErr = () => new Error(`failed with ${SECRETS.join(' ')}`);

function stub() {
  const calls = [];
  const fetch = async (url, opts = {}) => { calls.push({ url: String(url), opts }); return { ok: true, status: 200, text: async () => '' }; };
  fetch.calls = calls;
  return fetch;
}
const parse = (body) => body.trim().split('\n').map((l) => JSON.parse(l));

for (const route of ['health', 'keepalive', 'requeue']) {
  test(`capture posts a Sentry envelope with release=SHA, environment=production, tags.route=${route}`, async () => {
    const fetch = stub();
    await capture({ error: mkErr(), route, env: { SENTRY_DSN: DSN, GITHUB_SHA: 'deadbeef1234' }, fetch });
    assert.equal(fetch.calls.length, 1);
    const { url, opts } = fetch.calls[0];
    assert.equal(url, 'https://sentry.example.test/api/42/envelope/');
    assert.equal((opts.method || '').toUpperCase(), 'POST');
    const [header, itemHeader, event] = parse(opts.body);
    assert.equal(header.dsn, DSN);
    assert.equal(itemHeader.type, 'event');
    assert.equal(event.release, 'deadbeef1234');
    assert.equal(event.environment, 'production');
    assert.equal(event.tags.route, route);
  });
}

test('capture payload is scrubbed: no token, runner host, webhook URL, or error message text', async () => {
  const fetch = stub();
  await capture({ error: mkErr(), route: 'health', env: { SENTRY_DSN: DSN, GITHUB_SHA: 'abc' }, fetch });
  const body = fetch.calls[0].opts.body;
  for (const s of SECRETS) assert.ok(!body.includes(s), `leaked: ${s}`);
  assert.ok(!body.includes('failed with'));
});

test('capture is a no-op (no fetch) when SENTRY_DSN is missing', async () => {
  const fetch = stub();
  await capture({ error: mkErr(), route: 'health', env: { GITHUB_SHA: 'abc' }, fetch });
  assert.equal(fetch.calls.length, 0);
});

test('capture never throws when the transport fails', async () => {
  const fetch = async () => { throw new Error('network down'); };
  await assert.doesNotReject(capture({ error: mkErr(), route: 'health', env: { SENTRY_DSN: DSN, GITHUB_SHA: 'abc' }, fetch }));
});
