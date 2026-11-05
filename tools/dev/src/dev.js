#!/usr/bin/env node
// npm run dev  ->  API on http://localhost:3001 (in-memory store, JSON logs on
// stdout) and the Vite dev server on http://localhost:5173 proxying /api.
// npm run dev -- --api-only  to start just the API.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { configureLocalEnvironment, createDevServer } from './server.js';

const port = Number(process.env.API_PORT ?? 3001);
configureLocalEnvironment();
createDevServer().listen(port, () => {
  process.stderr.write(`dev: API listening on http://localhost:${port}\n`);
});

if (!process.argv.includes('--api-only')) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  const vite = spawn('npm', ['run', 'dev', '-w', 'web'], { cwd: root, stdio: ['ignore', 'inherit', 'inherit'], env: { ...process.env, API_PORT: String(port) } });
  const stop = () => { vite.kill(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
