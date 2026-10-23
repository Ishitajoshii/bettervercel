# Better Vercel on AWS PRD

## Product decision

Build a lecrev-like deployment experience on AWS that targets **$0–$5/month at low traffic**, measured before promotional credits. It should feel like lecrev: create a project, deploy a commit, see states and logs, and open an immutable preview URL. Free allowances depend on account eligibility and usage; budget alerts do not enforce a hard spending cap.

The first product is a static-hosting platform for Vite, React, Astro, and Next.js static export. It does not run arbitrary server code or server-side-rendered Next.js in version one.

This is a real deploy system—not a UI demo—with projects, immutable deployments, deploy logs, preview URLs, and rollback. Copy lecrev's useful product model, not its expensive runtime topology.

## Non negotiable cost rule

No always-running servers. No EC2, Lightsail, NAT Gateway, RDS, load balancer, paid DNS zone, Docker builder fleet, or managed Kubernetes.

A Lightsail instance can fit a $5 ceiling, but the $5 plan has only 512 MB RAM; it is not credible infrastructure for a Go control plane, database, queue, reverse proxy, and untrusted JavaScript builds. The AWS serverless free allowances are a better foundation for a quiet private alpha: Lambda includes 1M requests and 400,000 GB-seconds per month, while CloudFront includes an always-free allowance. [AWS Lambda pricing guidance](https://docs.aws.amazon.com/prescriptive-guidance/latest/optimize-costs-microsoft-workloads/net-serverless.html) [AWS Free Tier usage tracking](https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/tracking-free-tier-usage.html)

Builds run outside AWS at first:

- Local CLI for manual deployments: build on the developer machine, then upload the output to AWS.
- GitHub Actions for repository deployments: build static output there, then call the AWS deploy API.

That preserves an AWS-hosted product without paying for idle or per-minute build infrastructure. CodeBuild is a later opt-in, never the default path.

## What users can do

| User action | Result |
| --- | --- |
| Create project | Gets a project ID and deploy token |
| Run `bettervercel deploy` | CLI builds locally and creates an immutable deployment |
| Push to configured GitHub repo | GitHub Actions creates the same deployment |
| Open deployment | Gets cached HTTPS preview URL: `…cloudfront.net/d/<deployment-id>/` |
| Inspect status/logs | Sees uploading, ready, or failed with a small retained log |
| Roll back | Points production alias at a prior immutable deployment |
| Delete | Removes preview access and schedules artifact cleanup |

## Not in v1

- Next.js SSR, API routes, middleware, Edge Runtime, cron, image optimization, or arbitrary functions.
- Firecracker microVMs, EC2 workers, warm snapshots, NATS, PostgreSQL, and multi-region scheduling.
- GitHub App/OAuth, GitLab, custom domains, billing, teams, and public sign-up.
- User-controlled hosted build commands. Build only runs from trusted local machines or GitHub Actions.

`lecrev` already implements a larger architecture: split control/build/execution planes, Firecracker execution, Postgres, NATS, S3/MinIO, function URLs, and Next.js previews. It is a strong reference for lifecycle/API shape and static/Next packaging, but operating those planes defeats this budget. [lecrev](https://github.com/theg1239/lecrev)

## AWS architecture

```text
Local CLI or GitHub Actions
        | builds static output
        | requests presigned upload URL
        v
API Gateway HTTP API -> control Lambda -> DynamoDB
                              |             (projects, deployment state, token hashes)
                              v
                   private S3 bucket (immutable artifacts)
                              |
Browser -> CloudFront --------+-> /d/<deployment-id>/...
```

| Component | AWS choice | Cost discipline |
| --- | --- | --- |
| Dashboard | Static files in the same private S3 bucket, CloudFront-delivered | No web server |
| API | API Gateway HTTP API + Lambda | No provisioned concurrency |
| Metadata | DynamoDB on-demand | Tiny deployment records only |
| Artifacts | Private S3 + CloudFront Origin Access Control | Cap size; expire old artifacts |
| Delivery | One CloudFront distribution | AWS hostname initially; no Route 53 hosted zone |
| Logs | DynamoDB summary and optional CloudWatch, 3–7 day retention | Never retain large logs |
| Secrets | SSM Parameter Store SecureString if needed | Hash deploy tokens; never store raw tokens |

Keep it out of a VPC. A VPC adds no value here, and NAT gateways are a common accidental bill.

## Deployment lifecycle

1. CLI or GitHub Actions runs the framework build and produces `dist`, `build`, or Next.js `out`.
2. Client calls `POST /v1/deployments` with project ID, commit SHA, framework, artifact manifest, and idempotency key.
3. Lambda verifies deploy token, creates an `uploading` record, and returns presigned S3 URLs scoped to `artifacts/<project>/<deployment>/`.
4. Client uploads files directly to private S3 and calls `POST /v1/deployments/<id>/finalize`.
5. Lambda validates manifest/object list, atomically marks it `ready`, and returns the CloudFront preview URL.
6. CloudFront serves the immutable prefix. SPA fallback applies only if the framework declares it.
7. A production alias is a small DynamoDB pointer resolved by a redirect API at first; custom domains wait.

## Reuse plan for lecrev

Fork it and record exact commit SHA and license. Keep any reused code behind local interfaces.

| Reuse/adapt | Design reference | Exclude |
| --- | --- | --- |
| Deployment states, CLI ergonomics, artifact manifest ideas, static/Next output normalization | Control-plane endpoints, idempotency, preview semantics, docs | Firecracker, node agent, rootfs, EC2 scripts, NATS, Postgres, coordinator |
| `internal/build` ideas for framework detection/output packaging | Function lifecycle/status flows | Hosted build worker and arbitrary build execution |

Do not copy code until its license is reviewed. Start by reproducing lifecycle behavior from docs/tests, then port isolated helpers where boundaries are clear.

## Acceptance criteria

- Vite and Next.js static-export samples deploy through both CLI and GitHub Actions.
- A deployment gets an immutable URL within two minutes after the local/Actions build ends.
- Later deployments cannot overwrite earlier artifacts.
- A token cannot write outside its project prefix.
- Malformed/missing uploads cannot become `ready`.
- Dashboard shows project, deployment state, commit, time, size, preview, and concise logs.
- Cost Explorer and Free Tier dashboard show $0 for a low-traffic test month, excluding pre-existing charges.

## Ordered to do list

### Milestone 0 — cost safety

- [x] Confirm account plan and Free Tier usage via AWS CLI (active Free plan; checked October 23, 2026).
- [ ] Enable root MFA; use an admin IAM identity for setup.
- [x] Create monitoring-only $5 monthly AWS Budget with alerts above $1, $3, and $5, excluding credits/refunds.
- [ ] Enable cost anomaly detection; set log retention to 3 days.
- [x] Select `ap-south-1` and document the teardown procedure in README.

### Milestone 1 — static deployment proof

- [x] Create IaC (AWS CDK TypeScript), sample Vite site, upload/verify/delete scripts, and local infrastructure/routing checks.
- [x] Deploy private encrypted S3 bucket, public access block, seven-day artifact expiry, and CloudFront OAC.
- [x] Deploy one CloudFront distribution mapping `/d/*` to bucket paths.
- [x] Upload Vite `dist/` under `deployments/milestone-1/` using the operator upload script.
- [x] Verify HTTPS, asset paths, cache hits, correct MIME/content, and that S3 is not public.
- [x] Delete disposable `milestone-1-delete-check` objects, invalidate cached copies, and confirm its URL returns 403. Main preview remains available.

### Milestone 2 — deploy API

- [ ] Create DynamoDB `Projects` and `Deployments` schema.
- [ ] Create API Gateway HTTP API and Lambda control handler.
- [ ] Implement project creation, deployment create/finalize, deployment get, and project deployment list endpoints.
- [ ] Generate raw deploy token once; retain only salted hash.
- [ ] Generate short-lived prefix-scoped presigned upload URLs.
- [ ] Enforce 25 MB artifact limit, file-count/MIME limits, idempotency, and status transitions.
- [ ] Test token validation, prefix isolation, manifests, and concurrent finalization.

### Milestone 3 — CLI

- [ ] Create `login`, `init`, `deploy`, `status`, and `logs` commands.
- [ ] Detect Vite, Astro, React static output, and Next static export; otherwise require explicit output directory.
- [ ] Run local build only from explicit project configuration.
- [ ] Build file manifest with relative path, type, cache-control, and SHA-256.
- [ ] Upload with a small concurrency limit and finalize only if every upload succeeded.
- [ ] Print preview URL, deployment ID, and useful failure remediation.

### Milestone 4 — dashboard and GitHub workflow

- [ ] Build a static dashboard: projects, deployments, state, preview, delete.
- [ ] Use operator-created API key; no self-serve signup.
- [ ] Provide copy-paste GitHub Actions workflow using encrypted repository deploy token.
- [ ] Send branch/PR metadata through workflow environment variables.
- [ ] Document supported frameworks and Next static-export setup.

### Milestone 5 — release gate

- [ ] Test two projects and prove tokens cannot cross-write.
- [ ] Test empty artifact, interrupted upload, duplicate finalize, large file, and SPA fallback.
- [ ] Review IAM: no wildcard write/read beyond required prefixes.
- [ ] Verify lifecycle policies, logs, Free Tier, budget alert email, and teardown procedure.
- [ ] Deploy 2–3 own sites before letting anyone else in.

## Later upgrade path

1. Custom domains only after users bring an existing DNS domain; Route 53 hosted zones have a recurring charge.
2. Managed CodeBuild as a quota-limited beta; retain local/GitHub build path.
3. Experimental Next standalone-to-Lambda SSR adapter with strict duration/memory/concurrency limits.
4. GitHub App, teams, billing, other frameworks.
5. Firecracker/EC2 execution only once paid usage proves it worth operating.

## First concrete objective

```text
bettervercel deploy ./examples/vite-site
→ builds locally
→ uploads immutable files to private S3
→ finalizes DynamoDB deployment record
→ prints CloudFront preview URL
```

If that is not reliable, cheap, and easy to tear down, do not add SSR or hosted builds.
