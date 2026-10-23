import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

const hosting = JSON.parse(await readFile('cdk-outputs.json', 'utf8')).BetterVercelStaticStack;
const control = JSON.parse(await readFile('control-outputs.json', 'utf8')).BetterVercelControlStack;
const operator = JSON.parse(await readFile('.bettervercel/operator.json', 'utf8'));
const origin = `https://${hosting.DomainName}`;
const callback = `${origin}/dashboard/`;
const checks = [];
async function request(path, method = 'GET', body) {
  const response = await fetch(`${control.ApiUrl}/v1/github${path}`, { method, redirect: 'error',
    signal: AbortSignal.timeout(30000), headers: { origin, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  assert.equal(response.headers.get('access-control-allow-origin'), origin);
  return { status: response.status, body: await response.json() };
}

const config = await request('/config');
assert.equal(config.status, 200); assert.equal(config.body.enabled, true); checks.push('GitHub sign-in enabled');
const preflight = await fetch(`${control.ApiUrl}/v1/github/authorize`, { method: 'OPTIONS',
  headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' }, signal: AbortSignal.timeout(30000) });
assert.ok(preflight.ok); assert.equal(preflight.headers.get('access-control-allow-origin'), origin);
assert.ok(preflight.headers.get('access-control-allow-methods').includes('POST')); checks.push('Browser CORS preflight');
const verifier = randomBytes(32).toString('base64url');
const challenge = createHash('sha256').update(verifier).digest('base64url');
const start = await request('/authorize', 'POST', { challenge });
assert.equal(start.status, 200);
const url = new URL(start.body.url);
assert.equal(url.origin, 'https://github.com'); assert.equal(url.pathname, '/login/oauth/authorize');
assert.equal(url.searchParams.get('client_id'), operator.github.clientId);
assert.equal(url.searchParams.get('redirect_uri'), callback);
assert.equal(url.searchParams.get('code_challenge'), challenge);
assert.equal(url.searchParams.get('code_challenge_method'), 'S256'); checks.push('OAuth redirect and PKCE');
const wrongVerifier = await request('/exchange', 'POST', { state: start.body.state, verifier: randomBytes(32).toString('base64url'), code: 'invalid-smoke-test-code' });
assert.equal(wrongVerifier.status, 401); checks.push('PKCE mismatch rejected');
// An intentionally invalid code exercises secret access and GitHub connectivity without signing in.
const invalidCode = await request('/exchange', 'POST', { state: start.body.state, verifier, code: 'invalid-smoke-test-code' });
assert.equal(invalidCode.status, 401); assert.match(invalidCode.body.error, /GitHub sign-in could not be completed/);
checks.push('Secret retrieval and GitHub exchange reachable; invalid authorization code rejected');
await new Promise(resolve => setTimeout(resolve, 1000));
const unauthenticated = await request('/repos'); assert.equal(unauthenticated.status, 401); checks.push('Repository access requires sign-in');
for (const name of ['index.html', 'app.js', 'style.css']) {
  const response = await fetch(`${callback}${name}`, { cache: 'no-store', signal: AbortSignal.timeout(30000) });
  assert.equal(response.status, 200);
  const remote = Buffer.from(await response.arrayBuffer());
  const local = await readFile(`dashboard/${name}`);
  assert.equal(createHash('sha256').update(remote).digest('hex'), createHash('sha256').update(local).digest('hex'), `${name} differs from deployed source`);
}
checks.push('Live dashboard files match current source');
const result = { checkedAt: new Date().toISOString(), dashboard: callback, checks,
  pending: ['User GitHub consent and authenticated repository import'] };
await writeFile('.build/github-rollout-results.json', JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
