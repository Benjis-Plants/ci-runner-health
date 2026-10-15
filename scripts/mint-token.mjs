// Mints a GitHub App installation token (Node built-ins only) and exposes it as a masked step output.
import { createSign } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { capture } from './capture.mjs';

const b64 = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');

export async function mint({ env = process.env, fetch = globalThis.fetch } = {}) {
  const iat = Math.floor(Date.now() / 1000);
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iat: iat - 60, exp: iat + 540, iss: env.HEALTH_APP_ID })}`;
  const jwt = `${unsigned}.${createSign('RSA-SHA256').update(unsigned).sign(env.HEALTH_APP_PRIVATE_KEY, 'base64url')}`;
  const h = { authorization: `Bearer ${jwt}`, accept: 'application/vnd.github+json' };
  const inst = await fetch(`https://api.github.com/orgs/${env.GITHUB_REPOSITORY_OWNER}/installation`, { headers: h });
  if (!inst.ok) throw new Error('installation');
  const { id } = await inst.json();
  const tok = await fetch(`https://api.github.com/app/installations/${id}/access_tokens`, { method: 'POST', headers: h });
  if (!tok.ok) throw new Error('access_token');
  return (await tok.json()).token;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const token = await mint();
    console.log(`::add-mask::${token}`);
    appendFileSync(process.env.GITHUB_OUTPUT, `token=${token}\n`);
  } catch (e) {
    await capture({ error: e, route: process.env.CAPTURE_ROUTE || 'health', env: process.env });
    console.log('token_mint=failed');
    process.exitCode = 1;
  }
}
