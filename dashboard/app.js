const $ = id => document.getElementById(id);
const projects = new Map();
let selected;
let generation = 0;
let cursor = null;
let records = [];
const notice = (message = '', error = false) => { $('notice').textContent = message; $('notice').className = error ? 'error' : ''; };
const node = (tag, text, className) => { const element = document.createElement(tag); element.textContent = text; if (className) element.className = className; return element; };
async function api(project, path, method = 'GET') {
  const response = await fetch(project.api + path, { method, headers: { authorization: `Bearer ${project.token}` },
    cache: 'no-store', credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(30000) });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status}).`);
  return body;
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
  $('refresh').hidden = $('disconnect').hidden = !project;
  $('project-name').textContent = project?.name ?? 'Your next launch starts here';
  $('project-id').textContent = project?.projectId ?? 'Connect a project to see its deployments.';
  $('list').replaceChildren(); $('more').hidden = !cursor;
  if (!records.length) $('list').append(node('p', project ? 'No deployments yet. Run bettervercel deploy to publish your first preview.' : 'Connect a project to see its deployments.', 'empty'));
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
function select(key) { selected = key; records = []; cursor = null; renderProjects(); render(); return refresh(); }
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
$('add-project').onclick = () => { $('connect-panel').hidden = false; $('project').focus(); };
$('refresh').onclick = () => refresh(); $('more').onclick = () => refresh(true);
$('disconnect').onclick = () => { generation++; projects.delete(selected); selected = undefined; records = []; cursor = null; renderProjects(); render(); notice('Project disconnected.'); if (projects.size) select(projects.keys().next().value); };
fetch('./config.json', { cache: 'no-store' }).then(response => response.ok ? response.json() : {}).then(config => { if (config.apiUrl) $('api').value = config.apiUrl; }).catch(() => {});
