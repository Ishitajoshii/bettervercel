import test from 'node:test';
import assert from 'node:assert/strict';
import { createHandler } from '../api/handler.mjs';
import { digest, issueToken, MAX_BYTES, normalizeRequest, prefix } from '../api/domain.mjs';

const a = 'p1111111111111111';
const b = 'p2222222222222222';
const manifest = (projectId = a) => ({ projectId, framework: 'vite', commitSha: 'abcdef0', files: [
  { path: 'index.html', size: 5, contentType: 'text/html; charset=utf-8', sha256: digest('hello') },
] });
async function fixture() {
  const credentials = await issueToken();
  const otherCredentials = await issueToken();
  const projects = new Map([
    [a, { projectId: a, ...credentials }],
    [b, { projectId: b, ...otherCredentials }],
  ]);
  const records = new Map();
  let time = Date.parse('2026-10-23T18:00:00Z');
  let validation = { complete: true, valid: true };
  let onValidate = () => {};
  let transitions = 0;
  const store = {
    async getProject(id) { return projects.get(id); },
    async createProject(value) { projects.set(value.projectId, value); },
    async createDeployment(value) {
      if (records.has(value.deploymentId)) return false;
      records.set(value.deploymentId, structuredClone(value)); return true;
    },
    async getDeployment(owner, id) { const r = records.get(id); return r?.projectId === owner ? structuredClone(r) : undefined; },
    async transition(record, status, fields) {
      const r = records.get(record.deploymentId);
      if (r.status !== record.status) return false;
      Object.assign(r, { status }, fields); transitions++; return true;
    },
    async listDeployments(owner) { return { records: [...records.values()].filter(r => r.projectId === owner) }; },
  };
  const signs = [];
  let removalComplete = false;
  let removalFailure = false;
  const removed = [];
  const handler = createHandler({ store, domain: 'test.cloudfront.net', now: () => time, objects: {
    async sign(key, file, expiresIn) { signs.push({ key, file, expiresIn }); return { path: file.path, key, expiresIn }; },
    async validate() { await new Promise(resolve => setImmediate(resolve)); onValidate(); return validation; },
    async remove(record) { if (removalFailure) throw new Error('S3 unavailable'); removed.push(record.deploymentId); },
  }, delivery: { async remove() { return removalComplete; } } });
  async function request(routeKey, body, { token = credentials.token, params = {}, headers = {}, query, iam } = {}) {
    const response = await handler({ routeKey, body: body === undefined ? '' : JSON.stringify(body),
      headers: { authorization: `Bearer ${token}`, 'idempotency-key': 'deploy-key-001', ...headers },
      pathParameters: params, queryStringParameters: query,
      requestContext: { authorizer: iam ? { iam: { userArn: 'arn:aws:iam::123456789012:user/operator' } } : {} } });
    return { status: response.statusCode, body: JSON.parse(response.body) };
  }
  return { request, projects, records, signs, credentials, handler,
    removed, completeRemoval() { removalComplete = true; }, failRemoval(value) { removalFailure = value; },
    setValidation(value) { validation = value; }, onValidate(callback) { onValidate = callback; },
    advance(ms) { time += ms; }, transitions: () => transitions };
}

test('project creation is operator-only and returns a token once; storage contains only salted hash', async () => {
  const f = await fixture();
  assert.equal((await f.request('POST /v1/projects', { name: 'Demo' })).status, 403);
  const result = await f.request('POST /v1/projects', { name: 'Demo' }, { iam: true });
  assert.equal(result.status, 201);
  assert.match(result.body.deployToken, /^bv_/);
  const stored = f.projects.get(result.body.projectId);
  assert.equal(stored.token, undefined);
  assert.equal(stored.deployToken, undefined);
  assert.equal(stored.tokenHash.length, 64);
  assert.ok(!JSON.stringify(stored).includes(result.body.deployToken));
});

test('project details require the owning token and never expose credential material', async () => {
  const f = await fixture();
  const params = { projectId: a };
  assert.equal((await f.request('GET /v1/projects/{projectId}', undefined, { params, token: 'wrong' })).status, 401);
  const response = await f.request('GET /v1/projects/{projectId}', undefined, { params });
  assert.equal(response.body.projectId, a);
  assert.ok(!JSON.stringify(response).includes('tokenHash'));
  assert.ok(!JSON.stringify(response).includes(f.credentials.token));
});

test('branch and PR metadata round trip, validate, and participate in idempotency', async () => {
  const f = await fixture();
  const input = { ...manifest(), branch: 'feature/dashboard', pullRequest: 17 };
  const created = await f.request('POST /v1/deployments', input);
  assert.equal(created.body.branch, input.branch); assert.equal(created.body.pullRequest, 17);
  assert.equal((await f.request('POST /v1/deployments', { ...input, pullRequest: 18 })).status, 409);
  for (const change of [{ branch: 'x\ny' }, { branch: 'x'.repeat(256) }, { branch: [] }, { pullRequest: '17' }, { pullRequest: -1 }]) {
    assert.throws(() => normalizeRequest({ ...input, ...change }, 'metadata-test'));
  }
});

