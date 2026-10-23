import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CACHE_CONTROL, digest, issueToken, MAX_BYTES, prefix } from '../api/domain.mjs';
import { createHandler } from '../api/handler.mjs';
import { collectArtifacts, detectFramework, initProject, loadProject, runBuild, validateConfig } from '../cli/project.mjs';
import { createClient, uploadArtifacts } from '../cli/client.mjs';
import { runCli } from '../cli/main.mjs';

const projectId = 'p1111111111111111';
const config = { apiUrl: 'https://example.execute-api.ap-south-1.amazonaws.com', projectId,
  framework: 'static', outputDirectory: 'dist', buildCommand: null };
async function temp(t) {
  const root = await mkdtemp(join(tmpdir(), 'bettervercel-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function outputFiles(root, files = { 'index.html': '<h1>Hello</h1>', 'assets/app.js': 'console.log("hello")' }) {
  for (const [path, contents] of Object.entries(files)) {
    const target = join(root, 'dist', path);
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, contents);
  }
}

test('init detects supported frameworks from metadata, never executes scripts, and preserves existing config', async t => {
  const root = await temp(t);
  for (const [deps, framework, outputDirectory] of [
    [{ vite: '1', react: '1' }, 'vite', 'dist'], [{ astro: '1' }, 'astro', 'dist'],
    [{ next: '1', react: '1' }, 'next-static', 'out'], [{ 'react-scripts': '1' }, 'static', 'build'],
    [{ react: '1' }, 'static', undefined],
  ]) {
    await writeFile(join(root, 'package.json'), JSON.stringify({ dependencies: deps, scripts: { build: 'never-run-this' } }));
    assert.deepEqual(await detectFramework(root), { framework, ...(outputDirectory ? { outputDirectory } : {}) });
  }
  await assert.rejects(initProject(root, { api: config.apiUrl, project: projectId }), /outputDirectory/);
  await initProject(root, { api: config.apiUrl, project: projectId, output: 'dist' });
  assert.equal((await loadProject(root)).buildCommand, null);
  await assert.rejects(initProject(root, { api: config.apiUrl, project: projectId, output: 'build' }), /already exists/);
  assert.equal((await loadProject(root)).outputDirectory, 'dist');
});

test('config rejects unencrypted remote APIs, credentials in URLs, and output outside the project', () => {
  for (const apiUrl of ['http://example.com', 'file:///tmp', 'https://user:pass@example.com', 'https://example.com?token=bad']) {
    assert.throws(() => validateConfig({ ...config, apiUrl }));
  }
  for (const outputDirectory of ['.', '../dist', '/tmp/dist', 'C:\\dist', 'dist/../../private']) {
    assert.throws(() => validateConfig({ ...config, outputDirectory }));
  }
  assert.throws(() => validateConfig({ ...config, buildCommand: undefined }), /buildCommand/);
});

test('manifest contains exact bytes, SHA-256, API MIME types, relative paths and cache policy', async t => {
  const root = await temp(t);
  await outputFiles(root);
  const files = await collectArtifacts(root, config);
  assert.deepEqual(files.map(f => f.path), ['assets/app.js', 'index.html']);
  for (const file of files) {
    assert.equal(file.size, file.body.length);
    assert.equal(file.sha256, digest(file.body));
    assert.equal(file.cacheControl, CACHE_CONTROL);
  }
  assert.equal(files[0].contentType, 'text/javascript; charset=utf-8');
});

test('artifact validation rejects missing index, unsupported names/extensions, empty/oversized output and symlink roots', async t => {
  for (const files of [
    { 'assets/app.js': 'hello' }, { 'index.html': '' }, { 'index.html': 'ok', '.env': 'secret' },
    { 'index.html': 'ok', 'bad name.js': 'no' }, { 'index.html': Buffer.alloc(MAX_BYTES + 1) },
  ]) {
    const root = await temp(t);
    await outputFiles(root, files);
    await assert.rejects(collectArtifacts(root, config));
  }
  const root = await temp(t);
  const other = await temp(t);
  await outputFiles(other);
  await symlink(join(other, 'dist'), join(root, 'dist'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(collectArtifacts(root, config), /symlinks|junctions/);
});

test('manifest rejects the 501st file before upload', async t => {
  const root = await temp(t);
  await outputFiles(root, Object.fromEntries([['index.html', 'hello'], ...Array.from({ length: 500 }, (_, i) => [`${i}.txt`, 'x'])]));
  await assert.rejects(collectArtifacts(root, config), /500-file/);
});

test('only the explicitly configured build runs and deploy token is removed from its environment', async t => {
  const root = await temp(t);
  await writeFile(join(root, 'build.mjs'), `import { mkdirSync, writeFileSync } from 'node:fs';
if (process.env.BETTERVERCEL_TOKEN) process.exit(9);
mkdirSync('dist', {recursive:true}); writeFileSync('dist/index.html','built');`);
  const output = { write() {} };
  await runBuild(root, config, { output });
  await assert.rejects(readFile(join(root, 'dist/index.html')), /ENOENT/);
  await runBuild(root, { ...config, buildCommand: `"${process.execPath}" build.mjs` },
    { output, env: { ...process.env, BETTERVERCEL_TOKEN: 'secret' } });
  assert.equal(await readFile(join(root, 'dist/index.html'), 'utf8'), 'built');
  await assert.rejects(runBuild(root, { ...config, buildCommand: `"${process.execPath}" -e "process.exit(2)"` }, { output }), /Build failed/);
});

test('bounded workers stop scheduling on failure and wait for active uploads', async () => {
  let active = 0; let max = 0; let started = 0;
  const artifacts = Array.from({ length: 12 }, (_, i) => ({ path: `${i}.txt` }));
  const uploads = artifacts.map(({ path }) => ({ path }));
  await uploadArtifacts({ async upload() {
    active++; started++; max = Math.max(max, active);
    await new Promise(resolve => setTimeout(resolve, 5)); active--;
  } }, uploads, artifacts, 3);
  assert.equal(max, 3); assert.equal(started, 12); assert.equal(active, 0);
  started = 0;
  await assert.rejects(uploadArtifacts({ async upload(upload) {
    started++; active++;
    await new Promise(resolve => setTimeout(resolve, 5)); active--;
    if (upload.path === '0.txt') throw new Error('failed');
  } }, uploads, artifacts, 3), /failed/);
  assert.equal(started, 3); assert.equal(active, 0);
  await assert.rejects(uploadArtifacts({}, uploads.slice(1), artifacts), /manifest/);
});

async function service(t) {
  const credentials = await issueToken();
  const projects = new Map([[projectId, { projectId, ...credentials }]]);
  const records = new Map();
  const objects = new Map();
  let base; let failPath; let finalizeCount = 0; let createCount = 0;
  const handler = createHandler({ domain: 'example.cloudfront.net', store: {
    async getProject(id) { return projects.get(id); },
    async createDeployment(record) {
      if (records.has(record.deploymentId)) return false;
      records.set(record.deploymentId, structuredClone(record)); createCount++; return true;
    },
    async getDeployment(owner, id) { const record = records.get(id); return record?.projectId === owner ? structuredClone(record) : undefined; },
    async listDeployments(id) { return { records: [...records.values()].filter(record => record.projectId === id) }; },
    async transition(record, status, fields) {
      const saved = records.get(record.deploymentId);
      if (saved.status !== 'uploading') return false;
      Object.assign(saved, { status }, fields); return true;
    },
  }, objects: {
    async sign(key, file) { return { path: file.path, method: 'PUT', url: `${base}/upload/${key}`,
      headers: { 'content-type': file.contentType, 'content-length': String(file.size), 'cache-control': CACHE_CONTROL,
        'if-none-match': '*', 'x-amz-checksum-sha256': Buffer.from(file.sha256, 'hex').toString('base64') } }; },
    async validate(record) {
      const found = record.files.map(file => objects.get(prefix(record) + file.path));
      return { complete: found.every(Boolean), valid: record.files.every((file, i) => found[i] &&
        digest(found[i]) === file.sha256 && found[i].length === file.size) };
    },
  } });
  const server = createServer(async (req, res) => {
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      const url = new URL(req.url, base);
      if (url.pathname.startsWith('/upload/')) {
        assert.equal(req.headers.authorization, undefined);
        assert.equal(req.headers['if-none-match'], '*');
        assert.equal(req.headers['cache-control'], CACHE_CONTROL);
        assert.equal(req.headers['x-amz-checksum-sha256'], Buffer.from(digest(body), 'hex').toString('base64'));
        const key = url.pathname.slice('/upload/'.length);
        if (failPath && key.endsWith(failPath)) { res.writeHead(403); res.end('denied'); return; }
        if (objects.has(key)) { res.writeHead(412); res.end(); return; }
        objects.set(key, body); res.writeHead(200); res.end(); return;
      }
      let routeKey = `${req.method} ${url.pathname}`;
      const pathParameters = {};
      const deployment = /^\/v1\/deployments\/([^/]+)(\/finalize)?$/.exec(url.pathname);
      if (deployment) {
        pathParameters.deploymentId = deployment[1];
        routeKey = `${req.method} /v1/deployments/{deploymentId}${deployment[2] ?? ''}`;
        if (deployment[2]) finalizeCount++;
      }
      const list = /^\/v1\/projects\/([^/]+)\/deployments$/.exec(url.pathname);
      if (list) { pathParameters.projectId = list[1]; routeKey = 'GET /v1/projects/{projectId}/deployments'; }
      const result = await handler({ routeKey, headers: req.headers, body: body.toString(), pathParameters });
      res.writeHead(result.statusCode, result.headers); res.end(result.body);
    } catch { res.writeHead(500); res.end('{}'); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return { base, token: credentials.token, records, objects, fail(path) { failPath = path; },
    counts() { return { finalizeCount, createCount }; } };
}

test('CLI login, deploy, status and logs work with real HTTP and the milestone 2 handler; retries resume immutable uploads', async t => {
  const root = await temp(t); const svc = await service(t); let printed = '';
  await outputFiles(root);
  const env = { BETTERVERCEL_CREDENTIALS_FILE: join(root, '.bettervercel', 'credentials.json') };
  const context = { cwd: root, env, output: { write(value) { printed += value; } }, sleep: async () => {} };
  await runCli(['init', '--api', svc.base, '--project', projectId, '--output', 'dist'], context);
  await runCli(['login', '--token-stdin'], { ...context, input: Readable.from([svc.token + '\n']) });
  const saved = JSON.parse(await readFile(env.BETTERVERCEL_CREDENTIALS_FILE, 'utf8'));
  assert.equal(saved[`${svc.base}|${projectId}`], svc.token);
  svc.fail('index.html');
  await assert.rejects(runCli(['deploy', '--idempotency-key', 'cli-integration'], context), /resume unchanged output/);
  assert.equal(svc.counts().finalizeCount, 0);
  assert.equal([...svc.records.values()][0].status, 'uploading');
  svc.fail(undefined);
  const ready = await runCli(['deploy', '--skip-build', '--idempotency-key', 'cli-integration'], context);
  assert.equal(ready.status, 'ready');
  assert.equal(svc.counts().createCount, 1);
  assert.equal((await runCli(['status'], context)).deploymentId, ready.deploymentId);
  await runCli(['logs'], context);
  assert.match(printed, /All manifest objects verified/);
  assert.match(printed, /Preview: https:\/\/example.cloudfront.net/);
  assert.ok(!printed.includes(svc.token)); assert.ok(!printed.includes('/upload/'));
  await runCli(['deploy', '--skip-build', '--idempotency-key', 'cli-integration'], context);
  assert.equal(svc.counts().finalizeCount, 1);
  await outputFiles(root, { 'index.html': 'changed' });
  await assert.rejects(runCli(['deploy', '--skip-build', '--idempotency-key', 'cli-integration'], context), /409/);
  const state = await readFile(join(root, '.bettervercel', 'deployment.json'), 'utf8');
  assert.ok(!state.includes(svc.token)); assert.ok(!state.includes('/upload/'));
});

test('invalid login does not replace saved credentials; build failures create no deployment', async t => {
  const root = await temp(t); const svc = await service(t);
  await writeFile(join(root, 'bettervercel.json'), JSON.stringify({ ...config, apiUrl: svc.base, buildCommand: 'some-explicit-command' }));
  const path = join(root, 'credentials.json'); await writeFile(path, '{}\n');
  const context = { cwd: root, env: { BETTERVERCEL_TOKEN: `bv_${'x'.repeat(43)}`, BETTERVERCEL_CREDENTIALS_FILE: path },
    output: { write() {} }, sleep: async () => {} };
  await assert.rejects(runCli(['login'], context), /401/);
  assert.equal(await readFile(path, 'utf8'), '{}\n');
  context.env.BETTERVERCEL_TOKEN = svc.token;
  await assert.rejects(runCli(['deploy'], { ...context, build: async () => { throw new Error('build broken'); } }), /build broken/);
  assert.equal(svc.counts().createCount, 0);
});

test('client retries throttles and transient failures, redacts secrets and refuses API redirects', async t => {
  let calls = 0;
  const token = `bv_${'x'.repeat(43)}`;
  const client = createClient({ api: config.apiUrl, token, sleep: async () => {}, fetchImpl: async (url, options) => {
    assert.equal(options.redirect, 'error'); calls++;
    return calls < 3 ? new Response('{}', { status: calls === 1 ? 429 : 503 }) : new Response('{"status":"ready"}');
  } });
  assert.equal((await client.api('GET', '/v1/test')).status, 'ready'); assert.equal(calls, 3);
  const bad = createClient({ api: config.apiUrl, token, fetchImpl: async () => new Response(JSON.stringify({ error: `${token} https://s3.test/?secret=1` }), { status: 400 }) });
  await assert.rejects(bad.api('GET', '/'), error => !error.message.includes(token) && !error.message.includes('secret=1'));
  let destinationCalls = 0;
  const server = createServer((req, res) => {
    if (req.url === '/redirect') { res.writeHead(302, { location: '/destination' }); res.end(); }
    else { destinationCalls++; res.end('{}'); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const redirect = createClient({ api: `http://127.0.0.1:${server.address().port}`, token, sleep: async () => {} });
  await assert.rejects(redirect.api('GET', '/redirect'), /network request failed/);
  assert.equal(destinationCalls, 0);
});

test('executable entry point exposes help and returns failure for invalid arguments', async () => {
  async function command(args) {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../cli/bin.mjs', import.meta.url)), ...args], { windowsHide: true });
    let output = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
    const [code] = await once(child, 'close'); return { code, output };
  }
  assert.match((await command(['--help'])).output, /bettervercel deploy/);
  assert.equal((await command(['nonsense'])).code, 1);
  assert.equal((await command(['status', '--skip-build'])).code, 1);
});
