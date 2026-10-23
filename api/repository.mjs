import { requireValue } from './domain.mjs';

export function relativeDirectory(value, label = 'Root directory') {
  requireValue(typeof value === 'string' && value.length <= 200 &&
    (value === '.' || /^[A-Za-z0-9_@.-]+(?:\/[A-Za-z0-9_@.-]+)*$/.test(value)) &&
    !value.split('/').some(part => part === '..' || (part === '.' && value !== '.')), `${label} must be a folder inside the repository.`);
  return value;
}

export function detectProject(root, pkg, files) {
  const deps = { ...pkg?.dependencies, ...pkg?.devDependencies };
  const framework = deps.next ? 'next-static' : deps.astro ? 'astro' : deps.vite ? 'vite' : 'static';
  const local = name => files.has(root === '.' ? name : `${root}/${name}`);
  const folders = root === '.' ? ['.'] : [root, ...root.split('/').slice(0, -1).map((_, index, parts) => parts.slice(0, parts.length - index).join('/')), '.'];
  const installRoot = folders.find(folder => ['pnpm-lock.yaml', 'yarn.lock', 'package-lock.json'].some(name => files.has(folder === '.' ? name : `${folder}/${name}`))) ?? root;
  const lock = name => files.has(installRoot === '.' ? name : `${installRoot}/${name}`);
  const packageManager = lock('pnpm-lock.yaml') ? 'pnpm' : lock('yarn.lock') ? 'yarn' : 'npm';
  const levels = (root === '.' ? 0 : root.split('/').length) - (installRoot === '.' ? 0 : installRoot.split('/').length);
  const installPrefix = levels ? ` --prefix ${Array(levels).fill('..').join('/')}` : '';
  const installDir = levels ? ` --dir ${Array(levels).fill('..').join('/')}` : '';
  const hasBuild = typeof pkg?.scripts?.build === 'string';
  const buildCommand = hasBuild ? `${packageManager === 'npm' ? 'npm' : `corepack ${packageManager}`} run build` : framework === 'vite' ? 'npx --no-install vite build' :
    framework === 'astro' ? 'npx --no-install astro build' : framework === 'next-static' ? 'npx --no-install next build' : '';
  return { rootDirectory: root, name: typeof pkg?.name === 'string' ? pkg.name.slice(0, 100) : root === '.' ? 'Repository root' : root,
    framework, packageManager, buildCommand,
    installCommand: pkg ? packageManager === 'pnpm' ? `corepack pnpm${installDir} install --frozen-lockfile` : packageManager === 'yarn' ? `corepack yarn${levels ? ` --cwd ${Array(levels).fill('..').join('/')}` : ''} install --frozen-lockfile` : `npm${installPrefix} ${lock('package-lock.json') ? 'ci' : 'install'}` : '',
    outputDirectory: framework === 'next-static' ? 'out' : framework !== 'static' ? 'dist' : deps['react-scripts'] ? 'build' : hasBuild ? 'dist' : '.',
    routing: framework === 'vite' || deps['react-scripts'] ? 'spa' : 'static',
    warning: framework === 'next-static' ? 'Next.js must use output: "export". Server routes and SSR are not supported.' :
      hasBuild && framework === 'static' ? 'Check the output folder for this build tool.' : null };
}

