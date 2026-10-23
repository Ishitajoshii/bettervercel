import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const context = vm.createContext({});
vm.runInContext(readFileSync(new URL('../infra/preview-router.js', import.meta.url), 'utf8'), context);
const route = uri => context.handler({ request: { uri, method: 'GET', querystring: {} } });

test('preview root canonicalizes before loading relative Vite assets', () => {
  const result = route('/d/sample-01');
  assert.equal(result.statusCode, 308);
  assert.equal(result.headers.location.value, '/d/sample-01/');
  assert.equal(route('/d/sample-01/').uri, '/deployments/sample-01/index.html');
});

test('preserves asset paths and supports nested static export directory indexes', () => {
  assert.equal(route('/d/sample-01/assets/index-hash.js').uri, '/deployments/sample-01/assets/index-hash.js');
  assert.equal(route('/d/sample-01/docs/').uri, '/deployments/sample-01/docs/index.html');
  assert.equal(route('/d/sample-01/docs').statusCode, 308);
  assert.equal(route('/d/sample-01/docs').headers.location.value, '/d/sample-01/docs/');
  assert.equal(route('/d/sample-01/missing.css').uri, '/deployments/sample-01/missing.css');
});

test('rejects internal keys, invalid IDs, and path traversal rather than exposing other prefixes', () => {
  for (const uri of ['/dashboard/../index.html', '/dashboard/private.json', '/deployments/sample/index.html', '/d/-bad/', '/d/UPPER/',
    '/d/' + 'a'.repeat(64) + '/', '/d/sample/../other/index.html',
    '/d/sample/%2e%2e/other', '/d/sample/a%2fb', '/d/sample/a%5cb', '/d/sample/a\\b']) {
    assert.equal(route(uri).statusCode, 404, uri);
  }
});

test('dashboard routes expose only the public UI files and canonicalize the root', () => {
  assert.equal(route('/').headers.location.value, '/dashboard/');
  assert.equal(route('/dashboard').headers.location.value, '/dashboard/');
  assert.equal(route('/dashboard/').uri, '/dashboard/index.html');
  assert.equal(route('/dashboard/app.js').uri, '/dashboard/app.js');
});

test('API previews map to the owning project and legacy previews remain compatible', () => {
  const project = 'p1111111111111111';
  const id = `${project}-${'a'.repeat(32)}`;
  assert.equal(route(`/d/${id}/`).uri, `/deployments/${project}/${id}/index.html`);
  assert.equal(route(`/d/${id}/assets/app.js`).uri, `/deployments/${project}/${id}/assets/app.js`);
  assert.equal(route('/d/milestone-1/').uri, '/deployments/milestone-1/index.html');
});

test('SPA namespace rewrites extensionless deep links only and never uses a static deployment root', () => {
  const project = 'p1111111111111111';
  const id = `${project}-${'a'.repeat(32)}`;
  const base = `/d/${id}/_spa`;
  const storage = `/deployments/${project}/_spa/${id}`;
  assert.equal(route(base).headers.location.value, base + '/');
  for (const path of ['/', '/settings', '/settings/profile/', '/nested/missing-route']) {
    assert.equal(route(base + path).uri, storage + '/index.html');
  }
  for (const path of ['/index.html', '/assets/app.js', '/missing.css', '/missing.js/', '/user.name/settings', '/missing.json']) {
    assert.equal(route(base + path).uri, storage + path);
  }
  assert.equal(route(`/d/${id}/settings/`).uri, `/deployments/${project}/${id}/settings/index.html`);
  assert.notEqual(route(base + '/').uri, route(`/d/${id}/`).uri);
  for (const path of ['/../other', '/%2e%2e/other', '/assets%2fapp.js', '/a\\b']) assert.equal(route(base + path).statusCode, 404);
  const request = { uri: base + '/settings', querystring: { tab: { value: 'profile' } }, method: 'GET' };
  const result = context.handler({ request });
  assert.equal(result.uri, storage + '/index.html');
  assert.equal(result.querystring.tab.value, 'profile');
});
