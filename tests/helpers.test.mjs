import test from 'node:test';
import assert from 'node:assert/strict';
import { deploymentPrefix, contentType } from '../scripts/lib.mjs';

test('destructive commands can only target a single validated deployment prefix', () => {
  assert.equal(deploymentPrefix('smoke-20261023'), 'deployments/smoke-20261023/');
  for (const id of [undefined, '', '/', '../', 'a/b', 'a*', 'A', '-a', 'a'.repeat(64)]) {
    assert.throws(() => deploymentPrefix(id), /--id/);
  }
  assert.throws(() => deploymentPrefix(`p1111111111111111-${'a'.repeat(32)}`), /reserved/);
});

test('sets executable assets to the correct MIME type', () => {
  assert.equal(contentType('assets/app.js'), 'text/javascript; charset=utf-8');
  assert.equal(contentType('assets/style.css'), 'text/css; charset=utf-8');
  assert.equal(contentType('index.html'), 'text/html; charset=utf-8');
});
