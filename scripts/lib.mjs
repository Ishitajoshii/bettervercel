import { readFile, readdir } from 'node:fs/promises';
import { resolve, relative, sep } from 'node:path';
import { parseArgs } from 'node:util';

export function deploymentPrefix(id) {
  if (!id || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(id)) {
    throw new Error('Pass --id with 1–63 lowercase letters, digits, or hyphens; start with a letter/digit.');
  }
  if (/^p[a-f0-9]{16}-[a-f0-9]{32}$/.test(id)) throw new Error('API deployment IDs are reserved; use the deploy API.');
  return `deployments/${id}/`;
}

export async function configuration() {
  const { values } = parseArgs({
    options: { id: { type: 'string' }, outputs: { type: 'string', default: 'cdk-outputs.json' } },
    allowPositionals: false,
  });
  const prefix = deploymentPrefix(values.id);
  let outputs;
  try { outputs = JSON.parse(await readFile(values.outputs, 'utf8')).BetterVercelStaticStack; }
  catch { throw new Error('Missing CDK outputs. Deploy infrastructure with npm run deploy:infra first.'); }
  if (!outputs || !/^[a-z0-9.-]+$/.test(outputs.BucketName ?? '') ||
      !/^[A-Z0-9]+$/.test(outputs.DistributionId ?? '') ||
      !/^[a-z0-9]+\.cloudfront\.net$/.test(outputs.DomainName ?? '') ||
      !/^[a-z]{2}-[a-z]+-\d$/.test(outputs.Region ?? '')) {
    throw new Error('Invalid BetterVercelStaticStack outputs.');
  }
  return { ...outputs, id: values.id, prefix,
    url: `https://${outputs.DomainName}/d/${values.id}/` };
}

export async function sampleFiles(root = resolve('examples/vite-site/dist')) {
  const files = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error('Symlinks are not allowed in build output.');
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) {
        const key = relative(root, path).split(sep).join('/');
        files.push({ key, body: await readFile(path) });
      }
    }
  }
  try { await visit(root); }
  catch (error) {
    if (error.code === 'ENOENT') throw new Error('No sample build. Run npm run build:sample first.');
    throw error;
  }
  if (!files.some(file => file.key === 'index.html')) throw new Error('Build must contain index.html.');
  if (files.length > 500 || files.reduce((size, file) => size + file.body.length, 0) > 25 * 1024 * 1024) {
    throw new Error('Sample exceeds the 500-file / 25 MiB limit.');
  }
  return files;
}

export function contentType(key) {
  const extension = key.slice(key.lastIndexOf('.')).toLowerCase();
  return ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon',
    '.woff2': 'font/woff2' })[extension] ?? 'application/octet-stream';
}

export function run(action) {
  action().catch(error => {
    console.error(error.message);
    if (/credential|token|login|sso/i.test(error.message)) {
      console.error('Sign in with AWS CLI locally; set AWS_PROFILE if using a named profile.');
    }
    process.exitCode = 1;
  });
}

export function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function http(url, options = {}) {
  return fetch(url, { signal: AbortSignal.timeout(30_000), ...options });
}
