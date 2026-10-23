import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { deploymentProject, normalizeRequest, validProject } from '../api/domain.mjs';
import { apiUrl, collectArtifacts, initProject, loadProject, readJson, runBuild } from './project.mjs';
import { getToken, readToken, saveToken, validateToken } from './credentials.mjs';
import { createClient, safeMessage, uploadArtifacts } from './client.mjs';

const HELP = `Better Vercel — static deployments through the deploy API

  bettervercel init [directory] --api URL --project ID [--output dist] [--build-command "npm run build"]
  bettervercel login [directory] [--api URL --project ID] [--token-stdin]
  bettervercel deploy [directory] [--skip-build] [--idempotency-key KEY] [--commit SHA] [--concurrency 4]
  bettervercel status [deployment-id] [--directory path]
  bettervercel logs [deployment-id] [--directory path]

init only writes bettervercel.json. Builds run only from its explicit buildCommand.
login validates and saves an operator-issued token; it does not create projects.
BETTERVERCEL_TOKEN overrides saved credentials. Use it directly in CI without login.
status/logs default to the last local deployment. Logs are retained API summaries.
Use --help with any command. See cli/README.md for framework setup and retries.
`;
const optionTypes = {
  api: 'string', project: 'string', output: 'string', 'build-command': 'string',
  'token-stdin': 'boolean', 'skip-build': 'boolean', 'idempotency-key': 'string', commit: 'string',
  concurrency: 'string', directory: 'string', help: 'boolean',
};
const allowed = {
  init: ['api', 'project', 'output', 'build-command'], login: ['api', 'project', 'token-stdin'],
  deploy: ['skip-build', 'idempotency-key', 'commit', 'concurrency'], status: ['directory'], logs: ['directory'],
};
const statePath = root => resolve(root, '.bettervercel', 'deployment.json');
async function writeState(root, state) {
  await mkdir(resolve(root, '.bettervercel'), { recursive: true });
  await writeFile(statePath(root), JSON.stringify(state, null, 2) + '\n');
}
function checkDeployment(data, config, expected) {
  if (!data || deploymentProject(data.deploymentId) !== config.projectId ||
      (expected && data.deploymentId !== expected) || !['uploading', 'ready', 'failed'].includes(data.status)) {
    throw new Error('Deploy API returned an unexpected deployment. Check the API URL.');
  }
  return data;
}
function showDeployment(data, output) {
  output.write(`Deployment: ${data.deploymentId}\nStatus: ${data.status}\n`);
  if (data.status === 'ready') {
    let url;
    try { url = new URL(data.previewUrl); } catch { throw new Error('Ready deployment has no valid preview URL.'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Ready deployment has an invalid preview URL.');
    output.write(`Preview: ${url.href}\n`);
  }
}

export async function runCli(args, { cwd = process.cwd(), env = process.env, input = process.stdin,
  output = process.stdout, fetchImpl = fetch, sleep, build = runBuild } = {}) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true,
    options: Object.fromEntries(Object.entries(optionTypes).map(([name, type]) => [name, { type }])) });
  const [command, target, ...extra] = positionals;
  if (values.help || !command) { output.write(HELP); return; }
  if (!allowed[command] || extra.length) throw new Error('Unknown command or extra arguments. Run bettervercel --help.');
  for (const name of Object.keys(values)) if (!allowed[command].includes(name)) throw new Error(`--${name} is not supported by ${command}.`);
  const root = resolve(cwd, ['status', 'logs'].includes(command) ? values.directory ?? '.' : target ?? '.');
  if (command === 'init') {
    const config = await initProject(root, { ...values, api: values.api ?? env.BETTERVERCEL_API_URL,
      project: values.project ?? env.BETTERVERCEL_PROJECT_ID });
    output.write(`Created ${resolve(root, 'bettervercel.json')}\nFramework: ${config.framework}; output: ${config.outputDirectory}\n`);
    output.write(config.buildCommand ? 'The configured build will run when you deploy.\n' : 'No build command configured. Deploy will upload prebuilt output.\n');
    if (config.framework === 'next-static') output.write('Next.js requires output: "export" and assets that work beneath the preview path. See cli/README.md.\n');
    return config;
  }
  let config;
  if (command === 'login' && (values.api || values.project || env.BETTERVERCEL_API_URL || env.BETTERVERCEL_PROJECT_ID)) {
    config = { apiUrl: apiUrl(values.api ?? env.BETTERVERCEL_API_URL), projectId: values.project ?? env.BETTERVERCEL_PROJECT_ID };
    if (!validProject(config.projectId)) throw new Error('Pass --project with the operator-created project ID.');
  } else config = await loadProject(root);
  const token = command === 'login' ? values['token-stdin'] ? await readToken(input) : validateToken(env.BETTERVERCEL_TOKEN) : await getToken(config, env);
  const client = createClient({ api: config.apiUrl, token, fetchImpl, sleep });
  if (command === 'login') {
    await client.api('GET', `/v1/projects/${config.projectId}/deployments`);
    await saveToken(config, token, env);
    output.write(`Saved credentials for ${config.projectId}.\n`);
    return;
  }
  if (command === 'status' || command === 'logs') {
    const local = target ? undefined : await readJson(statePath(root), true);
    if (!target && (!local || local.apiUrl !== config.apiUrl || local.projectId !== config.projectId)) {
      throw new Error('No deployment recorded for this project. Pass a deployment ID or deploy first.');
    }
    const id = target ?? local.deploymentId;
    if (deploymentProject(id) !== config.projectId) throw new Error('Deployment ID belongs to another project.');
    const data = checkDeployment(await client.api('GET', `/v1/deployments/${id}`), config, id);
    if (command === 'status') showDeployment(data, output);
    else {
      output.write(`Deployment: ${id}\n`);
      for (const line of data.logs ?? []) output.write(safeMessage(line, token) + '\n');
      if (!data.logs?.length) output.write('No retained logs.\n');
    }
    return data;
  }

  const concurrency = Number(values.concurrency ?? 4);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new Error('--concurrency must be an integer from 1 to 8.');
  const key = values['idempotency-key'] ?? randomUUID();
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(key)) throw new Error('--idempotency-key must contain 8–128 letters, digits, underscores, or hyphens.');
  const commitSha = values.commit ?? env.GITHUB_SHA;
  if (commitSha !== undefined && !/^[a-f0-9]{7,40}$/.test(commitSha)) throw new Error('--commit or GITHUB_SHA must be 7–40 lowercase hexadecimal characters.');
  if (!values['skip-build']) await build(root, config, { env, output });
  let artifacts;
  try { artifacts = await collectArtifacts(root, config); }
  catch (error) {
    if (error.code === 'ENOENT') throw new Error('Build output is missing. Configure buildCommand or build locally before deploying.');
    throw error;
  }
  const body = { projectId: config.projectId, framework: config.framework, ...(commitSha ? { commitSha } : {}),
    files: artifacts.map(({ body: bytes, ...file }) => file) };
  const normalized = normalizeRequest(body, key);
  if (Buffer.byteLength(JSON.stringify(body)) > 220_000) throw new Error('Manifest exceeds the 220,000-byte API request limit. Shorten paths or reduce file count.');
  output.write(`Uploading ${artifacts.length} files (${normalized.totalBytes} bytes). Idempotency key: ${key}\n`);
  try {
    const created = checkDeployment(await client.api('POST', '/v1/deployments', body, key), config, normalized.deploymentId);
    await writeState(root, { apiUrl: config.apiUrl, projectId: config.projectId, deploymentId: created.deploymentId, idempotencyKey: key });
    output.write(`Deployment: ${created.deploymentId}\n`);
    if (created.status === 'failed') throw new Error('Deployment is failed. Use a new idempotency key for a fresh deployment.');
    if (created.status === 'ready') { showDeployment(created, output); return created; }
    await uploadArtifacts(client, created.uploads, artifacts, concurrency);
    const ready = checkDeployment(await client.api('POST', `/v1/deployments/${created.deploymentId}/finalize`), config, created.deploymentId);
    if (ready.status !== 'ready') throw new Error('Deployment is not ready. Run status and logs before retrying.');
    showDeployment(ready, output);
    return ready;
  } catch (error) {
    throw new Error(`${safeMessage(error.message, token)}\nTo resume unchanged output within 15 minutes: bettervercel deploy ${JSON.stringify(root)} --skip-build --idempotency-key ${key}${commitSha ? ` --commit ${commitSha}` : ''}\nAfter expiry or a build change, run deploy with a new key.`);
  }
}
