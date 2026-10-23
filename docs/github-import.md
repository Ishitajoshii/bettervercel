# GitHub sign-in and repository imports

The dashboard now supports **Continue with GitHub → choose repository and branch → review detected app folder → deploy**. It finds Vite, Astro, Next static exports, build scripts, plain HTML, and multiple apps in a monorepo. Root, install/build commands, output folder, and routing remain editable. The default root is selected when unambiguous; otherwise the screen presents choices.

Builds run in GitHub Actions using the existing deployment API. No AWS build service is provisioned. The first deployment of each import adds two uniquely named files to the repository's default branch and creates a repository Actions secret. The screen asks the person deploying to acknowledge these changes. It preserves existing workflows and never force-pushes. Repository admin access is required to configure the secret; protected default branches may block setup.

## One-time operator setup

1. Read `DomainName` from `cdk-outputs.json`. Register a [GitHub OAuth App](https://github.com/settings/applications/new):
   - Application name: `Better Vercel`.
   - Homepage URL: `https://<DomainName>/dashboard/`.
   - Authorization callback URL: **exactly** `https://<DomainName>/dashboard/` (including the trailing slash).
2. Generate the OAuth client secret. Store its raw value as a **plaintext secret** in AWS Secrets Manager in the control API's region using the default Secrets Manager encryption key. Do not use a JSON key/value wrapper. Do not paste the secret into chat, source files, environment variables, or shell history. The Lambda retrieves it by ARN; only the ARN is in the deployment configuration.
3. Set these non-secret values in the deployment shell:

   ```powershell
   $env:AWS_PROFILE = 'bettervercel'
   $env:BETTERVERCEL_GITHUB_CLIENT_ID = '<OAuth client ID>'
   $env:BETTERVERCEL_GITHUB_SECRET_ARN = '<complete Secrets Manager ARN>'
   $env:BETTERVERCEL_GITHUB_ALLOWED_USERS = '<your GitHub login>'
   ```

   Multiple private-alpha logins may be comma-separated. Keep these values set for subsequent control-stack deployments; omitting them disables sign-in. The app fails closed if only some values are set. There is no public signup.
4. Run `npm run check`, `npm run synth:api`, and `npm run diff:api`. Expect one additional retained, encrypted DynamoDB table with TTL, a GitHub API route, POST in the existing dashboard CORS policy, and access to the exact OAuth secret ARN. Existing artifact permissions and operator IAM authentication are preserved.
5. Deploy with `npm run deploy:api`, then upload the dashboard with `npm run upload:dashboard`. Hosting infrastructure does not need a change. GitHub sign-in remains disabled with a setup message until all three configuration values are supplied.
6. Open the dashboard and choose **Continue with GitHub**. Authorize repository and workflow access, including organization approval when required. Select a test repository you administer, review its settings, acknowledge the workflow setup, and deploy. Use **View build logs on GitHub** while the preview builds.

The OAuth flow follows [GitHub's authorization-code and PKCE guidance](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps). Deployment tokens are encrypted with the repository public key before calling [GitHub's repository secrets API](https://docs.github.com/en/rest/actions/secrets#create-or-update-a-repository-secret).

## Runtime behavior

- GitHub access tokens stay on the server in an encrypted DynamoDB table. The browser receives a separate opaque session token, held only in memory. Refreshing requires reconnecting; imported projects are restored after sign-in. Sessions expire after at most eight hours. Logout invalidates the server session.
- OAuth uses a fixed callback, PKCE S256, a ten-minute single-use state record, and a verifier held temporarily in this tab's session storage. Authorization codes are removed from the address bar immediately on return. Neither GitHub tokens nor client secrets are returned to the dashboard.
- The selected source commit is pinned. If the branch changes before import, inspect it again. A setup commit triggers the generated workflow. Imports are manual snapshots, not automatic deployments on every push. Reimport to deploy a newer commit or changed settings. GitHub's **Run workflow** can retry the same pinned source after a transient failure.
- A retry with the same import ID and settings resumes setup without creating another project or workflow. Completed setup returns the original project. The setup record expires after a day; start a fresh import after expiry.
- Build and publish run in separate steps. Dependency installation and build commands do not receive the deployment token. The workflow's GitHub token has read-only contents permission; checkouts do not persist Git credentials. Builds time out after ten minutes. GitHub Actions minutes and Secrets Manager storage are subject to their account's billing.
- The dashboard displays build status and links to full GitHub logs. Finalized deployments use the existing preview listing, logs, and deletion flow. Existing manual project-token connections still work under Advanced.
- Vite and Astro standard build commands receive the preview base path automatically. Custom commands can use `BETTERVERCEL_BASE_PATH`. Monorepo lockfiles are detected in ancestor folders for installation; custom workspace orchestration may require editing the commands.
- Next.js imports generate temporary static-export configuration during the build, with the preview base path and unoptimized images. `next.config.js`, `.mjs`, and `.cjs` are supported. TypeScript Next config currently needs conversion to `.mjs` or a CLI deployment. SSR and API routes are not supported.
- Plain HTML supports `.` as output. Source dotfiles, `.github`, dependency folders, and package metadata are excluded from staging. Other artifacts still pass the existing 500-file/25-MiB and URL validation. Absolute HTML asset URLs in a plain static site must already use the preview base or be made relative.
- Repository discovery and branches are paginated. Search filters the repositories already loaded. GitHub API rate limits, organization approval, branch protection, disabled Actions, LFS, private dependency registries, and custom framework configuration can require repository-side setup. A truncated tree or more than 40 package manifests fails explicitly rather than silently guessing.

## Validation

`npm run check` covers OAuth expiry/replay/PKCE, ownership checks, logout, repository detection, workflow setup retries and permissions, exact IAM scope, existing deployments, and real builds of plain HTML and a nested Vite app using the bundled runner. Live GitHub authorization and Actions execution require the operator configuration above and are separate acceptance checks.
