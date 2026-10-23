import { S3Client, GetBucketPolicyStatusCommand, GetPublicAccessBlockCommand,
  GetBucketEncryptionCommand } from '@aws-sdk/client-s3';
import { configuration, sampleFiles, contentType, http, assert, run } from './lib.mjs';

run(async () => {
  const config = await configuration();
  const files = await sampleFiles();
  const s3 = new S3Client({ region: config.Region });
  const block = await s3.send(new GetPublicAccessBlockCommand({ Bucket: config.BucketName }));
  const policy = await s3.send(new GetBucketPolicyStatusCommand({ Bucket: config.BucketName }));
  const encryption = await s3.send(new GetBucketEncryptionCommand({ Bucket: config.BucketName }));
  assert(Object.values(block.PublicAccessBlockConfiguration ?? {}).length === 4 &&
    Object.values(block.PublicAccessBlockConfiguration).every(Boolean), 'S3 public access block is incomplete.');
  assert(policy.PolicyStatus?.IsPublic === false, 'S3 policy is public.');
  assert(encryption.ServerSideEncryptionConfiguration?.Rules?.some(rule =>
    rule.ApplyServerSideEncryptionByDefault?.SSEAlgorithm === 'AES256'), 'S3 AES256 encryption missing.');
  console.log('PASS: private bucket policy, all public-access blocks, and S3-managed encryption.');

  const redirect = await http(config.url.replace('https:', 'http:'), { redirect: 'manual' });
  assert([301, 302, 307, 308].includes(redirect.status) &&
    redirect.headers.get('location') === config.url, 'HTTP must redirect to HTTPS.');
  const canonical = await http(config.url.slice(0, -1), { redirect: 'manual' });
  assert(canonical.status === 308 && canonical.headers.get('location') === `/d/${config.id}/`,
    'Preview root needs canonical trailing slash for relative assets.');
  console.log('PASS: HTTP → HTTPS and preview trailing-slash redirects.');

  for (const file of files) {
    const url = file.key === 'index.html' ? config.url : config.url + file.key;
    const response = await http(url);
    assert(response.status === 200, `${file.key} returned ${response.status}.`);
    assert(response.headers.get('content-type')?.startsWith(contentType(file.key).split(';')[0]),
      `${file.key} has incorrect Content-Type.`);
    assert(response.headers.get('cache-control')?.includes('max-age='), `${file.key} has no cache lifetime.`);
    const actual = Buffer.from(await response.arrayBuffer());
    assert(actual.equals(file.body), `${file.key} content does not match the local build.`);
    console.log(`PASS: HTTPS ${file.key}, correct content, MIME type, cache headers.`);
  }
  const asset = files.find(file => file.key.endsWith('.js'));
  assert(asset, 'Vite build must contain JavaScript to verify nested asset paths.');
  let cacheHit = false;
  for (let attempt = 0; attempt < 6; attempt++) {
    const repeat = await http(config.url + asset.key);
    assert(repeat.status === 200, `Repeat asset request returned ${repeat.status}.`);
    cacheHit = repeat.headers.get('x-cache')?.toLowerCase().includes('hit') ?? false;
    await repeat.arrayBuffer();
    if (cacheHit) break;
    // A fresh edge cache may still be filling when the first response completes.
    if (attempt < 5) await new Promise(resolve => setTimeout(resolve, 1000));
  }
  assert(cacheHit, 'Repeated asset requests did not produce a CloudFront cache hit.');
  console.log('PASS: repeated asset request served from CloudFront cache.');

  const direct = await http(`https://${config.BucketName}.s3.${config.Region}.amazonaws.com/${config.prefix}index.html`);
  assert(direct.status === 403, `Anonymous direct S3 access returned ${direct.status}, expected 403.`);
  const missing = await http(config.url + 'missing-file.js');
  assert([403, 404].includes(missing.status), 'Missing assets must not return an HTML 200 fallback.');
  const internal = await http(`https://${config.DomainName}/${config.prefix}index.html`);
  assert(internal.status === 404, 'Internal storage paths should not be public routes.');
  console.log('PASS: direct S3 reads blocked, internal paths hidden, missing assets remain errors.');
  console.log(`\nVerified: ${config.url}`);
});