test('deletion waits for signed URLs to expire, isolates tokens, retries partial failure and waits for cache removal', async () => {
  const f = await fixture();
  f.projects.set(b, { projectId: b, ...await issueToken() });
  const created = await f.request('POST /v1/deployments', manifest(b), { token: f.projects.get(b).token });
  const params = { deploymentId: created.body.deploymentId };
  const route = 'DELETE /v1/deployments/{deploymentId}';
  assert.equal((await f.request(route, undefined, { params })).status, 401);
  const options = { params, token: f.projects.get(b).token };
  await f.request('POST /v1/deployments/{deploymentId}/finalize', undefined, options);
  assert.equal((await f.request(route, undefined, options)).status, 409);
  assert.equal(f.removed.length, 0);
  f.advance(961000); f.failRemoval(true);
  assert.equal((await f.request(route, undefined, options)).status, 500);
  assert.equal(f.records.get(params.deploymentId).status, 'deleting');
  assert.equal((await f.request('POST /v1/deployments/{deploymentId}/finalize', undefined, options)).status, 409);
  f.failRemoval(false);
  const pending = await f.request(route, undefined, options);
  assert.equal(pending.status, 202); assert.equal(pending.body.previewUrl, null);
  f.completeRemoval();
  const complete = await f.request(route, undefined, options);
  assert.equal(complete.body.status, 'deleted'); assert.ok(complete.body.deletedAt);
  const count = f.removed.length;
  assert.equal((await f.request(route, undefined, options)).status, 200);
  assert.equal(f.removed.length, count);
  const retry = await f.request('POST /v1/deployments', manifest(b), { token: f.projects.get(b).token });
  assert.equal(retry.body.status, 'deleted'); assert.deepEqual(retry.body.uploads, []);
});

test('invalid tokens cannot create, read, finalize, or list deployments', async () => {
  const f = await fixture();
  const created = await f.request('POST /v1/deployments', manifest());
  const params = { deploymentId: created.body.deploymentId, projectId: a };
  for (const [route, body] of [
    ['POST /v1/deployments', manifest()], ['GET /v1/deployments/{deploymentId}'],
    ['POST /v1/deployments/{deploymentId}/finalize'], ['GET /v1/projects/{projectId}/deployments'],
  ]) assert.equal((await f.request(route, body, { token: 'wrong', params })).status, 401);
});

test('tokens and every signed key are isolated to the owning project', async () => {
  const f = await fixture();
  const other = await issueToken();
  f.projects.set(b, { projectId: b, ...other });
  assert.equal((await f.request('POST /v1/deployments', manifest(b))).status, 401);
  const created = await f.request('POST /v1/deployments', manifest());
  const params = { deploymentId: created.body.deploymentId };
  assert.equal((await f.request('GET /v1/deployments/{deploymentId}', undefined, { params, token: other.token })).status, 401);
  assert.equal((await f.request('POST /v1/deployments/{deploymentId}/finalize', undefined, { params, token: other.token })).status, 401);
  assert.ok(f.signs.every(sign => sign.key.startsWith(`deployments/${a}/${created.body.deploymentId}/`)));
  assert.ok(f.signs.every(sign => sign.expiresIn <= 300));
});

test('idempotency survives concurrent creates and rejects changed manifests', async () => {
  const f = await fixture();
  const results = await Promise.all(Array.from({ length: 5 }, () => f.request('POST /v1/deployments', manifest())));
  assert.equal(results.filter(r => r.status === 201).length, 1);
  assert.ok(results.every(r => r.body.deploymentId === results[0].body.deploymentId));
  assert.equal(f.records.size, 1);
  const changed = manifest(); changed.files[0].size = 6;
  assert.equal((await f.request('POST /v1/deployments', changed)).status, 409);
  const otherProject = normalizeRequest(manifest(b), 'deploy-key-001');
  assert.notEqual(otherProject.deploymentId, results[0].body.deploymentId);
});

