import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createGitHub, createGitHubClient } from '../api/github.mjs';
import { createHandler } from '../api/handler.mjs';
import { digest } from '../api/domain.mjs';
import { detectProject, inspectRepository, relativeDirectory, validateImport } from '../api/repository.mjs';
import { createWorkflow } from '../api/workflow.mjs';

const sha = 'a'.repeat(40);
const token = `gs_${'x'.repeat(43)}`;
const verifier = 'v'.repeat(43);
const challenge = createHash('sha256').update(verifier).digest('base64url');
const settings = { repository: 'owner/site', branch: 'feature/site', commitSha: sha, rootDirectory: 'apps/web',
  framework: 'vite', routing: 'spa', installCommand: 'npm ci', buildCommand: 'npm run build', outputDirectory: 'dist',
  confirmWorkflow: true, importId: 'first-import-123456' };
function fixture({ configured = true } = {}) {
  const items = new Map(); const projects = new Map(); const calls = []; let time = 1000000;
  const key = (pk, sk) => `${pk}|${sk}`;
  const data = {
    get: async (pk, sk) => structuredClone(items.get(key(pk, sk))),
    put: async item => items.set(key(item.pk, item.sk), structuredClone(item)),
    create: async item => { if (items.has(key(item.pk, item.sk))) return false; await data.put(item); return true; },
    consume: async (pk, sk) => items.delete(key(pk, sk)),
    claim: async (pk, sk, now) => { const item = items.get(key(pk, sk)); if (!item || item.leaseUntil >= now) return false; item.leaseUntil = now + 60000; return true; },
    list: async (pk, prefix) => [...items.values()].filter(item => item.pk === pk && item.sk.startsWith(prefix)),
  };
  const user = { pk: `SESSION#${digest(token)}`, sk: 'META', userId: '1', login: 'owner', accessToken: 'github-private-token', expiresAt: 999999 };
  items.set(key(user.pk, user.sk), user);
  const store = { getProject: async id => projects.get(id), createProject: async project => projects.set(project.projectId, project) };
  let responder = path => {
    if (path === '/user') return { id: 1, login: 'owner' };
    if (path === '/repos/owner/site') return { name: 'site', default_branch: 'main', permissions: { admin: true } };
    if (path.includes('/commits/feature%2Fsite')) return { sha };
    if (path.endsWith('/secrets/public-key')) return { key_id: 'key-id', key: 'public-key' };
    if (path.includes('/contents/')) return null;
    if (path.includes('/git/ref/')) return { object: { sha: 'b'.repeat(40) } };
    if (path.includes('/git/commits/')) return { tree: { sha: 'c'.repeat(40) } };
    if (path.endsWith('/git/trees')) return { sha: 'd'.repeat(40) };
    if (path.endsWith('/git/commits')) return { sha: 'e'.repeat(40) };
    return {};
  };
  const fetchImpl = async (url, options) => {
    const path = new URL(url).pathname + new URL(url).search;
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url, path, ...options, body });
    const result = path === '/login/oauth/access_token' ? { access_token: 'github-private-token', scope: 'repo,workflow' } : responder(path, options.method, body);
    const status = result === null ? 404 : result?.httpStatus ?? 200;
    return { ok: status < 400, status, json: async () => result };
  };
  const github = createGitHub({ data, store, fetchImpl, now: () => time,
    config: { clientId: configured ? 'client' : '', secretArn: 'secret', allowedUsers: ['owner'],
      redirectUri: 'https://test.cloudfront.net/dashboard/', apiUrl: 'https://api.example.com' },
    getSecret: async () => 'oauth-secret', seal: async value => { assert.match(value, /^bv_/); return 'sealed'; }, runner: '// reviewed runner' });
  const handler = createHandler({ store, github });
  async function request(path, body, method = body ? 'POST' : 'GET', auth = token) {
    const url = new URL('https://api.example.com/v1/github' + path);
    const response = await handler({ routeKey: 'ANY /v1/github/{proxy+}', rawPath: url.pathname,
      headers: auth ? { authorization: `Bearer ${auth}` } : {}, requestContext: { http: { method } },
      queryStringParameters: Object.fromEntries(url.searchParams), body: body ? JSON.stringify(body) : '' });
    return { status: response.statusCode, body: JSON.parse(response.body) };
  }
  return { request, calls, items, projects, data, github, handler, user, advance: ms => { time += ms; },
    respond(fn) { const prior = responder; responder = (path, ...args) => fn(path, ...args) ?? prior(path, ...args); } };
}

