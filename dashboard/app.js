const $ = id => document.getElementById(id);
const projects = new Map();
let selected;
let generation = 0;
let cursor = null;
let records = [];
const notice = (message = '', error = false) => { $('notice').textContent = message; $('notice').className = error ? 'error' : ''; };
const node = (tag, text, className) => { const element = document.createElement(tag); element.textContent = text; if (className) element.className = className; return element; };
async function api(project, path, method = 'GET', body, key) {
  const response = await fetch(project.api + path, { method, headers: { authorization: `Bearer ${project.token}`,
    ...(body ? { 'content-type': 'application/json' } : {}), ...(key ? { 'idempotency-key': key } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
    cache: 'no-store', credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(30000) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `Request failed (${response.status}).`);
  return result;
}
function renderProjects() {
  $('projects').replaceChildren(); $('project-count').textContent = projects.size;
  for (const [key, project] of projects) {
    const button = node('button', project.name, key === selected ? 'active' : '');
    button.onclick = () => select(key); $('projects').append(button);
  }
}
function render() {
  const project = projects.get(selected);
  renderLocalTarget();
  $('refresh').hidden = $('disconnect').hidden = !project;
  $('project-name').textContent = project?.name ?? 'Your next launch starts here';
  $('project-id').textContent = project?.projectId ?? 'Connect a project to see its deployments.';
  $('list').replaceChildren(); $('more').hidden = !cursor;
  if (!records.length) $('list').append(node('p', project?.github ? 'Your preview will appear here after the GitHub Actions build finishes, or upload built files from your computer.' : project ? 'No deployments yet. Choose Upload from computer to publish your first preview.' : 'Import a GitHub repository or connect a project to upload from your computer.', 'empty'));
  for (const record of records) {
    const card = node('article', '', 'deployment');
    const row = node('div', '', 'row'); row.append(node('h3', record.deploymentId), node('span', record.status, `badge ${record.status}`)); card.append(row);
    card.append(node('p', [record.branch, record.pullRequest ? `PR #${record.pullRequest}` : '', record.commitSha?.slice(0, 7),
      new Date(record.createdAt).toLocaleString(), `${(record.totalBytes / 1024).toFixed(1)} KB`, `${record.fileCount} files`].filter(Boolean).join(' · '), 'meta'));
    const actions = node('div', '', 'row');
    const details = node('details', ''); details.append(node('summary', 'Deployment logs'), node('pre', (record.logs ?? []).join('\n') || 'No retained logs.')); actions.append(details);
    const controls = node('div', '', 'actions');
    if (record.status === 'ready' && record.previewUrl) {
      const url = new URL(record.previewUrl);
      if (url.protocol === 'https:' && /^[a-z0-9]+\.cloudfront\.net$/.test(url.hostname) && !url.username && !url.password) {
        const link = node('a', 'Open preview ↗'); link.href = url.href; link.target = '_blank'; link.rel = 'noopener noreferrer'; controls.append(link);
      }
    }
    if (record.status !== 'deleted') {
      const button = node('button', record.status === 'deleting' ? 'Continue deletion' : 'Delete', 'secondary');
      button.onclick = () => confirmDelete(project, record); controls.append(button);
    }
    actions.append(controls); card.append(actions); $('list').append(card);
  }
}
async function refresh(more = false) {
  const project = projects.get(selected); if (!project) return;
  const version = ++generation; $('refresh').disabled = $('more').disabled = true;
  try {
    const page = await api(project, `/v1/projects/${project.projectId}/deployments${more && cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`);
    if (version !== generation) return;
    records = more ? [...records, ...page.deployments] : page.deployments;
    records = [...new Map(records.map(record => [record.deploymentId, record])).values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    cursor = page.nextCursor; render(); notice();
  } catch (error) { if (version === generation) notice(error.message, true); }
  finally { if (version === generation) $('refresh').disabled = $('more').disabled = false; }
}
function select(key) { selected = key; records = []; cursor = null; renderProjects(); render(); if (projects.get(key)?.github) watchBuild(key); else $('build-status').hidden = true; return refresh(); }
async function confirmDelete(project, record) {
  $('delete-id').textContent = record.deploymentId;
  const dialog = $('delete-dialog'); dialog.returnValue = 'cancel'; dialog.showModal();
  dialog.addEventListener('close', async () => {
    if (dialog.returnValue !== 'delete') return;
    notice('Removing files and cached previews…');
    try {
      for (let attempt = 0; attempt < 60; attempt++) {
        if (!projects.has(`${project.api}|${project.projectId}`)) return;
        const result = await api(project, `/v1/deployments/${record.deploymentId}`, 'DELETE');
        Object.assign(record, result); render();
        if (result.status === 'deleted') { notice('Deployment deleted. Cached preview access has been removed.'); return; }
        notice('Files removed. Waiting for CloudFront cache removal; keep this tab open.');
        await new Promise(resolve => setTimeout(resolve, 10000));
      }
      notice('Cache removal is still pending. Use Continue deletion to check again.');
    } catch (error) { notice(error.message + ' You can retry deletion safely.', true); }
  }, { once: true });
}
$('connect-form').onsubmit = async event => {
  event.preventDefault(); const button = event.submitter; button.disabled = true;
  try {
    const url = new URL($('api').value.trim());
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Use an HTTPS API endpoint without credentials, query, or fragment.');
    const project = { api: url.href.replace(/\/$/, ''), projectId: $('project').value.trim(), token: $('token').value.trim() };
    if (!/^p[a-f0-9]{16}$/.test(project.projectId) || !/^bv_[A-Za-z0-9_-]{43}$/.test(project.token)) throw new Error('Check the project ID and operator-issued token.');
    const info = await api(project, `/v1/projects/${project.projectId}`);
    project.name = info.name; const key = `${project.api}|${project.projectId}`; projects.set(key, project);
    $('token').value = ''; $('connect-panel').hidden = true; await select(key);
  } catch (error) { notice(error.message, true); }
  finally { button.disabled = false; }
};
$('add-project').textContent = 'Add deployment +';
$('add-project').onclick = () => { document.querySelector('.source-switch').scrollIntoView({ behavior: 'smooth' }); $('source-local').focus(); };
$('refresh').onclick = () => refresh(); $('more').onclick = () => refresh(true);
$('disconnect').onclick = () => { generation++; buildGeneration++; $('build-status').hidden = true; projects.delete(selected); selected = undefined; records = []; cursor = null; renderProjects(); render(); notice('Project disconnected.'); if (projects.size) select(projects.keys().next().value); };
fetch('./config.json', { cache: 'no-store' }).then(response => response.ok ? response.json() : {}).then(config => {
  if (config.apiUrl) $('api').value = config.apiUrl;
  if (typeof window !== 'undefined') initializeGitHub(config);
}).catch(() => {});

let githubApi = '';
let githubToken = '';
let repositories = [];
let repoPage = null;
let branchPage = null;
let importingRepo;
let inspection;
let importKey;
let importSnapshot;
let importGeneration = 0;
let buildGeneration = 0;
const ghNotice = (message = '', error = false) => { $('github-notice').textContent = message; $('github-notice').className = error ? 'error' : ''; };
async function gh(path, method = 'GET', body) {
  if (!githubApi) throw new Error('The deployment API is not configured. Reload after the operator finishes setup.');
  const response = await fetch(githubApi + '/v1/github' + path, { method, credentials: 'omit', redirect: 'error', cache: 'no-store',
    headers: { ...(githubToken ? { authorization: `Bearer ${githubToken}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30000) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `Request failed (${response.status}).`);
  return result;
}
const base64url = bytes => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
async function initializeGitHub(config) {
  try {
    const url = new URL(config.apiUrl);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('The deployment API is not configured correctly.');
    githubApi = url.href.replace(/\/$/, '');
    const params = new URLSearchParams(window.location.search);
    if (params.has('code') || params.has('error')) {
      window.history.replaceState({}, '', window.location.pathname);
      const saved = JSON.parse(window.sessionStorage.getItem('bettervercel-oauth') ?? 'null');
      window.sessionStorage.removeItem('bettervercel-oauth');
      if (params.has('error')) throw new Error('GitHub sign-in was cancelled or denied. You can try again.');
      if (!saved || saved.state !== params.get('state')) throw new Error('Sign-in did not start in this tab. Please connect GitHub again.');
      ghNotice('Completing GitHub sign-in...');
      const auth = await gh('/exchange', 'POST', { code: params.get('code'), state: saved.state, verifier: saved.verifier });
      githubToken = auth.token;
      $('github-account').textContent = `Connected as ${auth.login}`;
      $('github-welcome').hidden = true; $('github-browser').hidden = false; $('github-logout').hidden = false;
      const existing = await gh('/projects');
      for (const project of existing.projects) projects.set(`${githubApi}|${project.projectId}`, { ...project, api: githubApi, token: githubToken, github: true });
      renderProjects();
      if (existing.projects.length) await select(`${githubApi}|${existing.projects[0].projectId}`);
      await loadRepositories(); ghNotice();
    } else {
      const status = await gh('/config');
      $('github-connect').disabled = !status.enabled;
      $('github-setup').textContent = status.message ?? 'Sign-in lasts for this tab. Refreshing the page requires reconnecting.';
    }
  } catch (error) { ghNotice(error.message, true); }
}
$('github-connect').onclick = async () => {
  $('github-connect').disabled = true;
  try {
    const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
    const challenge = base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
    const auth = await gh('/authorize', 'POST', { challenge });
    const url = new URL(auth.url);
    if (url.origin !== 'https://github.com' || url.pathname !== '/login/oauth/authorize') throw new Error('Unexpected GitHub sign-in URL.');
    window.sessionStorage.setItem('bettervercel-oauth', JSON.stringify({ state: auth.state, verifier }));
    window.location.assign(url.href);
  } catch (error) { ghNotice(error.message, true); $('github-connect').disabled = false; }
};
function renderRepositories() {
  const search = $('repo-search').value.toLowerCase();
  const filtered = repositories.filter(repo => repo.fullName.toLowerCase().includes(search));
  $('repo-list').replaceChildren();
  if (!filtered.length) $('repo-list').append(node('p', repositories.length ? 'No matches in the loaded repositories. Load more or try another search.' : 'No repositories available. Check GitHub organization access or create a repository first.', 'empty'));
  for (const repo of filtered) {
    const row = node('div', '', 'repo-row');
    const description = node('div', ''); description.append(node('strong', repo.fullName), node('p', `${repo.private ? 'Private' : 'Public'} · ${repo.defaultBranch}${repo.canImport ? '' : ' · Admin access required; archived repositories cannot be imported'}`));
    const button = node('button', 'Import', 'secondary'); button.disabled = !repo.canImport;
    button.onclick = () => chooseRepository(repo); row.append(description, button); $('repo-list').append(row);
  }
  $('repo-more').hidden = !repoPage;
}
async function loadRepositories(more = false) {
  const version = importGeneration;
  $('repo-more').disabled = true;
  try {
    ghNotice('Loading repositories...');
    const result = await gh(`/repos?page=${more ? repoPage : 1}`);
    if (version !== importGeneration) return;
    repositories = [...new Map([...(more ? repositories : []), ...result.repositories].map(repo => [repo.fullName, repo])).values()];
    repoPage = result.nextPage; renderRepositories(); ghNotice();
  } catch (error) { if (version === importGeneration) ghNotice(error.message, true); }
  finally { $('repo-more').disabled = false; }
}
$('repo-search').oninput = renderRepositories;
$('repo-more').onclick = () => loadRepositories(true);
async function chooseRepository(repo) {
  const version = ++importGeneration;
  importingRepo = repo; inspection = null; importKey = null;
  $('github-browser').hidden = true; $('import-form').hidden = false; $('import-deploy').disabled = true; $('import-consent').checked = false;
  $('import-repository').textContent = repo.fullName; $('import-branch').replaceChildren(); $('import-candidate').replaceChildren();
  $('branch-more').hidden = true; $('detection-status').textContent = 'Loading branches...';
  try {
    const result = await gh(`/branches?repository=${encodeURIComponent(repo.fullName)}`);
    if (version !== importGeneration) return;
    for (const branch of [...new Set([repo.defaultBranch, ...result.branches])]) { const option = node('option', branch); option.value = branch; $('import-branch').append(option); }
    $('import-branch').value = repo.defaultBranch; branchPage = result.nextPage; $('branch-more').hidden = !branchPage;
    await inspectBranch();
  } catch (error) { if (version === importGeneration) ghNotice(error.message, true); }
}
$('branch-more').onclick = async () => {
  const version = importGeneration; $('branch-more').disabled = true;
  try {
    const result = await gh(`/branches?repository=${encodeURIComponent(importingRepo.fullName)}&page=${branchPage}`);
    if (version !== importGeneration) return;
    const existing = new Set([...$('import-branch').options].map(option => option.value));
    for (const branch of result.branches) if (!existing.has(branch)) { const option = node('option', branch); option.value = branch; $('import-branch').append(option); }
    branchPage = result.nextPage; $('branch-more').hidden = !branchPage;
  } catch (error) { ghNotice(error.message, true); } finally { $('branch-more').disabled = false; }
};
async function inspectBranch() {
  const version = ++importGeneration; inspection = null;
  $('import-deploy').disabled = true; $('import-candidate').replaceChildren(); $('detection-status').textContent = 'Detecting app folders and build settings...'; ghNotice();
  try {
    const result = await gh(`/inspect?repository=${encodeURIComponent(importingRepo.fullName)}&branch=${encodeURIComponent($('import-branch').value)}`);
    if (version !== importGeneration) return;
    inspection = result;
    const manual = node('option', 'Choose a folder or enter settings manually'); manual.value = ''; $('import-candidate').append(manual);
    for (const candidate of result.candidates) {
      const option = node('option', `${candidate.rootDirectory} — ${candidate.framework}${candidate.rootDirectory === result.recommendedRoot ? ' (detected)' : ''}`);
      option.value = candidate.rootDirectory; $('import-candidate').append(option);
    }
    $('import-candidate').required = false;
    if (result.recommendedRoot) { $('import-candidate').value = result.recommendedRoot; applyCandidate(); }
    else {
      $('import-candidate').value = ''; $('import-root').value = ''; $('import-output').value = 'dist'; $('import-install').value = ''; $('import-build').value = '';
      $('detection-status').textContent = result.candidates.length ? `${result.candidates.length} possible apps found. Choose the folder you want to deploy.` : 'No supported app detected. Enter a root directory and build settings manually.';
    }
    $('import-deploy').disabled = false;
  } catch (error) { if (version === importGeneration) { $('detection-status').textContent = 'Inspection failed. Select the branch again to retry.'; ghNotice(error.message, true); } }
}
function applyCandidate() {
  const candidate = inspection?.candidates.find(value => value.rootDirectory === $('import-candidate').value);
  if (!candidate) return;
  for (const [field, key] of [['root', 'rootDirectory'], ['framework', 'framework'], ['install', 'installCommand'], ['build', 'buildCommand'], ['output', 'outputDirectory'], ['routing', 'routing']]) $('import-' + field).value = candidate[key];
  $('detection-status').textContent = `Detected ${candidate.framework} in ${candidate.rootDirectory}. ${candidate.warning ?? 'You can edit all settings below.'}`;
}
$('import-branch').onchange = inspectBranch;
$('import-candidate').onchange = applyCandidate;
$('import-framework').onchange = () => { if ($('import-framework').value === 'next-static') { $('import-routing').value = 'static'; $('import-output').value = 'out'; } };
$('repo-back').onclick = () => { importGeneration++; inspection = null; $('import-form').hidden = true; $('github-browser').hidden = false; ghNotice(); };
$('import-form').onsubmit = async event => {
  event.preventDefault(); if (!inspection) return;
  const version = importGeneration;
  const body = { repository: importingRepo.fullName, branch: $('import-branch').value, commitSha: inspection.commitSha,
    rootDirectory: $('import-root').value.trim(), framework: $('import-framework').value,
    installCommand: $('import-install').value.trim(), buildCommand: $('import-build').value.trim(), outputDirectory: $('import-output').value.trim(),
    routing: $('import-routing').value, confirmWorkflow: $('import-consent').checked };
  const snapshot = JSON.stringify(body);
  if (!importKey || snapshot !== importSnapshot) { importKey = crypto.randomUUID(); importSnapshot = snapshot; }
  const controls = [...$('import-form').querySelectorAll('input,select,button')]; controls.forEach(control => { control.disabled = true; });
  try {
    ghNotice('Configuring GitHub Actions and starting your deployment...');
    const result = await gh('/import', 'POST', { ...body, importId: importKey });
    if (version !== importGeneration || !githubToken) return;
    const project = { ...result, api: githubApi, token: githubToken, github: true };
    const key = `${githubApi}|${project.projectId}`; projects.set(key, project); await select(key);
    ghNotice('Deployment queued. Follow the build below; your preview appears when it is ready.');
    $('import-form').hidden = true; $('github-browser').hidden = false; importKey = null;
  } catch (error) { if (version === importGeneration) ghNotice(error.message + ' You can retry with the same settings.', true); }
  finally { controls.forEach(control => { control.disabled = false; }); }
};
async function watchBuild(key) {
  const version = ++buildGeneration;
  const project = projects.get(key);
  if (!project?.github || !githubToken) return;
  const status = $('build-status'); status.hidden = false; status.textContent = 'Checking GitHub Actions build...';
  try {
    const build = await gh(`/build?projectId=${project.projectId}`);
    if (version !== buildGeneration || selected !== key || !githubToken) return;
    status.replaceChildren(node('p', `GitHub Actions: ${build.conclusion ?? build.status}`));
    const link = node('a', 'View build logs on GitHub');
    const url = new URL(build.actionsUrl);
    if (url.origin === 'https://github.com') { link.href = url.href; link.target = '_blank'; link.rel = 'noopener noreferrer'; status.append(link); }
    await refresh();
    if (build.status !== 'completed') setTimeout(() => { if (version === buildGeneration && selected === key && githubToken) watchBuild(key); }, 10000);
    else if (build.conclusion === 'success' && !records.some(record => record.status === 'ready')) status.append(node('p', 'Build finished. Press Refresh to check the preview.'));
  } catch (error) { if (version === buildGeneration && selected === key) status.textContent = error.message + ' Select the project again to retry.'; }
}
$('github-logout').onclick = async () => {
  try { await gh('/session', 'DELETE'); } catch (error) { ghNotice(error.message, true); return; }
  importGeneration++; buildGeneration++; generation++; githubToken = ''; repositories = []; importingRepo = null; inspection = null;
  for (const [key, project] of projects) if (project.github) projects.delete(key);
  selected = undefined; records = []; cursor = null; renderProjects(); render(); $('build-status').hidden = true;
  $('github-welcome').hidden = false; $('github-connect').disabled = false; $('github-browser').hidden = $('import-form').hidden = $('github-logout').hidden = true;
  ghNotice('GitHub disconnected. Your deployed previews remain available.');
};

let localFiles = [];
let localGeneration = 0;
let localBusy = false;
let localAttempt;
const localTypes = {
  html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8', json: 'application/json', txt: 'text/plain; charset=utf-8', xml: 'application/xml',
  svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', avif: 'image/avif', ico: 'image/x-icon', woff: 'font/woff', woff2: 'font/woff2',
  ttf: 'font/ttf', wasm: 'application/wasm', pdf: 'application/pdf', map: 'application/json',
};
const localNotice = (message = '', error = false) => { $('local-notice').textContent = message; $('local-notice').className = error ? 'error' : ''; };
function renderLocalTarget() {
  const project = projects.get(selected);
  $('local-target').textContent = project ? `Deploy to: ${project.name} (${project.projectId})` : 'Connect a project with its deploy token below, then select your files.';
  $('local-deploy').disabled = localBusy || !project || !localFiles.length || !$('local-consent').checked;
}
function chooseSource(local) {
  $('local-panel').hidden = !local; $('github-panel').hidden = local;
  for (const [id, active] of [['source-local', local], ['source-github', !local]]) {
    $(id).setAttribute('aria-pressed', String(active)); $(id).className = active ? '' : 'secondary';
  }
  renderLocalTarget();
}
$('source-local').onclick = () => chooseSource(true);
$('source-github').onclick = () => chooseSource(false);
$('local-connect').onclick = () => {
  document.querySelector('.manual-connect').open = true; $('connect-panel').hidden = false;
  $('connect-panel').scrollIntoView({ behavior: 'smooth' }); $('project').focus();
};
$('local-consent').onchange = renderLocalTarget;
function clearLocalFiles() {
  localGeneration++; localFiles = []; localAttempt = null;
  $('local-folder').value = $('local-files').value = ''; $('local-consent').checked = false;
  $('local-review').hidden = true; $('local-file-list').replaceChildren();
  $('local-scan').textContent = 'Waiting for files. Checks run in your browser before upload.';
  $('local-integrity').textContent = 'A fingerprint is calculated for every file and verified by the server before publishing. Hashing is not encryption.';
  localNotice(); renderLocalTarget();
}
$('local-clear').onclick = clearLocalFiles;
function sensitivePath(path) {
  return path.split('/').some(part => /^(?:\.env(?:\..*)?|\.git|\.aws|\.ssh|\.npmrc|\.netrc|\.pypirc|id_rsa|id_ed25519|credentials(?:\..*)?|service[-_]?account(?:[.-].*)?)$/i.test(part)) || /\.(?:pem|key|p12|pfx)$/i.test(path);
}
function containsCredential(text) {
  return /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\bgh[pousr]_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b|\bbv_[A-Za-z0-9_-]{43}\b|\bgs_[A-Za-z0-9_-]{43}\b/.test(text);
}
async function inspectLocalFiles(files, folder) {
  if (localBusy) return;
  clearLocalFiles(); const version = localGeneration;
  if (!files.length) return;
  $('local-scan').textContent = 'Checking filenames and common credential patterns...';
  $('local-integrity').textContent = 'Calculating SHA-256 fingerprints locally...';
  try {
    if (files.length > 500) throw new Error('Select at most 500 files. Choose your built output folder, not the source repository.');
    const total = files.reduce((sum, file) => sum + file.size, 0);
    if (total <= 0 || total > 25 * 1024 * 1024) throw new Error('The selected site must contain 1 byte to 25 MiB.');
    const seen = new Set();
    const prepared = files.map(file => {
      const relative = folder ? file.webkitRelativePath : file.name;
      const path = folder ? relative.slice(relative.indexOf('/') + 1) : relative;
      if (sensitivePath(path)) throw new Error(`Blocked sensitive file: ${path}. Remove it from the output folder and select again.`);
      if (path.length > 240 || !/^[A-Za-z0-9_@.~\-]+(?:\/[A-Za-z0-9_@.~\-]+)*$/.test(path) ||
          path.split('/').some(part => part === '.' || part === '..') || path.split('/')[0] === '_spa' || seen.has(path)) throw new Error(`Invalid, reserved, or duplicate path: ${path}`);
      seen.add(path);
      const contentType = localTypes[path.split('.').at(-1).toLowerCase()];
      if (!contentType) throw new Error(`Unsupported file: ${path}. Select built website files, not an archive or source project.`);
      return { file, path, size: file.size, contentType };
    });
    if (!prepared.some(file => file.path === 'index.html' && file.size > 0)) throw new Error('Include a nonempty index.html at the root of the selected folder or files.');
    // Bound memory usage: read and hash one file at a time, retaining only File handles and checksums.
    for (const entry of prepared) {
      const bytes = await entry.file.arrayBuffer();
      if (version !== localGeneration) return;
      if (containsCredential(new TextDecoder().decode(bytes))) throw new Error(`Possible credential in ${entry.path}. Remove it and select your files again.`);
      entry.sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');
      if (version !== localGeneration) return;
    }
    localFiles = prepared;
    $('local-scan').textContent = 'Checks passed: no sensitive filenames or recognized credentials found.';
    $('local-integrity').textContent = `${prepared.length} SHA-256 fingerprints calculated. Server verification happens after upload.`;
    $('local-summary').textContent = `Review ${prepared.length} files · ${(total / 1024).toFixed(1)} KiB · SHA-256 fingerprints`;
    for (const entry of prepared) {
      const item = node('li', ''); item.append(node('strong', entry.path), node('span', `${entry.size} bytes`), node('code', entry.sha256));
      $('local-file-list').append(item);
    }
    $('local-review').hidden = false;
    localNotice('Files checked locally. Nothing has been uploaded yet.');
  } catch (error) {
    if (version !== localGeneration) return;
    localFiles = []; $('local-scan').textContent = 'Upload blocked. Resolve the issue below and select your files again.';
    $('local-integrity').textContent = 'Verification pending.'; localNotice(error.message, true);
  } finally { if (version === localGeneration) renderLocalTarget(); }
}
$('local-folder').onchange = event => inspectLocalFiles([...event.target.files], true);
$('local-files').onchange = event => inspectLocalFiles([...event.target.files], false);
$('local-form').onsubmit = async event => {
  event.preventDefault();
  const project = projects.get(selected); const projectKey = selected;
  if (localBusy || !project || !localFiles.length || !$('local-consent').checked) return;
  const files = localFiles;
  const body = { projectId: project.projectId, framework: 'static', routing: $('local-routing').value,
    files: files.map(({ path, size, contentType, sha256 }) => ({ path, size, contentType, sha256 })) };
  const snapshot = JSON.stringify([project.api, body]);
  if (localAttempt?.snapshot !== snapshot) localAttempt = { snapshot, key: crypto.randomUUID() };
  localBusy = true;
  const controls = [...$('local-form').querySelectorAll('input,select,button')]; controls.forEach(control => { control.disabled = true; });
  const stillConnected = () => { if (projects.get(projectKey) !== project) throw new Error('Project disconnected. Reconnect to resume uploading.'); };
  try {
    localNotice('Creating deployment and requesting signed upload URLs...');
    const deployment = await api(project, '/v1/deployments', 'POST', body, localAttempt.key);
    stillConnected();
    if (!new RegExp(`^${project.projectId}-[a-f0-9]{32}$`).test(deployment.deploymentId)) throw new Error('Invalid deployment response.');
    if (deployment.status !== 'ready') {
      if (deployment.status !== 'uploading') throw new Error(`Deployment is ${deployment.status}. Clear and reselect your files to start again.`);
      const uploads = deployment.uploads;
      const byPath = new Map(files.map(file => [file.path, file]));
      if (!Array.isArray(uploads) || uploads.length !== files.length || new Set(uploads.map(upload => upload.path)).size !== files.length || uploads.some(upload => !byPath.has(upload.path))) throw new Error('Upload instructions do not match the selected files.');
      // Validate the entire batch before transmitting file bytes. Never forward project credentials to storage.
      for (const upload of uploads) {
        const url = new URL(upload.url);
        const expected = byPath.get(upload.path);
        const checksum = btoa(String.fromCharCode(...expected.sha256.match(/../g).map(byte => parseInt(byte, 16))));
        if (upload.method !== 'PUT' || url.protocol !== 'https:' || url.username || url.password || url.hash ||
            !/^[a-z0-9.-]+\.s3\.[a-z0-9-]+\.amazonaws\.com$/.test(url.hostname) ||
            upload.headers?.['x-amz-checksum-sha256'] !== checksum || upload.headers?.['content-type'] !== expected.contentType ||
            upload.headers?.['content-length'] !== String(expected.size) || upload.headers?.['if-none-match'] !== '*' ||
            upload.headers?.['cache-control'] !== 'public, max-age=86400, immutable' ||
            Object.keys(upload.headers).some(header => !['content-type', 'content-length', 'cache-control', 'if-none-match', 'x-amz-checksum-sha256'].includes(header))) throw new Error('Invalid signed upload instructions.');
      }
      let completed = 0;
      for (const upload of uploads) {
        stillConnected();
        localNotice(`Uploading ${completed + 1} of ${files.length}: ${upload.path}`);
        // The browser supplies Content-Length from the File body; scripts cannot set this header.
        const headers = Object.fromEntries(Object.entries(upload.headers).filter(([name]) => name !== 'content-length'));
        const response = await fetch(upload.url, { method: 'PUT', headers, body: byPath.get(upload.path).file,
          credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(60000) });
        if (!response.ok && response.status !== 412) throw new Error(`Upload failed for ${upload.path} (${response.status}).`);
        completed++;
      }
      stillConnected(); localNotice('Uploads complete. The server is verifying file sizes and SHA-256 checksums...');
      const result = await api(project, `/v1/deployments/${deployment.deploymentId}/finalize`, 'POST');
      if (result.status !== 'ready') throw new Error('Server verification has not completed. Retry to check again.');
    }
    $('local-integrity').textContent = 'SHA-256 verified: the server confirmed every uploaded file matches its fingerprint.';
    localNotice(`Published to ${project.name}. SHA-256 integrity verified. Open the preview in the deployments list.`);
    $('local-consent').checked = false;
    if (selected === projectKey && projects.get(projectKey) === project) await refresh();
  } catch (error) {
    localNotice(`${error.message} Retry Upload & deploy with the same files to resume. If the upload window expired, clear and reselect your files.`, true);
  } finally {
    localBusy = false; controls.forEach(control => { control.disabled = false; }); renderLocalTarget();
  }
};
