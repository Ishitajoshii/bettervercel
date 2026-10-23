import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createProject } from './operator-request.mjs';
import { sampleFiles, contentType, assert, http, run } from './lib.mjs';
import { digest, MAX_BYTES } from '../api/domain.mjs';

run(async () => {
  const startedAt = new Date().toISOString();
  const { BetterVercelControlStack: control } = JSON.parse(await readFile('control-outputs.json', 'utf8'));
  const { BetterVercelStaticStack: hosting } = JSON.parse(await readFile('cdk-outputs.json', 'utf8'));
  const api = control.ApiUrl;
  const files = await sampleFiles();
  assert(files.length >= 2, 'Build the multi-file Vite sample to test interrupted uploads.');
  const first = await createProject(api, hosting.Region, `smoke-${Date.now()}`);
  const second = await createProject(api, hosting.Region, `isolation-${Date.now()}`);
  const manifest = { projectId: first.projectId, framework: 'vite', files: files.map(file => ({
    path: file.key, size: file.body.length, contentType: contentType(file.key), sha256: digest(file.body),
  })) };
  const key = randomUUID();
  assert(first.deployToken !== second.deployToken, 'Projects must have distinct tokens.');
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
  const aggregate = structuredClone(manifest); aggregate.files[0].size = MAX_BYTES;
  assert((await request('POST', '/v1/deployments', { body: aggregate })).status === 400, 'Oversized aggregate accepted.');
  for (const empty of [[], [{ path: 'index.html', size: 0, contentType: contentType('index.html'), sha256: digest('') }]]) {
    assert((await request('POST', '/v1/deployments', { body: { ...manifest, files: empty } })).status === 400, 'Empty artifact accepted.');
  }
  const traversal = structuredClone(manifest); traversal.files[0].path = '../index.html';
  assert((await request('POST', '/v1/deployments', { body: traversal })).status === 400, 'Traversal manifest accepted.');
  const created = await request('POST', '/v1/deployments', { body: manifest });
  assert(created.status === 201, `Deployment create failed: ${JSON.stringify(created.body)}`);
  const id = created.body.deploymentId;
  const path = `/v1/deployments/${id}`;
  const secondBody = Buffer.from('<!doctype html><title>Independent project</title><h1>Project isolation</h1>');
  const secondManifest = { projectId: second.projectId, framework: 'static', files: [
    { path: 'index.html', size: secondBody.length, contentType: contentType('index.html'), sha256: digest(secondBody) },
  ] };
  const secondCreated = await request('POST', '/v1/deployments', { body: secondManifest, token: second.deployToken });
  assert(secondCreated.status === 201 && secondCreated.body.deploymentId !== id, 'Independent project create failed.');
  const retry = await request('POST', '/v1/deployments', { body: manifest });
  assert(retry.status === 200 && retry.body.deploymentId === id, 'Create is not idempotent.');
  const changed = structuredClone(manifest); changed.files[0].size++;
  assert((await request('POST', '/v1/deployments', { body: changed })).status === 409, 'Changed idempotent request accepted.');
  assert((await request('POST', path + '/finalize')).status === 409, 'Incomplete deployment became ready.');
  for (const [owner, attacker, record, input] of [
    [first, second, created.body, manifest], [second, first, secondCreated.body, secondManifest],
  ]) {
    assert((await request('POST', '/v1/deployments', { body: input, token: attacker.deployToken })).status === 401, 'Cross-project create accepted.');
    const target = `/v1/deployments/${record.deploymentId}`;
    for (const [method, route] of [['GET', target], ['POST', target + '/finalize'], ['DELETE', target],
      ['GET', `/v1/projects/${owner.projectId}`], ['GET', `/v1/projects/${owner.projectId}/deployments`]]) {
      assert((await request(method, route, { token: attacker.deployToken })).status === 401, 'Cross-project access accepted.');
    }
    const signed = record.uploads[0];
    const tampered = new URL(signed.url);
    tampered.pathname = tampered.pathname.replace(owner.projectId, attacker.projectId);
    const body = owner === first ? files.find(file => file.key === signed.path).body : secondBody;
    const escape = await http(tampered, { method: 'PUT', headers: signed.headers, body });
    assert(escape.status === 403, `Changed upload prefix was not rejected: ${escape.status}`);
    await escape.arrayBuffer();
  }
  console.log('PASS: IAM project creation, bidirectional token/prefix isolation, empty/large artifacts, idempotency, incomplete finalization.');
  const invalidUpload = created.body.uploads[0];
  const original = files.find(file => file.key === invalidUpload.path).body;
  const corrupted = Buffer.from(original); corrupted[0] ^= 1;
  const badChecksum = await http(invalidUpload.url, { method: 'PUT', headers: invalidUpload.headers, body: corrupted });
  assert(badChecksum.status === 400, `Checksum mismatch was not rejected: ${badChecksum.status}`);
  await badChecksum.arrayBuffer();
  for (const [index, upload] of created.body.uploads.entries()) {
    const file = files.find(file => file.key === upload.path);
    const response = await http(upload.url, { method: 'PUT', headers: upload.headers, body: file.body });
    assert(response.status === 200, `Upload failed (${response.status}): ${await response.text()}`);
    if (index === 0) {
      assert((await request('POST', path + '/finalize')).status === 409, 'Partial upload became ready.');
      const resumed = await request('POST', '/v1/deployments', { body: manifest });
      assert(resumed.status === 200 && resumed.body.deploymentId === id && resumed.body.status === 'uploading', 'Interrupted upload did not resume.');
      assert(resumed.body.uploadExpiresAt === created.body.uploadExpiresAt, 'Resume extended the upload deadline.');
      // Continue with refreshed URLs for all remaining files.
      created.body.uploads.splice(1, created.body.uploads.length - 1, ...resumed.body.uploads.filter(item => item.path !== upload.path));
    }
  }
  const upload = created.body.uploads[0];
  const body = files.find(file => file.key === upload.path).body;
  const duplicate = await http(upload.url, { method: 'PUT', headers: upload.headers, body });
  assert(duplicate.status === 412, `Overwrite was not rejected: ${duplicate.status}`);
  await duplicate.arrayBuffer();
  const ready = await Promise.all(Array.from({ length: 3 }, () => request('POST', path + '/finalize')));
  assert(ready.every(result => result.status === 200 && result.body.status === 'ready'), `Concurrent finalization failed: ${JSON.stringify(ready)}`);
  const duplicateFinalize = await request('POST', path + '/finalize');
  assert(duplicateFinalize.status === 200 && duplicateFinalize.body.readyAt === ready[0].body.readyAt, 'Duplicate finalize changed ready state.');
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
  const secondUpload = secondCreated.body.uploads[0];
  const secondPut = await http(secondUpload.url, { method: 'PUT', headers: secondUpload.headers, body: secondBody });
  assert(secondPut.status === 200, `Second project upload failed (${secondPut.status}).`);
  await secondPut.arrayBuffer();
  const secondReady = await request('POST', `/v1/deployments/${secondCreated.body.deploymentId}/finalize`, { token: second.deployToken });
  assert(secondReady.status === 200 && secondReady.body.status === 'ready', 'Second project finalize failed.');
  const secondPreview = await http(secondReady.body.previewUrl);
  assert(secondPreview.status === 200 && Buffer.from(await secondPreview.arrayBuffer()).equals(secondBody), 'Second project preview differs.');
  for (const [owner, expectedId] of [[first, id], [second, secondCreated.body.deploymentId]]) {
    const own = await request('GET', `/v1/projects/${owner.projectId}/deployments`, { token: owner.deployToken });
    assert(own.status === 200 && own.body.deployments.length === 1 && own.body.deployments[0].deploymentId === expectedId, 'Project listing is not isolated.');
  }
  console.log('PASS: signed uploads, checksum enforcement, overwrite prevention, interrupted-upload resume, concurrent/duplicate finalization, isolated lists and two preview bodies.');
  const reportPath = `.build/release-gate-api-${Date.now()}.json`;
  await mkdir('.build', { recursive: true });
  await writeFile(reportPath, JSON.stringify({ startedAt, completedAt: new Date().toISOString(), api,
    projects: [first.projectId, second.projectId], deployments: [id, secondCreated.body.deploymentId],
    previews: [preview, secondReady.body.previewUrl],
    passed: ['bidirectional-token-isolation', 'bidirectional-signed-prefix-isolation', 'empty-artifact', 'file-and-aggregate-size-limits',
      'interrupted-upload-resume', 'checksum-enforcement', 'immutable-uploads', 'concurrent-and-duplicate-finalize', 'isolated-project-lists', 'preview-bytes'],
    pending: ['spa-fallback', 'live-iam-review', 'cost-and-email-verification', 'own-sites-acceptance'],
  }, null, 2) + '\n');
  console.log(`Release-gate evidence (no credentials): ${reportPath}`);
  console.log(`Preview: ${preview}`);
  console.log(`Test projects: ${first.projectId}, ${second.projectId}. Artifacts expire after seven days; metadata is retained.`);
  // Tokens and signed URLs intentionally remain in memory and never appear in logs or files.
});
