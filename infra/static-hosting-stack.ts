import { readFileSync } from 'node:fs';
import {
  CfnOutput, Duration, RemovalPolicy, Stack,
  aws_cloudfront as cloudfront, aws_cloudfront_origins as origins, aws_s3 as s3,
  aws_budgets as budgets,
  type StackProps,
} from 'aws-cdk-lib';
import type { Construct } from 'constructs';

interface StaticHostingStackProps extends StackProps {
  budgetEmail?: string;
}

export class StaticHostingStack extends Stack {
  constructor(scope: Construct, id: string, props?: StaticHostingStackProps) {
    super(scope, id, props);

    const bucket = new s3.Bucket(this, 'Artifacts', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      enforceSSL: true,
      versioned: false,
      // Empty manually before destroy. No auto-delete Lambda or hidden assets.
      removalPolicy: RemovalPolicy.DESTROY,
      lifecycleRules: [{
        id: 'ExpireDemoDeployments',
        prefix: 'deployments/',
        expiration: Duration.days(7),
        abortIncompleteMultipartUploadAfter: Duration.days(1),
      }],
    });

    const router = new cloudfront.Function(this, 'PreviewRouter', {
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      code: cloudfront.FunctionCode.fromInline(
        readFileSync(new URL('./preview-router.js', import.meta.url), 'utf8'),
      ),
      comment: 'Map /d/<id>/ paths to immutable S3 deployments; explicit directory indexes',
    });

    const cache = new cloudfront.CachePolicy(this, 'PreviewCache', {
      minTtl: Duration.seconds(0),
      defaultTtl: Duration.minutes(5),
      maxTtl: Duration.days(1),
      enableAcceptEncodingGzip: true,
      enableAcceptEncodingBrotli: true,
      queryStringBehavior: cloudfront.CacheQueryStringBehavior.none(),
      cookieBehavior: cloudfront.CacheCookieBehavior.none(),
      headerBehavior: cloudfront.CacheHeaderBehavior.none(),
    });

    const distribution = new cloudfront.Distribution(this, 'Previews', {
      comment: 'Better Vercel static previews',
      priceClass: cloudfront.PriceClass.PRICE_CLASS_200,
      httpVersion: cloudfront.HttpVersion.HTTP2,
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(bucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD,
        compress: true,
        cachePolicy: cache,
        responseHeadersPolicy: cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS,
        functionAssociations: [{
          function: router, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
        }],
      },
      // Never turn missing JS/CSS or unknown deployments into a 200 SPA document.
      errorResponses: [403, 404].map(httpStatus => ({
        httpStatus, ttl: Duration.seconds(0),
      })),
    });

    distribution.addBehavior('dashboard/*', origins.S3BucketOrigin.withOriginAccessControl(bucket), {
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
      cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
      responseHeadersPolicy: new cloudfront.ResponseHeadersPolicy(this, 'DashboardHeaders', {
        securityHeadersBehavior: {
          contentSecurityPolicy: { override: true, contentSecurityPolicy: "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self' https://*.amazonaws.com; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" },
          contentTypeOptions: { override: true },
          frameOptions: { override: true, frameOption: cloudfront.HeadersFrameOption.DENY },
          referrerPolicy: { override: true, referrerPolicy: cloudfront.HeadersReferrerPolicy.NO_REFERRER },
        },
      }),
      functionAssociations: [{ function: router, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST }],
    });

    new CfnOutput(this, 'BucketName', { value: bucket.bucketName });
    new CfnOutput(this, 'DistributionId', { value: distribution.distributionId });
    new CfnOutput(this, 'DomainName', { value: distribution.distributionDomainName });
    new CfnOutput(this, 'Region', { value: this.region });

    if (props?.budgetEmail) {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(props.budgetEmail)) {
        throw new Error('BETTERVERCEL_BUDGET_EMAIL must be a valid email address.');
      }
      const budget = new budgets.CfnBudget(this, 'MonthlyBudget', {
        budget: {
          budgetName: 'bettervercel-monthly-guardrail',
          budgetType: 'COST',
          timeUnit: 'MONTHLY',
          budgetLimit: { amount: 5, unit: 'USD' },
          // Alert on underlying account spend even while promotional credits cover it.
          costTypes: { includeCredit: false, includeRefund: false },
        },
        notificationsWithSubscribers: [1, 3, 5].map(threshold => ({
          notification: {
            notificationType: 'ACTUAL', comparisonOperator: 'GREATER_THAN',
            thresholdType: 'ABSOLUTE_VALUE', threshold,
          },
          subscribers: [{ subscriptionType: 'EMAIL', address: props.budgetEmail! }],
        })),
      });
      new CfnOutput(this, 'BudgetName', { value: budget.ref });
    }
  }
}
