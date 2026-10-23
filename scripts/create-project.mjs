import { readFile } from 'node:fs/promises';
import { createProject } from './operator-request.mjs';
import { run } from './lib.mjs';

run(async () => {
  const name = process.argv[2];
  if (!name) throw new Error('Usage: npm run create:project -- "My project"');
  const { BetterVercelControlStack: control } = JSON.parse(await readFile('control-outputs.json', 'utf8'));
  const { BetterVercelStaticStack: hosting } = JSON.parse(await readFile('cdk-outputs.json', 'utf8'));
  const project = await createProject(control.ApiUrl, hosting.Region, name);
  console.log(JSON.stringify(project, null, 2));
  console.error('Save deployToken securely now. Only its salted hash is stored; it cannot be retrieved later.');
});
