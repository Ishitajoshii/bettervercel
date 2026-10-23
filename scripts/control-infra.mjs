import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const command = process.argv[2];
if (!['synth', 'diff', 'deploy', 'destroy'].includes(command)) throw new Error('Expected synth, diff, deploy, or destroy.');
const root = fileURLToPath(new URL('../', import.meta.url));
process.chdir(root);
await import('./build-api.mjs');
const outputs = JSON.parse(await readFile('cdk-outputs.json', 'utf8')).BetterVercelStaticStack;
const result = spawnSync(process.execPath, ['node_modules/aws-cdk/bin/cdk', command, 'BetterVercelControlStack', '--output', 'cdk.out/control',
  ...(command === 'deploy' ? ['--outputs-file', 'control-outputs.json'] : []), ...process.argv.slice(3)], {
  stdio: 'inherit', env: { ...process.env, BETTERVERCEL_CONTROL_PLANE: '1',
    BETTERVERCEL_BUCKET: outputs.BucketName, BETTERVERCEL_PREVIEW_DOMAIN: outputs.DomainName,
    AWS_REGION: outputs.Region },
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