test('GitHub OAuth uses fixed redirect, PKCE, single-use state, and never returns the GitHub token', async () => {
  const f = fixture();
  const start = await f.request('/authorize', { challenge }, 'POST', '');
  const url = new URL(start.body.url);
  assert.equal(url.searchParams.get('code_challenge'), challenge);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('redirect_uri'), 'https://test.cloudfront.net/dashboard/');
  const body = { state: start.body.state, verifier, code: 'github-code' };
  assert.equal((await f.request('/exchange', { ...body, verifier: 'z'.repeat(43) })).status, 401);
  const auth = await f.request('/exchange', body, 'POST', '');
  assert.equal(auth.status, 200); assert.match(auth.body.token, /^gs_/);
  assert.ok(!JSON.stringify(auth).includes('github-private-token'));
  assert.equal((await f.request('/exchange', body)).status, 401);
  const exchange = f.calls.find(call => call.path === '/login/oauth/access_token');
  assert.equal(exchange.body.client_secret, 'oauth-secret'); assert.equal(exchange.body.code_verifier, verifier);
});

test('expired sign-in state and sessions are rejected, even before DynamoDB TTL cleanup', async () => {
  const f = fixture(); const start = await f.request('/authorize', { challenge });
  f.advance(601000);
  assert.equal((await f.request('/exchange', { state: start.body.state, verifier, code: 'code' })).status, 401);
  f.advance(999999000);
  assert.equal((await f.request('/projects')).status, 401);
});

test('unconfigured OAuth gives actionable setup status; logout invalidates server session', async () => {
  const disabled = fixture({ configured: false });
  assert.equal((await disabled.request('/config')).body.enabled, false);
  assert.equal((await disabled.request('/authorize', { challenge })).status, 503);
  const f = fixture();
  assert.equal((await f.request('/session', undefined, 'DELETE')).status, 200);
  assert.equal((await f.request('/projects')).status, 401);
});

test('GitHub session cannot access another user or operator project', async () => {
  const f = fixture();
  await assert.rejects(f.github.authenticate({ githubUserId: '2' }, { headers: { authorization: `Bearer ${token}` } }), /another account/);
  await assert.rejects(f.github.authenticate({}, { headers: { authorization: `Bearer ${token}` } }), /another account/);
  await assert.rejects(f.github.authenticate({ githubUserId: '1' }, { headers: { authorization: 'Bearer wrong' } }), /Connect GitHub/);
});

test('import encrypts the project secret, makes an atomic non-force commit, and retries idempotently', async () => {
  const f = fixture();
  const first = await f.request('/import', settings);
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const again = await f.request('/import', settings);
  assert.deepEqual(first, again); assert.equal(f.projects.size, 1);
  const treeCalls = f.calls.filter(call => call.path.endsWith('/git/trees'));
  assert.equal(treeCalls.length, 1); assert.equal(treeCalls[0].body.tree.length, 2);
  const workflow = treeCalls[0].body.tree[0].content;
  assert.ok(workflow.includes(`ref: "${sha}"`)); assert.ok(!workflow.includes('github-private-token'));
  const secret = f.calls.find(call => call.method === 'PUT'); assert.equal(secret.body.encrypted_value, 'sealed');
  const update = f.calls.find(call => call.method === 'PATCH'); assert.equal(update.body.force, false);
  assert.ok(!JSON.stringify(first).includes('deployToken'));
  assert.equal((await f.request('/import', { ...settings, outputDirectory: 'other' })).status, 409);
});

test('import checks consent, admin access, and source revision before mutating a repository', async () => {
  const f = fixture();
  assert.equal((await f.request('/import', { ...settings, confirmWorkflow: false })).status, 400);
  f.respond(path => path === '/repos/owner/site' ? { name: 'site', permissions: { admin: false } } : undefined);
  assert.equal((await f.request('/import', settings)).status, 403);
  assert.equal(f.calls.filter(call => call.method !== 'GET').length, 0);
  const moved = fixture(); moved.respond(path => path.includes('/commits/feature') ? { sha: 'f'.repeat(40) } : undefined);
  assert.equal((await moved.request('/import', settings)).status, 409);
  assert.equal(moved.projects.size, 0);
});

