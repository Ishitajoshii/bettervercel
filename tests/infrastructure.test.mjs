import test from 'node:test';
import assert from 'node:assert/strict';
import { App, LegacyStackSynthesizer } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { tsImport } from 'tsx/esm/api';

const { StaticHostingStack } = await tsImport('../infra/static-hosting-stack.ts', import.meta.url);
const stack = new StaticHostingStack(new App(), 'TestStack', {
  env: { account: '123456789012', region: 'ap-south-1' },
  synthesizer: new LegacyStackSynthesizer(),
});
const template = Template.fromStack(stack);

test('private bucket uses AES256, public access blocks, short artifact retention, and no website endpoint', () => {
  template.resourceCountIs('AWS::S3::Bucket', 1);
  template.hasResourceProperties('AWS::S3::Bucket', {
    BucketEncryption: { ServerSideEncryptionConfiguration: [{ ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }] },
    PublicAccessBlockConfiguration: {
      BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true,
    },
    OwnershipControls: { Rules: [{ ObjectOwnership: 'BucketOwnerEnforced' }] },
    LifecycleConfiguration: { Rules: Match.arrayWith([Match.objectLike({
      ExpirationInDays: 7, Prefix: 'deployments/', Status: 'Enabled',
      AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 },
    })]) },
    WebsiteConfiguration: Match.absent(),
  });
});

test('CloudFront uses signed S3 OAC, scoped read permission, HTTPS, and no HTML error fallback', () => {
  template.resourceCountIs('AWS::CloudFront::Distribution', 1);
  template.hasResourceProperties('AWS::CloudFront::OriginAccessControl', {
    OriginAccessControlConfig: Match.objectLike({
      OriginAccessControlOriginType: 's3', SigningBehavior: 'always', SigningProtocol: 'sigv4',
    }),
  });
  template.hasResourceProperties('AWS::S3::BucketPolicy', {
    PolicyDocument: { Statement: Match.arrayWith([Match.objectLike({
      Principal: { Service: 'cloudfront.amazonaws.com' },
      Action: 's3:GetObject', Effect: 'Allow',
      Condition: { StringEquals: { 'AWS:SourceArn': Match.anyValue() } },
    })]), Version: '2012-10-17' },
  });
  template.hasResourceProperties('AWS::CloudFront::Distribution', {
    DistributionConfig: Match.objectLike({
      DefaultCacheBehavior: Match.objectLike({
        ViewerProtocolPolicy: 'redirect-to-https', AllowedMethods: ['GET', 'HEAD'],
        FunctionAssociations: Match.arrayWith([Match.objectLike({ EventType: 'viewer-request' })]),
      }),
      CustomErrorResponses: [
        { ErrorCode: 403, ErrorCachingMinTTL: 0 },
        { ErrorCode: 404, ErrorCachingMinTTL: 0 },
      ],
    }),
  });
});

test('does not introduce always-on compute, KMS keys, bootstrap assets, or cleanup Lambdas', () => {
  const types = Object.values(template.toJSON().Resources).map(resource => resource.Type);
  assert.deepEqual(new Set(types), new Set([
    'AWS::S3::Bucket', 'AWS::S3::BucketPolicy', 'AWS::CloudFront::Function',
    'AWS::CloudFront::CachePolicy', 'AWS::CloudFront::OriginAccessControl', 'AWS::CloudFront::Distribution',
    'AWS::CloudFront::ResponseHeadersPolicy',
  ]));
  assert.equal(JSON.stringify(template.toJSON()).includes('BootstrapVersion'), false);
});

test('release gate: CloudFront reads only public prefixes and cannot list or write the bucket', () => {
  const bucketId = Object.keys(template.findResources('AWS::S3::Bucket'))[0];
  const distributionId = Object.keys(template.findResources('AWS::CloudFront::Distribution'))[0];
  const statements = Object.values(template.findResources('AWS::S3::BucketPolicy'))
    .flatMap(policy => policy.Properties.PolicyDocument.Statement);
  const allowed = statements.filter(statement => statement.Effect === 'Allow');
  assert.equal(allowed.length, 1);
  assert.deepEqual(allowed[0].Principal, { Service: 'cloudfront.amazonaws.com' });
  assert.equal(allowed[0].Action, 's3:GetObject');
  assert.deepEqual(allowed[0].Resource, ['deployments/*', 'dashboard/*'].map(path => ({
    'Fn::Join': ['', [{ 'Fn::GetAtt': [bucketId, 'Arn'] }, '/' + path]],
  })));
  assert.deepEqual(allowed[0].Condition, { StringEquals: { 'AWS:SourceArn': {
    'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':cloudfront::', { Ref: 'AWS::AccountId' }, ':distribution/', { Ref: distributionId }]],
  } } });
  // A broad deny enforces TLS; it grants no additional read/write permissions.
  assert.ok(statements.some(statement => statement.Effect === 'Deny' && statement.Condition?.Bool?.['aws:SecureTransport'] === 'false'));
});

test('optional budget alerts track pre-credit spending at $1, $3, and $5', () => {
  const budgetStack = new StaticHostingStack(new App(), 'BudgetTestStack', {
    env: { account: '123456789012', region: 'ap-south-1' },
    budgetEmail: 'owner@example.com',
    synthesizer: new LegacyStackSynthesizer(),
  });
  Template.fromStack(budgetStack).hasResourceProperties('AWS::Budgets::Budget', {
    Budget: Match.objectLike({
      BudgetLimit: { Amount: 5, Unit: 'USD' }, BudgetType: 'COST', TimeUnit: 'MONTHLY',
      CostTypes: { IncludeCredit: false, IncludeRefund: false },
    }),
    NotificationsWithSubscribers: [1, 3, 5].map(Threshold => ({
      Notification: {
        NotificationType: 'ACTUAL', ComparisonOperator: 'GREATER_THAN',
        ThresholdType: 'ABSOLUTE_VALUE', Threshold,
      },
      Subscribers: [{ SubscriptionType: 'EMAIL', Address: 'owner@example.com' }],
    })),
  });
});

test('deployment assembly uses current credentials without bootstrap roles or assets', () => {
  const app = new App();
  new StaticHostingStack(app, 'DirectCredentialStack', {
    env: { account: '123456789012', region: 'ap-south-1' },
    synthesizer: new LegacyStackSynthesizer(),
  });
  const assembly = app.synth();
  const properties = assembly.manifest.artifacts.DirectCredentialStack.properties;
  assert.equal(properties.assumeRoleArn, undefined);
  assert.equal(properties.cloudFormationExecutionRoleArn, undefined);
  assert.equal(properties.requiresBootstrapStackVersion, undefined);
  assert.equal(properties.stackTemplateAssetObjectUrl, undefined);
});
