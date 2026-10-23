import test from 'node:test';
import assert from 'node:assert/strict';
import { S3Client } from '@aws-sdk/client-s3';
import { createDelivery, createObjects, createStore } from '../api/aws.mjs';
import { CACHE_CONTROL, digest, prefix } from '../api/domain.mjs';

const file = { path: 'index.html', size: 5, contentType: 'text/html; charset=utf-8', sha256: digest('hello') };
const record = { projectId: 'p1111111111111111', deploymentId: `p1111111111111111-${'a'.repeat(32)}`, files: [file] };
const checksum = Buffer.from(file.sha256, 'hex').toString('base64');
const metadata = { ContentLength: 5, ContentType: file.contentType, CacheControl: CACHE_CONTROL, ChecksumSHA256: checksum };

test('deletion uses exact manifest keys, surfaces partial failures, and invalidates both viewer and storage paths idempotently', async () => {
  let input;
  let fail = false;
  const objects = createObjects({ async send(command) { input = command.input; return fail ? { Errors: [{ Code: 'AccessDenied' }] } : {}; } }, 'bucket');
  await objects.remove(record);
  assert.deepEqual(input.Delete.Objects, [{ Key: prefix(record) + 'index.html' }]);
  fail = true; await assert.rejects(objects.remove(record), /could not be deleted/);
  let complete = false;
  const delivery = createDelivery({ async send(command) { input = command.input; return { Invalidation: { Status: complete ? 'Completed' : 'InProgress' } }; } }, 'E123');
  assert.equal(await delivery.remove(record), false);
  assert.equal(input.DistributionId, 'E123');
  assert.deepEqual(input.InvalidationBatch.Paths.Items, [`/d/${record.deploymentId}*`, `/${prefix(record)}*`]);
  const reference = input.InvalidationBatch.CallerReference;
  complete = true; assert.equal(await delivery.remove(record), true);
  assert.equal(input.InvalidationBatch.CallerReference, reference);
});

test('real S3 presigner binds key, size, MIME, cache policy, checksum, and create-only header', async () => {
  const client = new S3Client({ region: 'ap-south-1', credentials: { accessKeyId: 'TESTKEY', secretAccessKey: 'test-secret' } });
  const signed = await createObjects(client, 'test-artifacts').sign(prefix(record) + file.path, file, 300);
  const url = new URL(signed.url);
  assert.equal(url.pathname, '/' + prefix(record) + file.path);
  assert.equal(url.searchParams.get('X-Amz-Expires'), '300');
  const headers = url.searchParams.get('X-Amz-SignedHeaders').split(';');
  for (const name of ['content-length', 'content-type', 'cache-control', 'if-none-match', 'x-amz-checksum-sha256']) {
    assert.ok(headers.includes(name), name);
  }
  assert.equal(signed.headers['if-none-match'], '*');
  assert.equal(signed.headers['x-amz-checksum-sha256'], checksum);
  client.destroy();
});

test('SPA validation, deletion and invalidation target its separate project namespace', async () => {
  const spa = { ...record, routing: 'spa' };
  const root = `deployments/${record.projectId}/_spa/${record.deploymentId}/`;
  const commands = [];
  const objects = createObjects({ async send(command) {
    commands.push(command);
    if (command.constructor.name === 'ListObjectsV2Command') {
      assert.equal(command.input.Prefix, root);
      return { Contents: [{ Key: root + file.path, Size: file.size }] };
    }
    if (command.constructor.name === 'HeadObjectCommand') {
      assert.equal(command.input.Key, root + file.path); return metadata;
    }
    return {};
  } }, 'bucket');
  assert.deepEqual(await objects.validate(spa), { complete: true, valid: true });
  await objects.remove(spa);
  assert.deepEqual(commands.at(-1).input.Delete.Objects, [{ Key: root + file.path }]);
  const delivery = createDelivery({ async send(command) {
    assert.deepEqual(command.input.InvalidationBatch.Paths.Items, [`/d/${record.deploymentId}*`, `/${root}*`]);
    return { Invalidation: { Status: 'Completed' } };
  } }, 'E123');
  assert.equal(await delivery.remove(spa), true);
});

test('S3 validation checks stored bytes, metadata, checksum, missing and unexpected keys', async () => {
  for (const [label, listing, head, expected] of [
    ['valid', [{ Key: prefix(record) + file.path, Size: 5 }], metadata, { complete: true, valid: true }],
    ['missing', [], metadata, { complete: false, valid: false }],
    ['extra', [{ Key: prefix(record) + 'extra.js', Size: 5 }], metadata, { complete: true, valid: false }],
    ['size', [{ Key: prefix(record) + file.path, Size: 6 }], metadata, { complete: true, valid: false }],
    ...['ContentLength', 'ContentType', 'CacheControl', 'ChecksumSHA256'].map(key =>
      [key, [{ Key: prefix(record) + file.path, Size: 5 }], { ...metadata, [key]: 'wrong' }, { complete: true, valid: false }]),
  ]) {
    const client = { async send(command) {
      assert.equal(command.input.Bucket, 'bucket');
      if (command.constructor.name === 'ListObjectsV2Command') {
        assert.equal(command.input.Prefix, prefix(record));
        return { Contents: listing };
      }
      assert.equal(command.input.ChecksumMode, 'ENABLED');
      return head;
    } };
    assert.deepEqual(await createObjects(client, 'bucket').validate(record), expected, label);
  }
});

test('S3 validation follows truncated listings', async () => {
  let calls = 0;
  const objects = createObjects({ async send(command) {
    if (command.constructor.name === 'HeadObjectCommand') return metadata;
    calls++;
    if (calls === 1) return { Contents: [], IsTruncated: true, NextContinuationToken: 'next' };
    assert.equal(command.input.ContinuationToken, 'next');
    return { Contents: [{ Key: prefix(record) + file.path, Size: 5 }] };
  } }, 'bucket');
  assert.deepEqual(await objects.validate(record), { complete: true, valid: true });
  assert.equal(calls, 2);
});

test('DynamoDB uses conditional writes, consistent reads, project queries and continuation keys', async () => {
  const calls = [];
  let conflict = false;
  const store = createStore({ async send(command) {
    calls.push(command.input);
    if (conflict) throw Object.assign(new Error('conflict'), { name: 'ConditionalCheckFailedException' });
    if (command.constructor.name === 'GetCommand') return { Item: record };
    if (command.constructor.name === 'QueryCommand') return { Items: [record], LastEvaluatedKey: { deploymentId: record.deploymentId } };
    return {};
  } }, 'projects', 'deployments');
  assert.equal(await store.createDeployment(record), true);
  assert.equal(calls.at(-1).ConditionExpression, 'attribute_not_exists(deploymentId)');
  assert.deepEqual(await store.getDeployment(record.projectId, record.deploymentId), record);
  assert.equal(calls.at(-1).ConsistentRead, true);
  const page = await store.listDeployments(record.projectId, record.deploymentId);
  assert.equal(page.nextCursor, record.deploymentId);
  assert.deepEqual(calls.at(-1).ExclusiveStartKey, { projectId: record.projectId, deploymentId: record.deploymentId });
  assert.equal(calls.at(-1).ExpressionAttributeValues[':project'], record.projectId);
  assert.equal(await store.transition(record, 'ready', { readyAt: 'now' }), true);
  assert.equal(calls.at(-1).ConditionExpression, '#status = :before');
  assert.equal(calls.at(-1).ExpressionAttributeValues[':before'], 'uploading');
  conflict = true;
  assert.equal(await store.createDeployment(record), false);
  assert.equal(await store.transition(record, 'ready', {}), false);
});
