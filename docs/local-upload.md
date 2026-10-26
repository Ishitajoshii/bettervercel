# Local dashboard uploads

Choose **Upload from computer** on the dashboard. Connect an operator-issued project ID and deploy token, or select a project already connected through GitHub. A GitHub account is not required for the token flow. Project creation remains operator-managed.

Select a built output folder (such as `dist` or `out`) to preserve nested paths, or select individual files for a flat site. Include a nonempty root `index.html`; the existing API limits of 500 files and 25 MiB apply. Build source projects locally first. ZIP extraction and server-side builds are not supported by this flow. Use relative asset paths because previews live under `/d/<deployment-id>/` (with an additional `/_spa/` for SPA routing).

The browser checks sensitive filenames and common credential patterns before making any upload request. It blocks environment files, private key files, common credential files, private-key contents, and recognized AWS, GitHub, and Better Vercel token formats. This is a best-effort client-side guard, not a comprehensive secret scanner or a server-enforced security boundary. Review the files and confirm public publication.

Each file has a real SHA-256 fingerprint visible in the review list. The browser submits the manifest, uploads through expiring signed HTTPS PUT URLs with checksum headers, and requests finalization. The existing server verifies stored sizes, checksums, and metadata before marking the deployment ready. SHA-256 provides integrity checking, not encryption or malware detection. No deploy token is sent to S3, and tokens remain in the tab's memory.

If uploading fails, submit again with the same files and routing to resume under the same idempotency key. Existing immutable objects return 412 and are verified during finalization. Clear and reselect files to start a new deployment after expiry. Reloading the tab loses retry state.

## Rollout

Deploy both CDK stacks and upload the dashboard assets. The control stack adds `idempotency-key` to its CORS allowlist. The static stack enables S3 CORS for PUT with only the required headers from `https://*.cloudfront.net`; other methods are not enabled. The CloudFront wildcard avoids a bucket/distribution dependency cycle. CORS grants no S3 authorization: each upload still requires an API-issued signature bound to its file and checksum, and public access remains blocked. A custom dashboard domain would need a corresponding S3 CORS entry and control API origin change.

References: [S3 CORS elements](https://docs.aws.amazon.com/AmazonS3/latest/userguide/ManageCorsUsing.html), [browser-controlled Content-Length](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Length). The browser supplies Content-Length from the File body; application code omits that forbidden header.
