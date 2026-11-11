// npx cdk --app "npx tsx bin/github-oidc.ts" deploy -c githubRepo=<owner>/<repo> \
//   [-c githubOwnerId=<numeric id> -c githubRepoId=<numeric id>]
import { App, Tags } from 'aws-cdk-lib';
import { GithubOidcStack } from '../lib/github-oidc-stack.js';

const app = new App();
Tags.of(app).add('Application', 'learnloop');
Tags.of(app).add('env', 'prod');

const githubRepo = app.node.tryGetContext('githubRepo');
if (!githubRepo) throw new Error('pass -c githubRepo=<owner>/<repo>');

new GithubOidcStack(app, 'LearnLoopGithubOidc', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: 'us-east-1' },
  githubRepo,
  githubOwnerId: app.node.tryGetContext('githubOwnerId'),
  githubRepoId: app.node.tryGetContext('githubRepoId'),
  existingProviderArn: app.node.tryGetContext('existingOidcProviderArn'),
});
