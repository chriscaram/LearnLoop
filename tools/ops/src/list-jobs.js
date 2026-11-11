#!/usr/bin/env node
// node tools/ops/src/list-jobs.js [repoRoot]
// Prints { "<service>": ["<job>", ...] } for the scheduled jobs each service
// registers with createHandler in the checkout at repoRoot (default: cwd).
// Works on any checkout (the checkout's dependencies must be installed); it only
// imports the handler modules and never invokes a handler.
import { existsSync, readdirSync } from 'node:fs';
import { register } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

register('./list-jobs-hooks.js', import.meta.url);

const root = path.resolve(process.argv[2] ?? '.');
const jobs = {};
for (const service of readdirSync(path.join(root, 'services')).sort()) {
  const entry = path.join(root, 'services', service, 'src', 'handler.js');
  if (!existsSync(entry)) continue;
  globalThis.__learnloopJobs = [];
  await import(pathToFileURL(entry).href);
  jobs[service] = globalThis.__learnloopJobs;
}
process.stdout.write(`${JSON.stringify(jobs)}\n`);
process.exit(0);
