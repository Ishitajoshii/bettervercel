import { CfnOutput, Duration, RemovalPolicy, Stack, aws_apigatewayv2 as apigw,
  aws_apigatewayv2_integrations as integrations, aws_apigatewayv2_authorizers as authorizers,
  aws_dynamodb as dynamodb, aws_iam as iam, aws_lambda as lambda, aws_logs as logs,
  type StackProps } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import { fileURLToPath } from 'node:url';

interface ControlPlaneStackProps extends StackProps {
  bucketName: string;
  previewDomain: string;
  distributionId: string;
  github?: { clientId: string; secretArn: string; allowedUsers: string };
}

export class ControlPlaneStack extends Stack {
  constructor(scope: Construct, id: string, props: ControlPlaneStackProps) {
    super(scope, id, props);
    const projects = new dynamodb.Table(this, 'Projects', {
      partitionKey: { name: 'projectId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED, removalPolicy: RemovalPolicy.RETAIN,
    });
    const deployments = new dynamodb.Table(this, 'Deployments', {
      partitionKey: { name: 'projectId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'deploymentId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED, removalPolicy: RemovalPolicy.RETAIN,
    });
    const github = new dynamodb.Table(this, 'GitHubConnections', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      timeToLiveAttribute: 'expiresAt', billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED, removalPolicy: RemovalPolicy.RETAIN,
    });
    const logGroup = new logs.LogGroup(this, 'ControlLogs', {
      retention: logs.RetentionDays.THREE_DAYS, removalPolicy: RemovalPolicy.DESTROY,
    });
    const executionRole = new iam.Role(this, 'ControlExecutionRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    });
    logGroup.grantWrite(executionRole);
    const control = new lambda.Function(this, 'Control', {
      runtime: lambda.Runtime.NODEJS_24_X, architecture: lambda.Architecture.ARM_64,
      handler: 'index.handler', code: lambda.Code.fromAsset(fileURLToPath(new URL('../.build/control-api/', import.meta.url))),
      memorySize: 256, timeout: Duration.seconds(28), logGroup, role: executionRole,
      environment: { PROJECTS_TABLE: projects.tableName, DEPLOYMENTS_TABLE: deployments.tableName,
        GITHUB_TABLE: github.tableName, GITHUB_CLIENT_ID: props.github?.clientId ?? '',
        GITHUB_SECRET_ARN: props.github?.secretArn ?? '', GITHUB_ALLOWED_USERS: props.github?.allowedUsers ?? '',
        ARTIFACTS_BUCKET: props.bucketName, PREVIEW_DOMAIN: props.previewDomain, DISTRIBUTION_ID: props.distributionId },
    });
    control.addToRolePolicy(new iam.PolicyStatement({ actions: ['dynamodb:GetItem', 'dynamodb:PutItem'], resources: [projects.tableArn] }));
    control.addToRolePolicy(new iam.PolicyStatement({ actions: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:Query'], resources: [deployments.tableArn] }));
    control.addToRolePolicy(new iam.PolicyStatement({ actions: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem', 'dynamodb:Query'], resources: [github.tableArn] }));
    if (props.github) control.addToRolePolicy(new iam.PolicyStatement({ actions: ['secretsmanager:GetSecretValue'], resources: [props.github.secretArn] }));
    const bucketArn = `arn:${this.partition}:s3:::${props.bucketName}`;
    control.addToRolePolicy(new iam.PolicyStatement({ actions: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'], resources: [`${bucketArn}/deployments/p*/*/*`] }));
    control.addToRolePolicy(new iam.PolicyStatement({ actions: ['cloudfront:CreateInvalidation'],
      resources: [`arn:${this.partition}:cloudfront::${this.account}:distribution/${props.distributionId}`] }));
    control.addToRolePolicy(new iam.PolicyStatement({ actions: ['s3:ListBucket'], resources: [bucketArn],
      conditions: { StringLike: { 's3:prefix': ['deployments/p*/*/'] } } }));
    // The API role cannot bypass create-only semantics, even if a future signer omits the header.
    control.addToRolePolicy(new iam.PolicyStatement({ effect: iam.Effect.DENY, actions: ['s3:PutObject'],
      resources: [`${bucketArn}/deployments/p*/*/*`], conditions: { StringNotEquals: { 's3:if-none-match': '*' } } }));
    const api = new apigw.HttpApi(this, 'DeployApi', { createDefaultStage: false,
      corsPreflight: { allowOrigins: [`https://${props.previewDomain}`],
        allowMethods: [apigw.CorsHttpMethod.GET, apigw.CorsHttpMethod.POST, apigw.CorsHttpMethod.DELETE],
        allowHeaders: ['authorization', 'content-type', 'idempotency-key'], maxAge: Duration.minutes(10) } });
    new apigw.HttpStage(this, 'ApiStage', { httpApi: api, stageName: '$default', autoDeploy: true,
      throttle: { rateLimit: 5, burstLimit: 10 } });
    const integration = new integrations.HttpLambdaIntegration('ControlIntegration', control);
    control.addEnvironment('API_URL', api.apiEndpoint);
    api.addRoutes({ path: '/v1/projects', methods: [apigw.HttpMethod.POST], integration,
      authorizer: new authorizers.HttpIamAuthorizer() });
    for (const [path, method] of [
      ['/v1/deployments', apigw.HttpMethod.POST],
      ['/v1/deployments/{deploymentId}/finalize', apigw.HttpMethod.POST],
      ['/v1/deployments/{deploymentId}', apigw.HttpMethod.GET],
      ['/v1/deployments/{deploymentId}', apigw.HttpMethod.DELETE],
      ['/v1/projects/{projectId}', apigw.HttpMethod.GET],
      ['/v1/projects/{projectId}/deployments', apigw.HttpMethod.GET],
    ] as const) api.addRoutes({ path, methods: [method], integration });
    // Bind existing routes first so adding GitHub does not change the integration logical ID.
    api.addRoutes({ path: '/v1/github/{proxy+}', methods: [apigw.HttpMethod.ANY], integration });
    new CfnOutput(this, 'ApiUrl', { value: api.apiEndpoint });
    new CfnOutput(this, 'ProjectsTableName', { value: projects.tableName });
    new CfnOutput(this, 'DeploymentsTableName', { value: deployments.tableName });
    new CfnOutput(this, 'ControlFunctionName', { value: control.functionName });
  }
}