test('release gate: two independent project tokens cannot access or mutate each other in either direction', async () => {
  const f = await fixture();
  const created = new Map();
  for (const owner of [a, b]) {
    const result = await f.request('POST /v1/deployments', manifest(owner), { token: f.projects.get(owner).token });
    assert.equal(result.status, 201);
    created.set(owner, result.body);
  }
  assert.notEqual(f.projects.get(a).token, f.projects.get(b).token);
  assert.notEqual(created.get(a).deploymentId, created.get(b).deploymentId);
  // Make deletion eligible so the test proves authentication, not the upload-window guard.
  f.advance(961_000);
  const before = structuredClone([...f.records]);
  const signCount = f.signs.length;
  for (const [owner, attacker] of [[a, b], [b, a]]) {
    const params = { projectId: owner, deploymentId: created.get(owner).deploymentId };
    for (const [route, body] of [
      ['POST /v1/deployments', manifest(owner)],
      ['GET /v1/projects/{projectId}'], ['GET /v1/projects/{projectId}/deployments'],
      ['GET /v1/deployments/{deploymentId}'], ['POST /v1/deployments/{deploymentId}/finalize'],
      ['DELETE /v1/deployments/{deploymentId}'],
    ]) assert.equal((await f.request(route, body, { params, token: f.projects.get(attacker).token })).status, 401, `${attacker}: ${route}`);
    const list = await f.request('GET /v1/projects/{projectId}/deployments', undefined,
      { params: { projectId: owner }, token: f.projects.get(owner).token });
    assert.deepEqual(list.body.deployments.map(record => record.deploymentId), [created.get(owner).deploymentId]);
  }
  assert.deepEqual([...f.records], before);
  assert.equal(f.signs.length, signCount);
  assert.equal(f.transitions(), 0);
  assert.deepEqual(f.removed, []);
});

test('release gate: empty and oversized artifacts fail before records or upload URLs are created', async () => {
  const f = await fixture();
  const cases = [
    { ...manifest(), files: [] },
    { ...manifest(), files: [{ ...manifest().files[0], size: 0, sha256: digest('') }] },
    { ...manifest(), files: [{ ...manifest().files[0], size: MAX_BYTES + 1 }] },
    { ...manifest(), files: [...manifest().files, { ...manifest().files[0], path: 'large.html', size: MAX_BYTES }] },
  ];
  for (const input of cases) assert.equal((await f.request('POST /v1/deployments', input)).status, 400);
  assert.equal(f.records.size, 0);
  assert.equal(f.signs.length, 0);
});

test('release gate: interrupted uploads resume under the same ID and duplicate finalize preserves ready time', async () => {
  const f = await fixture();
  const created = await f.request('POST /v1/deployments', manifest());
  const params = { deploymentId: created.body.deploymentId };
  f.setValidation({ complete: false, valid: false });
  assert.equal((await f.request('POST /v1/deployments/{deploymentId}/finalize', undefined, { params })).status, 409);
  f.advance(120_000);
  const resumed = await f.request('POST /v1/deployments', manifest());
  assert.equal(resumed.status, 200);
  assert.equal(resumed.body.deploymentId, params.deploymentId);
  assert.equal(resumed.body.uploadExpiresAt, created.body.uploadExpiresAt);
  assert.equal(resumed.body.uploads.length, 1);
  f.setValidation({ complete: true, valid: true });
  const ready = await f.request('POST /v1/deployments/{deploymentId}/finalize', undefined, { params });
  f.advance(1_000_000);
  const duplicate = await f.request('POST /v1/deployments/{deploymentId}/finalize', undefined, { params });
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.body.readyAt, ready.body.readyAt);
  assert.equal(f.transitions(), 1);
});

test('manifest rejects traversal, URL escapes, duplicate files, MIME spoofing and size/count limits', () => {
  const bad = [
    input => { input.files[0].path = '../index.html'; },
    input => { input.files[0].path = '/index.html'; },
    input => { input.files[0].path = 'dir\\index.html'; },
    input => { input.files[0].path = '%2e%2e/index.html'; },
    input => { input.files[0].path = 'foo//index.html'; },
    input => { input.files.push({ ...input.files[0] }); },
    input => { input.files[0].contentType = 'application/javascript'; },
    input => { input.files[0].size = MAX_BYTES + 1; },
    input => { input.files[0].size = -1; },
    input => { input.files[0].sha256 = 'bad'; },
    input => { input.files = []; },
    input => { input.files = Array(501).fill(input.files[0]); },
    input => { input.files[0].path = 'readme.txt'; input.files[0].contentType = 'text/plain; charset=utf-8'; },
    input => { input.files[0].size = 0; },
    input => { input.files.push({ ...input.files[0], path: 'large.html', size: MAX_BYTES }); },
    input => { input.projectId = [a]; },
    input => { input.commitSha = ['abcdef0']; },
  ];
  for (const change of bad) {
    const input = manifest(); change(input);
    assert.throws(() => normalizeRequest(input, 'deploy-key-001'));
  }
  assert.throws(() => normalizeRequest(manifest(), 'short'));
  const record = normalizeRequest(manifest(), 'deploy-key-001');
  assert.equal(prefix(record), `deployments/${a}/${record.deploymentId}/`);
});

