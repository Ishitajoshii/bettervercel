import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, PutObjectCommand, HeadObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { CACHE_CONTROL, prefix } from './domain.mjs';
import { createHandler } from './handler.mjs';

export function createStore(client, projects, deployments) {
  const get = async (TableName, Key) => (await client.send(new GetCommand({ TableName, Key, ConsistentRead: true }))).Item;
  async function insert(TableName, Item, key) {
    try {
      await client.send(new PutCommand({ TableName, Item, ConditionExpression: `attribute_not_exists(${key})` }));
      return true;
    } catch (error) {
      if (error.name === 'ConditionalCheckFailedException') return false;
      throw error;
    }
  }
  return {
    getProject: projectId => get(projects, { projectId }),
    async createProject(project) {
      if (!await insert(projects, project, 'projectId')) throw new Error('Project ID collision; retry.');
    },
    getDeployment: (projectId, deploymentId) => get(deployments, { projectId, deploymentId }),
    createDeployment: record => insert(deployments, record, 'deploymentId'),
    async transition(record, status, fields) {
      const values = { ':before': 'uploading', ':after': status };
      const names = { '#status': 'status' };
      const assignments = ['#status = :after'];
      Object.entries(fields).forEach(([key, value], index) => {
        names[`#f${index}`] = key; values[`:f${index}`] = value;
        assignments.push(`#f${index} = :f${index}`);
      });
      try {
        await client.send(new UpdateCommand({ TableName: deployments,
          Key: { projectId: record.projectId, deploymentId: record.deploymentId },
          UpdateExpression: `SET ${assignments.join(', ')}`, ConditionExpression: '#status = :before',
          ExpressionAttributeNames: names, ExpressionAttributeValues: values }));
        return true;
      } catch (error) {
        if (error.name === 'ConditionalCheckFailedException') return false;
        throw error;
      }
    },
    async listDeployments(projectId, cursor) {
      const result = await client.send(new QueryCommand({ TableName: deployments,
        KeyConditionExpression: 'projectId = :project', ExpressionAttributeValues: { ':project': projectId },
        ConsistentRead: true, Limit: 20, ScanIndexForward: false,
        ...(cursor ? { ExclusiveStartKey: { projectId, deploymentId: cursor } } : {}) }));
      return { records: result.Items ?? [], nextCursor: result.LastEvaluatedKey?.deploymentId };
    },
  };
}

export function createObjects(client, bucket) {
  return {
    async sign(key, file, expiresIn) {
      const checksum = Buffer.from(file.sha256, 'hex').toString('base64');
      const headers = { 'content-type': file.contentType, 'content-length': String(file.size),
        'cache-control': CACHE_CONTROL, 'if-none-match': '*', 'x-amz-checksum-sha256': checksum };
      const url = await getSignedUrl(client, new PutObjectCommand({ Bucket: bucket, Key: key,
        ContentType: file.contentType, ContentLength: file.size, CacheControl: CACHE_CONTROL,
        IfNoneMatch: '*', ChecksumSHA256: checksum }), {
        expiresIn, signableHeaders: new Set(Object.keys(headers)),
        unhoistableHeaders: new Set(['x-amz-checksum-sha256']),
      });
      return { path: file.path, method: 'PUT', url, headers, expiresIn };
    },
    async validate(record) {
      const root = prefix(record);
      const expected = new Map(record.files.map(file => [root + file.path, file]));
      const found = new Set();
      let ContinuationToken;
      do {
        const page = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: root, ContinuationToken, MaxKeys: 501 }));
        for (const object of page.Contents ?? []) {
          if (!expected.has(object.Key) || object.Size !== expected.get(object.Key).size) return { complete: true, valid: false };
          found.add(object.Key);
        }
        if (found.size > 500) return { complete: true, valid: false };
        ContinuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (ContinuationToken);
      if (found.size !== expected.size) return { complete: false, valid: false };
      let valid = true;
      // Bound fan-out while checking all S3 checksums and metadata, not just caller declarations.
      const files = [...expected];
      for (let index = 0; index < files.length; index += 16) {
        const checks = await Promise.all(files.slice(index, index + 16).map(async ([Key, file]) => {
          try {
            const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key, ChecksumMode: 'ENABLED' }));
            return head.ContentLength === file.size && head.ContentType === file.contentType &&
              head.CacheControl === CACHE_CONTROL && head.ChecksumSHA256 === Buffer.from(file.sha256, 'hex').toString('base64');
          } catch (error) {
            if (error.$metadata?.httpStatusCode === 404) return false;
            throw error;
          }
        }));
        valid &&= checks.every(Boolean);
      }
      return { complete: true, valid };
    },
  };
}

let control;
export async function handler(event) {
  control ??= createHandler({
    store: createStore(DynamoDBDocumentClient.from(new DynamoDBClient({})), process.env.PROJECTS_TABLE, process.env.DEPLOYMENTS_TABLE),
    objects: createObjects(new S3Client({}), process.env.ARTIFACTS_BUCKET), domain: process.env.PREVIEW_DOMAIN,
  });
  return control(event);
}
