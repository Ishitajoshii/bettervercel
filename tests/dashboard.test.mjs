import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';

const html = await readFile(new URL('../dashboard/index.html', import.meta.url), 'utf8');
const script = await readFile(new URL('../dashboard/app.js', import.meta.url), 'utf8');
const projectId = 'p1111111111111111';
const token = `bv_${'x'.repeat(43)}`;
const deploymentId = `${projectId}-${'a'.repeat(32)}`;
const record = { projectId, deploymentId, status: 'ready', createdAt: '2026-10-24T01:00:00Z',
  totalBytes: 1024, fileCount: 1, branch: '<img src=x onerror=alert(1)>', pullRequest: 7,
  logs: ['<script>alert(1)</script>'], previewUrl: `https://test.cloudfront.net/d/${deploymentId}/` };
async function fixture() {
  const { document, window } = parseHTML(html);
  const requests = [];
  let deletes = 0;
  const context = vm.createContext({ document, URL, AbortSignal,
    setTimeout: callback => { callback(); },
    fetch: async (url, options = {}) => {
      requests.push({ url, ...options });
      const body = url === './config.json' ? { apiUrl: 'https://api.example.com' } :
        options.method === 'DELETE' ? { ...record, status: ++deletes === 1 ? 'deleting' : 'deleted', previewUrl: null } :
        url.includes('/deployments') ? { deployments: [record], nextCursor: null } :
        { projectId, name: '<b>Project</b>' };
      return { ok: true, json: async () => body };
    },
  });
  vm.runInContext(script, context);
  const $ = id => document.getElementById(id);
  await new Promise(resolve => setImmediate(resolve));
  $('project').value = projectId; $('token').value = token;
  await $('connect-form').onsubmit({ preventDefault() {}, submitter: $('connect-form').querySelector('button') });
  return { $, document, window, requests };
}
test('dashboard authenticates, renders metadata and logs as text, and clears the entered token', async () => {
  const f = await fixture();
  assert.equal(f.$('project-name').textContent, '<b>Project</b>');
  assert.equal(f.$('project-name').querySelector('b'), null);
  assert.match(f.$('list').textContent, /PR #7/);
  assert.equal(f.$('list').querySelector('img'), null);
  assert.equal(f.$('list').querySelector('script'), null);
  assert.equal(f.$('token').value, '');
  assert.equal(f.$('list').querySelector('a').rel, 'noopener noreferrer');
  assert.ok(f.requests.filter(request => request.url !== './config.json').every(request => request.headers.authorization === `Bearer ${token}`));
  f.$('disconnect').onclick();
  assert.equal(f.$('project-count').textContent, '0');
  assert.ok(!f.document.toString().includes(token));
});
test('dashboard deletion requires confirmation and polls until cache removal completes', async () => {
  const f = await fixture();
  const dialog = f.$('delete-dialog'); dialog.showModal = () => {};
  f.$('list').querySelector('button').onclick();
  assert.equal(f.requests.filter(request => request.method === 'DELETE').length, 0);
  dialog.returnValue = 'delete'; dialog.dispatchEvent(new f.window.Event('close'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.requests.filter(request => request.method === 'DELETE').length, 2);
  assert.match(f.$('notice').textContent, /Deployment deleted/);
  assert.equal(f.$('list').querySelector('a'), null);
});
