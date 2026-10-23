import { deploymentProject, HttpError, issueToken, normalizeRequest, prefix, projectId,
  requireValue, summary, UPLOAD_SECONDS, validProject, verifyToken } from './domain.mjs';

export function createHandler({ store, objects, delivery, domain, github, now = () => Date.now() }) {
  async function authenticate(id, event) {
    requireValue(validProject(id), 'Invalid project ID.');
    const project = await store.getProject(id);
    const token = (event.headers?.authorization ?? '').replace(/^Bearer /, '');
    if (token.startsWith('gs_') && github) return github.authenticate(project, event);
    requireValue(await verifyToken(token, project), 'Invalid project credentials.', 401);
    return project;
  }
  async function uploads(record) {
    if (record.status !== 'uploading') return [];
    const expiresIn = Math.min(300, record.uploadExpiresAt - Math.floor(now() / 1000));
    requireValue(expiresIn > 0, 'Upload window expired; create a deployment with a new idempotency key.', 409);
    return Promise.all(record.files.map(file => objects.sign(prefix(record) + file.path, file, expiresIn)));
  }
  async function execute(event) {
    const route = event.routeKey;
    const headers = Object.fromEntries(Object.entries(event.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    event = { ...event, headers };
    const raw = event.isBase64Encoded ? Buffer.from(event.body ?? '', 'base64').toString('utf8') : event.body ?? '';
    requireValue(Buffer.byteLength(raw) <= 220_000, 'Request body too large.', 413);
    let body = {};
    if (raw) {
      try { body = JSON.parse(raw); } catch { throw new HttpError(400, 'Invalid JSON body.'); }
      requireValue(body && typeof body === 'object' && !Array.isArray(body), 'Expected JSON object.');
    }
    if (event.rawPath?.startsWith('/v1/github/')) {
      requireValue(github, 'GitHub sign-in is not configured yet. See docs/github-import.md.', 503);
      return github.execute(event, body);
    }
    if (route === 'POST /v1/projects') {
      requireValue(event.requestContext?.authorizer?.iam?.userArn, 'Operator AWS IAM authentication required.', 403);
      requireValue(typeof body.name === 'string' && /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,79}$/.test(body.name), 'Invalid project name.');
      const { token, ...credentials } = await issueToken();
      const project = { projectId: projectId(), name: body.name, createdAt: new Date(now()).toISOString(), ...credentials };
      await store.createProject(project);
      return [201, { projectId: project.projectId, name: project.name, deployToken: token }];
    }
    if (route === 'POST /v1/deployments') {
      await authenticate(body.projectId, event);
      const request = normalizeRequest(body, headers['idempotency-key']);
      const record = { ...request, status: 'uploading', createdAt: new Date(now()).toISOString(),
        uploadExpiresAt: Math.floor(now() / 1000) + UPLOAD_SECONDS, logs: ['Manifest accepted; waiting for uploads.'] };
      const created = await store.createDeployment(record);
      const saved = created ? record : await store.getDeployment(record.projectId, record.deploymentId);
      requireValue(saved && saved.requestHash === record.requestHash, 'Idempotency key already used for a different request.', 409);
      return [created ? 201 : 200, { ...summary(saved, domain), uploads: await uploads(saved) }];
    }
    if (route === 'GET /v1/projects/{projectId}') {
      const project = await authenticate(event.pathParameters?.projectId, event);
      return [200, { projectId: project.projectId, name: project.name, createdAt: project.createdAt }];
    }
    if (route === 'DELETE /v1/deployments/{deploymentId}') {
      const id = event.pathParameters?.deploymentId;
      const owner = deploymentProject(id);
      await authenticate(owner, event);
      let record = await store.getDeployment(owner, id);
      requireValue(record, 'Deployment not found.', 404);
      if (record.status === 'deleted') return [200, summary(record, domain)];
      // Signed PUTs cannot be revoked individually. Never remove objects while a URL can recreate them.
      requireValue(record.uploadExpiresAt + 60 <= Math.floor(now() / 1000),
        'Deletion is available 16 minutes after creation, once all upload URLs have expired. Retry then.', 409);
      if (record.status !== 'deleting') {
        await store.transition(record, 'deleting', { logs: ['Deletion requested; removing artifacts and cached previews.'] });
        record = await store.getDeployment(owner, id);
      }
      if (record.status === 'deleted') return [200, summary(record, domain)];
      requireValue(record.status === 'deleting', 'Deployment changed; retry deletion.', 409);
      // Repeating cleanup and the deterministic invalidation is safe after any partial failure.
      await objects.remove(record);
      const complete = await delivery.remove(record);
      if (complete) await store.transition(record, 'deleted', {
        deletedAt: new Date(now()).toISOString(), logs: ['Artifacts removed; CloudFront invalidation completed.'],
      });
      record = await store.getDeployment(owner, id);
      return [record.status === 'deleted' ? 200 : 202, summary(record, domain)];
    }
    if (route === 'GET /v1/projects/{projectId}/deployments') {
      const id = event.pathParameters?.projectId;
      await authenticate(id, event);
      const cursor = event.queryStringParameters?.cursor;
      requireValue(!cursor || (cursor.length <= 100 && deploymentProject(cursor) === id), 'Invalid list cursor.');
      const page = await store.listDeployments(id, cursor);
      return [200, { deployments: page.records.map(record => summary(record, domain)), nextCursor: page.nextCursor ?? null }];
    }
    if (route === 'GET /v1/deployments/{deploymentId}' || route === 'POST /v1/deployments/{deploymentId}/finalize') {
      const id = event.pathParameters?.deploymentId;
      const owner = deploymentProject(id);
      await authenticate(owner, event);
      let record = await store.getDeployment(owner, id);
      requireValue(record, 'Deployment not found.', 404);
      if (route.startsWith('GET') || record.status === 'ready') return [200, summary(record, domain)];
      requireValue(record.status === 'uploading', 'Deployment cannot be finalized.', 409);
      if (record.uploadExpiresAt <= Math.floor(now() / 1000)) {
        await store.transition(record, 'failed', { logs: ['Upload window expired.'] });
        throw new HttpError(409, 'Upload window expired; create a new deployment.');
      }
      // Signed conditional writes make every uploaded object immutable, including during validation.
      const validation = await objects.validate(record);
      requireValue(validation.complete, 'Uploads are incomplete; upload missing files and retry.', 409);
      if (!validation.valid) {
        await store.transition(record, 'failed', { logs: ['Uploaded objects do not match the manifest.'] });
        throw new HttpError(422, 'Uploaded objects do not match the manifest.');
      }
      // Validation may finish after the deadline; never publish an expired upload.
      if (record.uploadExpiresAt <= Math.floor(now() / 1000)) {
        await store.transition(record, 'failed', { logs: ['Upload window expired during validation.'] });
        throw new HttpError(409, 'Upload window expired; create a new deployment.');
      }
      await store.transition(record, 'ready', { readyAt: new Date(now()).toISOString(), logs: ['All manifest objects verified; deployment ready.'] });
      record = await store.getDeployment(owner, id);
      requireValue(record?.status === 'ready', 'Deployment changed during finalization; retry status.', 409);
      return [200, summary(record, domain)];
    }
    throw new HttpError(404, 'Route not found.');
  }
  return async event => {
    try {
      const [statusCode, body] = await execute(event);
      return { statusCode, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }, body: JSON.stringify(body) };
    } catch (error) {
      if (!(error instanceof HttpError)) console.error('Control API failure', { name: error.name, requestId: event.requestContext?.requestId });
      return { statusCode: error.status ?? 500, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
        body: JSON.stringify({ error: error instanceof HttpError ? error.message : 'Internal server error.' }) };
    }
  };
}
