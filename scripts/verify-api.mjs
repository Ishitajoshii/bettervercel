import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createProject } from './operator-request.mjs';
import { sampleFiles, contentType, assert, http, run } from './lib.mjs';
import { digest, MAX_BYTES } from '../api/domain.mjs';

run(async () => {
  const { BetterVercelControlStack: control } = JSON.parse(await readFile('control-outputs.json', 'utf8'));
  const { BetterVercelStaticStack: hosting } = JSON.parse(await readFile('cdk-outputs.json', 'utf8'));
  const api = control.ApiUrl;
  const files = await sampleFiles();
  const first = await createProject(api, hosting.Region, `smoke-${Date.now()}`);
  const second = await createProject(api, hosting.Region, `isolation-${Date.now()}`);
  const manifest = { projectId: first.projectId, framework: 'vite', files: files.map(file => ({
    path: file.key, size: file.body.length, contentType: contentType(file.key), sha256: digest(file.body),
  })) };
  const key = randomUUID();
  async function request(method, path, { body, token = first.deployToken, idempotencyKey = key } = {}) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const response = await http(api + path, { method, headers: { authorization: `Bearer ${token}`,
        'content-type': 'application/json', 'idempotency-key': idempotencyKey }, body: body && JSON.stringify(body) });
      if (response.status === 429 && attempt < 4) {
        await response.arrayBuffer();
        await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
        continue;
      }
      const data = await response.json();
      return { status: response.status, body: data };
    }
  }
  const anonymous = await http(api + '/v1/projects', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"name":"forbidden"}' });
  assert(anonymous.status === 403, 'Anonymous project creation must be forbidden.');
  await anonymous.arrayBuffer();
  assert((await request('POST', '/v1/deployments', { body: manifest, token: second.deployToken })).status === 401, 'Cross-project create accepted.');
  const oversized = structuredClone(manifest); oversized.files[0].size = MAX_BYTES + 1;
  assert((await request('POST', '/v1/deployments', { body: oversized })).status === 400, 'Oversized manifest accepted.');
  const traversal = structuredClone(manifest); traversal.files[0].path = '../index.html';
  assert((await request('POST', '/v1/deployments', { body: traversal })).status === 400, 'Traversal manifest accepted.');
  const created = await request('POST', '/v1/deployments', { body: manifest });
  assert(created.status === 201, `Deployment create failed: ${JSON.stringify(created.body)}`);
  const id = created.body.deploymentId;
  const path = `/v1/deployments/${id}`;
  const retry = await request('POST', '/v1/deployments', { body: manifest });
  assert(retry.status === 200 && retry.body.deploymentId === id, 'Create is not idempotent.');
  const changed = structuredClone(manifest); changed.files[0].size++;
  assert((await request('POST', '/v1/deployments', { body: changed })).status === 409, 'Changed idempotent request accepted.');
  assert((await request('POST', path + '/finalize')).status === 409, 'Incomplete deployment became ready.');
  for (const [method, route] of [['GET', path], ['POST', path + '/finalize'], ['GET', `/v1/projects/${first.projectId}/deployments`]]) {
    assert((await request(method, route, { token: second.deployToken })).status === 401, 'Cross-project access accepted.');
  }
  console.log('PASS: IAM project creation, token isolation, manifest limits, idempotency, incomplete finalization.');
  const invalidUpload = created.body.uploads[0];
  const original = files.find(file => file.key === invalidUpload.path).body;
  const corrupted = Buffer.from(original); corrupted[0] ^= 1;
  const badChecksum = await http(invalidUpload.url, { method: 'PUT', headers: invalidUpload.headers, body: corrupted });
  assert(badChecksum.status === 400, `Checksum mismatch was not rejected: ${badChecksum.status}`);
  await badChecksum.arrayBuffer();
  for (const upload of created.body.uploads) {
    const file = files.find(file => file.key === upload.path);
    const response = await http(upload.url, { method: 'PUT', headers: upload.headers, body: file.body });
    assert(response.status === 200, `Upload failed (${response.status}): ${await response.text()}`);
  }
  const upload = created.body.uploads[0];
  const body = files.find(file => file.key === upload.path).body;
  const duplicate = await http(upload.url, { method: 'PUT', headers: upload.headers, body });
  assert(duplicate.status === 412, `Overwrite was not rejected: ${duplicate.status}`);
  await duplicate.arrayBuffer();
  const tampered = new URL(upload.url); tampered.pathname = tampered.pathname.replace(first.projectId, second.projectId);
  const escape = await http(tampered, { method: 'PUT', headers: upload.headers, body });
  assert(escape.status === 403, `Changed upload prefix was not rejected: ${escape.status}`);
  await escape.arrayBuffer();
  const ready = await Promise.all(Array.from({ length: 3 }, () => request('POST', path + '/finalize')));
  assert(ready.every(result => result.status === 200 && result.body.status === 'ready'), `Concurrent finalization failed: ${JSON.stringify(ready)}`);
  const status = await request('GET', path);
  const list = await request('GET', `/v1/projects/${first.projectId}/deployments`);
  assert(status.body.status === 'ready' && list.body.deployments.some(d => d.deploymentId === id), 'Read/list lost deployment.');
  const finalRetry = await request('POST', '/v1/deployments', { body: manifest });
  assert(finalRetry.body.uploads.length === 0, 'Ready deployment issued new upload URLs.');
  const preview = ready[0].body.previewUrl;
  for (const file of files) {
    const response = await http(file.key === 'index.html' ? preview : preview + file.key);
    assert(response.status === 200, `Preview ${file.key} returned ${response.status}.`);
    assert(Buffer.from(await response.arrayBuffer()).equals(file.body), `Preview bytes differ: ${file.key}`);
  }
  console.log('PASS: signed uploads, checksum enforcement, overwrite prevention, signed-prefix isolation, concurrent finalization, get/list and preview bytes.');
  console.log(`Preview: ${preview}`);
  console.log(`Test projects: ${first.projectId}, ${second.projectId}. Artifacts expire after seven days; metadata is retained.`);
  // Tokens and signed URLs intentionally remain in memory and never appear in logs or files.
});
