# Better Vercel CLI

The milestone 3 CLI builds on your machine, uploads immutable files using the milestone 2 API, and prints a preview URL. It needs Node.js 22.12+ and an operator-created project ID and deploy token. AWS credentials are only needed by the existing operator project-creation helper, not by the CLI.

From this checkout, use `npm run cli -- <command>` or `node cli/bin.mjs <command>`. The package also declares a `bettervercel` executable; after a local `npm link`, the examples below can use `bettervercel` directly. The package is private and has not been published to npm.

## First deployment

Create a project using the existing operator helper, then configure the directory containing your application:

```powershell
# Operator only: prints a one-time token. Save it securely.
npm run create:project -- "My site"

# Replace these placeholders with the API URL and returned project ID.
npm run cli -- init . --api "https://<api-id>.execute-api.ap-south-1.amazonaws.com" --project "p<16-hex-digits>" --output "examples/vite-site/dist" --build-command "npm run build:sample"

# Supply BETTERVERCEL_TOKEN from your secret store, then validate and save it.
npm run cli -- login
npm run cli -- deploy
npm run cli -- status
npm run cli -- logs
```

Alternatively, pipe the token from a secure file to `npm run cli -- login --token-stdin`. There is no command-line token flag, which avoids putting the token in process arguments or shell history. For CI, set `BETTERVERCEL_TOKEN` from the runner's secret store and deploy directly without saving credentials.

`login` validates the token with the project's list endpoint before saving it. Credentials are keyed by both API URL and project ID in `~/.bettervercel/credentials.json`; `BETTERVERCEL_CREDENTIALS_FILE` overrides that path. This is a plaintext local credential file: mode 0600 is applied on POSIX, while Windows relies on the user profile's filesystem permissions. Do not commit or share it. `BETTERVERCEL_TOKEN` takes precedence over saved credentials.

## Project configuration

`init` writes `bettervercel.json` without running code or overwriting an existing configuration:

```json
{
  "apiUrl": "https://<api-id>.execute-api.ap-south-1.amazonaws.com",
  "projectId": "p<16-hex-digits>",
  "framework": "vite",
  "outputDirectory": "dist",
  "buildCommand": "npm run build"
}
```

| Package metadata | Framework | Default output |
| --- | --- | --- |
| `vite` | `vite` | `dist` |
| `astro` | `astro` | `dist` |
| `next` | `next-static` | `out` |
| `react-scripts` | `static` | `build` |
| Other, including React without a recognized builder | `static` | Explicit `--output` required |

Detection reads dependencies/devDependencies in that directory's `package.json`; it never imports framework configuration. Override custom output paths using `--output`. Directories must be inside the project; output symlinks and junctions are rejected.

Builds run only from the explicit `buildCommand` in this file, with the project as working directory. Without `--build-command`, `init` writes `null` and deployment uploads prebuilt output. It never infers or runs a package's build script automatically, installs dependencies, or runs a hosted build. `--skip-build` bypasses a configured build for retries. Treat build configuration as executable code and review it before deploying an unfamiliar checkout. Build stdout/stderr stays in your terminal; the CLI removes its token environment variable from the child process, but local build commands still run with your user permissions.

Vite's `base: './'` works with path-based previews, as shown in the included sample. Astro must produce static HTML and assets compatible with the preview path. Next.js requires static export (`output: 'export'`); server output under `.next` is unsupported. Framework detection does not rewrite HTML or asset URLs. Root-absolute asset/navigation URLs will not work beneath `/d/<deployment-id>/`; Next.js assets and links need an appropriate build configuration. A Next.js preview fixture and end-to-end framework delivery checks remain part of the later acceptance work. SPA history fallback is not yet available.

## Commands and retries

```text
bettervercel login [directory] [--api URL --project ID] [--token-stdin]
bettervercel init [directory] --api URL --project ID [--output dist] [--build-command "npm run build"]
bettervercel deploy [directory] [--skip-build] [--idempotency-key KEY] [--commit SHA] [--concurrency 4]
bettervercel status [deployment-id] [--directory path]
bettervercel logs [deployment-id] [--directory path]
```

`BETTERVERCEL_API_URL` and `BETTERVERCEL_PROJECT_ID` can provide the `init`/explicit `login` settings. Deploy/status/logs use the selected project's configuration. `--commit` or `GITHUB_SHA` supplies optional commit metadata; the CLI does not guess a commit from a parent repository.

Before contacting the API, deployment reads and snapshots at most 500 files / 25 MiB, requires a nonempty `index.html`, rejects unsupported paths/extensions, and computes SHA-256, MIME, size, relative path, and the server's fixed cache policy. Manifest JSON must also fit the API's 220,000-byte request limit. The file bytes used for hashing are the same bytes uploaded.

Uploads use four workers by default, configurable from one to eight. Requests time out after 30 seconds and transient network/429/5xx errors get up to three attempts. The CLI never follows API or upload redirects and never sends the bearer token to S3. All uploads must succeed before finalization. An immutable-object `412` on retry is accepted provisionally; the API then verifies every object against the original manifest before making it ready.

Each deployment uses a new idempotency key unless supplied explicitly. The key and deployment ID are printed and stored without secrets in `.bettervercel/deployment.json`. On failure, the CLI prints a resume command using the same key, unchanged output, and `--skip-build`. Resume within the 15-minute upload window to refresh signed URLs and reuse uploaded objects. A changed manifest or expired window requires a new key. A ready deployment is returned immediately on an identical retry.

`status` and `logs` default to the last recorded deployment for the configured project/API. Pass an ID to inspect another deployment. Logs are the API's bounded lifecycle summaries, not persisted local build stdout. Errors return a nonzero exit status with remediation; tokens and signed upload URLs are not printed by the CLI.

## Verification and current scope

`npm run check` includes CLI filesystem/build tests, real loopback HTTP integration with the actual milestone 2 handler, interrupted upload/resume, immutable retries, ready retries, status/logs, credential validation, manifest limits, bounded concurrency, redirect refusal, and executable exit codes. These tests do not require AWS.

Milestone 3 has been verified locally; its CLI has not yet been smoke-tested against the live AWS API. Existing hosting constraints still apply: public previews share one origin, known uploaded paths are accessible before finalization, and objects expire after seven days. See [the API guide](../api/README.md) and [the PRD](../prd/aws-vercel-mvp.md).