test('missing uploads remain retryable; malformed uploads become terminal failed', async () => {
  const f = await fixture();
  const created = await f.request('POST /v1/deployments', manifest());
  const params = { deploymentId: created.body.deploymentId };
  f.setValidation({ complete: false, valid: false });
  assert.equal((await f.request('POST /v1/deployments/{deploymentId}/finalize', undefined, { params })).status, 409);
  assert.equal(f.records.get(params.deploymentId).status, 'uploading');
  f.setValidation({ complete: true, valid: false });
  assert.equal((await f.request('POST /v1/deployments/{deploymentId}/finalize', undefined, { params })).status, 422);
  assert.equal(f.records.get(params.deploymentId).status, 'failed');
  f.setValidation({ complete: true, valid: true });
  assert.equal((await f.request('POST /v1/deployments/{deploymentId}/finalize', undefined, { params })).status, 409);
});

test('concurrent finalization performs one state transition and duplicate finalize is harmless', async () => {
  const f = await fixture();
  const created = await f.request('POST /v1/deployments', manifest());
  assert.equal(created.body.previewUrl, null);
  const params = { deploymentId: created.body.deploymentId };
  const results = await Promise.all(Array.from({ length: 10 }, () => f.request('POST /v1/deployments/{deploymentId}/finalize', undefined, { params })));
  assert.ok(results.every(r => r.status === 200 && r.body.status === 'ready'));
  assert.equal(f.transitions(), 1);
  assert.ok(results.every(r => r.body.previewUrl.endsWith(`/d/${params.deploymentId}/`)));
  const retry = await f.request('POST /v1/deployments', manifest());
  assert.equal(retry.status, 200); assert.deepEqual(retry.body.uploads, []);
  assert.equal((await f.request('POST /v1/deployments/{deploymentId}/finalize', undefined, { params })).status, 200);
});

test('expired uploads cannot refresh signed URLs or become ready', async () => {
  const f = await fixture();
  const created = await f.request('POST /v1/deployments', manifest());
  f.advance(901_000);
  assert.equal((await f.request('POST /v1/deployments', manifest())).status, 409);
  assert.equal((await f.request('POST /v1/deployments/{deploymentId}/finalize', undefined,
    { params: { deploymentId: created.body.deploymentId } })).status, 409);
  assert.equal(f.records.get(created.body.deploymentId).status, 'failed');
});

test('status and list responses omit credentials, manifest and internal storage keys', async () => {
  const f = await fixture();
  const created = await f.request('POST /v1/deployments', manifest());
  const status = await f.request('GET /v1/deployments/{deploymentId}', undefined, { params: { deploymentId: created.body.deploymentId } });
  const list = await f.request('GET /v1/projects/{projectId}/deployments', undefined, { params: { projectId: a } });
  assert.equal(status.status, 200); assert.equal(list.body.deployments.length, 1);
  for (const result of [status, list]) {
    assert.ok(!JSON.stringify(result).includes(f.credentials.token));
    assert.ok(!JSON.stringify(result).includes('tokenHash'));
    assert.ok(!JSON.stringify(result).includes('sha256'));
  }
  assert.equal((await f.request('GET /v1/projects/{projectId}/deployments', undefined,
    { params: { projectId: a }, query: { cursor: `${b}-${'a'.repeat(32)}` } })).status, 400);
});

test('invalid JSON, base64 JSON, body limits, and unknown routes return controlled responses', async () => {
  const f = await fixture();
  assert.equal((await f.handler({ body: '{' })).statusCode, 400);
  assert.equal((await f.handler({ body: 'a'.repeat(220_001) })).statusCode, 413);
  assert.equal((await f.handler({ body: Buffer.from('{}').toString('base64'), isBase64Encoded: true })).statusCode, 404);
});

test('validation that crosses the upload deadline cannot publish the deployment', async () => {
  const f = await fixture();
  const created = await f.request('POST /v1/deployments', manifest());
  f.advance(899_000);
  f.onValidate(() => f.advance(2_000));
  const pending = f.request('POST /v1/deployments/{deploymentId}/finalize', undefined,
    { params: { deploymentId: created.body.deploymentId } });
  assert.equal((await pending).status, 409);
  assert.equal(f.records.get(created.body.deploymentId).status, 'failed');
});

test('manifest accepts exactly the file and aggregate byte limits and rejects one byte beyond', () => {
  const input = manifest();
  input.files[0].size = MAX_BYTES - 499;
  for (let index = 1; index < 500; index++) input.files.push({ ...input.files[0], path: `asset-${index}.html`, size: 1 });
  const result = normalizeRequest(input, 'boundary-test');
  assert.equal(result.files.length, 500);
  assert.equal(result.totalBytes, MAX_BYTES);
  input.files[0].size++;
  assert.throws(() => normalizeRequest(input, 'boundary-test'), /25 MiB/);
});
