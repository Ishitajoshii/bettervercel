import { S3Client, ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3';
import { CloudFrontClient, CreateInvalidationCommand,
  waitUntilInvalidationCompleted } from '@aws-sdk/client-cloudfront';
import { configuration, http, assert, run } from './lib.mjs';

run(async () => {
  const config = await configuration();
  const s3 = new S3Client({ region: config.Region });
  const cloudfront = new CloudFrontClient({ region: 'us-east-1' });
  let count = 0;
  // Re-read the first page after deleting it. No broad bucket deletion or wildcard keys.
  while (true) {
    const page = await s3.send(new ListObjectsV2Command({
      Bucket: config.BucketName, Prefix: config.prefix,
    }));
    const objects = (page.Contents ?? []).map(({ Key }) => {
      assert(Key?.startsWith(config.prefix), 'Refusing deletion outside the exact deployment prefix.');
      return { Key };
    });
    if (!objects.length) break;
    const result = await s3.send(new DeleteObjectsCommand({
      Bucket: config.BucketName, Delete: { Objects: objects, Quiet: true },
    }));
    assert(!result.Errors?.length, `S3 deletion errors: ${JSON.stringify(result.Errors)}`);
    count += objects.length;
  }
  console.log(`Deleted ${count} demo objects under ${config.prefix}. This cannot be undone.`);
  // Include both viewer and rewritten URIs for function-based routing.
  const invalidation = await cloudfront.send(new CreateInvalidationCommand({
    DistributionId: config.DistributionId,
    InvalidationBatch: {
      CallerReference: `bettervercel-delete-${config.id}-${Date.now()}`,
      Paths: { Quantity: 3, Items: [`/d/${config.id}`, `/d/${config.id}/*`, `/${config.prefix}*`] },
    },
  }));
  console.log('Waiting for CloudFront invalidation to finish…');
  await waitUntilInvalidationCompleted({ client: cloudfront, maxWaitTime: 600 }, {
    DistributionId: config.DistributionId, Id: invalidation.Invalidation.Id,
  });
  const response = await http(config.url);
  assert([403, 404].includes(response.status), `Deleted preview returned ${response.status}; expected 403/404.`);
  console.log(`PASS: deleted preview is unavailable (${response.status}).`);
});
