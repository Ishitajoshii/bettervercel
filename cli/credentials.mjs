import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { readJson } from './project.mjs';

const credentialKey = config => `${config.apiUrl}|${config.projectId}`;
export const credentialPath = env => env.BETTERVERCEL_CREDENTIALS_FILE ?? join(homedir(), '.bettervercel', 'credentials.json');
export function validateToken(token) {
  if (typeof token !== 'string' || !/^bv_[A-Za-z0-9_-]{43}$/.test(token)) {
    throw new Error('Expected a project deploy token. Set BETTERVERCEL_TOKEN or use login --token-stdin.');
  }
  return token;
}
export async function getToken(config, env) {
  if (env.BETTERVERCEL_TOKEN) return validateToken(env.BETTERVERCEL_TOKEN);
  const saved = await readJson(credentialPath(env), true);
  return validateToken(saved?.[credentialKey(config)]);
}
export async function saveToken(config, token, env) {
  const path = credentialPath(env);
  const saved = await readJson(path, true) ?? {};
  saved[credentialKey(config)] = validateToken(token);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(saved, null, 2) + '\n', { mode: 0o600 });
  await chmod(path, 0o600);
}

export async function readToken(input) {
  if (input.isTTY) throw new Error('Pipe the token to login --token-stdin, or set BETTERVERCEL_TOKEN. Tokens are not accepted as command arguments.');
  let value = '';
  for await (const chunk of input) {
    value += chunk;
    if (value.length > 256) throw new Error('Token input is too long.');
  }
  return validateToken(value.trim());
}
