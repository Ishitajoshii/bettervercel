import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGitHubClientSecret } from '../api/github-aws.mjs';

test('OAuth secret accepts raw text and the Secrets Manager client_secret key/value format', () => {
  assert.equal(parseGitHubClientSecret('  example-secret\n'), 'example-secret');
  assert.equal(parseGitHubClientSecret(JSON.stringify({ client_secret: 'example-secret', client_id: 'public-id' })), 'example-secret');
});

test('invalid secret configuration fails without exposing its contents', () => {
  for (const value of [undefined, '', ' ', '{bad-sensitive-content', '[]', '"sensitive-content"', '{}',
    '{"wrong_key":"sensitive-content"}', '{"client_secret":null}', '{"client_secret":123}',
    '{"client_secret":" "}', '{"client_secret":"sensitive content"}']) {
    assert.throws(() => parseGitHubClientSecret(value), error => error.status === 503 &&
      error.message.includes('client_secret') && !error.message.includes('sensitive'));
  }
});
