import { S3Client, ListObjectsV2Command, PutObjectCommand } from '@aws-sdk/client-s3';
import { configuration, sampleFiles, contentType, run } from './lib.mjs';

run(async () => {
  const config = await configuration();
  const files = await sampleFiles();
  const s3 = new S3Client({ region: config.Region });
  const existing = await s3.send(new ListObjectsV2Command({
    Bucket: config.BucketName, Prefix: config.prefix, MaxKeys: 1,
  }));
  if (existing.KeyCount) throw new Error('Deployment ID already exists. Use a new --id; previews are immutable.');
  for (const file of files) {
    await s3.send(new PutObjectCommand({
      Bucket: config.BucketName, Key: config.prefix + file.key, Body: file.body,
      ContentType: contentType(file.key),
      CacheControl: file.key.endsWith('.html') ? 'public, max-age=60' : 'public, max-age=86400, immutable',
      IfNoneMatch: '*',
    }));
    console.log(`Uploaded ${file.key} (${file.body.length} bytes)`);
  }
  console.log(`\nPreview: ${config.url}\nDemo expires after 7 days.\nVerify: npm run verify:sample -- --id ${config.id}`);
});
