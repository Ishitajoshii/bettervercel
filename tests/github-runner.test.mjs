import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { collectArtifacts, validatePreviewPaths } from '../cli/project.mjs';
import { deploymentIdFor, previewBasePath } from '../api/domain.mjs';

const runner = resolve('.build/control-api/github-runner.cjs');
const settings = { projectId: 'p1111111111111111', apiUrl: 'https://api.example.com', rootDirectory: '.',
  outputDirectory: '.', framework: 'static', routing: 'static', installCommand: '', buildCommand: '' };
async function fixture() {
  await mkdir('.build/runner-tests', { recursive: true });
  const cwd = await mkdtemp(resolve('.build/runner-tests/test-'));
  await mkdir(resolve(cwd, 'source'), { recursive: true });
  return cwd;
}
async function build(cwd, config) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [runner, 'build'], { cwd, windowsHide: true,
      env: { ...process.env, BETTERVERCEL_IMPORT: Buffer.from(JSON.stringify(config)).toString('base64'),
        GITHUB_RUN_ID: '12345', GITHUB_RUN_ATTEMPT: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', bytes => { output += bytes; }); child.stderr.on('data', bytes => { output += bytes; });
    child.on('error', reject); child.on('exit', code => resolveRun({ code, output }));
  });
}
test('bundled GitHub runner stages plain HTML from root and excludes dotfiles and package metadata', async () => {
  const cwd = await fixture();
  await writeFile(resolve(cwd, 'source/index.html'), '<h1>Plain site</h1>');
  await writeFile(resolve(cwd, 'source/.env'), 'SECRET=hidden');
  await writeFile(resolve(cwd, 'source/package.json'), '{}');
  const result = await build(cwd, settings);
  assert.equal(result.code, 0, result.output);
  const config = JSON.parse(await readFile(resolve(cwd, '.bettervercel-stage/bettervercel.json'), 'utf8'));
  const artifacts = await collectArtifacts(resolve(cwd, '.bettervercel-stage'), config);
  assert.deepEqual(artifacts.map(file => file.path), ['index.html']);
});

test('bundled GitHub runner builds a nested Vite app with the exact SPA deployment base', async () => {
  const cwd = await fixture(); const app = resolve(cwd, 'source/apps/web');
  await mkdir(app, { recursive: true });
  await writeFile(resolve(app, 'package.json'), JSON.stringify({ type: 'module', scripts: { build: 'vite build' } }));
  await writeFile(resolve(app, 'index.html'), '<!doctype html><div id="app">Vite</div><script type="module" src="/main.js"></script>');
  await writeFile(resolve(app, 'main.js'), 'document.getElementById("app").textContent = "Deployed";');
  const config = { ...settings, rootDirectory: 'apps/web', framework: 'vite', routing: 'spa', buildCommand: 'npm run build', outputDirectory: 'dist' };
  const result = await build(cwd, config);
  assert.equal(result.code, 0, result.output);
  const staged = JSON.parse(await readFile(resolve(cwd, '.bettervercel-stage/bettervercel.json'), 'utf8'));
  const artifacts = await collectArtifacts(resolve(cwd, '.bettervercel-stage'), staged);
  const base = previewBasePath(deploymentIdFor(settings.projectId, 'gha-12345-1'), 'spa');
  assert.doesNotThrow(() => validatePreviewPaths(artifacts, base, 'spa'));
  assert.ok(artifacts.find(file => file.path === 'index.html').body.toString().includes(base + '/assets/'));
});

test('runner build failures do not produce a publishable stage', async () => {
  const cwd = await fixture();
  const result = await build(cwd, { ...settings, buildCommand: 'node -e "process.exit(12)"' });
  assert.notEqual(result.code, 0); assert.match(result.output, /Build failed/);
  await assert.rejects(readFile(resolve(cwd, '.bettervercel-stage/bettervercel.json')), { code: 'ENOENT' });
});
