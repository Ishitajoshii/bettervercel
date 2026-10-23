import { GetCommand, PutCommand, DeleteCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import sodium from 'libsodium-wrappers';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createGitHub } from './github.mjs';
import { HttpError } from './domain.mjs';

export function parseGitHubClientSecret(value) {
  const invalid = () => new HttpError(503, 'GitHub OAuth secret must contain a nonempty plaintext value or a client_secret key/value pair.');
  if (typeof value !== 'string' || !value.trim()) throw invalid();
  let secret = value.trim();
  if (/^[{\["]/.test(secret)) {
    let parsed;
    try { parsed = JSON.parse(secret); } catch { throw invalid(); }
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw invalid();
    secret = parsed.client_secret;
  }
  if (typeof secret !== 'string' || !secret.trim() || /\s/.test(secret.trim())) throw invalid();
  return secret.trim();
}

export function createGitHubData(client, TableName) {
  const conditional = async command => {
    try { await client.send(command); return true; }
    catch (error) { if (error.name === 'ConditionalCheckFailedException') return false; throw error; }
  };
  return {
    get: async (pk, sk) => (await client.send(new GetCommand({ TableName, Key: { pk, sk }, ConsistentRead: true }))).Item,
    put: Item => client.send(new PutCommand({ TableName, Item })),
    create: Item => conditional(new PutCommand({ TableName, Item, ConditionExpression: 'attribute_not_exists(pk)' })),
    consume: (pk, sk) => conditional(new DeleteCommand({ TableName, Key: { pk, sk }, ConditionExpression: 'attribute_exists(pk)' })),
    claim: (pk, sk, now) => conditional(new UpdateCommand({ TableName, Key: { pk, sk },
      UpdateExpression: 'SET leaseUntil = :until', ConditionExpression: 'attribute_exists(pk) AND (attribute_not_exists(leaseUntil) OR leaseUntil < :now)',
      ExpressionAttributeValues: { ':until': now + 60000, ':now': now } })),
    async list(pk, prefix) {
      const items = []; let ExclusiveStartKey;
      do {
        const page = await client.send(new QueryCommand({ TableName, KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
          ExpressionAttributeValues: { ':pk': pk, ':prefix': prefix }, ConsistentRead: true, ExclusiveStartKey }));
        items.push(...(page.Items ?? []).map(({ pk: partition, sk: key, ...item }) => item));
        ExclusiveStartKey = page.LastEvaluatedKey;
      } while (ExclusiveStartKey);
      return items;
    },
  };
}

export function githubFromEnvironment(client, store) {
  const secretClient = new SecretsManagerClient({});
  let secret;
  return createGitHub({ data: createGitHubData(client, process.env.GITHUB_TABLE), store,
    config: { clientId: process.env.GITHUB_CLIENT_ID, secretArn: process.env.GITHUB_SECRET_ARN,
      allowedUsers: (process.env.GITHUB_ALLOWED_USERS ?? '').toLowerCase().split(',').map(value => value.trim()).filter(Boolean),
      redirectUri: `https://${process.env.PREVIEW_DOMAIN}/dashboard/`, apiUrl: process.env.API_URL },
    getSecret: async () => secret ??= parseGitHubClientSecret((await secretClient.send(new GetSecretValueCommand({ SecretId: process.env.GITHUB_SECRET_ARN }))).SecretString),
    seal: async (value, publicKey) => {
      await sodium.ready;
      return sodium.to_base64(sodium.crypto_box_seal(sodium.from_string(value), sodium.from_base64(publicKey, sodium.base64_variants.ORIGINAL)), sodium.base64_variants.ORIGINAL);
    },
    runner: readFileSync(join(process.env.LAMBDA_TASK_ROOT ?? '.build/control-api', 'github-runner.cjs'), 'utf8'),
  });
}
