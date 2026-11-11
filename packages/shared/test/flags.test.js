import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { FLAG_CACHE_MS, isEnabled, listFlags, setFlag } from '../src/flags.js';
import { setupTestEnvironment } from '../src/testing.js';

let env;
beforeEach(() => {
  env = setupTestEnvironment({ flags: { new_catalog_filters: { enabled: true }, other: { enabled: false } } });
});

test('enabled flag returns true, disabled false', async () => {
  assert.equal(await isEnabled('new_catalog_filters'), true);
  assert.equal(await isEnabled('other', { userId: 'usr_1' }), false);
});

test('unknown key returns false', async () => {
  assert.equal(await isEnabled('does_not_exist'), false);
});

test('read failure returns false, logs a warning and does not throw', async () => {
  env.ssm.failReads = true;
  assert.equal(await isEnabled('new_catalog_filters'), false);
  const warning = env.logs.records.find((r) => r.kind === 'log');
  env.logs.restore();
  assert.equal(warning.level, 'warn');
  assert.equal(warning['error.type'], 'ThrottlingException');
});

test('values are cached for 30 seconds', async () => {
  assert.equal(FLAG_CACHE_MS, 30_000);
  await isEnabled('new_catalog_filters');
  await isEnabled('new_catalog_filters');
  assert.equal(env.ssm.calls.filter((c) => c.name === 'GetParameterCommand').length, 1);
});

test('setFlag writes the map and is visible immediately', async () => {
  await isEnabled('new_catalog_filters');
  await setFlag('new_catalog_filters', false);
  assert.equal(await isEnabled('new_catalog_filters'), false);
  const stored = JSON.parse(env.ssm.params.get('/learnloop/prod/feature-flags'));
  assert.deepEqual(stored.new_catalog_filters, { enabled: false });
  assert.deepEqual(stored.other, { enabled: false });
  await assert.rejects(setFlag('Bad Key', true), TypeError);
  // per-branch flags: ga/<id> -> ga-<id>
  assert.deepEqual(await setFlag('ga-find_a431764685ac', true), { key: 'ga-find_a431764685ac', enabled: true });
});

test('listFlags includes known flags with descriptions', async () => {
  const flags = await listFlags();
  const filters = flags.find((f) => f.key === 'new_catalog_filters');
  assert.equal(filters.enabled, true);
  assert.ok(filters.description.length > 0);
});