test('protected branch errors preserve other workflows and allow retrying the same import', async () => {
  const f = fixture(); let blocked = true;
  f.respond((path, method) => method === 'PATCH' && blocked ? { httpStatus: 422 } : undefined);
  const failure = await f.request('/import', settings);
  assert.equal(failure.status, 502); assert.match(failure.body.error, /branch protection/);
  blocked = false;
  assert.equal((await f.request('/import', settings)).status, 201);
  assert.equal(f.projects.size, 1);
});

test('repository detection finds monorepo apps, plain HTML, and inherited package manager lockfiles', async () => {
  const entries = [ ['package.json', { workspaces: ['apps/*'], scripts: { build: 'turbo run build' }, devDependencies: { vite: '8' } }], ['apps/web/package.json', { scripts: { build: 'vite build' }, dependencies: { vite: '8' } }],
    ['apps/docs/package.json', { scripts: { build: 'astro build' }, dependencies: { astro: '5' } }] ];
  const tree = [...entries.map(([path], index) => ({ path, type: 'blob', mode: '100644', sha: String(index), size: 100 })),
    { path: 'pnpm-lock.yaml', type: 'blob' }, { path: 'landing/index.html', type: 'blob' }];
  const result = await inspectRepository(async path => path.includes('/commits/') ? { sha, commit: { tree: { sha: 'tree' } } } :
    path.includes('/trees/') ? { tree } : { content: Buffer.from(JSON.stringify(entries[Number(path.split('/').at(-1))][1])).toString('base64') }, 'owner/site', 'main');
  assert.equal(result.candidates.length, 3); assert.equal(result.recommendedRoot, null);
  const web = result.candidates.find(candidate => candidate.rootDirectory === 'apps/web');
  assert.equal(web.installCommand, 'corepack pnpm --dir ../.. install --frozen-lockfile');
  assert.equal(web.buildCommand, 'corepack pnpm run build'); assert.equal(web.routing, 'spa');
  assert.equal(result.candidates.find(candidate => candidate.rootDirectory === 'landing').outputDirectory, '.');
});

test('single app is automatically recommended, and truncated repository trees fail explicitly', async () => {
  const github = async path => path.includes('/commits/') ? { sha, commit: { tree: { sha: 'tree' } } } : { tree: [{ path: 'index.html', type: 'blob' }] };
  assert.equal((await inspectRepository(github, 'owner/site', 'main')).recommendedRoot, '.');
  await assert.rejects(inspectRepository(async path => path.includes('/commits/') ? { commit: { tree: { sha } } } : { truncated: true }, 'owner/site', 'main'), /too large/);
});

test('detection recognizes Next static and import rejects traversal, invalid routing, and malformed settings', () => {
  assert.equal(detectProject('.', { dependencies: { next: '16' } }, new Set()).outputDirectory, 'out');
  for (const path of ['../app', '/app', 'C:/app', 'apps/../web', 'apps\\web', '.github/../../etc', '']) assert.throws(() => relativeDirectory(path));
  assert.equal(relativeDirectory('.'), '.'); assert.equal(relativeDirectory('apps/web'), 'apps/web');
  for (const change of [{ framework: 'next-static', routing: 'spa' }, { buildCommand: 'npm\nrun build' }, { commitSha: 'main' }]) assert.throws(() => validateImport({ ...settings, ...change }));
});

test('generated workflow keeps secrets out of build steps and does not interpolate commands into YAML', () => {
  const workflow = createWorkflow({ ...settings, projectId: 'p1111111111111111', secretName: 'PROJECT_TOKEN', apiUrl: 'https://api.example.com' });
  assert.equal(workflow.split('BETTERVERCEL_TOKEN:').length, 2);
  assert.ok(workflow.indexOf('BETTERVERCEL_TOKEN:') > workflow.indexOf('name: Publish preview'));
  assert.ok(!workflow.includes('npm run build')); assert.ok(workflow.includes('timeout-minutes: 10'));
  assert.ok(workflow.includes('persist-credentials: false')); assert.ok(!workflow.includes('pull_request_target'));
});

test('GitHub transport never follows redirects with credentials and sanitizes upstream errors', async () => {
  const github = createGitHubClient('private-token', async (url, options) => {
    assert.equal(options.redirect, 'error');
    return { ok: false, status: 403, json: async () => ({ message: 'secret data' }) };
  });
  await assert.rejects(github('/user'), /denied access/);
  await assert.rejects(github('//evil.example'), /Invalid GitHub request/);
});
