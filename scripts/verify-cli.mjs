import assert from 'node:assert/strict';
import { cp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createProject } from './operator-request.mjs';
import { runCli } from '../cli/main.mjs';
import { collectArtifacts, readJson } from '../cli/project.mjs';

const hosting = JSON.parse(await readFile('cdk-outputs.json', 'utf8')).BetterVercelStaticStack;
const control = JSON.parse(await readFile('control-outputs.json', 'utf8')).BetterVercelControlStack;
const repo = process.cwd();
const root = process.argv[2] ? resolve(process.argv[2]) : resolve('.build', `cli-smoke-${Date.now()}`);
assert.ok(root.startsWith(resolve('.build') + (process.platform === 'win32' ? '\\' : '/')), 'Smoke directory must be inside .build');
await mkdir(root, { recursive: true });
const results = await readJson(resolve(root, 'results.json'), true) ?? [];
for (const [name, framework, source, outputDirectory, executable] of [
  ['vite', 'vite', 'examples/vite-site', 'dist', 'node_modules/vite/bin/vite.js'],
  ['next', 'next-static', 'examples/next-static', 'out', 'examples/next-static/node_modules/next/dist/bin/next'],
]) {
  const directory = resolve(root, name);
  if (results.some(result => result.name === name)) continue;
  let config = await readJson(resolve(directory, 'bettervercel.json'), true);
  const env = { ...process.env, NEXT_TELEMETRY_DISABLED: '1',
    BETTERVERCEL_CREDENTIALS_FILE: resolve(root, 'credentials.json') };
  if (!config) {
    await cp(source, directory, { recursive: true, filter: path => !/(?:^|[\\/])(node_modules|\.next|dist|out)(?:[\\/]|$)/.test(path) });
    if (name === 'next') await symlink(resolve(source, 'node_modules'), resolve(directory, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    const project = await createProject(control.ApiUrl, hosting.Region, `CLI audit ${name}`);
    config = { apiUrl: control.ApiUrl, projectId: project.projectId, framework, outputDirectory,
      buildCommand: `node "${resolve(executable)}" build` };
    await writeFile(resolve(directory, 'bettervercel.json'), JSON.stringify(config));
    env.BETTERVERCEL_TOKEN = project.deployToken;
    await runCli(['login'], { cwd: directory, env });
  }
  const key = `smoke-${randomUUID()}`;
  const started = Date.now();
  const deployment = await runCli(['deploy', '--idempotency-key', key], { cwd: directory, env });
  assert.equal(deployment.status, 'ready');
  assert.equal((await runCli(['status'], { cwd: directory, env })).deploymentId, deployment.deploymentId);
  await runCli(['logs'], { cwd: directory, env });
  const files = await collectArtifacts(directory, config);
  // Fetch every emitted object, including Next's JS chunks and nested HTML, through CloudFront.
  for (const file of files) {
    const response = await fetch(deployment.previewUrl + file.path, { signal: AbortSignal.timeout(30000) });
    assert.equal(response.status, 200, file.path);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), file.body, file.path);
    assert.equal(response.headers.get('content-type'), file.contentType, file.path);
  }
  if (name === 'next') {
    const nested = await fetch(deployment.previewUrl + 'about/');
    assert.equal(nested.status, 200); assert.match(await nested.text(), /Nested route works/);
  }
  results.push({ name, directory, apiUrl: control.ApiUrl, ...deployment, elapsedIncludingBuildMs: Date.now() - started });
  await writeFile(resolve(root, 'results.json'), JSON.stringify(results, null, 2));
  console.log(`Verified ${name}: ${files.length} exact objects and MIME types; ${deployment.previewUrl}`);
}
console.log(`Verification results: ${resolve(root, 'results.json')}`);
