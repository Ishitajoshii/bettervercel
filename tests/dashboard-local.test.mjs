import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { webcrypto, createHash } from 'node:crypto';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';
import { artifactContentType, normalizeRequest } from '../api/domain.mjs';

const html = await readFile(new URL('../dashboard/index.html', import.meta.url), 'utf8');
const script = await readFile(new URL('../dashboard/app.js', import.meta.url), 'utf8');
const projectId = 'p1111111111111111';
const deploymentId = `${projectId}-${'a'.repeat(32)}`;
const token = `bv_${'x'.repeat(43)}`;
function file(name, contents = '<h1>Hello</h1>', relative = '') {
  const value = new File([contents], name); Object.defineProperty(value, 'webkitRelativePath', { value: relative }); return value;
}
async function fixture() {
  const { document } = parseHTML(html);
  for (const select of document.querySelectorAll('select')) Object.defineProperty(select, 'value', {
    get() { return this._value ?? this.querySelector('option')?.getAttribute('value') ?? ''; }, set(value) { this._value = value; },
  });
  const requests = []; let manifest;
  let responder = async (url, options, body) => {
    if (url === './config.json') return { apiUrl: 'https://api.example.com' };
    if (url.includes('.s3.')) return {};
    if (url.endsWith('/finalize')) return { status: 'ready' };
    if (options.method === 'POST') {
      manifest = body; normalizeRequest(body, options.headers['idempotency-key']);
      return { deploymentId, status: 'uploading', uploads: body.files.map(entry => ({ path: entry.path, method: 'PUT',
        url: `https://artifacts.s3.ap-south-1.amazonaws.com/${entry.path}?signed=yes`,
        headers: { 'content-type': entry.contentType, 'content-length': String(entry.size), 'cache-control': 'public, max-age=86400, immutable',
          'if-none-match': '*', 'x-amz-checksum-sha256': Buffer.from(entry.sha256, 'hex').toString('base64') } })) };
    }
    if (url.endsWith('/deployments')) return { deployments: [], nextCursor: null };
    return { name: 'Local site', projectId };
  };
  const context = vm.createContext({ document, URL, AbortSignal, crypto: webcrypto, TextEncoder, TextDecoder, Uint8Array, btoa, setTimeout,
    fetch: async (url, options = {}) => {
      const body = typeof options.body === 'string' ? JSON.parse(options.body) : options.body;
      requests.push({ url, ...options, body });
      const result = await responder(url, options, body);
      return { ok: !result.error && !result.httpStatus, status: result.httpStatus ?? (result.error ? 422 : 200), json: async () => result };
    },
  });
  vm.runInContext(script, context); await new Promise(resolve => setImmediate(resolve));
  const $ = id => document.getElementById(id);
  $('project').value = projectId; $('token').value = token;
  await $('connect-form').onsubmit({ preventDefault() {}, submitter: $('connect-form').querySelector('button') });
  return { $, document, requests, context, get manifest() { return manifest; },
    select: (files, folder = false) => $(folder ? 'local-folder' : 'local-files').onchange({ target: { files } }),
    submit: () => { $('local-consent').checked = true; return $('local-form').onsubmit({ preventDefault() {} }); },
    respond(fn) { const previous = responder; responder = async (...args) => await fn(...args) ?? previous(...args); } };
}

test('local folder upload preserves nested paths, hashes exact bytes, and waits for server verification', async () => {
  const f = await fixture(); f.$('source-local').onclick();
  assert.equal(f.$('github-panel').hidden, true); assert.equal(f.$('source-local').getAttribute('aria-pressed'), 'true');
  await f.select([file('index.html', '<h1>Hello</h1>', 'dist/index.html'), file('main.js', 'console.log(1)', 'dist/assets/main.js')], true);
  assert.equal(f.requests.filter(r => r.method === 'POST' || r.method === 'PUT').length, 0);
  assert.equal(f.$('local-deploy').disabled, true);
  assert.match(f.$('local-scan').textContent, /Checks passed/);
  await f.submit();
  assert.deepEqual(f.manifest.files.map(entry => entry.path), ['index.html', 'assets/main.js']);
  assert.equal(f.manifest.files[0].sha256, createHash('sha256').update('<h1>Hello</h1>').digest('hex'));
  const uploads = f.requests.filter(r => r.method === 'PUT');
  assert.equal(uploads.length, 2);
  assert.equal(uploads[0].headers.authorization, undefined); assert.equal(uploads[0].headers['content-length'], undefined);
  assert.equal(uploads[0].credentials, 'omit'); assert.equal(uploads[0].redirect, 'error');
  assert.match(f.$('local-integrity').textContent, /^SHA-256 verified/);
  assert.equal(f.$('local-consent').checked, false);
});