export async function inspectRepository(github, repository, ref) {
  const base = `/repos/${repository}`;
  const commit = await github(`${base}/commits/${encodeURIComponent(ref)}`);
  const result = await github(`${base}/git/trees/${commit.commit.tree.sha}?recursive=1`);
  requireValue(!result.truncated, 'This repository is too large to inspect completely. Import a smaller repository.', 422);
  const entries = result.tree.filter(entry => entry.type === 'blob' && entry.mode !== '120000' &&
    !entry.path.split('/').some(part => ['node_modules', '.git', '.next', '.github', 'vendor'].includes(part)));
  const files = new Set(entries.map(entry => entry.path));
  const manifests = entries.filter(entry => entry.path === 'package.json' || entry.path.endsWith('/package.json'));
  requireValue(manifests.length <= 40, 'More than 40 packages found. Import a smaller repository.', 422);
  const candidates = [];
  // Bounded concurrency keeps GitHub secondary rate limits and Lambda duration predictable.
  for (let index = 0; index < manifests.length; index += 8) {
    await Promise.all(manifests.slice(index, index + 8).map(async entry => {
      requireValue(entry.size <= 100_000, 'A package.json is too large to inspect.', 422);
      const blob = await github(`${base}/git/blobs/${entry.sha}`);
      let pkg;
      try { pkg = JSON.parse(Buffer.from(blob.content, 'base64').toString('utf8')); }
      catch { return; }
      const root = entry.path === 'package.json' ? '.' : entry.path.slice(0, -13);
      const detected = detectProject(root, pkg, files);
      const at = name => root === '.' ? name : `${root}/${name}`;
      const workspace = pkg.workspaces || files.has(at('pnpm-workspace.yaml'));
      const hasAppEntry = files.has(at('index.html')) || files.has(at('public/index.html')) ||
        [...files].some(path => ['app/', 'pages/', 'src/app/', 'src/pages/'].some(folder => path.startsWith(at(folder))));
      // A workspace-level build script often orchestrates child packages; it is not itself a website.
      if (workspace && !hasAppEntry) return;
      if (detected.buildCommand || files.has(root === '.' ? 'index.html' : `${root}/index.html`)) candidates.push(detected);
    }));
  }
  for (const entry of entries.filter(entry => /(^|\/)index\.html$/.test(entry.path))) {
    const root = entry.path === 'index.html' ? '.' : entry.path.slice(0, -11);
    if (!candidates.some(candidate => candidate.rootDirectory === root ||
      (candidate.rootDirectory === '.' ? /^(dist|build|out|public)\//.test(entry.path) : entry.path.startsWith(candidate.rootDirectory + '/')))) {
      candidates.push(detectProject(root, null, files));
    }
  }
  candidates.sort((a, b) => (a.rootDirectory === '.' ? -1 : b.rootDirectory === '.' ? 1 : a.rootDirectory.localeCompare(b.rootDirectory)));
  return { commitSha: commit.sha, candidates: candidates.slice(0, 50),
    recommendedRoot: candidates.length === 1 ? candidates[0].rootDirectory : candidates.find(candidate => candidate.rootDirectory === '.')?.rootDirectory ?? null };
}

export function validateImport(input) {
  requireValue(typeof input.repository === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.repository), 'Choose a GitHub repository.');
  requireValue(typeof input.branch === 'string' && input.branch.length > 0 && input.branch.length <= 255 && !/[\x00-\x1f\x7f]/.test(input.branch), 'Choose a branch.');
  relativeDirectory(input.rootDirectory);
  relativeDirectory(input.outputDirectory, 'Output directory');
  requireValue(['vite', 'astro', 'next-static', 'static'].includes(input.framework), 'Choose a supported framework.');
  requireValue(['spa', 'static'].includes(input.routing) && !(input.framework === 'next-static' && input.routing === 'spa'), 'Choose valid routing for this framework.');
  for (const field of ['installCommand', 'buildCommand']) requireValue(typeof input[field] === 'string' && input[field].length <= 1000 && !/[\x00\r\n]/.test(input[field]), `Invalid ${field}.`);
  requireValue(/^[a-f0-9]{40}$/.test(input.commitSha), 'Inspect the selected branch before deploying.');
  requireValue(input.confirmWorkflow === true, 'Confirm GitHub Actions setup before deploying.');
  return Object.fromEntries(['repository', 'branch', 'rootDirectory', 'outputDirectory', 'framework', 'routing', 'installCommand', 'buildCommand', 'commitSha'].map(key => [key, input[key]]));
}
