import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_STACK, flagsParameter, stackName, stackOutput } from '../src/stack.js';

const fakeClient = (stacks) => ({
  calls: [],
  async send(command) {
    this.calls.push(command.input.StackName);
    const outputs = stacks[command.input.StackName];
    if (!outputs) throw Object.assign(new Error('does not exist'), { name: 'ValidationError' });
    return { Stacks: [{ Outputs: Object.entries(outputs).map(([OutputKey, OutputValue]) => ({ OutputKey, OutputValue })) }] };
  },
});

test('the tools act on LearnLoopProd unless LEARNLOOP_STACK names another stack', () => {
  assert.equal(DEFAULT_STACK, 'LearnLoopProd');
  assert.equal(stackName({}), 'LearnLoopProd');
  assert.equal(stackName({ LEARNLOOP_STACK: '' }), 'LearnLoopProd');
  assert.equal(stackName({ LEARNLOOP_STACK: 'LearnLoopStaging' }), 'LearnLoopStaging');
  assert.throws(() => stackName({ LEARNLOOP_STACK: 'SomethingElse' }), /not a LearnLoop stack name/);
});

test('stack outputs are read from the named stack', async () => {
  const client = fakeClient({ LearnLoopStaging: { StateBucketName: 'learnloop-staging-state-1' } });
  assert.equal(await stackOutput('StateBucketName', { name: 'LearnLoopStaging', client }), 'learnloop-staging-state-1');
  await assert.rejects(stackOutput('Missing', { name: 'LearnLoopStaging', client }), /has no output Missing/);
});

test('the flag parameter: FLAGS_PARAMETER, else the stack output when LEARNLOOP_STACK is set, else the prod default', async () => {
  const client = fakeClient({ LearnLoopStaging: { FeatureFlagsParameter: '/learnloop/staging/feature-flags' } });
  assert.equal(await flagsParameter({ client }, { LEARNLOOP_STACK: 'LearnLoopStaging' }), '/learnloop/staging/feature-flags');
  assert.equal(await flagsParameter({ client }, { LEARNLOOP_STACK: 'LearnLoopStaging', FLAGS_PARAMETER: '/x' }), '/x');
  assert.equal(await flagsParameter({ client }, {}), undefined);
  assert.deepEqual(client.calls, ['LearnLoopStaging']);
});
