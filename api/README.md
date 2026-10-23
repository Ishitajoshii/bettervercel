# Deploy API

The control plane uses an API Gateway HTTP API, one ARM64 Node.js 24 Lambda, three DynamoDB on-demand tables, and the existing private artifact bucket. The third table stores expiring GitHub sign-in/setup records and durable project ownership links. Lambda is outside a VPC, has no provisioned concurrency, and writes only to its own log group (three-day retention). The HTTP API is throttled to 5 requests/second with burst 10. Throttles and budget alerts are not hard spending caps.

The optional [GitHub import flow](../docs/github-import.md) adds `/v1/github/*` endpoints for OAuth, repo/branch discovery, root detection, workflow setup, and build status. Its opaque session tokens can access only projects owned by the authenticated GitHub user. Existing project bearer tokens and operator IAM project creation remain available. GitHub OAuth client secrets are read from one explicitly permitted Secrets Manager ARN.

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

`verify:api` creates two disposable test projects and one tiny deployment in each. It checks operator IAM auth, token isolation for all project routes in both directions, signed prefix tampering in both directions, empty artifacts, per-file/aggregate size limits, duplicate create, interrupted upload and resumption, checksum/overwrite rejection, concurrent and duplicate finalize, isolated lists, and actual preview bytes from both projects. Build the multi-file Vite sample first. Successful runs save a credential-free evidence report under ignored `.build/release-gate-api-<timestamp>.json`; the report also names the release checks this command does not cover. It never logs deploy tokens or upload URLs. Artifacts expire after seven days; both projects and deployment records remain until explicitly removed. These smoke fixtures do not replace the PRD's own-site acceptance requirement.

## Authentication and endpoints

| Method and route | Authentication | Result |
| --- | --- | --- |
| `POST /v1/projects` | AWS SigV4, IAM `execute-api:Invoke` on this route | `201`: project ID and one-time deploy token |
| `POST /v1/deployments` | Project bearer token; `Idempotency-Key` header | `201` new / `200` same request: state and signed PUT instructions |
| `POST /v1/deployments/{id}/finalize` | Owning project's bearer token | `200` ready after S3 verification |
| `GET /v1/deployments/{id}` | Owning project's bearer token | Summary, state, timestamps, preview, retained log |
| `GET /v1/projects/{id}/deployments?cursor=...` | Owning project's bearer token | Up to 20 summaries plus `nextCursor` |
| `GET /v1/projects/{id}` | Owning project's bearer token | Project ID, name, creation time; no credential material |
| `DELETE /v1/deployments/{id}` | Owning project's bearer token | `202` deleting / `200` deleted after cache removal; retry safely |

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

That checksum corresponds to the exact five bytes `hello`. `framework` is `vite`, `astro`, `next-static`, or `static`; `commitSha` is optional, 7–40 lowercase hexadecimal characters. Optional `branch` is 1–255 characters without control characters; `pullRequest` is an integer from 1 to 2,147,483,647. Paths use ASCII letters/digits and `_@.~-`, with `/` between segments. Absolute paths, dot segments, escapes, backslashes, duplicate paths, unsupported extensions, and mismatched MIME types are rejected. The exact extension-to-MIME allowlist is in `domain.mjs`. A nonempty root `index.html` is mandatory.

