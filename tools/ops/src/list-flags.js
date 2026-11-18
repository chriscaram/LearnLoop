#!/usr/bin/env node
// node tools/ops/src/list-flags.js [repoRoot]
// Prints ["ga-…", …]: the ga-* feature-flag keys the application code in the
// checkout at repoRoot (default: cwd) reads. A key counts when it appears as a
// string literal (e.g. export const NUDGE_FLAG_KEY = 'ga-find_…') in the source
// of a service, a shared package or the web app; tests are not read.
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SOURCE_ROOTS = ['services/*/src', 'packages/*/src', 'web/src'];
const SOURCE_FILE = /\.(?:m?js|jsx|ts|tsx)$/;
const SKIP_DIRS = new Set(['node_modules', 'dist', 'test', 'tests', '__tests__']);
const FLAG_LITERAL = /(['"`])(ga-[a-z0-9_-]{1,61})\1/g;
const FLAG_KEY = /^[a-z][a-z0-9_-]{0,63}$/; // same rule as setFlag

function* sourceFiles(dir) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { if (!SKIP_DIRS.has(entry.name)) yield* sourceFiles(full); }
    else if (SOURCE_FILE.test(entry.name) && !/\.test\.[a-z]+$/.test(entry.name)) yield full;
  }
}

function expand(root, pattern) {
  const [first, star, ...rest] = pattern.split('/');
  if (star !== '*') return [path.join(root, pattern)];
  let names = [];
  try { names = readdirSync(path.join(root, first), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { /* absent */ }
  return names.sort().map((name) => path.join(root, first, name, ...rest));
}

/** The ga-* flag keys read by the application source under root, sorted. */
export function flagKeysIn(root) {
  const keys = new Set();
  for (const dir of SOURCE_ROOTS.flatMap((p) => expand(root, p))) {
    for (const file of sourceFiles(dir)) {
      for (const [, , key] of readFileSync(file, 'utf8').matchAll(FLAG_LITERAL)) if (FLAG_KEY.test(key)) keys.add(key);
    }
  }
  return [...keys].sort();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write(`${JSON.stringify(flagKeysIn(path.resolve(process.argv[2] ?? '.')))}\n`);
}
