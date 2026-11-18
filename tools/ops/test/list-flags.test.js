import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { flagKeysIn } from '../src/list-flags.js';

test('list-flags finds the ga-* keys in service, package and web source, not in tests or comments', () => {
  assert.deepEqual(flagKeysIn(fileURLToPath(new URL('./fixtures/repo', import.meta.url))), ['ga-find_0001', 'ga-find_0002', 'ga-find_0003']);
});

test('list-flags on this checkout returns only valid ga-* keys', () => {
  const keys = flagKeysIn(fileURLToPath(new URL('../../..', import.meta.url)));
  for (const key of keys) assert.match(key, /^ga-[a-z0-9_-]+$/);
});
