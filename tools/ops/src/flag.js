#!/usr/bin/env node
// Usage: npm run flag -- <flagKey> on|off
//        npm run flag -- list
// Uses the operator's AWS credentials in AWS_REGION (default us-east-1) and the
// flag parameter of the stack named by LEARNLOOP_STACK (default: the prod
// parameter /learnloop/prod/feature-flags). FLAGS_PARAMETER overrides both.
import { listFlags, setFlag } from '@learnloop/shared/flags';
import { flagsParameter } from './stack.js';

process.env.AWS_REGION ??= 'us-east-1';
const [flagKey, state] = process.argv.slice(2);

try {
  const parameter = await flagsParameter();
  if (parameter) process.env.FLAGS_PARAMETER = parameter; // read on every call by @learnloop/shared/config
  if (!flagKey || flagKey === 'list') {
    for (const flag of await listFlags()) console.log(`${flag.key}\t${flag.enabled ? 'on' : 'off'}`);
  } else if (state === 'on' || state === 'off') {
    const result = await setFlag(flagKey, state === 'on');
    console.log(`${result.key}\t${result.enabled ? 'on' : 'off'}`);
  } else {
    console.error('Usage: npm run flag -- <flagKey> on|off   |   npm run flag -- list');
    process.exitCode = 2;
  }
} catch (error) {
  console.error(`flag: ${error.name}: ${error.message}`);
  process.exitCode = 1;
}
