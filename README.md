# Better Vercel

Milestone 1 serves a Vite build from a private S3 bucket through an HTTPS CloudFront URL. Milestone 2 adds an authenticated deployment API, DynamoDB metadata, scoped immutable uploads, and validated finalization. Milestone 3 adds the local CLI with `login`, `init`, `deploy`, `status`, and `logs`. Infrastructure is AWS CDK in TypeScript. See [the CLI guide](cli/README.md) to deploy a project and [the deploy API guide](api/README.md) for setup, endpoint contracts, verification, and teardown.

Milestone 4 adds a static project/deployment dashboard, authenticated deletion with CloudFront cache removal, branch/PR metadata, a [copy-paste GitHub Actions workflow](examples/github-actions/deploy.yml), and a runnable Next.js static-export sample. See [framework setup and dashboard operations](docs/frameworks-and-actions.md). The dashboard uses operator-issued project tokens; it has no self-serve signup.

[Open the dashboard](https://d34mbpew2lb7ue.cloudfront.net/dashboard/) · [Open the Next.js static preview](https://d34mbpew2lb7ue.cloudfront.net/d/p7f0c6e2a840a04ed-866563d5bc4878abfc74c66208bcc3b1/). The October 24 review passed 51 local tests and real Vite/Next CLI deployments. See the [milestone audit](prd/aws-vercel-mvp.md) for evidence and the remaining browser/GitHub-run acceptance checks.

## Live milestone 1

Deployed and verified on October 23, 2026 in `ap-south-1`:

[Open the live sample preview](https://d34mbpew2lb7ue.cloudfront.net/d/milestone-1/)

CloudFormation reports `UPDATE_COMPLETE` after the routing audit. Live checks passed for HTTPS redirects, HTML/JS/CSS contents and MIME types, CloudFront cache hits, S3 encryption/public-access blocks, and blocked anonymous S3 reads. A separate disposable preview was uploaded, cached, deleted, and invalidated; its URL then returned 403. The main preview remains available and its artifacts expire after seven days.

The audit reran the live content, HTTPS, caching, and S3 privacy checks successfully. The original 30 local tests passed across both milestones, including storage adapters, token isolation, signed upload constraints, concurrent finalization, and infrastructure. The $5 whole-account budget is active with $1/$3/$5 email notifications and excludes credits/refunds. This verifies alert configuration, not delivery of an email. The browser click test remains manual because both browser automation helpers failed during startup.

## Live milestone 2

`BetterVercelControlStack` reports `CREATE_COMPLETE` in `ap-south-1`. API: `https://bubil63r3f.execute-api.ap-south-1.amazonaws.com`. The full `npm run verify:api` smoke test passed with real IAM authentication, two independent project tokens, S3 uploads, checksum/overwrite/prefix rejection, concurrent finalization, status/list, and exact preview bytes. [Open the API-created preview](https://d34mbpew2lb7ue.cloudfront.net/d/p98bba9981bb88a5e-5b2aefa02b022f413a1194297d2829a0/). The API contract and operating instructions are in [api/README.md](api/README.md).

## Requirements

- Node.js 22.12+ (Node.js 24 recommended).
- AWS CLI v2 with a locally authenticated AWS profile for the live deployment. Never commit or paste credentials.
- Permissions to create CloudFormation, S3, and CloudFront resources in your chosen account. The hosting stack creates no IAM roles. The optional control stack also needs Lambda, API Gateway, DynamoDB, CloudWatch Logs, IAM, and CDK bootstrap permissions.

Default region: Mumbai (`ap-south-1`). Set `AWS_REGION` to change it before deploying.

## Local checks

```powershell
npm ci
npm run check
npm run synth
npm run build:sample
```

`cdk.out/BetterVercelStaticStack.template.json` is the reviewable hosting template. No AWS account is needed for these checks. The hosting stack uses `LegacyStackSynthesizer` with no assets, so hosting alone needs no bootstrap. The API has a bundled Lambda asset and uses standard CDK bootstrap; `npm run synth:api` writes its template under `cdk.out/control/`.

## Sign in and deploy

Install [AWS CLI v2 for Windows](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html). With a current CLI version, [sign in through the browser](https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-sign-in.html):

```powershell
aws login --profile bettervercel
$env:AWS_PROFILE = 'bettervercel'
$env:AWS_REGION = 'ap-south-1'
aws sts get-caller-identity
$env:BETTERVERCEL_BUDGET_EMAIL = 'your-email@example.com'
npm run deploy:infra
```

An existing SSO or other local AWS profile also works. `AWS_PROFILE` must be set in the shell running CDK/sample commands. CDK writes `cdk-outputs.json` with bucket, distribution, domain, and region. Deployment can take several minutes while CloudFront propagates.

`BETTERVERCEL_BUDGET_EMAIL` adds a monitoring-only $5 monthly budget with email alerts above $1, $3, and $5. It covers the whole AWS account and excludes credits/refunds so credits cannot hide consumption. Keep this environment variable set for subsequent CDK deployments to retain the budget. The address is supplied locally rather than committed in source. [Monitoring-only budgets and alerts are free](https://aws.amazon.com/aws-cost-management/aws-budgets/pricing/).

Before deploying, check the AWS Free Tier page in your account and set a small AWS Budget. The $0–$5 target assumes a few tiny sites and light traffic. S3 storage/requests, CloudFront requests/Functions/traffic, and cache invalidations can incur usage charges depending on allowances. **Budget alerts are delayed notifications, not a spending cap.** Credits hide cash charges temporarily but do not make the underlying usage free.

## Upload and verify the sample

Use a new ID for every upload; the uploader rejects an existing prefix and conditional writes prevent object overwrites.

```powershell
npm run build:sample
npm run upload:sample -- --id smoke-001
npm run verify:sample -- --id smoke-001
```

Open the printed `https://<distribution>.cloudfront.net/d/smoke-001/` URL and click the button to check JavaScript in the browser. Vite uses relative asset URLs so the build works under the preview path. The automated verification checks HTTPS redirects, JS/CSS/HTML bytes and MIME types, cache headers and a repeat cache hit, private S3 access, missing-file errors, and blocked internal storage paths.

The router supports directory indexes (`/docs/` → `docs/index.html`); SPA history fallback is not implemented yet. Unknown S3 objects can return 403 because public callers cannot list the bucket; this is an expected missing-file response for this proof.

All `/d/` previews are public and share one browser origin. Use your own trusted sample builds during this milestone. Per-project browser-origin isolation belongs in the hosting design before accepting unrelated users' pages.

Demo artifacts expire after seven days. Lifecycle deletion is asynchronous and does not immediately evict CDN copies; assets may remain cached for at most a further day. Use explicit deletion below when checking removal.

## Delete a test deployment

```powershell
npm run delete:sample -- --id smoke-001
```

This permanently deletes only `deployments/smoke-001/`, invalidates its viewer and rewritten cache paths, waits for CloudFront, and checks that the preview returns 403/404. The ID is mandatory and validated; the script cannot target the bucket root. Invalidation usually takes a few minutes. Rerun the same command if the wait times out after the objects were deleted.

## Remove infrastructure

1. Delete every uploaded demo using `delete:sample` and its exact ID. The bucket is deliberately not auto-emptied.
2. Review `cdk-outputs.json` and your selected AWS profile/account.
3. Run `npm run destroy:infra` and accept CDK's confirmation for `BetterVercelStaticStack`.
4. Confirm stack removal in CloudFormation. A nonempty bucket prevents full deletion; empty only this stack's bucket, then retry.

The hosting stack contains the private S3 bucket and policy, CloudFront distribution, origin access controls, cache policy, request function, and dashboard security-header policy. Setting the budget email adds one AWS Budgets resource. No KMS key, Lambda, DNS zone, VPC, database, or builder is created by the hosting stack. Remove the `dashboard/` objects as well as deployment artifacts before destroying the bucket. Stopping CloudFront is not the teardown procedure; delete the stack when finished. Stack deletion also removes its budget.

## Plan

See [the PRD and checklist](prd/aws-vercel-mvp.md) and [the deploy API guide](api/README.md). The milestone 1 helpers use the operator's local AWS identity and reject API deployment IDs. API clients use project bearer tokens and signed object URLs; `npm run verify:api` exercises the complete API flow with disposable projects.
