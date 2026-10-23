import { lstat, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { artifactContentType, CACHE_CONTROL, digest, MAX_BYTES, MAX_FILES, normalizeRequest, validProject } from '../api/domain.mjs';

export const CONFIG_NAME = 'bettervercel.json';
export function apiUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Set --api or BETTERVERCEL_API_URL to the deploy API URL.'); }
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) ||
      url.username || url.password || url.search || url.hash) {
    throw new Error('API URL must use HTTPS (HTTP is allowed only on loopback) without credentials, query, or fragment.');
  }
  return url.href.replace(/\/$/, '');
}

export async function readJson(path, optional = false) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) {
    if (optional && error.code === 'ENOENT') return undefined;
    throw new Error(`Cannot read ${path}. Check that it contains valid JSON.`);
  }
}

export async function detectFramework(root) {
  const pkg = await readJson(resolve(root, 'package.json'), true) ?? {};
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  // Read metadata only: never import framework configuration or run package scripts here.
  if (deps.next) return { framework: 'next-static', outputDirectory: 'out' };
  if (deps.astro) return { framework: 'astro', outputDirectory: 'dist' };
  if (deps.vite) return { framework: 'vite', outputDirectory: 'dist' };
  if (deps['react-scripts']) return { framework: 'static', outputDirectory: 'build' };
  return { framework: 'static' };
}

export function validateConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Expected a project configuration object.');
  if (!validProject(config.projectId)) throw new Error('Set a valid operator-created project ID with --project.');
  const api = apiUrl(config.apiUrl);
  if (!['vite', 'astro', 'next-static', 'static'].includes(config.framework)) throw new Error('Unsupported framework in bettervercel.json.');
  if (config.routing !== undefined && !['static', 'spa'].includes(config.routing)) throw new Error('routing must be static or spa.');
  if (config.routing === 'spa' && config.framework === 'next-static') throw new Error('Next static export requires static routing.');
  if (typeof config.outputDirectory !== 'string' || !config.outputDirectory.trim() || isAbsolute(config.outputDirectory) ||
      config.outputDirectory.includes(':') || config.outputDirectory.split(/[\\/]/).includes('..') ||
      config.outputDirectory.split(/[\\/]/).every(part => !part || part === '.')) {
    throw new Error('outputDirectory must be a build subdirectory inside the project, such as dist, build, or out.');
  }
  if (config.buildCommand !== null && (typeof config.buildCommand !== 'string' || !config.buildCommand.trim())) {
    throw new Error('Set buildCommand to an explicit local command, or null for prebuilt output.');
  }
  return { apiUrl: api, projectId: config.projectId, framework: config.framework,
    ...(config.routing === 'spa' ? { routing: 'spa' } : {}),
    outputDirectory: config.outputDirectory, buildCommand: config.buildCommand };
}

export async function initProject(root, options) {
  const detected = await detectFramework(root);
  const config = validateConfig({ ...detected, apiUrl: options.api, projectId: options.project,
    routing: options.routing,
    outputDirectory: options.output ?? detected.outputDirectory, buildCommand: options['build-command'] ?? null });
  try { await writeFile(resolve(root, CONFIG_NAME), JSON.stringify(config, null, 2) + '\n', { flag: 'wx' }); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error('bettervercel.json already exists. Edit it explicitly to change project settings.');
    throw error;
  }
  return config;
}

export async function loadProject(root) { return validateConfig(await readJson(resolve(root, CONFIG_NAME))); }

export function validatePreviewPaths(artifacts, basePath, routing) {
  for (const file of artifacts.filter(file => file.path.endsWith('.html'))) {
    for (const match of file.body.toString('utf8').matchAll(/\b(?:src|href)\s*=\s*["'](\/(?!\/)[^"']*)["']/gi)) {
      if (match[1] !== basePath && !match[1].startsWith(basePath + '/')) {
        throw new Error(`Root-absolute URL in ${file.path} points outside this preview. Configure the framework base path with BETTERVERCEL_BASE_PATH and rebuild; relative URLs also work.`);
      }
    }
    if (routing === 'spa') {
      for (const match of file.body.toString('utf8').matchAll(/\b(?:src|href)\s*=\s*["']([^"']+)["']/gi)) {
        if (!/^(?:\/|#|[a-z][a-z0-9+.-]*:)/i.test(match[1])) {
          throw new Error(`Relative URL in ${file.path} will break on SPA deep links. Configure the framework base with BETTERVERCEL_BASE_PATH and rebuild.`);
        }
      }
    }
  }
}

export async function runBuild(root, config, { env = process.env, output = process.stdout } = {}) {
  if (config.buildCommand === null) return;
  const buildEnv = { ...env };
  delete buildEnv.BETTERVERCEL_TOKEN;
  delete buildEnv.BETTERVERCEL_CREDENTIALS_FILE;
  output.write(`Building with configured command: ${config.buildCommand}\n`);
  await new Promise((resolveBuild, reject) => {
    const child = spawn(config.buildCommand, { cwd: root, shell: true, windowsHide: true,
      stdio: ['ignore', 'inherit', 'inherit'], env: buildEnv });
    child.once('error', () => reject(new Error('Could not start the configured build command. Check installed tools and dependencies.')));
    child.once('exit', (code, signal) => code === 0 ? resolveBuild() :
      reject(new Error(`Build failed (${signal ?? code}). Fix the local build before deploying.`)));
  });
}

export async function collectArtifacts(root, config) {
  const projectRoot = await realpath(root);
  const output = resolve(root, config.outputDirectory);
  // Reject links in each output path segment, including an output-directory junction.
  let current = resolve(root);
  for (const part of relative(current, output).split(sep)) {
    current = resolve(current, part);
    if ((await lstat(current)).isSymbolicLink()) throw new Error('Build output cannot contain symlinks or junctions.');
  }
  const resolvedOutput = await realpath(output);
  const within = relative(projectRoot, resolvedOutput);
  if (!within || within === '..' || within.startsWith(`..${sep}`) || isAbsolute(within)) throw new Error('Build output must stay inside the project.');
  const artifacts = [];
  let bytes = 0;
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error('Build output cannot contain symlinks or junctions.');
      if (entry.isDirectory()) { await walk(path); continue; }
      if (!entry.isFile()) throw new Error('Build output must contain only regular files.');
      if (artifacts.length >= MAX_FILES) throw new Error('Build exceeds the 500-file limit. Remove unnecessary output files.');
      const name = relative(output, path).split(sep).join('/');
      if (!/^[A-Za-z0-9_@.~\-]+(?:\/[A-Za-z0-9_@.~\-]+)*$/.test(name) || name.length > 240) throw new Error(`Unsupported artifact path: ${name}`);
      const contentType = artifactContentType(name);
      if (!contentType) throw new Error(`Unsupported artifact extension: ${name}. Remove it from the build output.`);
      const stat = await lstat(path);
      if (!stat.isFile() || bytes + stat.size > MAX_BYTES) throw new Error('Build exceeds the 25 MiB limit or contains a nonregular file.');
      const body = await readFile(path);
      bytes += body.length;
      if (bytes > MAX_BYTES) throw new Error('Build exceeds the 25 MiB limit.');
      artifacts.push({ path: name, size: body.length, contentType, cacheControl: CACHE_CONTROL, sha256: digest(body), body });
    }
  }
  await walk(output);
  artifacts.sort((a, b) => a.path.localeCompare(b.path, 'en'));
  // Reuse the server contract so malformed output fails before any deployment is created.
  normalizeRequest({ projectId: config.projectId, framework: config.framework, routing: config.routing, files: artifacts }, 'local-validation');
  return artifacts;
}
