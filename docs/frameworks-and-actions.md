# Static frameworks and GitHub Actions

The CLI builds on your machine or on a trusted GitHub runner. AWS receives static output only. Static deployments live at `/d/<deployment-id>/`; opt-in SPA deployments use `/d/<deployment-id>/_spa/`. Links and assets must work beneath the issued preview path. The CLI sets `BETTERVERCEL_BASE_PATH` (no trailing slash) and `BETTERVERCEL_DEPLOYMENT_ID` before running the explicitly configured `buildCommand`. It rejects HTML `src`/`href` paths pointing outside the preview. This is a common-mistake check, not a full parser of CSS or runtime-generated URLs.

## Framework configuration

| Framework | Output | Configuration |
| --- | --- | --- |
| Vite / React with Vite | `dist` | `base: process.env.BETTERVERCEL_BASE_PATH ? process.env.BETTERVERCEL_BASE_PATH + '/' : './'` in Vite config; relative `base: './'` works for the sample |
| Astro | `dist` | `output: 'static'`, `base: process.env.BETTERVERCEL_BASE_PATH || '/'`, `trailingSlash: 'always'`; use `import.meta.env.BASE_URL` for links and public assets |
| Create React App | `build` | Set `homepage: '.'` for relative assets; configure any client router for the preview base |
| Next.js static export | `out` | Use the configuration below; rebuild for each new deployment ID |
| Other static output | explicit directory | Pass `--output` to init; use relative paths or the supplied preview base |

Static routing supports `/about/` → `about/index.html`; it does not map `/about/` to `about.html`. SSR, API routes, middleware, server actions, ISR, and the default Next image optimization service are unsupported.

### Opt-in SPA history routing

The source now supports `bettervercel init ... --routing spa`, or `"routing": "spa"` in `bettervercel.json`. Deploy the updated hosting router and control API before using it; live rollout is tracked in [TODO.md](../TODO.md). Omitted routing or `"static"` preserves the static-export behavior. Next static export must use static routing.

The CLI supplies the complete SPA base path to the build. For Vite, set `base: process.env.BETTERVERCEL_BASE_PATH + '/'` and configure the client router's basename from the same value (Vite exposes `import.meta.env.BASE_URL`). Relative HTML asset URLs such as `./assets/app.js` break at nested URLs and are rejected for SPA output. Use the absolute preview base for assets and links; the relative settings in the framework table apply to static routing only. Hash links and external URLs are permitted.

Extensionless paths such as `/settings/profile` and `/settings/profile/` serve the SPA's root `index.html`. Paths containing a dot, including JavaScript, CSS, JSON and dotted route segments, remain exact object requests; missing files still fail. Use extensionless history routes. The root `_spa` output directory is reserved. Changing routing mode changes request identity: use a new idempotency key and rebuild.

SPA objects use a separate project-owned storage namespace, so requesting `/_spa/` on an ordinary static deployment cannot return that deployment's root HTML. No global 403/404 fallback, database lookup, extra AWS service or new IAM grant is added. Known uploaded SPA paths remain public before finalization, just like static previews.

After both stack updates, `npm run verify:spa` builds and deploys disposable SPA and static Vite fixtures. It checks exact artifact bytes/MIME, deep links with queries, missing assets, namespace isolation, unknown deployment IDs and the two-minute post-build target. It retains credentials separately under ignored `.build/spa-smoke-*/` for later cleanup; results contain no tokens. Browser interaction acceptance is separate.

### Next.js

```js
// next.config.mjs
export default {
  output: 'export',
  trailingSlash: true,
  basePath: process.env.BETTERVERCEL_BASE_PATH || '',
  images: { unoptimized: true },
};
```

