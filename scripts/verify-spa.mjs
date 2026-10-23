import assert from 'node:assert/strict';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createProject } from './operator-request.mjs';
import { runCli } from '../cli/main.mjs';
import { collectArtifacts, runBuild } from '../cli/project.mjs';
import { http } from './lib.mjs';

// Run only after deploying both the router and control API changes.
// Creates two disposable projects. Credentials stay in the ignored smoke directory
// so an operator can later delete the previews after their upload windows expire.
const hosting = JSON.parse(await readFile('cdk-outputs.json', 'utf8')).BetterVercelStaticStack;
const control = JSON.parse(await readFile('control-outputs.json', 'utf8')).BetterVercelControlStack;
const root = resolve('.build', `spa-smoke-${Date.now()}`);
await mkdir(root, { recursive: true });
const results = [];
for (const routing of ['spa', 'static']) {
  const directory = resolve(root, routing);
  await cp('examples/vite-site', directory, { recursive: true,
    filter: path => !/(?:^|[\\/])(node_modules|dist)(?:[\\/]|$)/.test(path) && !path.endsWith('vite.config.ts') });
  await writeFile(resolve(directory, 'vite.config.mjs'),
    "export default { base: process.env.BETTERVERCEL_BASE_PATH + '/', build: { outDir: 'dist' } };\n");
  const project = await createProject(control.ApiUrl, hosting.Region, `Routing acceptance ${routing}`);
  const config = { apiUrl: control.ApiUrl, projectId: project.projectId, framework: 'vite', routing,
    outputDirectory: 'dist', buildCommand: `node "${resolve('node_modules/vite/bin/vite.js')}" build` };
  await writeFile(resolve(directory, 'bettervercel.json'), JSON.stringify(config, null, 2) + '\n');
  const env = { ...process.env, BETTERVERCEL_TOKEN: project.deployToken,
    BETTERVERCEL_CREDENTIALS_FILE: resolve(root, 'credentials.json') };
  await runCli(['login'], { cwd: directory, env });
  let builtAt;
  const deployment = await runCli(['deploy', '--idempotency-key', `routing-${randomUUID()}`], {
    cwd: directory, env, build: async (...args) => { await runBuild(...args); builtAt = Date.now(); },
  });
  const elapsedAfterBuildMs = Date.now() - builtAt;
  assert.ok(elapsedAfterBuildMs < 120_000, 'Deployment exceeded the two-minute post-build target.');
  const artifacts = await collectArtifacts(directory, config);
  const index = artifacts.find(file => file.path === 'index.html');
  for (const file of artifacts) {
    const response = await http(deployment.previewUrl + file.path);
    assert.equal(response.status, 200, `${routing}: ${file.path}`);
    assert.equal(response.headers.get('content-type'), file.contentType);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), file.body);
  }
  for (const path of ['settings', 'settings/profile/', 'settings/profile?tab=general']) {
    const response = await http(deployment.previewUrl + path);
    if (routing === 'spa') {
      assert.equal(response.status, 200, path);
      assert.equal(response.headers.get('content-type'), index.contentType);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), index.body);
    } else {
      assert.ok([403, 404].includes(response.status), 'Static export unexpectedly fell back to HTML.');
      await response.arrayBuffer();
    }
  }
  for (const path of ['missing.js', 'assets/missing.css', 'missing.json', 'missing.js/']) {
    const response = await http(deployment.previewUrl + path);
    assert.ok([403, 404].includes(response.status), `Missing asset became HTML: ${path}`);
    await response.arrayBuffer();
  }
  const alternate = `https://${hosting.DomainName}/d/${deployment.deploymentId}/${routing === 'static' ? '_spa/settings' : ''}`;
  const wrongNamespace = await http(alternate);
  assert.ok([403, 404].includes(wrongNamespace.status), 'Routing mode leaked across artifact namespaces.');
  await wrongNamespace.arrayBuffer();
  results.push({ directory, apiUrl: control.ApiUrl, ...deployment, elapsedAfterBuildMs });
  await writeFile(resolve(root, 'results.json'), JSON.stringify(results, null, 2) + '\n');
  console.log(`PASS: ${routing} artifact bytes, MIME, deep links, missing assets, namespace isolation; ${elapsedAfterBuildMs} ms after build.`);
}
const unknownId = `${results[0].projectId}-${randomUUID().replaceAll('-', '')}`;
const unknown = await http(`https://${hosting.DomainName}/d/${unknownId}/_spa/settings`);
assert.ok([403, 404].includes(unknown.status), 'Unknown deployment received SPA HTML.');
await unknown.arrayBuffer();
await writeFile(resolve(root, 'verification.json'), JSON.stringify({ completedAt: new Date().toISOString(),
  checks: ['spa-deep-links', 'static-no-fallback', 'exact-assets-and-mime', 'missing-assets', 'routing-namespace-isolation', 'unknown-deployment', 'two-minute-target'],
}, null, 2) + '\n');
console.log(`Verified routing. Results: ${resolve(root, 'results.json')}`);
