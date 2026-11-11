// Module hooks for list-jobs.js: every import of @learnloop/shared/http from
// service code gets a thin wrapper whose createHandler records the job names
// it is given, then delegates to the real createHandler of that checkout.
const SHIM = 'learnloop-list-jobs:';

export async function resolve(specifier, context, next) {
  if (specifier === '@learnloop/shared/http' && !context.parentURL?.startsWith(SHIM)) {
    const real = await next(specifier, context);
    return { url: SHIM + encodeURIComponent(real.url), shortCircuit: true };
  }
  return next(specifier, context);
}

export async function load(url, context, next) {
  if (!url.startsWith(SHIM)) return next(url, context);
  const real = JSON.stringify(decodeURIComponent(url.slice(SHIM.length)));
  return {
    format: 'module',
    shortCircuit: true,
    source: [
      `import * as real from ${real};`,
      `export * from ${real};`,
      'export function createHandler(options) {',
      '  globalThis.__learnloopJobs?.push(...Object.keys(options?.jobs ?? {}));',
      '  return real.createHandler(options);',
      '}',
    ].join('\n'),
  };
}
