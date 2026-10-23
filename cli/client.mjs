const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const retryable = status => status === 429 || status >= 500;
const hints = {
  400: 'Check the project configuration and artifact manifest.',
  401: 'Run login with the token for this project, or set BETTERVERCEL_TOKEN.',
  403: 'Check the token, API URL, or upload expiry; retry deploy with the same key to refresh upload URLs.',
  404: 'Check the API URL and deployment ID.',
  409: 'Resume with the same key and unchanged output; use a new key if the upload window expired or the build changed.',
  413: 'Reduce the manifest size below 220,000 bytes.',
  422: 'Uploaded files failed validation. Create a new deployment from a clean build.',
  429: 'The API is throttled. Wait briefly and retry.',
};

export function safeMessage(value, token = '') {
  let message = String(value).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');
  if (token) message = message.split(token).join('[redacted]');
  return message.replace(/bv_[A-Za-z0-9_-]{43}/g, '[redacted]').replace(/https?:\/\/\S+/g, '[URL omitted]').slice(0, 500);
}

export function createClient({ api, token, fetchImpl = fetch, sleep = delay }) {
  async function request(url, options, label, accepted = []) {
    for (let attempt = 0; attempt < 3; attempt++) {
      let response;
      try { response = await fetchImpl(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(30_000) }); }
      catch {
        if (attempt < 2) { await sleep(300 * 2 ** attempt); continue; }
        throw new Error(`${label}: network request failed. Check connectivity and retry with the same idempotency key.`);
      }
      if (retryable(response.status) && attempt < 2) {
        await response.arrayBuffer();
        await sleep(300 * 2 ** attempt);
        continue;
      }
      if (!response.ok && !accepted.includes(response.status)) {
        const data = await response.json().catch(() => ({}));
        throw new Error(`${label}: HTTP ${response.status}. ${safeMessage(data.error ?? '', token)} ${hints[response.status] ?? 'Retry later; check status before creating a new deployment.'}`);
      }
      return response;
    }
  }
  return {
    async api(method, path, body, key) {
      const response = await request(api + path, { method,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(key ? { 'idempotency-key': key } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}) }, 'Deploy API');
      try { return await response.json(); } catch { throw new Error('Deploy API returned invalid JSON. Check the configured API URL.'); }
    },
    async upload(instruction, artifact) {
      let url;
      try { url = new URL(instruction.url); } catch { throw new Error('Invalid upload instructions from API.'); }
      if (instruction.method !== 'PUT' || url.username || url.password ||
          (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) {
        throw new Error('Invalid upload instructions from API.');
      }
      // A 412 means a previous attempt already wrote this immutable key. Finalize verifies its bytes and metadata.
      const response = await request(url, { method: 'PUT', headers: instruction.headers, body: artifact.body },
        `Upload ${artifact.path}`, [412]);
      await response.arrayBuffer();
    },
  };
}

export async function uploadArtifacts(client, uploads, artifacts, concurrency = 4) {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new Error('Upload concurrency must be between 1 and 8.');
  const files = new Map(artifacts.map(file => [file.path, file]));
  if (!Array.isArray(uploads) || uploads.length !== files.size || new Set(uploads.map(upload => upload.path)).size !== files.size ||
      uploads.some(upload => !files.has(upload.path))) throw new Error('API upload instructions do not match the local manifest.');
  let next = 0;
  let failure;
  await Promise.all(Array.from({ length: Math.min(concurrency, uploads.length) }, async () => {
    while (!failure && next < uploads.length) {
      const upload = uploads[next++];
      try { await client.upload(upload, files.get(upload.path)); }
      catch (error) { failure ??= error; }
    }
  }));
  if (failure) throw failure;
}
