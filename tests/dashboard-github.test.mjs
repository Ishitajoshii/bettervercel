import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';

const html = await readFile(new URL('../dashboard/index.html', import.meta.url), 'utf8');
const script = await readFile(new URL('../dashboard/app.js', import.meta.url), 'utf8');
const projectId = 'p1111111111111111';
const candidate = rootDirectory => ({ rootDirectory, framework: 'vite', installCommand: 'npm ci', buildCommand: 'npm run build', outputDirectory: 'dist', routing: 'spa' });
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };
async function fixture({ callback = true, enabled = true } = {}) {
  const { document } = parseHTML(html);
  // Linkedom intentionally has no select.value setter; emulate browser selection for these tests.
  for (const select of document.querySelectorAll('select')) Object.defineProperty(select, 'value', {
    get() { return this._value ?? this.querySelector('option')?.getAttribute('value') ?? ''; }, set(value) { this._value = value; },
  });
  const requests = []; const timers = []; const storage = new Map();
  if (callback) storage.set('bettervercel-oauth', JSON.stringify({ state: 'expected-state', verifier: 'verifier' }));
  const location = { search: callback ? '?code=gh-code&state=expected-state' : '', pathname: '/dashboard/', assign(url) { this.assigned = url; } };
  const window = { location, history: { replaceState(...args) { location.replaced = args[2]; } },
    sessionStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) } };
  let responder = async url => {
    if (url === './config.json') return { apiUrl: 'https://api.example.com' };
    if (url.endsWith('/config')) return { enabled, message: enabled ? null : 'Complete one-time setup.' };
    if (url.endsWith('/exchange')) return { token: `gs_${'x'.repeat(43)}`, login: '<b>owner</b>' };
    if (url.endsWith('/authorize')) return { url: 'https://github.com/login/oauth/authorize?client_id=test', state: 'new-state' };
    if (url.endsWith('/github/projects')) return { projects: [] };
    if (url.includes('/repos?')) return { repositories: [ { fullName: 'owner/site', defaultBranch: 'main', canImport: true }, { fullName: 'owner/readonly', defaultBranch: 'main', canImport: false } ], nextPage: null };
    if (url.includes('/branches?')) return { branches: ['main', 'feature'], nextPage: null };
    if (url.includes('/inspect?')) return { commitSha: 'a'.repeat(40), candidates: [candidate('apps/web')], recommendedRoot: 'apps/web' };
    if (url.endsWith('/import')) return { projectId, name: 'site', status: 'queued' };
    if (url.includes('/build?')) return { status: 'completed', conclusion: 'failure', actionsUrl: 'https://github.com/owner/site/actions' };
    if (url.endsWith('/deployments')) return { deployments: [], nextCursor: null };
    return {};
  };
  const context = vm.createContext({ document, window, URL, URLSearchParams, AbortSignal, crypto: webcrypto,
    TextEncoder, Uint8Array, btoa, setTimeout: callback => timers.push(callback),
    fetch: async (url, options = {}) => {
      const body = options.body ? JSON.parse(options.body) : undefined;
      requests.push({ url, ...options, body }); const result = await responder(url, options, body);
      return { ok: !result.error, status: result.error ? 409 : 200, json: async () => result };
    },
  });
  vm.runInContext(script, context); await flush();
  return { $: id => document.getElementById(id), document, requests, storage, location, timers,
    respond(fn) { const previous = responder; responder = async (...args) => await fn(...args) ?? previous(...args); } };
}

test('GitHub dashboard completes callback, scrubs code/verifier, renders repos safely, and disables read-only imports', async () => {
  const f = await fixture();
  assert.equal(f.location.replaced, '/dashboard/'); assert.equal(f.storage.size, 0);
  assert.equal(f.$('github-account').textContent, 'Connected as <b>owner</b>');
  assert.equal(f.$('github-account').querySelector('b'), null);
  assert.equal(f.$('repo-list').querySelectorAll('button')[1].disabled, true);
  f.$('repo-search').value = 'site'; f.$('repo-search').oninput();
  assert.equal(f.$('repo-list').querySelectorAll('button').length, 1);
});

