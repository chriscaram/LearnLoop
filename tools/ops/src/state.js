import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SEED_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../data/seed');

/** [key, body] pairs for s3://<state bucket>/state/<domain>.json from data/seed/. */
export async function stateObjects(dir = SEED_DIR) {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.json')).sort();
  return Promise.all(files.map(async (f) => [`state/${f}`, await readFile(path.join(dir, f))]));
}
