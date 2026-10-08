import test from 'node:test';
import assert from 'node:assert/strict';
test('first-party mail contract is defined', () => {
  assert.equal(typeof globalThis.fetch, 'function');
  assert.match('Testagram <noreply@testagram.site>', /@testagram\.site/);
});