test('local guard blocks secrets, private keys, unsafe paths, duplicates, archives and missing entrypoints before network uploads', async () => {
  const bad = [file('.env'), file('key.pem'), file('credentials.json'), file('data.json', JSON.stringify({ key: 'AKIA' + 'A'.repeat(16) })),
    file('config.txt', '-----BEGIN RSA PRIVATE KEY-----'), file('index.html', token), file('../index.html'), file('site.zip'), file('index.html', '')];
  for (const entry of bad) {
    const f = await fixture(); await f.select([entry]); await f.submit();
    assert.match(f.$('local-scan').textContent, /blocked/); assert.equal(f.requests.filter(r => r.method === 'POST' || r.method === 'PUT').length, 0);
    assert.equal(f.$('local-review').hidden, true);
    assert.ok(!f.document.toString().includes(token));
  }
  const f = await fixture(); await f.select([file('index.html'), file('index.html')]); assert.match(f.$('local-notice').textContent, /duplicate/);
  await f.select([file('main.js')]); assert.match(f.$('local-notice').textContent, /index.html/);
  await f.select(Array.from({ length: 501 }, () => file('index.html'))); assert.match(f.$('local-notice').textContent, /500/);
  await f.select([{ name: 'index.html', size: 25 * 1024 * 1024 + 1 }]); assert.match(f.$('local-notice').textContent, /25 MiB/);
});

test('retry reuses deployment key and accepts immutable existing objects but does not claim verification on finalize failure', async () => {
  const f = await fixture(); await f.select([file('index.html')]);
  let failed = true;
  f.respond(url => url.includes('.s3.') ? { httpStatus: 412 } : url.endsWith('/finalize') && failed ? { error: 'Checksum mismatch' } : undefined);
  await f.submit(); assert.match(f.$('local-notice').textContent, /Checksum mismatch/);
  assert.doesNotMatch(f.$('local-integrity').textContent, /^SHA-256 verified/);
  failed = false; await f.submit();
  const creates = f.requests.filter(r => r.url.endsWith('/deployments') && r.method === 'POST');
  assert.equal(creates[0].headers['idempotency-key'], creates[1].headers['idempotency-key']);
  assert.match(f.$('local-integrity').textContent, /^SHA-256 verified/);
});

test('stale local scans cannot restore files after clear or overwrite a new selection', async () => {
  const f = await fixture(); let release;
  const pending = file('index.html'); pending.arrayBuffer = () => new Promise(resolve => { release = resolve; });
  const scan = f.select([pending]); f.$('local-clear').onclick();
  await f.select([file('index.html', 'new bytes')]); release(new TextEncoder().encode('old bytes').buffer); await scan;
  await f.submit(); assert.equal(f.manifest.files[0].sha256, createHash('sha256').update('new bytes').digest('hex'));
});

test('rejects untrusted upload destinations and missing manifest instructions before sending bytes', async () => {
  for (const url of ['http://artifacts.s3.ap-south-1.amazonaws.com/index.html', 'https://evil.example.com/index.html']) {
    const f = await fixture(); await f.select([file('index.html')]);
    f.respond((path, options) => options.method === 'POST' ? { deploymentId, status: 'uploading', uploads: [{ path: 'index.html', method: 'PUT', url }] } : undefined);
    await f.submit(); assert.equal(f.requests.filter(r => r.method === 'PUT').length, 0);
    assert.match(f.$('local-notice').textContent, /Invalid signed upload/);
  }
});

test('disconnect disables local deployment and browser MIME mapping stays aligned with the backend', async () => {
  const f = await fixture(); await f.select([file('index.html')]);
  f.$('local-consent').checked = true; f.$('local-consent').onchange(); assert.equal(f.$('local-deploy').disabled, false);
  f.$('disconnect').onclick(); assert.equal(f.$('local-deploy').disabled, true);
  await f.submit(); assert.equal(f.requests.filter(r => r.method === 'POST').length, 0);
  const mapping = vm.runInContext('localTypes', f.context);
  for (const [extension, type] of Object.entries(mapping)) assert.equal(type, artifactContentType(`file.${extension}`));
});