Use `next/link` for navigation. Explicitly prefix public image paths with the base path. Next embeds `basePath` at build time, so do not upload output built for one deployment ID under another. `--skip-build` is for resuming the same idempotency key, or output already built for the exact target ID. See the [Next basePath contract](https://nextjs.org/docs/app/api-reference/config/next-config-js/basePath) and [static-export directory layout](https://nextjs.org/docs/app/api-reference/config/next-config-js/trailingSlash).

The runnable Pages Router fixture is in `examples/next-static/`; install its dependencies with `npm ci --prefix examples/next-static`. `npm run verify:cli` builds and uploads both the Vite and Next fixtures using the operator's AWS profile, checks every artifact's bytes and MIME type through CloudFront, and tests a nested Next route. It writes local credentials and results under ignored `.build/cli-smoke-*/` directories; never commit or share those credentials.

## Copy-paste GitHub workflow

1. Have the operator create your project with `npm run create:project -- "My site"`. Keep the returned token secret.
2. Run CLI init in your application repository with the API endpoint, project ID, output directory, and explicit build command. Commit `bettervercel.json`, application source, and your npm lockfile. Do not commit the token.
3. This private alpha CLI is not published on npm. Copy the `cli/` directory and `api/domain.mjs` from a reviewed revision of this repository into `tools/bettervercel/` in your app repository, preserving that layout. These CLI files use Node built-ins and do not need the infrastructure SDK packages. Record the source revision when updating them.
4. Add an encrypted repository Actions secret named `BETTERVERCEL_TOKEN` containing this project's token.
5. Copy [deploy.yml](../examples/github-actions/deploy.yml) into `.github/workflows/deploy.yml` in the application repository.

The workflow runs `npm ci` then the CLI, whose configured build receives the deployment base path. Branch and PR values go through environment variables rather than being interpolated into shell source. `GITHUB_SHA` identifies the checked-out commit (the merge commit for PR runs). The run ID and attempt form a fresh deployment key; the CLI's own network retries reuse that key. A GitHub rerun creates a fresh deployment.

Only same-repository PRs from trusted contributors deploy. Fork PRs and Dependabot are skipped because they do not receive repository secrets. Do not switch this workflow to `pull_request_target` to expose tokens to fork code; see [GitHub's event security guidance](https://docs.github.com/en/actions/reference/security/securely-using-pull_request_target). Restrict repository write access to people trusted to run builds with the project token. The CLI removes the token from its child build environment, but this is not a sandbox against malicious repository code. No AWS access key or IAM administrator credential is needed in Actions.

## Dashboard

After the hosting and API stack updates, run `npm run upload:dashboard`. Open `https://<distribution>.cloudfront.net/dashboard/`, then connect a project with its operator-issued ID and token. Connect more projects to switch between them. The dashboard supports deployment pagination, state, commit, branch/PR, time, size, preview links, retained logs, and deletion. Refresh checks current state; connection tokens exist only in tab memory. Disconnect or refresh the page to clear them.

Deletion becomes available 16 minutes after deployment creation, after signed upload URLs have expired plus a one-minute margin. It removes exact manifest keys and invalidates both public and rewritten CloudFront paths. A `deleting` state remains until cache invalidation completes. Keep the tab open; if interrupted, reconnect and click **Continue deletion**. Retry is safe after partial failures. This is not a background deletion queue. Metadata remains as a tombstone, preventing reuse of the deployment's immutable ID. Previously downloaded browser copies cannot be recalled.

The dashboard has its own no-cache CloudFront behavior and restrictive response headers; API CORS allows the hosting distribution origin. All previews still share that origin, so the private alpha is for your own trusted projects. Per-project origin isolation and production aliases remain later work.

`npm run verify:dashboard -- .build/cli-smoke-<timestamp>` verifies the deployed dashboard and CORS, creates a Vite deployment carrying branch/PR metadata, checks deletion authorization, waits for the original Vite smoke deployment's upload window to expire, then deletes only that original deployment and verifies a 403/404 response after cache removal. It leaves the Next sample and new Vite metadata preview available. This command performs a real deletion of the disposable smoke deployment identified in the supplied results file.
