# Better Vercel remaining work

Updated October 24, 2026 (IST). Source: [PRD and audit](prd/aws-vercel-mvp.md).
Checked items require recorded evidence; an implementation alone does not close live acceptance.

## Current release

- [ ] **R1 — Deploy and verify IAM restriction.** Narrow CloudFront reads to `deployments/*` and `dashboard/*`; verify the live policy and dashboard/preview delivery. Implementation and local regression tests are ready.
- [ ] **R2 — Implement opt-in SPA fallback.** Implementation, CLI/config/docs, namespace-isolation tests and `npm run verify:spa` are ready. Live stack rollout and smoke verification remain pending.
- [ ] **R3 — Confirm root MFA and setup identity.** Root MFA is verified enabled. Both local profiles (`default`, `bettervercel`) and the AWS connector identify as root; a non-root admin profile is still needed for setup/deployment.
- [ ] **R4 — Configure useful cost anomaly alerts.** An existing SERVICE monitor and DAILY subscription with confirmed email are verified. Its default alert requires both $100 absolute impact and 40% impact; tune a project-appropriate threshold before closing this $5-budget safety item.
- [x] **R5 — Verify deployed retention.** Live S3 lifecycle and CloudWatch APIs confirm seven-day artifacts, one-day incomplete multipart cleanup and three-day logs. Evidence: ignored `.build/operations-audit-20261024.json`.
- [ ] **R6 — Verify current Free Tier and costs.** Snapshot obtained: Free plan ACTIVE; October 1–23 pre-credit Cost Explorer reports $0, but every day is estimated with no service groups. Mature/project-attributed data is still needed to distinguish unrelated charges; this is not the month-long acceptance. Evidence: ignored `.build/cost-audit-20261024.json`.
- [ ] **R7 — Verify budget email delivery.** Configuration for $1/$3/$5 alerts exists; actual receipt is unverified.
- [ ] **R8 — Rehearse teardown safely.** Use disposable infrastructure; verify control-plane-first removal, retained tables, exact artifact/dashboard cleanup and shared bootstrap handling. Do not destroy current sites as a test.
- [ ] **R9 — Run Vite and Next static-export deployments in GitHub Actions.** Verify repository secrets, branch/PR metadata, previews and the two-minute post-build deployment target.
- [ ] **R10 — Complete real-browser acceptance.** Vite interactions, Next hydration/navigation, dashboard connection, project switching, pagination, logs, previews, deletion and disconnect.
- [ ] **R11 — Deploy and accept 2–3 own sites.** Disposable smoke fixtures do not count as accepted sites.
- [ ] **R12 — Complete the low-traffic test month.** Collect Cost Explorer/Free Tier evidence for the PRD's $0 criterion before credits, excluding pre-existing charges.

## Product gaps and scope decisions

- [ ] **P1 — Production aliases and rollback.** Implement the production pointer/redirect and switching to a prior immutable deployment, or explicitly revise the product scope.
- [ ] **P2 — Browser-origin isolation.** Separate unrelated uploaded sites from each other and the dashboard before accepting unrelated users.
- [ ] **P3 — Durable hosting retention.** Decide whether release is temporary previews only or introduce retention suitable for persistent sites.
- [ ] **P4 — Publication gating.** Decide whether known uploaded paths may remain public before finalize or require readiness before serving.
- [ ] **P5 — Background deletion completion.** Current clients repeat DELETE; reconcile this with scheduled cleanup in the PRD.
- [ ] **P6 — Lecrev reuse bookkeeping (conditional).** If reusing code, record the fork/revision and review the license before copying.

## Deferred upgrades — outside this release

- [ ] **L1 — Custom domains** using user-owned DNS domains.
- [ ] **L2 — Optional quota-limited CodeBuild builds** while preserving local/GitHub builds.
- [ ] **L3 — Experimental Next.js SSR on Lambda** with explicit runtime/resource limits.
- [ ] **L4 — GitHub App/OAuth and broader repository integrations**, including GitLab if pursued.
- [ ] **L5 — Teams, billing and public signup.**
- [ ] **L6 — Additional framework support.**
- [ ] **L7 — Firecracker/EC2 execution**, only when paid usage justifies its cost and operation.

## Already verified

- [x] Two-project token isolation in both directions, including signed-prefix tampering.
- [x] Empty/oversized artifact rejection and interrupted-upload recovery.
- [x] Checksum enforcement, overwrite rejection, concurrent and duplicate finalization.
- [x] Original milestone 1–4 implementation tasks reviewed; browser and hosted Actions acceptance remain tracked above.
- [x] Baseline: all 56 local tests passed; hosting diff showed only the pending IAM policy restriction.

## Work log

- October 24: Created this consolidated checklist. Starting R1 and R2; remaining entries preserve their existing scope and acceptance requirements.
- October 24: SPA implementation passed all 62 tests, including refusal to upload to an older API that ignores routing. The live verifier passed syntax checking but has not been run. Read-only hosting diff contains only the bucket-policy restriction and router code; control-plane diff contains only Lambda code. No resource replacements, new services or new IAM grants. Both rollouts remain pending the non-root setup identity required by the PRD.
- October 24: Read-only AWS checks confirmed root MFA, retention, existing anomaly monitor/subscription and healthy $5 budget with $1/$3/$5 alerts. Anomaly subscription confirmation does not prove receipt of a budget alert email. Root MFA and retention needed verification, not reconfiguration.