test('repo import autofills detected root and editable settings; submission creates and selects project', async () => {
  const f = await fixture(); await f.$('repo-list').querySelector('button').onclick();
  assert.equal(f.$('import-root').value, 'apps/web'); assert.equal(f.$('import-output').value, 'dist');
  assert.equal(f.$('import-routing').value, 'spa'); assert.equal(f.$('import-deploy').disabled, false);
  f.$('import-consent').checked = true; f.$('import-output').value = 'custom-dist';
  await f.$('import-form').onsubmit({ preventDefault() {} }); await flush();
  const request = f.requests.find(request => request.url.endsWith('/import'));
  assert.equal(request.body.rootDirectory, 'apps/web'); assert.equal(request.body.outputDirectory, 'custom-dist');
  assert.equal(request.body.confirmWorkflow, true); assert.match(request.body.importId, /^[a-f0-9-]+$/);
  assert.equal(f.$('project-count').textContent, '1'); assert.equal(f.$('project-name').textContent, 'site');
  assert.match(f.$('build-status').textContent, /failure/);
  assert.equal(f.$('build-status').querySelector('a').rel, 'noopener noreferrer');
});

test('multiple roots require an explicit choice and stale branch inspections cannot overwrite the selected branch', async () => {
  const f = await fixture();
  f.respond(url => url.includes('/inspect?') ? { commitSha: 'a'.repeat(40), candidates: [candidate('apps/web'), candidate('apps/docs')], recommendedRoot: null } : undefined);
  await f.$('repo-list').querySelector('button').onclick();
  assert.equal(f.$('import-root').value, ''); assert.match(f.$('detection-status').textContent, /2 possible apps/);
  f.$('import-candidate').value = 'apps/docs'; f.$('import-candidate').onchange(); assert.equal(f.$('import-root').value, 'apps/docs');
  let release;
  f.respond(url => url.includes('/inspect?') && url.endsWith('branch=main') ? new Promise(resolve => { release = resolve; }) :
    url.includes('/inspect?') ? { commitSha: 'b'.repeat(40), candidates: [candidate('feature-app')], recommendedRoot: 'feature-app' } : undefined);
  f.$('import-branch').value = 'main'; const previous = f.$('import-branch').onchange(); await flush();
  f.$('import-branch').value = 'feature'; await f.$('import-branch').onchange();
  release({ commitSha: 'a'.repeat(40), candidates: [candidate('stale-app')], recommendedRoot: 'stale-app' }); await previous;
  assert.equal(f.$('import-root').value, 'feature-app');
});

test('failed import keeps its idempotency key on retry and logout clears connected projects', async () => {
  const f = await fixture(); await f.$('repo-list').querySelector('button').onclick(); f.$('import-consent').checked = true;
  let fail = true;
  f.respond(url => url.endsWith('/import') && fail ? { error: 'Branch protection blocked setup.' } : undefined);
  await f.$('import-form').onsubmit({ preventDefault() {} });
  assert.match(f.$('github-notice').textContent, /Branch protection/); assert.equal(f.$('import-deploy').disabled, false);
  fail = false; await f.$('import-form').onsubmit({ preventDefault() {} }); await flush();
  const imports = f.requests.filter(request => request.url.endsWith('/import'));
  assert.equal(imports[0].body.importId, imports[1].body.importId);
  await f.$('github-logout').onclick();
  assert.equal(f.$('project-count').textContent, '0'); assert.equal(f.$('github-browser').hidden, true);
  assert.equal(f.$('github-welcome').hidden, false);
});

test('missing OAuth setup gives an actionable message and configured sign-in stores only transient PKCE data', async () => {
  const disabled = await fixture({ callback: false, enabled: false });
  assert.equal(disabled.$('github-connect').disabled, true); assert.match(disabled.$('github-setup').textContent, /one-time setup/);
  const f = await fixture({ callback: false }); await f.$('github-connect').onclick();
  assert.match(f.location.assigned, /^https:\/\/github.com\/login\/oauth\/authorize/);
  const saved = JSON.parse(f.storage.get('bettervercel-oauth'));
  assert.equal(saved.state, 'new-state'); assert.match(saved.verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(Object.keys(saved).sort(), ['state', 'verifier']);
});
