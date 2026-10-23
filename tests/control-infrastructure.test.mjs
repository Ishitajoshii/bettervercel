import test from 'node:test';
import assert from 'node:assert/strict';
import { App } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { tsImport } from 'tsx/esm/api';

const { ControlPlaneStack } = await tsImport('../infra/control-plane-stack.ts', import.meta.url);
const template = Template.fromStack(new ControlPlaneStack(new App(), 'ControlTest', {
  env: { account: '123456789012', region: 'ap-south-1' },
  bucketName: 'test-artifacts', previewDomain: 'example.cloudfront.net', distributionId: 'E123456789',
}));

test('control plane is serverless with two on-demand encrypted retained tables and bounded logs', () => {
  template.resourceCountIs('AWS::DynamoDB::Table', 2);
  for (const table of Object.values(template.findResources('AWS::DynamoDB::Table'))) {
    assert.equal(table.Properties.BillingMode, 'PAY_PER_REQUEST');
    assert.equal(table.Properties.SSESpecification.SSEEnabled, true);
    assert.equal(table.DeletionPolicy, 'Retain');
  }
  template.hasResourceProperties('AWS::Logs::LogGroup', { RetentionInDays: 3 });
  template.hasResourceProperties('AWS::Lambda::Function', {
    Runtime: 'nodejs24.x', Architectures: ['arm64'], Timeout: 28, MemorySize: 256,
    VpcConfig: Match.absent(),
  });
  const types = Object.values(template.toJSON().Resources).map(r => r.Type);
  assert.ok(!types.some(t => /EC2|RDS|ECS|EKS|KMS::Key/.test(t)));
});

test('project creation requires IAM while deploy routes use application token checks; stage is throttled', () => {
  template.resourceCountIs('AWS::ApiGatewayV2::Route', 7);
  template.hasResourceProperties('AWS::ApiGatewayV2::Route', { RouteKey: 'POST /v1/projects', AuthorizationType: 'AWS_IAM' });
  template.hasResourceProperties('AWS::ApiGatewayV2::Stage', {
    DefaultRouteSettings: { ThrottlingBurstLimit: 10, ThrottlingRateLimit: 5 },
  });
});

test('API can only access project artifact prefixes; deletion and invalidation are scoped', () => {
  const statements = Object.values(template.findResources('AWS::IAM::Policy')).flatMap(p => p.Properties.PolicyDocument.Statement);
  const s3 = statements.filter(s => JSON.stringify(s.Action).includes('s3:'));
  assert.equal(s3.length, 3);
  assert.ok(s3.some(s => JSON.stringify(s.Action).includes('s3:DeleteObject') && JSON.stringify(s.Resource).includes('/deployments/p*/*/*')));
  const delivery = statements.find(s => JSON.stringify(s.Action).includes('cloudfront:CreateInvalidation'));
  assert.ok(JSON.stringify(delivery.Resource).includes('distribution/E123456789'));
  const write = s3.find(s => s.Effect === 'Allow' && s.Action.includes('s3:PutObject'));
  assert.ok(JSON.stringify(write.Resource).includes('/deployments/p*/*/*'));
  const deny = s3.find(s => s.Effect === 'Deny');
  assert.deepEqual(deny.Condition, { StringNotEquals: { 's3:if-none-match': '*' } });
  const list = s3.find(s => s.Action === 's3:ListBucket');
  assert.deepEqual(list.Condition, { StringLike: { 's3:prefix': ['deployments/p*/*/'] } });
  for (const statement of statements) assert.notEqual(statement.Resource, '*');
});
