import { App } from 'aws-cdk-lib';
import { ENVIRONMENTS, LearnLoopStack, type EnvironmentName } from '../lib/learnloop-stack.js';

// One stack per deployment: LearnLoopProd and LearnLoopStaging. Each stack tags
// its own resources (Application=<tag>, env=<environment>).
const app = new App();

for (const [environmentName, { stackName }] of Object.entries(ENVIRONMENTS) as [EnvironmentName, { stackName: string }][]) {
  new LearnLoopStack(app, stackName, {
    env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: 'us-east-1' },
    appVersion: app.node.tryGetContext('appVersion') ?? 'dev',
    description: `LearnLoop online course platform (${environmentName})`,
    environmentName,
  });
}
