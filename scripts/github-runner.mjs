import { cp, lstat, mkdir, readdir, rename, writeFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { runCli } from '../cli/main.mjs';
import { runBuild } from '../cli/project.mjs';
import { deploymentIdFor, previewBasePath } from '../api/domain.mjs';
import { relativeDirectory } from '../api/repository.mjs';

async function main() {
  const settings = JSON.parse(Buffer.from(process.env.BETTERVERCEL_IMPORT, 'base64').toString('utf8'));
  relativeDirectory(settings.rootDirectory); relativeDirectory(settings.outputDirectory);
  const source = resolve('source');
  const root = resolve(source, settings.rootDirectory);
  let current = source;
  for (const part of settings.rootDirectory === '.' ? [] : settings.rootDirectory.split('/')) {
    current = resolve(current, part);
    if ((await lstat(current)).isSymbolicLink()) throw new Error('Root directory cannot be a symlink.');
  }
  const key = `gha-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`;
  const deploymentId = deploymentIdFor(settings.projectId, key);
  const basePath = previewBasePath(deploymentId, settings.routing);
  const config = { apiUrl: settings.apiUrl, projectId: settings.projectId, framework: settings.framework,
    routing: settings.routing, outputDirectory: '.bettervercel-output', buildCommand: null };
  if (process.argv[2] === 'build') {
    const env = { ...process.env, BETTERVERCEL_BASE_PATH: basePath, BETTERVERCEL_DEPLOYMENT_ID: deploymentId, CI: 'true' };
    if (settings.installCommand) await runBuild(root, { buildCommand: settings.installCommand }, { env });
    let command = settings.buildCommand;
    if (command && ['vite', 'astro'].includes(settings.framework)) {
      // Standard framework scripts accept base through their CLI; custom scripts can use the env var.
      const separator = /^(?:npm|pnpm|yarn|corepack pnpm|corepack yarn) run build$/.test(command) ? (/^npm /.test(command) ? ' --' : '') : '';
      if (/^(?:(?:npm|pnpm|yarn|corepack pnpm|corepack yarn) run build|npx --no-install (?:vite|astro) build)$/.test(command)) command += `${separator} --base "${basePath}/"`;
    }
    if (command && settings.framework === 'next-static') {
      const names = await readdir(root);
      const existing = ['next.config.mjs', 'next.config.js', 'next.config.cjs', 'next.config.ts'].find(name => names.includes(name));
      if (existing === 'next.config.ts') throw new Error('Use next.config.mjs for automatic static-export configuration, or deploy with the CLI.');
      const original = existing ? `bettervercel-original-${existing}` : null;
      if (existing) await rename(resolve(root, existing), resolve(root, original));
      await writeFile(resolve(root, 'next.config.mjs'), `${original ? `import original from './${original}';` : 'const original = {};'}\nexport default async (...args) => { const config = typeof original === 'function' ? await original(...args) : await original; return { ...config, output: 'export', basePath: ${JSON.stringify(basePath)}, assetPrefix: ${JSON.stringify(basePath)}, trailingSlash: true, images: { ...config?.images, unoptimized: true } }; };\n`);
    }
    if (command) await runBuild(root, { buildCommand: command }, { env });
    const output = resolve(root, settings.outputDirectory);
    current = root;
    for (const part of settings.outputDirectory === '.' ? [] : settings.outputDirectory.split('/')) {
      current = resolve(current, part);
      if ((await lstat(current)).isSymbolicLink()) throw new Error('Output directory cannot be a symlink.');
    }
    // Use a fresh staging directory outside the source, including for plain HTML at repository root.
    const stage = resolve('.bettervercel-stage');
    await mkdir(resolve(stage, config.outputDirectory), { recursive: true });
    const excluded = new Set(['.git', '.github', 'node_modules', 'bettervercel.json', 'package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock']);
    await cp(output, resolve(stage, config.outputDirectory), { recursive: true, dereference: false,
      filter: path => !relative(output, path).split(/[\\/]/).some(part => part.startsWith('.') || excluded.has(part)) });
    await writeFile(resolve(stage, 'bettervercel.json'), JSON.stringify(config));
    console.log('Build complete. Publishing next.');
  } else if (process.argv[2] === 'deploy') {
    await runCli(['deploy', resolve('.bettervercel-stage'), '--skip-build', '--idempotency-key', key, '--commit', settings.commitSha, '--branch', settings.branch]);
  } else throw new Error('Expected build or deploy.');
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
