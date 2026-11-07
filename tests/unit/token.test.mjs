import assert from 'node:assert/strict';
import { test } from 'node:test';

import { generateDeviceToken, hashToken, looksLikeDeviceToken } from '../../src/js/shared/token.js';

test('a device token is 256 bits of URL-safe base64', () => {
  const token = generateDeviceToken();
  assert.equal(token.length, 43, '32 bytes encode to 43 base64url characters');
  assert.match(token, /^[A-Za-z0-9_-]+$/);
  assert.equal(looksLikeDeviceToken(token), true);
});

test('tokens are unique across many devices', () => {
  const seen = new Set();
  for (let i = 0; i < 500; i += 1) seen.add(generateDeviceToken());
  assert.equal(seen.size, 500);
});

test('looksLikeDeviceToken rejects anything that is not a device token', () => {
  assert.equal(looksLikeDeviceToken(''), false);
  assert.equal(looksLikeDeviceToken('short'), false);
  assert.equal(looksLikeDeviceToken('a'.repeat(42)), false);
  assert.equal(looksLikeDeviceToken('a'.repeat(44)), false);
  assert.equal(looksLikeDeviceToken(`${'a'.repeat(42)}+`), false, 'standard base64 is not accepted');
  assert.equal(looksLikeDeviceToken(null), false);
  assert.equal(looksLikeDeviceToken(undefined), false);
});

test('hashToken matches the published SHA-256 of "abc"', async () => {
  assert.equal(
    await hashToken('abc'),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  );
});

test('the same token always hashes to the same key, and the hash hides the token', async () => {
  const token = generateDeviceToken();
  const first = await hashToken(token);
  const second = await hashToken(token);
  assert.equal(first, second);
  assert.equal(first.length, 64);
  assert.equal(first.includes(token.slice(0, 10)), false);
  assert.notEqual(await hashToken(generateDeviceToken()), first);
});
