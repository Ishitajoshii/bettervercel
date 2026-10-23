import { App, LegacyStackSynthesizer, Tags } from 'aws-cdk-lib';
import { StaticHostingStack } from './static-hosting-stack.js';
import { ControlPlaneStack } from './control-plane-stack.js';

const app = new App();
const stack = new StaticHostingStack(app, 'BetterVercelStaticStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? 'ap-south-1',
  },
  // No assets/custom resources: deploy without creating a bootstrap bucket or roles.
  synthesizer: new LegacyStackSynthesizer(),
  analyticsReporting: false,
  budgetEmail: process.env.BETTERVERCEL_BUDGET_EMAIL,
  description: 'Better Vercel milestone 1: private S3 static previews through CloudFront',
});
Tags.of(stack).add('Project', 'bettervercel');
Tags.of(stack).add('Milestone', 'static-preview');

// Opt in explicitly: static-only deployments remain asset/bootstrap free.
if (process.env.BETTERVERCEL_CONTROL_PLANE === '1') {
  const bucketName = process.env.BETTERVERCEL_BUCKET;
  const previewDomain = process.env.BETTERVERCEL_PREVIEW_DOMAIN;
  const distributionId = process.env.BETTERVERCEL_DISTRIBUTION_ID;
  if (!bucketName || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucketName) ||
      !previewDomain || !/^[a-z0-9]+\.cloudfront\.net$/.test(previewDomain) || !distributionId || !/^[A-Z0-9]+$/.test(distributionId)) {
    throw new Error('Set BETTERVERCEL_BUCKET and BETTERVERCEL_PREVIEW_DOMAIN from the hosting stack outputs.');
  }
  const control = new ControlPlaneStack(app, 'BetterVercelControlStack', {
    env: { account: process.env.CDK_DEFAULT_ACCOUNT,
      region: process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? 'ap-south-1' },
    bucketName, previewDomain, distributionId,
    analyticsReporting: false,
    description: 'Better Vercel milestone 2: deployment API and project metadata',
  });
  Tags.of(control).add('Project', 'bettervercel');
}
