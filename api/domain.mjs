import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);
export const MAX_BYTES = 25 * 1024 * 1024;
export const MAX_FILES = 500;
export const UPLOAD_SECONDS = 900;
export const CACHE_CONTROL = 'public, max-age=86400, immutable';
export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export function requireValue(condition, message, status = 400) {
  if (!condition) throw new HttpError(status, message);
}
export const digest = value => createHash('sha256').update(value).digest('hex');
export const projectId = () => `p${randomBytes(8).toString('hex')}`;
export function validProject(id) { return typeof id === 'string' && /^p[a-f0-9]{16}$/.test(id); }
export function deploymentProject(id) {
  const match = typeof id === 'string' && /^(p[a-f0-9]{16})-[a-f0-9]{32}$/.exec(id);
  requireValue(match, 'Invalid deployment ID.');
  return match[1];
}
export async function issueToken() {
  const token = `bv_${randomBytes(32).toString('base64url')}`;
  const salt = randomBytes(16).toString('hex');
  return { token, salt, tokenHash: (await scrypt(token, salt, 32)).toString('hex') };
}
export async function verifyToken(token, project) {
  if (!/^bv_[A-Za-z0-9_-]{43}$/.test(token ?? '') || !project) return false;
  const actual = await scrypt(token, project.salt, 32);
  return timingSafeEqual(actual, Buffer.from(project.tokenHash, 'hex'));
}
const types = {
  html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8',
  json: 'application/json', txt: 'text/plain; charset=utf-8', xml: 'application/xml',
  svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', ico: 'image/x-icon',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', wasm: 'application/wasm',
  pdf: 'application/pdf', map: 'application/json',
};
export function normalizeRequest(input, idempotencyKey) {
  requireValue(typeof idempotencyKey === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(idempotencyKey),
    'Idempotency-Key must contain 8–128 letters, digits, underscores, or hyphens.');
  requireValue(input && validProject(input.projectId), 'Invalid project ID.');
  requireValue(['vite', 'astro', 'next-static', 'static'].includes(input.framework), 'Unsupported static framework.');
  requireValue(input.commitSha === undefined || (typeof input.commitSha === 'string' && /^[a-f0-9]{7,40}$/.test(input.commitSha)), 'Invalid commit SHA.');
  requireValue(Array.isArray(input.files) && input.files.length > 0 && input.files.length <= MAX_FILES,
    'Manifest must contain 1–500 files.');
  const seen = new Set();
  let totalBytes = 0;
  const files = input.files.map(file => {
    requireValue(file && typeof file.path === 'string' && file.path.length <= 240 &&
      /^[A-Za-z0-9_@.-]+(?:\/[A-Za-z0-9_@.-]+)*$/.test(file.path) &&
      !file.path.split('/').some(part => part === '.' || part === '..') && !seen.has(file.path),
    'Invalid or duplicate manifest path.');
    seen.add(file.path);
    requireValue(Number.isSafeInteger(file.size) && file.size >= 0 && file.size <= MAX_BYTES, 'Invalid file size.');
    totalBytes += file.size;
    const contentType = types[file.path.split('.').at(-1).toLowerCase()];
    requireValue(contentType && file.contentType === contentType, 'Unsupported extension or mismatched MIME type.');
    requireValue(typeof file.sha256 === 'string' && /^[a-f0-9]{64}$/.test(file.sha256), 'Expected SHA-256 hex checksum.');
    return { path: file.path, size: file.size, contentType, sha256: file.sha256 };
  }).sort((a, b) => a.path.localeCompare(b.path, 'en'));
  requireValue(totalBytes > 0 && totalBytes <= MAX_BYTES, 'Artifact must contain 1 byte–25 MiB.');
  requireValue(files.some(file => file.path === 'index.html' && file.size > 0), 'A nonempty index.html is required.');
  const request = { projectId: input.projectId, framework: input.framework, commitSha: input.commitSha ?? null, files };
  return { ...request, totalBytes, requestHash: digest(JSON.stringify(request)),
    deploymentId: `${input.projectId}-${digest(idempotencyKey).slice(0, 32)}` };
}
export function prefix(record) { return `deployments/${record.projectId}/${record.deploymentId}/`; }
export function summary(record, domain) {
  return {
    projectId: record.projectId, deploymentId: record.deploymentId, status: record.status,
    framework: record.framework, commitSha: record.commitSha, createdAt: record.createdAt,
    readyAt: record.readyAt ?? null, uploadExpiresAt: record.uploadExpiresAt,
    totalBytes: record.totalBytes, fileCount: record.files.length,
    previewUrl: record.status === 'ready' ? `https://${domain}/d/${record.deploymentId}/` : null,
    logs: record.logs,
  };
}
