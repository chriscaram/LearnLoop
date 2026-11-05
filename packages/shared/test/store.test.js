import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ConflictError, MemoryStateStore, S3StateStore } from '../src/store.js';

function preconditionFailed() {
  return Object.assign(new Error('PreconditionFailed'), { name: 'PreconditionFailed', $metadata: { httpStatusCode: 412 } });
}

/** In-memory S3 with ETags; `conflicts` forces that many 412s on If-Match puts. */
function fakeS3({ objects = {}, conflicts = 0 } = {}) {
  const store = new Map(Object.entries(objects).map(([k, v]) => [k, { body: JSON.stringify(v), etag: '"1"' }]));
  let version = 1;
  const s3 = {
    puts: [],
    async send(command) {
      const { input } = command;
      if (command.constructor.name === 'GetObjectCommand') {
        const obj = store.get(input.Key);
        if (!obj) throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } });
        if (input.IfNoneMatch && input.IfNoneMatch === obj.etag) {
          throw Object.assign(new Error('NotModified'), { name: 'NotModified', $metadata: { httpStatusCode: 304 } });
        }
        return { ETag: obj.etag, Body: { transformToString: async () => obj.body } };
      }
      if (command.constructor.name === 'PutObjectCommand') {
        s3.puts.push(input);
        const obj = store.get(input.Key);
        if (input.IfNoneMatch === '*' && obj) throw preconditionFailed();
        if (input.IfMatch) {
          if (conflicts > 0) {
            conflicts -= 1;
            // someone else wrote in between
            version += 1;
            store.set(input.Key, { body: JSON.stringify([...JSON.parse(obj.body), 'other']), etag: `"${version}"` });
            throw preconditionFailed();
          }
          if (!obj || obj.etag !== input.IfMatch) throw preconditionFailed();
        }
        version += 1;
        store.set(input.Key, { body: input.Body, etag: `"${version}"` });
        return { ETag: `"${version}"` };
      }
      throw new Error('unsupported');
    },
    get: (key) => JSON.parse(store.get(key).body),
  };
  return s3;
}

test('conditional write retries once after a 412 and keeps the other writer\'s change', async () => {
  const s3 = fakeS3({ objects: { 'state/users.json': ['a'] }, conflicts: 1 });
  let clock = 0;
  const store = new S3StateStore({ client: s3, bucket: 'b', clock: () => (clock += 5000) });
  await store.update('users', (users) => users.push('mine'));
  assert.deepEqual(s3.get('state/users.json'), ['a', 'other', 'mine']);
  assert.equal(s3.puts.filter((p) => p.IfMatch).length, 2);
});

test('two consecutive conflicts raise ConflictError', async () => {
  const s3 = fakeS3({ objects: { 'state/users.json': [] }, conflicts: 2 });
  const store = new S3StateStore({ client: s3, bucket: 'b' });
  await assert.rejects(store.update('users', (u) => u.push(1)), ConflictError);
});

test('absent domain is initialised from the seed with If-None-Match', async () => {
  const seedDir = await mkdtemp(path.join(tmpdir(), 'seed-'));
  await writeFile(path.join(seedDir, 'courses.json'), JSON.stringify([{ id: 'crs_0123456789ab' }]));
  const s3 = fakeS3();
  const store = new S3StateStore({ client: s3, bucket: 'b', seedDir });
  assert.deepEqual(await store.read('courses'), [{ id: 'crs_0123456789ab' }]);
  assert.equal(s3.puts[0].IfNoneMatch, '*');
  assert.deepEqual(s3.get('state/courses.json'), [{ id: 'crs_0123456789ab' }]);
});

test('reads use the cache with If-None-Match after the freshness window', async () => {
  const s3 = fakeS3({ objects: { 'state/users.json': ['a'] } });
  let now = 0;
  const store = new S3StateStore({ client: s3, bucket: 'b', clock: () => now });
  const first = await store.read('users');
  now = 10_000;
  const second = await store.read('users');
  assert.equal(first, second);
});

test('unknown domains are rejected', async () => {
  await assert.rejects(new MemoryStateStore({ data: {} }).read('passwords'), TypeError);
});

test('memory store update is isolated until it completes', async () => {
  const store = new MemoryStateStore({ data: { users: [{ id: 1 }] } });
  const before = await store.read('users');
  await store.update('users', (users) => users.push({ id: 2 }));
  assert.equal(before.length, 1);
  assert.equal((await store.read('users')).length, 2);
});

test('concurrent reads of one domain share a single S3 request', async () => {
  const s3 = fakeS3({ objects: { 'state/progress.json': { lessons: [], courses: [] } } });
  let gets = 0;
  const send = s3.send.bind(s3);
  s3.send = (command) => {
    if (command.constructor.name === 'GetObjectCommand') gets += 1;
    return send(command);
  };
  const store = new S3StateStore({ client: s3, bucket: 'b' });
  const results = await Promise.all(Array.from({ length: 500 }, () => store.read('progress')));
  assert.equal(gets, 1);
  assert.ok(results.every((r) => r === results[0]));
});
