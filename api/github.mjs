import { randomBytes, createHash } from 'node:crypto';
import { digest, HttpError, issueToken, requireValue } from './domain.mjs';
import { inspectRepository, validateImport } from './repository.mjs';
import { createWorkflow } from './workflow.mjs';

const random = () => randomBytes(32).toString('base64url');
const challengeFor = value => createHash('sha256').update(value).digest('base64url');
export function createGitHubClient(token, fetchImpl = fetch) {
  return async (path, method = 'GET', body, optional = false) => {
    requireValue(path.startsWith('/') && !path.startsWith('//'), 'Invalid GitHub request.');
    const response = await fetchImpl(`https://api.github.com${path}`, { method, redirect: 'error', signal: AbortSignal.timeout(12000),
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'content-type': 'application/json',
        'x-github-api-version': '2022-11-28', 'user-agent': 'BetterVercel' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (optional && response.status === 404) return null;
    if (!response.ok) {
      const message = response.status === 401 ? 'GitHub authorization expired. Connect GitHub again.' :
        response.status === 403 || response.status === 429 ? 'GitHub denied access or rate-limited this request. Check repository permissions, organization approval, and Actions availability; then retry.' :
        response.status === 404 ? 'Repository or branch not found, or access has not been granted.' :
        response.status === 409 || response.status === 422 ? 'GitHub could not update this branch. Check branch protection and retry after refreshing.' : 'GitHub is temporarily unavailable. Please retry.';
      throw new HttpError(response.status === 401 ? 401 : 502, message);
    }
    return response.status === 204 ? {} : response.json();
  };
}

export function createGitHub({ data, store, config, getSecret, seal, runner, fetchImpl = fetch, now = () => Date.now() }) {
  const enabled = Boolean(config.clientId && config.secretArn && config.allowedUsers?.length);
  const expires = seconds => Math.floor(now() / 1000) + seconds;
  const client = session => createGitHubClient(session.accessToken, fetchImpl);
  async function session(event) {
    const token = (event.headers?.authorization ?? '').replace(/^Bearer /, '');
    requireValue(/^gs_[A-Za-z0-9_-]{43}$/.test(token), 'Connect GitHub to continue.', 401);
    const saved = await data.get(`SESSION#${digest(token)}`, 'META');
    requireValue(saved && saved.expiresAt > Math.floor(now() / 1000), 'Your session expired. Connect GitHub again.', 401);
    requireValue(config.allowedUsers.includes(saved.login.toLowerCase()), 'This GitHub account is not enabled for this private alpha.', 403);
    return saved;
  }
  async function authenticate(project, event) {
    const user = await session(event);
    requireValue(project?.githubUserId === user.userId, 'This project belongs to another account.', 403);
    return project;
  }
  function publicJob(job) {
    return { projectId: job.projectId, name: job.name, repository: job.settings.repository, status: job.status,
      workflow: job.workflow, actionsUrl: `https://github.com/${job.settings.repository}/actions/workflows/${job.workflow}` };
  }
  async function importRepo(user, body) {
    const settings = validateImport(body);
    requireValue(typeof body.importId === 'string' && /^[a-zA-Z0-9_-]{16,80}$/.test(body.importId), 'Invalid import ID.');
    const github = client(user);
    const repo = await github(`/repos/${settings.repository}`);
    requireValue(repo.permissions?.admin && !repo.archived && !repo.disabled, 'Repository admin access is required to configure its Actions secret.', 403);
    const pk = `USER#${user.userId}`;
    const sk = `IMPORT#${body.importId}`;
    let job = await data.get(pk, sk);
    if (job) {
      requireValue(job.requestHash === digest(JSON.stringify(settings)), 'These import settings changed. Start a new import.', 409);
      if (job.status === 'queued') return publicJob(job);
    } else {
      const current = await github(`/repos/${settings.repository}/commits/${encodeURIComponent(settings.branch)}`);
      requireValue(current.sha === settings.commitSha, 'The branch changed since inspection. Select the branch again before deploying.', 409);
      const projectId = `p${digest(`${user.userId}:${body.importId}`).slice(0, 16)}`;
      requireValue(!await store.getProject(projectId), 'This import has expired. Choose the repository again to start a new import.', 409);
      const { token, ...credentials } = await issueToken();
      job = { pk, sk, projectId, name: `${repo.name}${settings.rootDirectory === '.' ? '' : ` / ${settings.rootDirectory}`}`.slice(0, 100),
        workflow: `bettervercel-${projectId}.yml`, settings, deployToken: token, credentials,
        requestHash: digest(JSON.stringify(settings)), status: 'preparing', expiresAt: expires(86400) };
      if (!await data.create(job)) {
        job = await data.get(pk, sk);
        requireValue(job?.requestHash === digest(JSON.stringify(settings)), 'Import already exists with different settings.', 409);
      }
    }
    // Conditional lease prevents overlapping retries from creating duplicate commits/builds.
    requireValue(await data.claim(pk, sk, now()), 'This import is being configured. Wait a moment and retry.', 409);
    try {
      let project = await store.getProject(job.projectId);
      if (!project) {
        project = { projectId: job.projectId, name: job.name, createdAt: new Date(now()).toISOString(),
          githubUserId: user.userId, repository: settings.repository, ...job.credentials };
        await store.createProject(project);
      }
      await data.put({ pk, sk: `PROJECT#${job.projectId}`, projectId: job.projectId, name: job.name,
        repository: settings.repository, workflow: job.workflow });
      const secretName = `BETTERVERCEL_${job.projectId.toUpperCase()}_TOKEN`;
      const key = await github(`/repos/${settings.repository}/actions/secrets/public-key`);
      await github(`/repos/${settings.repository}/actions/secrets/${secretName}`, 'PUT', {
        key_id: key.key_id, encrypted_value: await seal(job.deployToken, key.key) });
      const workflow = createWorkflow({ ...settings, apiUrl: config.apiUrl, projectId: job.projectId, secretName });
      const path = `.github/workflows/${job.workflow}`;
      const existing = await github(`/repos/${settings.repository}/contents/${path}?ref=${encodeURIComponent(repo.default_branch)}`, 'GET', undefined, true);
      if (existing) {
        requireValue(Buffer.from(existing.content ?? '', 'base64').toString('utf8') === workflow,
          'A different workflow already occupies this import path. Start a new import.', 409);
      } else {
        const base = `/repos/${settings.repository}/git`;
        const head = await github(`${base}/ref/heads/${encodeURIComponent(repo.default_branch)}`);
        const commit = await github(`${base}/commits/${head.object.sha}`);
        const tree = await github(`${base}/trees`, 'POST', { base_tree: commit.tree.sha, tree: [
          { path, mode: '100644', type: 'blob', content: workflow },
          { path: `.github/bettervercel/${job.projectId}.cjs`, mode: '100644', type: 'blob', content: runner },
        ] });
        const created = await github(`${base}/commits`, 'POST', { message: `Configure Better Vercel deployment (${job.projectId})`, tree: tree.sha, parents: [head.object.sha] });
        // Never overwrite concurrent work or bypass protected branches.
        await github(`${base}/refs/heads/${encodeURIComponent(repo.default_branch)}`, 'PATCH', { sha: created.sha, force: false });
      }
      job.status = 'queued';
      await data.put({ ...job, leaseUntil: 0 });
      return publicJob(job);
    } catch (error) {
      await data.put({ ...job, leaseUntil: 0 });
      throw error;
    }
  }
  async function execute(event, body) {
    const path = event.rawPath ?? '';
    const method = event.requestContext?.http?.method ?? event.routeKey.split(' ')[0];
    if (path === '/v1/github/config' && method === 'GET') return [200, { enabled,
      message: enabled ? null : 'GitHub sign-in needs one-time operator setup. See docs/github-import.md.' }];
    requireValue(enabled, 'GitHub sign-in is not configured yet. Complete the one-time setup in docs/github-import.md.', 503);
    if (path === '/v1/github/authorize' && method === 'POST') {
      requireValue(typeof body.challenge === 'string' && /^[A-Za-z0-9_-]{43}$/.test(body.challenge), 'Invalid sign-in challenge.');
      const state = random();
      await data.put({ pk: `STATE#${digest(state)}`, sk: 'META', challenge: body.challenge, expiresAt: expires(600) });
      const query = new URLSearchParams({ client_id: config.clientId, redirect_uri: config.redirectUri, scope: 'repo workflow',
        state, code_challenge: body.challenge, code_challenge_method: 'S256' });
      return [200, { url: `https://github.com/login/oauth/authorize?${query}`, state }];
    }
    if (path === '/v1/github/exchange' && method === 'POST') {
      requireValue(/^[A-Za-z0-9_-]{43}$/.test(body.state ?? '') && /^[A-Za-z0-9_-]{43,128}$/.test(body.verifier ?? '') &&
        typeof body.code === 'string' && body.code.length <= 200, 'Invalid sign-in response.');
      const stateKey = `STATE#${digest(body.state)}`;
      const state = await data.get(stateKey, 'META');
      requireValue(state && state.expiresAt > Math.floor(now() / 1000) && state.challenge === challengeFor(body.verifier), 'Sign-in expired or did not start in this tab. Try again.', 401);
      requireValue(await data.consume(stateKey, 'META'), 'Sign-in was already used. Try again.', 401);
      const response = await fetchImpl('https://github.com/login/oauth/access_token', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(12000),
        headers: { accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify({
          client_id: config.clientId, client_secret: await getSecret(), code: body.code, code_verifier: body.verifier, redirect_uri: config.redirectUri }) });
      const auth = await response.json();
      requireValue(response.ok && auth.access_token, 'GitHub sign-in could not be completed. Try again.', 401);
      const scopes = new Set((auth.scope ?? '').split(/[ ,]+/));
      requireValue(scopes.has('repo') && scopes.has('workflow'), 'Authorize repository and workflow access to deploy from GitHub.', 403);
      const profile = await createGitHubClient(auth.access_token, fetchImpl)('/user');
      requireValue(config.allowedUsers.includes(profile.login.toLowerCase()), 'This GitHub account is not enabled for this private alpha.', 403);
      const token = `gs_${random()}`;
      await data.put({ pk: `SESSION#${digest(token)}`, sk: 'META', accessToken: auth.access_token, userId: String(profile.id),
        login: profile.login, expiresAt: expires(Math.min(auth.expires_in ?? 28800, 28800)) });
      return [200, { token, login: profile.login }];
    }
    const user = await session(event);
    if (path === '/v1/github/session' && method === 'DELETE') {
      await data.consume(user.pk, user.sk); return [200, { disconnected: true }];
    }
    const github = client(user);
    const query = event.queryStringParameters ?? {};
    if (path === '/v1/github/repos' && method === 'GET') {
      const page = Number(query.page ?? 1);
      requireValue(Number.isInteger(page) && page > 0 && page <= 100, 'Invalid page.');
      const repos = await github(`/user/repos?per_page=50&page=${page}&sort=updated&affiliation=owner,collaborator,organization_member`);
      return [200, { repositories: repos.map(repo => ({ fullName: repo.full_name, name: repo.name, private: repo.private,
        defaultBranch: repo.default_branch, canImport: Boolean(repo.permissions?.admin && !repo.archived && !repo.disabled) })), nextPage: repos.length === 50 ? page + 1 : null }];
    }
    if (['/v1/github/branches', '/v1/github/inspect'].includes(path) && method === 'GET') {
      requireValue(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(query.repository ?? ''), 'Invalid repository.');
      if (path.endsWith('/branches')) {
        const page = Number(query.page ?? 1);
        requireValue(Number.isInteger(page) && page > 0 && page <= 100, 'Invalid page.');
        const branches = await github(`/repos/${query.repository}/branches?per_page=100&page=${page}`);
        return [200, { branches: branches.map(branch => branch.name), nextPage: branches.length === 100 ? page + 1 : null }];
      }
      requireValue(typeof query.branch === 'string' && query.branch.length <= 255, 'Choose a branch.');
      return [200, await inspectRepository(github, query.repository, query.branch)];
    }
    if (path === '/v1/github/projects' && method === 'GET') return [200, { projects: await data.list(`USER#${user.userId}`, 'PROJECT#') }];
    if (path === '/v1/github/import' && method === 'POST') return [201, await importRepo(user, body)];
    if (path === '/v1/github/build' && method === 'GET') {
      const project = await store.getProject(query.projectId);
      await authenticate(project, event);
      const link = await data.get(`USER#${user.userId}`, `PROJECT#${project.projectId}`);
      const runs = await github(`/repos/${project.repository}/actions/workflows/${link.workflow}/runs?per_page=1`, 'GET', undefined, true);
      const run = runs?.workflow_runs?.[0];
      return [200, { status: run?.status ?? 'queued', conclusion: run?.conclusion ?? null,
        actionsUrl: `https://github.com/${project.repository}/actions/workflows/${link.workflow}` }];
    }
    throw new HttpError(404, 'GitHub route not found.');
  }
  return { execute, authenticate };
}
