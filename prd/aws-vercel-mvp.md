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
3. Lambda verifies deploy token, creates an `uploading` record, and returns presigned S3 URLs scoped to `deployments/<project>/<deployment>/`.
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
- [x] Enable root MFA; confirm setup identity. Root MFA verified enabled October 24. Owner explicitly prefers the existing root-backed `bettervercel` profile for this demo; the original non-root admin setup requirement is deferred for this demo and does not block rollout.
- [x] Create monitoring-only $5 monthly AWS Budget with alerts above $1, $3, and $5, excluding credits/refunds.
- [x] Enable cost anomaly detection; set log retention to 3 days. Existing monitor/email subscription and live three-day logs verified October 24; lowering the default anomaly threshold is tracked in `TODO.md`.
- [x] Select `ap-south-1` and document the teardown procedure in README.

### Milestone 1 — static deployment proof

- [x] Create IaC (AWS CDK TypeScript), sample Vite site, upload/verify/delete scripts, and local infrastructure/routing checks.
- [x] Deploy private encrypted S3 bucket, public access block, seven-day artifact expiry, and CloudFront OAC.
- [x] Deploy one CloudFront distribution mapping `/d/*` to bucket paths.
- [x] Upload Vite `dist/` under `deployments/milestone-1/` using the operator upload script.
- [x] Verify HTTPS, asset paths, cache hits, correct MIME/content, and that S3 is not public.
- [x] Delete disposable `milestone-1-delete-check` objects, invalidate cached copies, and confirm its URL returns 403. Main preview remains available.

### Milestone 2 — deploy API

- [x] Create DynamoDB `Projects` and `Deployments` schema.
- [x] Create API Gateway HTTP API and Lambda control handler.
- [x] Implement project creation, deployment create/finalize, deployment get, and project deployment list endpoints.
- [x] Generate raw deploy token once; retain only salted hash.
- [x] Generate short-lived prefix-scoped presigned upload URLs.
- [x] Enforce 25 MiB artifact limit, file-count/MIME limits, idempotency, and status transitions.
- [x] Test token validation, prefix isolation, manifests, and concurrent finalization.

Audit and live verification on October 23, 2026:

- `npm run check` passed TypeScript checking, API bundling, and all 30 tests. Both hosting and control-stack synthesis succeeded. CloudFormation reports hosting `UPDATE_COMPLETE`, control plane `CREATE_COMPLETE`, and bootstrap `CREATE_COMPLETE`.
- Milestone 1 was reverified against AWS: HTTPS/canonical redirects, exact HTML/JS/CSS and MIME, cache hits, S3 encryption/public-access blocks, and anonymous S3 denial. A fresh `audit-20261023-m1` preview was uploaded, verified, deleted, and invalidated; its URL returned 403 afterward. The original `milestone-1` preview remains available.
- Fixed nested-directory redirects so relative assets resolve correctly. Added bounded retries to the fresh CDN cache-hit check. The updated CloudFront function also routes API deployments through their owning project prefix; the hosting update preserved the bucket, distribution, and budget.
- Deployed `BetterVercelControlStack` in `ap-south-1`. The live API smoke test passed IAM-only project creation, separate project tokens, cross-project create/read/list/finalize denial, path and size validation, idempotent create/conflict, incomplete finalize, signed S3 uploads, checksum enforcement, overwrite denial, changed-prefix signature denial, concurrent finalize, status/list, and byte-for-byte preview delivery.
- [Live API-created preview](https://d34mbpew2lb7ue.cloudfront.net/d/p98bba9981bb88a5e-5b2aefa02b022f413a1194297d2829a0/). It expires under the seven-day artifact lifecycle. API endpoint: `https://bubil63r3f.execute-api.ap-south-1.amazonaws.com`.
- Browser click verification remains manual: both browser automation helpers failed at startup. All HTTP/content and API checks ran against real deployed resources.
- See [API contracts, security boundaries, schema and teardown](../api/README.md). Public previews share an origin; known uploaded paths are accessible before finalization. SPA fallback, production aliases, deletion APIs, durable hosting retention, and the CLI remain later work.

### Milestone 2 follow-up review

Reviewed all seven tasks against the implementation and reran the original 30 local tests before starting the CLI. This review did not repeat the earlier live AWS verification.

| Task | Evidence | Result |
| --- | --- | --- |
| Projects/Deployments schema | `infra/control-plane-stack.ts`, `api/aws.mjs`; schema and adapter tests | Implemented; encrypted on-demand tables, project keys, retained metadata |
| HTTP API and Lambda | Five routes, IAM project creation, application token checks, throttled stage; infrastructure tests | Implemented |
| Create/finalize/get/list endpoints | `api/handler.mjs`; endpoint, retry, and summary tests | Implemented |
| One-time tokens and salted hashes | `issueToken`/`verifyToken`; token-storage and invalid-token tests | Implemented |
| Short-lived scoped upload URLs | `api/aws.mjs`; real presigner and prefix-isolation tests | Implemented; checksum, size, MIME, cache and create-only headers signed |
| Limits, idempotency, transitions | `normalizeRequest`, conditional DynamoDB operations, deadline checks; boundary/race tests | Implemented; 500 files, 25 MiB, 220 KB request body |
| Security and concurrency tests | Token isolation, malformed/missing objects, immutable writes, simultaneous create/finalize | All original 30 tests passed |

Existing limitations remain explicit: public previews share an origin, known uploads are accessible before finalization, artifacts expire after seven days, and SPA fallback is deferred. None of those deferred features was marked complete by this review.

### Milestone 3 — CLI

- [x] Create `login`, `init`, `deploy`, `status`, and `logs` commands.
- [x] Detect Vite, Astro, React static output, and Next static export; otherwise require explicit output directory.
- [x] Run local build only from explicit project configuration.
- [x] Build file manifest with relative path, type, cache-control, and SHA-256.
- [x] Upload with a small concurrency limit and finalize only if every upload succeeded.
- [x] Print preview URL, deployment ID, and useful failure remediation.

Local implementation and verification:

- Added the package's `bettervercel` executable and `npm run cli -- ...`; see [the CLI guide](../cli/README.md).
- Configuration-only init, verified project-token login, explicit builds, bounded artifact snapshots, four concurrent uploads by default, idempotent retries, and status/logs through the existing API. Credentials are stored separately from project configuration; CLI state contains no token or signed URL.
- `npm run check` passed all 41 tests, including 11 CLI tests. The CLI integration uses real loopback HTTP with the milestone 2 handler and checks upload failure without finalization, immutable resume, ready retries, changed-manifest conflicts, status/logs, and credential handling. No AWS infrastructure or live project records were changed for this milestone.
- The initial implementation left live CLI and Next export verification open. The follow-up review below closes the HTTP/content portion of those checks; interactive browser verification remains pending.

### Milestone 3 follow-up review — October 24, 2026 (IST)

All six CLI tasks were reviewed against code and tests. The original 41 tests passed before changes. Live review found and fixed two framework gaps: build commands now receive the deterministic `BETTERVERCEL_BASE_PATH` / deployment ID, and the CLI/API manifest allowlists accept `~` in Next Turbopack chunk filenames. HTML paths that escape the deployment prefix now fail before upload with build-configuration guidance. Existing requests without branch/PR metadata retain their original idempotency hash.

- Live Vite: local build, saved login, deploy, status/logs, all 3 files byte-for-byte through CloudFront, and MIME checks passed. Build plus deployment and HTTP verification took 5.6 seconds.
- Live Next.js 16.4.3: real static export, 19 verified files (398,084 bytes), chunk paths, and `/about/` directory navigation passed. Build plus deployment and HTTP verification took 16 seconds. [Next preview](https://d34mbpew2lb7ue.cloudfront.net/d/p7f0c6e2a840a04ed-866563d5bc4878abfc74c66208bcc3b1/).
- The new fixture's production dependency audit reports zero vulnerabilities. `npm run verify:cli` records reproducible results under ignored `.build/cli-smoke-*/`; credentials remain in a separate ignored file and are never printed.
- Browser automation failed at Windows sandbox startup, including after a reset. Real browser hydration/click verification is not claimed; HTTP/content checks and dashboard DOM interaction tests passed.

### Milestone 4 — dashboard and GitHub workflow

- [x] Build a static dashboard: projects, deployments, state, preview, delete.
- [x] Use operator-created API key; no self-serve signup.
- [x] Provide copy-paste GitHub Actions workflow using encrypted repository deploy token.
- [x] Send branch/PR metadata through workflow environment variables.
- [x] Document supported frameworks and Next static-export setup.

Implementation and verification:

- [Live dashboard](https://d34mbpew2lb7ue.cloudfront.net/dashboard/): connect multiple operator-created projects; inspect paginated deployment state, commit, branch/PR, timestamps, bytes, preview and logs; disconnect to clear credentials. Tokens remain in tab memory. No public account creation or global administrative browser token was introduced.
- Added authenticated project details and deployment deletion, exact manifest-key removal, retryable partial failure, and deterministic CloudFront invalidation of viewer and rewritten paths. Deletion waits until 16 minutes after creation so signed uploads have expired; clients repeat DELETE until cache removal completes. Interrupted deletion can be resumed. Metadata tombstones retain immutable IDs.
- Both existing AWS stacks updated successfully after review of their diffs. No bucket/table replacements or always-running compute. Dashboard uses a dedicated no-cache behavior and security headers. API CORS permits the hosting origin; S3 delete and CloudFront invalidation permissions are scoped to project artifacts and the existing distribution.
- All 51 tests passed: original coverage plus framework paths/Turbopack names, metadata/idempotency, token isolation, deletion retries/cache completion, dashboard authentication/rendering/deletion, and infrastructure/routing. The original live API security smoke test also passed again after deployment.
- Live dashboard asset delivery/headers, CORS allow/deny, authenticated project details, branch/PR metadata, cross-project deletion denial, and the active-upload deletion guard passed. The original disposable Vite deployment was deleted after the upload window; CloudFront invalidation completed, its cached preview returned 403, a duplicate DELETE succeeded, and the separate Next project remained accessible. Results are in ignored `.build/cli-smoke-1792781813797/milestone-4-results.json`. The newer [Vite metadata preview](https://d34mbpew2lb7ue.cloudfront.net/d/p340dc4351eb589f8-a95d06f8fd093ce9924371dcb640144b/) remains available.
- Post-deployment diffs for both stacks report no differences. The bucket, distribution, existing budget, and metadata tables were preserved.
- [Workflow template](../examples/github-actions/deploy.yml) uses an encrypted repository token, read-only GitHub permissions, trusted same-repository PRs, and environment variables for branch/PR metadata. [Setup and framework guide](../docs/frameworks-and-actions.md) covers vendoring this unpublished CLI, Vite/Astro/React/Next configuration, retries, and dashboard operations. A hosted GitHub Actions run has not been performed; the milestone task is to provide the workflow, while running both sample deployments in GitHub remains release acceptance work.
- Existing limitations remain: trusted projects share a browser origin; known uploaded paths are public before finalize; artifacts expire after seven days; SPA fallback, origin isolation, production aliases, and browser interaction acceptance remain open.

### Milestone 4 follow-up review — October 24, 2026 (IST)

Reviewed every milestone 4 task against the implementation; the original 51 tests passed before changes.

| Task | Evidence | Result |
| --- | --- | --- |
| Static dashboard: projects, deployments, state, preview, delete | `dashboard/app.js`, `tests/dashboard.test.mjs`, authenticated GET/DELETE handlers and deletion adapter tests | Implemented; DOM tests verify authentication, safe text rendering, token clearing and confirmed deletion through cache completion |
| Operator-created API key; no public signup | IAM-only `POST /v1/projects`, salted per-project deploy-token hashes, dashboard in-memory credentials, route/auth tests | Implemented with operator-issued project tokens; no global browser admin key |
| Copy-paste encrypted-token GitHub workflow | `examples/github-actions/deploy.yml`, `docs/frameworks-and-actions.md` | Provided; read-only repository permissions, no checkout credentials retained, same-repository trusted PRs only, secret passed through the environment |
| Branch/PR metadata | Workflow environment, CLI metadata test, API normalization/idempotency tests, dashboard metadata rendering | Implemented and tested |
| Framework and Next static-export documentation | `docs/frameworks-and-actions.md`, `cli/README.md`, runnable Vite/Next fixtures | Documented, including deployment base paths, Next directory export, unsupported server features and current SPA limitation |

This review does not claim a hosted GitHub Actions run or browser hydration/click acceptance. Those remain release acceptance work. Earlier milestone 4 live delivery/CORS/deletion evidence above was not rerun here; the expanded live API release checks below are new.

### Milestone 5 — release gate

- [x] Test two projects and prove tokens cannot cross-write.
- [x] Test empty artifact, interrupted upload, duplicate finalize, large file, and SPA fallback.
- [x] Review IAM: no wildcard write/read beyond required prefixes.
- [ ] Verify lifecycle policies, logs, Free Tier, budget alert email, and teardown procedure.
- [ ] Deploy 2–3 own sites before letting anyone else in.

Initial release-gate work — October 24, 2026 (IST):

- `npm run check` passed TypeScript checking, API bundling and all 56 tests. Hosting synthesis/read-only live CDK diff succeeded: the only change is the narrowed S3 bucket-policy read grant, with no resource replacement or budget change. Control-plane synthesis also succeeded. No infrastructure update was deployed in this review.
- Fixed the default API test fixture to issue independent tokens for its two projects. Added a bidirectional authorization matrix covering create, project details, list, get, finalize and delete; denied calls leave records, signed URLs and cleanup unchanged. The deletion test advances beyond the upload guard so it specifically proves authorization.
- Extended `npm run verify:api` to deploy into two independent projects and exercise token/presigned-prefix isolation in both directions. It also checks empty and zero-byte artifacts, per-file and aggregate size rejection, partial-upload rejection, resumption without extending the deadline, immutable writes, checksum enforcement, concurrent/duplicate finalize, isolated lists and exact preview bytes. The live run passed in approximately 23 seconds. Credential-free evidence: ignored `.build/release-gate-api-1792783626667.json`; projects `pe1203976c47982d3` and `p909eca10c2e6842d`. Two disposable previews were created; existing sites were not changed. Artifacts expire after seven days and metadata is retained.
- Reviewed synthesized runtime IAM permissions: exact metadata tables, own log group, project artifact prefix, prefix-conditioned bucket listing, create-only PUT deny and the existing CloudFront distribution. Added exact resource/action regression checks, including rejection of extra or managed policy grants. The shared Lambda role spans all projects; the handler's project authentication and signed object keys enforce per-token isolation.
- Found CDK's generated CloudFront OAC grant read the entire artifact bucket. Narrowed its resources in source to `deployments/*` and `dashboard/*`, preserving the exact distribution condition, TLS deny and resource identities. This hosting policy change is pending deployment and live verification, so the IAM release task remains unchecked. The TLS deny's broad action is intentional and grants no access.
- Local infrastructure checks cover seven-day artifact expiry, one-day incomplete multipart cleanup, three-day logs, retained metadata and $1/$3/$5 budget-email configuration. Clarified control-plane-first teardown and retained tables in the root README. Current Free Tier/cost data, actual alert-email receipt and a teardown rehearsal have not been verified in this review; that combined task remains unchecked.
- At this initial checkpoint SPA history fallback was unimplemented. The upload edge cases above passed locally and live, but the combined task stays open until explicit per-deployment fallback works without masking missing assets or unrelated deployments. The two disposable smoke fixtures do not count as 2–3 accepted own sites. Hosted Vite/Next Actions runs, browser interaction acceptance, shared-origin isolation and the low-traffic month cost criterion remain open.

### Milestone 5 follow-up — checklist, SPA implementation and operations audit

The complete remaining-work checklist, including product decisions and deferred upgrades, is now [TODO.md](../TODO.md).

- Implemented opt-in `routing: "spa"` through configuration, CLI, API normalization, immutable request identity, storage prefixes and the CloudFront router. Static behavior and old static request hashes are preserved. SPA URLs use `/d/<id>/_spa/`; only extensionless paths fall back to the deployment's root HTML. Dotted paths remain exact requests. SPA storage is `deployments/<project>/_spa/<id>/`, so static deployments cannot acquire fallback by changing their viewer URL. Next static export remains static-only.
- Added CLI checks for relative HTML URLs that break at deep links and for older APIs that silently ignore routing mode. Existing project permissions cover the SPA namespace. Added tests for API/CLI routing contracts, token isolation, idempotency conflicts, deep paths/queries, exact asset paths, traversal rejection, validation/deletion/invalidation, retries and older-server rejection.
- `npm run check` passes all **62 tests**. `scripts/verify-spa.mjs` passes syntax checking and is available as `npm run verify:spa` for post-deployment acceptance; it has not been run against AWS yet. The script builds two Vite fixtures and verifies static/SPA behavior, bytes/MIME, namespace isolation, missing assets, unknown deployments and post-build timing.
- Read-only CDK diffs show only the hosting bucket-policy restriction and router code, plus control Lambda code. No new AWS services, IAM grants or resource replacements. Hosting/API deployment and live SPA verification remain open. Both local profiles (`default`, `bettervercel`) and the AWS connector identify as root; the PRD's non-root setup identity is needed before rollout.
- Live AWS APIs confirm root MFA is enabled, artifact expiry is seven days, incomplete multipart cleanup is one day and the control log group retains three days. Retention is complete in the checklist. Evidence is in ignored `.build/operations-audit-20261024.json`.
- An existing SERVICE anomaly monitor and DAILY email subscription are active; its subscriber is confirmed. The current threshold requires both $100 and 40% impact, so budget-appropriate threshold adjustment remains open. The $5 budget is healthy, excludes credits/refunds and has actual-cost thresholds at $1/$3/$5. This does not prove receipt of a budget alert email. Evidence: ignored `.build/notifications-audit-20261024.json`.
- Free plan is ACTIVE. A single cached Cost Explorer query for October 1–23, excluding credits/refunds, reports $0; all days are estimated and contain no service groups. This is not mature project-attributed billing data or a completed low-traffic month. Evidence: ignored `.build/cost-audit-20261024.json`.

### Milestone 5 demo rollout — October 24, 2026 (IST)

The owner confirmed the root-backed `bettervercel` profile is the intended setup identity for this demo, overriding the earlier non-root rollout prerequisite. No new credentials or IAM-user changes were required; root MFA remains enabled.

- Deployed `BetterVercelStaticStack` (restricted bucket policy and SPA router) and `BetterVercelControlStack` (API code). The reviewed diffs contained no new services or resource replacements; the bucket, distribution, budget and tables were preserved.
- Live bucket-policy inspection confirms CloudFront `GetObject` is limited to `deployments/*` and `dashboard/*`, with the exact distribution condition and TLS deny intact. Dashboard contents, no-store/security headers, API config, the original Vite preview and existing nested Next preview passed HTTP checks. Evidence: ignored `.build/rollout-policy-results.json` and `.build/rollout-http-results.json`.
- `npm run verify:spa` passed for real SPA and static Vite deployments: exact artifact bytes/MIME, nested routes with queries, missing JS/CSS/JSON errors, namespace isolation and unknown deployment denial. Ready time after build was 1,983 ms for SPA and 1,240 ms for static. Evidence: ignored `.build/spa-smoke-1792787072799/results.json` and `verification.json`. [SPA preview](https://d34mbpew2lb7ue.cloudfront.net/d/p5a74c182efce3b77-01fe76ea1ff6a268e8eb45e479210616/_spa/).
- The full live API security smoke test passed again after deployment, including both-direction project/token/signed-prefix isolation, empty/large artifacts, interrupted upload recovery, checksums, immutable uploads and concurrent/duplicate finalization. Evidence: ignored `.build/release-gate-api-1792787103467.json`.
- The local suite remains at 62 passing tests. Browser interaction acceptance, hosted GitHub Actions, budget-appropriate anomaly thresholds, email receipt, teardown rehearsal, own-site acceptance and mature/month-long billing evidence remain tracked in [TODO.md](../TODO.md).

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
