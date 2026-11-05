import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DOMAINS } from '@learnloop/shared/store';
import { stateObjects } from '../src/state.js';

test('state:reset writes one document per state domain from data/seed', async () => {
  const objects = await stateObjects();
  assert.deepEqual(objects.map(([k]) => k).sort(), DOMAINS.map((d) => `state/${d}.json`).sort());
  for (const [, body] of objects) JSON.parse(body.toString('utf8'));
});