Optional `routing` is `static` (the default) or `spa`. SPA mode is rejected for `next-static`. Responses include the routing mode; SPA preview URLs end in `/d/<id>/_spa/`. The root `_spa` manifest directory is reserved. Deploy the updated hosting router and API together before enabling this option; see [SPA configuration and live verification](../docs/frameworks-and-actions.md#opt-in-spa-history-routing).

`Idempotency-Key` is 8–128 letters/digits/underscores/hyphens. Reusing it within a project with the same normalized manifest returns the existing deployment, even after ready; a changed request returns `409`. Different projects have separate keys. `commitSha`, framework, routing, paths, sizes, MIME, and checksums are part of request identity; input file order is not. Explicit `static` and omitted routing preserve legacy hashes. Changing to/from SPA with the same key returns a conflict, not a second deployment.

## Upload and finalization contract

- At most 500 files and **25 MiB (26,214,400 bytes)** total; file sizes must be safe nonnegative integers. JSON request bodies are capped at 220,000 bytes.
- Upload window: 15 minutes from creation. Each signed URL lasts at most five minutes and never outlives that window. Retry creation with the same manifest/key to refresh URLs within the window.
- Upload each `uploads[]` entry using its exact `method`, `url`, `headers`, and file bytes. Headers bind length, MIME, cache policy, SHA-256, and `If-None-Match: *`. Altered bytes/checksums or URL paths fail S3 validation/signature checks. Reuploading an existing object returns `412`; when retrying, a successfully uploaded immutable file can be skipped.
- Static keys are `deployments/<projectId>/<deploymentId>/<path>`; SPA keys are `deployments/<projectId>/_spa/<deploymentId>/<path>`. Both remain inside the existing project IAM prefix. Tokens only authorize their project. Clients receive individual signed object URLs, never AWS credentials or a wildcard prefix grant. The Lambda role can delete project artifacts for the authenticated deletion route and denies PUT without the create-only header. CloudFront invalidation permission is limited to this distribution.
- Finalization checks the full S3 object listing, exact sizes, checksums, MIME, and cache headers. Missing files return `409` and remain retryable. Mismatched uploads return `422` and become `failed`. Expired finalization returns `409` and becomes `failed`.
- DynamoDB conditionally creates deployments and uses compare-and-set status transitions. Concurrent successful finalizers converge on the same ready record. Manifest/artifact contents cannot be overwritten. Deletion transitions `uploading`, `ready`, or `failed` to `deleting`, then `deleted`. Transient AWS failures return `500` without leaking service details and can be retried.
- Only ready responses include a preview URL. Hosting paths are public, and a known path can be fetched as soon as its object is uploaded; state is **not** a CDN authorization gate. Use trusted private-alpha builds only. All previews share one origin. Opt-in SPA fallback rewrites extensionless routes inside its separate storage namespace; dotted paths remain exact object requests.

Status/list return file count and bytes without returning token hashes, manifests, or internal keys. Lists use descending deployment-ID order (not chronological order) and must be paginated until `nextCursor` is null. Logs are bounded state summaries, not build stdout. Expired abandoned deployments remain `uploading` until finalize is attempted; no scheduled worker is introduced.

Deletion returns `409` until 16 minutes after creation (the upload window plus a one-minute margin). It conditionally marks the record deleting, removes exact manifest keys, and issues an idempotent invalidation covering viewer and rewritten storage paths. Repeat DELETE until it returns deleted; GET is read-only and does not drive cleanup. If the client disconnects, resume DELETE later. Records remain as immutable-ID tombstones. See [dashboard and workflow operations](../docs/frameworks-and-actions.md).

Branch/PR metadata is included in summaries and request identity when supplied. Existing requests without these fields retain their original request hash. API CORS permits GET/DELETE with Authorization only from the configured CloudFront origin; project creation still requires SigV4 IAM authentication.

## Schema and retention

`Projects`: partition key `projectId`; `name`, `createdAt`, random `salt`, `tokenHash`.

`Deployments`: partition key `projectId`, sort key `deploymentId`; normalized manifest, request hash, framework, commit SHA, total bytes, status, creation/upload-expiry/ready timestamps, bounded logs. Conditional writes enforce idempotency and terminal transitions; reads and project queries are strongly consistent. No scan permission or secondary index is required.

Both tables are encrypted with the AWS-managed DynamoDB key and retained on stack deletion. Artifact objects expire after seven days; CloudFront copies may survive another day. Metadata can therefore outlive preview artifacts. The platform is currently a short-lived preview alpha, not durable production hosting.

## Teardown

Run `npm run destroy:api` to remove the API, Lambda, execution role, and log group. The two metadata tables deliberately remain; record their names from `control-outputs.json` and delete them explicitly in DynamoDB only after reviewing/exporting the records. Delete test artifact prefixes explicitly or wait for the hosting lifecycle. Remove the hosting stack using the root README procedure. CDK bootstrap resources are shared account infrastructure: retain them if another CDK app uses them; otherwise empty their versioned asset bucket and remove `CDKToolkit` after all dependent stacks are gone. Do not use the milestone 1 delete helper for API deployment IDs; it deliberately rejects them.
