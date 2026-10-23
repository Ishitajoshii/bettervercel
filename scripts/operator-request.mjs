import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import { SignatureV4 } from '@smithy/signature-v4';
import { Hash } from '@smithy/hash-node';

// Project creation uses the operator's existing local AWS identity, never a public signup key.
export async function createProject(apiUrl, region, name) {
  const url = new URL('/v1/projects', apiUrl);
  const signer = new SignatureV4({ credentials: fromNodeProviderChain(), region,
    service: 'execute-api', sha256: Hash.bind(null, 'sha256') });
  const signed = await signer.sign({ protocol: url.protocol, hostname: url.hostname, path: url.pathname,
    method: 'POST', headers: { host: url.host, 'content-type': 'application/json' }, body: JSON.stringify({ name }) });
  const response = await fetch(url, { method: signed.method, headers: signed.headers, body: signed.body,
    signal: AbortSignal.timeout(30_000) });
  if (response.status !== 201) throw new Error(`Project creation failed (${response.status}): ${await response.text()}`);
  return response.json();
}
