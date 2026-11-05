import { App, Tags } from 'aws-cdk-lib';
import { LearnLoopStack } from '../lib/learnloop-stack.js';

const app = new App();
Tags.of(app).add('Application', 'learnloop');
Tags.of(app).add('env', 'prod');

new LearnLoopStack(app, 'LearnLoopProd', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: 'us-east-1' },
  appVersion: app.node.tryGetContext('appVersion') ?? 'dev',
  description: 'LearnLoop online course platform (prod)',
});
