import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runCli } from '../cli/main.mjs';
import { getToken } from '../cli/credentials.mjs';
import { loadProject } from '../cli/project.mjs';
import { createClient } from '../cli/client.mjs';

const root = resolve(process.argv[2] ?? '');
assert.ok(root.startsWith(resolve('.build') + (process.platform === 'win32' ? '\\' : '/')), 'Pass a CLI smoke directory inside .build');
const results = JSON.parse(await readFile(resolve(root, 'results.json'), 'utf8'));
const vite = results.find(result => result.name === 'vite');
const next = results.find(result => result.name === 'next');
assert.ok(vite && next, 'Complete verify:cli first.');
const env = { ...process.env, BETTERVERCEL_CREDENTIALS_FILE: resolve(root, 'credentials.json') };
const config = await loadProject(vite.directory);
const token = await getToken(config, env);
const client = createClient({ api: config.apiUrl, token });
const origin = new URL(vite.previewUrl).origin;
for (const path of ['/dashboard/', '/dashboard/app.js', '/dashboard/style.css', '/dashboard/config.json']) {
  const response = await fetch(origin + path);
  assert.equal(response.status, 200, path);
  assert.equal(response.headers.get('cache-control'), 'no-store', path);
  assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  if (path === '/dashboard/config.json') assert.equal((await response.json()).apiUrl, config.apiUrl);
  else assert.ok((await response.arrayBuffer()).byteLength > 100);
}
const preflight = await fetch(config.apiUrl + `/v1/projects/${config.projectId}`, { method: 'OPTIONS',
  headers: { origin, 'access-control-request-method': 'GET', 'access-control-request-headers': 'authorization' } });
assert.equal(preflight.headers.get('access-control-allow-origin'), origin);
const forbidden = await fetch(config.apiUrl + `/v1/projects/${config.projectId}`, { method: 'OPTIONS',
  headers: { origin: 'https://untrusted.example', 'access-control-request-method': 'GET', 'access-control-request-headers': 'authorization' } });
assert.notEqual(forbidden.headers.get('access-control-allow-origin'), 'https://untrusted.example');
const project = await client.api('GET', `/v1/projects/${config.projectId}`);
assert.equal(project.projectId, config.projectId); assert.equal(project.tokenHash, undefined);
const denied = await fetch(config.apiUrl + `/v1/deployments/${next.deploymentId}`, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } });
assert.equal(denied.status, 401); await denied.arrayBuffer();
const metadata = await runCli(['deploy', '--skip-build', '--branch', 'milestone-4/live', '--pull-request', '4', '--commit', 'abcdef0'], { cwd: vite.directory, env });
assert.equal(metadata.branch, 'milestone-4/live'); assert.equal(metadata.pullRequest, 4);
const page = await client.api('GET', `/v1/projects/${config.projectId}/deployments`);
assert.ok(page.deployments.some(record => record.deploymentId === metadata.deploymentId && record.branch === metadata.branch));
const freshDelete = await fetch(config.apiUrl + `/v1/deployments/${metadata.deploymentId}`, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } });
assert.equal(freshDelete.status, 409); await freshDelete.arrayBuffer();
console.log('Dashboard assets/headers, CORS, project details, live CI metadata, cross-project deletion denial and upload-window guard passed.');
// Delete only the original disposable Vite deployment created by verify:cli, preserving the new metadata preview and Next sample.
const delay = ms => new Promise(resolveDelay => setTimeout(resolveDelay, ms));
const eligible = (vite.uploadExpiresAt + 60) * 1000;
if (Date.now() < eligible) console.log(`Waiting ${Math.ceil((eligible - Date.now()) / 1000)} seconds for the original smoke upload URLs to expire.`);
while (Date.now() < eligible) await delay(Math.min(10000, eligible - Date.now()));
let deleted;
for (let attempt = 0; attempt < 90; attempt++) {
  deleted = await client.api('DELETE', `/v1/deployments/${vite.deploymentId}`);
  if (deleted.status === 'deleted') break;
  assert.equal(deleted.status, 'deleting');
  await delay(10000);
}
assert.equal(deleted.status, 'deleted', 'Cache invalidation did not complete within 15 minutes; rerun DELETE.');
assert.equal((await client.api('DELETE', `/v1/deployments/${vite.deploymentId}`)).status, 'deleted');
const removed = await fetch(vite.previewUrl);
assert.ok([403, 404].includes(removed.status), `Deleted preview still accessible: ${removed.status}`); await removed.arrayBuffer();
const nextPreview = await fetch(next.previewUrl); assert.equal(nextPreview.status, 200); await nextPreview.arrayBuffer();
await writeFile(resolve(root, 'milestone-4-results.json'), JSON.stringify({ verifiedAt: new Date().toISOString(), dashboardUrl: origin + '/dashboard/',
  metadataDeployment: metadata, deletedDeployment: deleted, untouchedNextPreview: next.previewUrl }, null, 2));
console.log(`Live deletion verified: ${vite.deploymentId}; preview returns ${removed.status}. Next project remains accessible.`);
