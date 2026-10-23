import { readFile } from 'node:fs/promises';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { CloudFrontClient, CreateInvalidationCommand } from '@aws-sdk/client-cloudfront';
const hosting = JSON.parse(await readFile('cdk-outputs.json', 'utf8')).BetterVercelStaticStack;
const control = JSON.parse(await readFile('control-outputs.json', 'utf8')).BetterVercelControlStack;
const s3 = new S3Client({ region: hosting.Region });
for (const [name, ContentType] of [['index.html', 'text/html; charset=utf-8'], ['app.js', 'text/javascript; charset=utf-8'], ['style.css', 'text/css; charset=utf-8'], ['config.json', 'application/json']]) {
  const Body = name === 'config.json' ? JSON.stringify({ apiUrl: control.ApiUrl }) : await readFile(`dashboard/${name}`);
  await s3.send(new PutObjectCommand({ Bucket: hosting.BucketName, Key: `dashboard/${name}`, Body, ContentType, CacheControl: 'no-store' }));
}
await new CloudFrontClient({ region: hosting.Region }).send(new CreateInvalidationCommand({ DistributionId: hosting.DistributionId,
  InvalidationBatch: { CallerReference: `dashboard-${Date.now()}`, Paths: { Quantity: 1, Items: ['/dashboard/*'] } } }));
console.log(`Dashboard uploaded: https://${hosting.DomainName}/dashboard/`);
