# Deploy API (milestone 2)

The control plane uses an API Gateway HTTP API, one ARM64 Node.js 24 Lambda, two DynamoDB on-demand tables, and the existing private artifact bucket. Lambda is outside a VPC, has no provisioned concurrency, and writes only to its own log group (three-day retention). The HTTP API is throttled to 5 requests/second with burst 10. Throttles and budget alerts are not hard spending caps.

## Build and deploy

Set `AWS_PROFILE=bettervercel` and `AWS_REGION=ap-south-1` in your shell. These commands assume milestone 1 has produced `cdk-outputs.json`:

```powershell
npm ci
npm run check
npm run synth:api
npx --no-install cdk bootstrap aws://<account-id>/ap-south-1
npm run diff:api
npm run deploy:api
npm run build:sample
npm run verify:api
```

The standard CDK bootstrap is needed once per account/region for the Lambda bundle. It creates an artifact bucket, ECR repository, SSM bootstrap version, and deployment roles; it adds no running compute. Deploying the control stack does not redeploy the hosting stack. API output values go to ignored `control-outputs.json`. Both synthesized templates are under `cdk.out/`.

Before first API use, update `BetterVercelStaticStack` with the current router. Preserve `BETTERVERCEL_BUDGET_EMAIL` from the existing deployment, review `npx cdk diff BetterVercelStaticStack`, then run `npm run deploy:infra -- BetterVercelStaticStack`. The router supports both milestone 1 prefixes and API project prefixes.

`verify:api` creates two disposable test projects and one tiny deployment. It checks operator IAM auth, project token isolation, malformed manifests, size limits, duplicate create, incomplete upload, signed prefix tampering, S3 overwrite rejection, concurrent finalize, status/list, and actual preview bytes. It never logs deploy tokens or upload URLs. Artifacts expire after seven days; the two test project records and deployment record remain until explicitly removed.

## Authentication and endpoints

| Method and route | Authentication | Result |
| --- | --- | --- |
| `POST /v1/projects` | AWS SigV4, IAM `execute-api:Invoke` on this route | `201`: project ID and one-time deploy token |
| `POST /v1/deployments` | Project bearer token; `Idempotency-Key` header | `201` new / `200` same request: state and signed PUT instructions |
| `POST /v1/deployments/{id}/finalize` | Owning project's bearer token | `200` ready after S3 verification |
| `GET /v1/deployments/{id}` | Owning project's bearer token | Summary, state, timestamps, preview, retained log |
| `GET /v1/projects/{id}/deployments?cursor=...` | Owning project's bearer token | Up to 20 summaries plus `nextCursor` |

Create a project with `npm run create:project -- "My project"`. This command prints the raw deploy token once. Save it in a secret store; do not commit it. The server stores a random salt and scrypt hash, compares hashes in constant time, and returns no credentials from status/list. Project creation is not public signup. IAM setup identities must be restricted to the intended operators.

Deployment creation body:

```json
{
  "projectId": "p0123456789abcdef",
  "framework": "vite",
  "commitSha": "abcdef0",
  "files": [{
    "path": "index.html",
    "size": 5,
    "contentType": "text/html; charset=utf-8",
    "sha256": "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
  }]
}
```

That checksum corresponds to the exact five bytes `hello`. `framework` is `vite`, `astro`, `next-static`, or `static`; `commitSha` is optional, 7–40 lowercase hexadecimal characters. Paths use ASCII letters/digits and `_@.-`, with `/` between segments. Absolute paths, dot segments, escapes, backslashes, duplicate paths, unsupported extensions, and mismatched MIME types are rejected. The exact extension-to-MIME allowlist is in `domain.mjs`. A nonempty root `index.html` is mandatory.

`Idempotency-Key` is 8–128 letters/digits/underscores/hyphens. Reusing it within a project with the same normalized manifest returns the existing deployment, even after ready; a changed request returns `409`. Different projects have separate keys. `commitSha`, framework, paths, sizes, MIME, and checksums are part of request identity; input file order is not.

## Upload and finalization contract

- At most 500 files and **25 MiB (26,214,400 bytes)** total; file sizes must be safe nonnegative integers. JSON request bodies are capped at 220,000 bytes.
- Upload window: 15 minutes from creation. Each signed URL lasts at most five minutes and never outlives that window. Retry creation with the same manifest/key to refresh URLs within the window.
- Upload each `uploads[]` entry using its exact `method`, `url`, `headers`, and file bytes. Headers bind length, MIME, cache policy, SHA-256, and `If-None-Match: *`. Altered bytes/checksums or URL paths fail S3 validation/signature checks. Reuploading an existing object returns `412`; when retrying, a successfully uploaded immutable file can be skipped.
- Keys are `deployments/<projectId>/<deploymentId>/<path>`. Tokens only authorize their project. Clients receive individual signed object URLs, never AWS credentials or a wildcard prefix grant. The Lambda role has no artifact delete permission and denies PUT without the create-only header.
- Finalization checks the full S3 object listing, exact sizes, checksums, MIME, and cache headers. Missing files return `409` and remain retryable. Mismatched uploads return `422` and become `failed`. Expired finalization returns `409` and becomes `failed`.
- DynamoDB conditionally creates deployments and conditionally transitions `uploading` to `ready` or `failed`. Concurrent successful finalizers converge on the same ready record; ready/failed records cannot be overwritten. Transient AWS failures return `500` without leaking service details and can be retried.
- Only ready responses include a preview URL. Hosting paths are public, and a known path can be fetched as soon as its object is uploaded; state is **not** a CDN authorization gate. Use trusted private-alpha builds only. All previews share one origin, and SPA history fallback is deferred to the release gate.

Status/list return file count and bytes without returning token hashes, manifests, or internal keys. Lists use descending deployment-ID order (not chronological order) and must be paginated until `nextCursor` is null. Logs are bounded state summaries, not build stdout. Expired abandoned deployments remain `uploading` until finalize is attempted; no scheduled worker is introduced.

## Schema and retention

`Projects`: partition key `projectId`; `name`, `createdAt`, random `salt`, `tokenHash`.

`Deployments`: partition key `projectId`, sort key `deploymentId`; normalized manifest, request hash, framework, commit SHA, total bytes, status, creation/upload-expiry/ready timestamps, bounded logs. Conditional writes enforce idempotency and terminal transitions; reads and project queries are strongly consistent. No scan permission or secondary index is required.

Both tables are encrypted with the AWS-managed DynamoDB key and retained on stack deletion. Artifact objects expire after seven days; CloudFront copies may survive another day. Metadata can therefore outlive preview artifacts. The platform is currently a short-lived preview alpha, not durable production hosting.

## Teardown

Run `npm run destroy:api` to remove the API, Lambda, execution role, and log group. The two metadata tables deliberately remain; record their names from `control-outputs.json` and delete them explicitly in DynamoDB only after reviewing/exporting the records. Delete test artifact prefixes explicitly or wait for the hosting lifecycle. Remove the hosting stack using the root README procedure. CDK bootstrap resources are shared account infrastructure: retain them if another CDK app uses them; otherwise empty their versioned asset bucket and remove `CDKToolkit` after all dependent stacks are gone. Do not use the milestone 1 delete helper for API deployment IDs; it deliberately rejects them.
