// State store for mock data. Each domain (users, courses, ...) is one JSON
// document. In AWS it lives at s3://$STATE_BUCKET/state/<domain>.json; locally
// and in tests it lives in memory. Only repositories/*.js call this module.
//
// Writes are optimistic: PutObject with If-Match on the ETag that was read,
// retried once from a fresh read when another writer got there first.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getS3Client } from './aws.js';
import { getConfig } from './config.js';

export const DOMAINS = Object.freeze([
  'users',
  'courses',
  'lessons',
  'enrolments',
  'progress',
  'subscriptions',
  'notifications',
  'quiz_results',
]);

/** Reads within this window reuse the cached copy without a network call. */
export const READ_FRESHNESS_MS = 1_000;

export class ConflictError extends Error {
  constructor(domain) {
    super(`concurrent update on ${domain}`);
    this.name = 'ConflictError';
  }
}

function assertDomain(domain) {
  if (!DOMAINS.includes(domain)) throw new TypeError(`unknown state domain: ${domain}`);
}

export function defaultSeedDir() {
  const configured = getConfig().seedDir;
  if (configured) return configured;
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../data/seed');
}

async function readSeed(seedDir, domain) {
  return JSON.parse(await readFile(path.join(seedDir, `${domain}.json`), 'utf8'));
}

const statusOf = (error) => error?.$metadata?.httpStatusCode;

export class S3StateStore {
  constructor({ client = getS3Client(), bucket, seedDir = defaultSeedDir(), prefix = 'state/', clock = Date.now } = {}) {
    this.client = client;
    this.bucket = bucket;
    this.seedDir = seedDir;
    this.prefix = prefix;
    this.clock = clock;
    this.cache = new Map(); // domain -> { etag, data, checkedAt }
    this.inflight = new Map(); // domain -> pending read, shared by concurrent callers
  }

  key(domain) {
    return `${this.prefix}${domain}.json`;
  }

  async load(domain, { fresh = false } = {}) {
    const cached = this.cache.get(domain);
    if (!fresh && cached && this.clock() - cached.checkedAt < READ_FRESHNESS_MS) return cached;
    if (!fresh && this.inflight.has(domain)) return this.inflight.get(domain);
    const pending = this.fetch(domain, cached);
    if (!fresh) {
      this.inflight.set(domain, pending);
      pending.finally(() => this.inflight.delete(domain)).catch(() => {});
    }
    return pending;
  }

  async fetch(domain, cached) {
    try {
      const out = await this.client.send(new GetObjectCommand({
        Bucket: this.bucket,
        Key: this.key(domain),
        IfNoneMatch: cached?.etag,
      }));
      const entry = { etag: out.ETag, data: JSON.parse(await out.Body.transformToString()), checkedAt: this.clock() };
      this.cache.set(domain, entry);
      return entry;
    } catch (error) {
      if (statusOf(error) === 304 && cached) {
        cached.checkedAt = this.clock();
        return cached;
      }
      if (error?.name === 'NoSuchKey' || statusOf(error) === 404) return this.initialise(domain);
      throw error;
    }
  }

  /** First use of a domain: copy the bundled seed into the bucket. */
  async initialise(domain) {
    const data = await readSeed(this.seedDir, domain);
    try {
      const out = await this.client.send(new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.key(domain),
        Body: JSON.stringify(data),
        ContentType: 'application/json',
        IfNoneMatch: '*',
      }));
      const entry = { etag: out.ETag, data, checkedAt: this.clock() };
      this.cache.set(domain, entry);
      return entry;
    } catch (error) {
      if (statusOf(error) === 412 || statusOf(error) === 409) return this.load(domain, { fresh: true });
      throw error;
    }
  }

  async read(domain) {
    assertDomain(domain);
    return (await this.load(domain)).data;
  }

  async update(domain, mutator) {
    assertDomain(domain);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const { etag, data } = await this.load(domain, { fresh: attempt > 0 });
      const draft = structuredClone(data);
      const result = await mutator(draft);
      try {
        const out = await this.client.send(new PutObjectCommand({
          Bucket: this.bucket,
          Key: this.key(domain),
          Body: JSON.stringify(draft),
          ContentType: 'application/json',
          IfMatch: etag,
        }));
        this.cache.set(domain, { etag: out.ETag, data: draft, checkedAt: this.clock() });
        return result;
      } catch (error) {
        const status = statusOf(error);
        if (status !== 412 && status !== 409) throw error;
      }
    }
    throw new ConflictError(domain);
  }
}

export class MemoryStateStore {
  constructor({ seedDir = defaultSeedDir(), data = null } = {}) {
    this.seedDir = seedDir;
    this.domains = new Map(Object.entries(data ?? {}).map(([k, v]) => [k, structuredClone(v)]));
    this.fixed = data !== null;
  }

  async load(domain) {
    if (!this.domains.has(domain)) {
      this.domains.set(domain, this.fixed ? emptyDomain(domain) : await readSeed(this.seedDir, domain));
    }
    return this.domains.get(domain);
  }

  async read(domain) {
    assertDomain(domain);
    return this.load(domain);
  }

  async update(domain, mutator) {
    assertDomain(domain);
    const draft = structuredClone(await this.load(domain));
    const result = await mutator(draft);
    this.domains.set(domain, draft);
    return result;
  }
}

function emptyDomain(domain) {
  return domain === 'progress' ? { lessons: [], courses: [] } : [];
}

let current = null;

export function getStore() {
  if (!current) {
    const { stateBucket } = getConfig();
    current = stateBucket ? new S3StateStore({ bucket: stateBucket }) : new MemoryStateStore();
  }
  return current;
}

export function setStore(store) {
  current = store;
}
