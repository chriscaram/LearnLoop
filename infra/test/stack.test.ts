import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { App, Tags } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { LearnLoopStack } from '../lib/learnloop-stack.js';
import { GithubOidcStack } from '../lib/github-oidc-stack.js';
import { SERVICES } from '../lib/services.js';

// Offline synth: no AWS calls, no Docker and no asset bundling. With an empty
// bundling-stacks list CDK neither runs esbuild nor builds a Docker image.
const outdir = mkdtempSync(path.join(tmpdir(), 'learnloop-cdk-'));
function synth() {
  const app = new App({ outdir, context: { 'aws:cdk:bundling-stacks': [] } });
  Tags.of(app).add('Application', 'learnloop');
  Tags.of(app).add('env', 'prod');
  const stack = new LearnLoopStack(app, 'LearnLoopProd', { env: { account: '123456789012', region: 'us-east-1' }, appVersion: 'a1b2c3d' });
  return Template.fromStack(stack);
}
const template = synth();
const resources = template.toJSON().Resources as Record<string, { Type: string; Properties?: Record<string, any> }>;
const ofType = (type: string) => Object.values(resources).filter((r) => r.Type === type);

test('one Lambda per service with the required runtime settings and environment', () => {
  const fns = ofType('AWS::Lambda::Function').filter((f) => String(f.Properties?.FunctionName ?? '').startsWith('learnloop-prod-'));
  assert.deepEqual(fns.map((f) => f.Properties!.FunctionName).sort(), Object.keys(SERVICES).map((s) => `learnloop-prod-${s}`).sort());
  for (const fn of fns) {
    const p = fn.Properties!;
    assert.equal(p.Runtime, 'nodejs22.x');
    assert.deepEqual(p.Architectures, ['arm64']);
    assert.equal(p.MemorySize, 512);
    assert.equal(p.Timeout, 10);
    assert.equal(p.LoggingConfig.LogFormat, 'JSON');
    for (const key of ['APP_ENV', 'APP_VERSION', 'STATE_BUCKET', 'FLAGS_PARAMETER', 'LOG_PSEUDONYM_SALT_PARAMETER']) {
      assert.ok(key in p.Environment.Variables, `${p.FunctionName} ${key}`);
    }
    assert.equal(p.Environment.Variables.APP_ENV, 'prod');
    assert.equal(p.Environment.Variables.APP_VERSION, 'a1b2c3d');
  }
});

test('log groups exist explicitly with 90-day retention', () => {
  const names = ofType('AWS::Logs::LogGroup').map((g) => [g.Properties!.LogGroupName, g.Properties!.RetentionInDays]);
  for (const service of Object.keys(SERVICES)) assert.deepEqual(names.find(([n]) => n === `/aws/lambda/learnloop-prod-${service}`), [`/aws/lambda/learnloop-prod-${service}`, 90]);
  assert.deepEqual(names.find(([n]) => n === '/aws/apigateway/learnloop-prod'), ['/aws/apigateway/learnloop-prod', 90]);
});

test('all service functions share one execution role with AdministratorAccess (first iteration)', () => {
  template.hasResourceProperties('AWS::IAM::Role', {
    RoleName: 'learnloop-prod-lambda-role',
    ManagedPolicyArns: [{ 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':iam::aws:policy/AdministratorAccess']] }],
  });
  const roleIds = new Set(ofType('AWS::Lambda::Function').filter((f) => String(f.Properties?.FunctionName ?? '').startsWith('learnloop-prod-')).map((f) => JSON.stringify(f.Properties!.Role)));
  assert.equal(roleIds.size, 1);
});

test('HTTP API routes match the services\' route tables, with JSON access logs', () => {
  const routeKeys = ofType('AWS::ApiGatewayV2::Route').map((r) => r.Properties!.RouteKey).sort();
  const expected = Object.values(SERVICES).flat().map((r) => `${r.method} ${r.path}`).sort();
  assert.deepEqual(routeKeys, expected);
  const [stage] = ofType('AWS::ApiGatewayV2::Stage');
  const format = JSON.parse(stage.Properties!.AccessLogSettings.Format);
  for (const field of ['requestId', 'ip', 'requestTime', 'httpMethod', 'routeKey', 'status', 'responseLatency', 'responseLength', 'userAgent']) {
    assert.ok(field in format, field);
  }
});

test('buckets: access logs (ACLs, SSE-S3, 120 days), app logs (120 days), state, web', () => {
  const buckets = ofType('AWS::S3::Bucket').map((b) => b.Properties!);
  const named = (fragment: string) => buckets.find((b) => JSON.stringify(b.BucketName).includes(fragment))!;
  const access = named('learnloop-prod-access-logs-');
  assert.equal(access.OwnershipControls.Rules[0].ObjectOwnership, 'BucketOwnerPreferred');
  assert.equal(access.BucketEncryption.ServerSideEncryptionConfiguration[0].ServerSideEncryptionByDefault.SSEAlgorithm, 'AES256');
  assert.equal(access.LifecycleConfiguration.Rules[0].ExpirationInDays, 120);
  assert.equal(named('learnloop-prod-app-logs-').LifecycleConfiguration.Rules[0].ExpirationInDays, 120);
  assert.ok(named('learnloop-prod-state-'));
  assert.ok(named('learnloop-prod-web-'));
});

test('CloudFront: S3 default, /api/* to the HTTP API, standard logs under cloudfront/', () => {
  const [dist] = ofType('AWS::CloudFront::Distribution');
  const config = dist.Properties!.DistributionConfig;
  assert.equal(config.Logging.Prefix, 'cloudfront/');
  const accessId = Object.entries(resources).find(([, r]) => JSON.stringify(r.Properties?.BucketName ?? '').includes('access-logs'))![0];
  assert.deepEqual(config.Logging.Bucket, { 'Fn::GetAtt': [accessId, 'RegionalDomainName'] });
  assert.equal(config.CacheBehaviors[0].PathPattern, '/api/*');
  assert.deepEqual(config.CacheBehaviors[0].AllowedMethods.sort(), ['DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT']);
});

test('flags in SSM, generated secrets in Secrets Manager, no custom resources', () => {
  template.hasResourceProperties('AWS::SSM::Parameter', { Name: '/learnloop/prod/feature-flags', Type: 'String', Tier: 'Standard' });
  const secrets = ofType('AWS::SecretsManager::Secret').map((r) => r.Properties!);
  assert.deepEqual(secrets.map((p) => p.Name).sort(), ['learnloop/prod/jwt-secret', 'learnloop/prod/log-pseudonym-salt']);
  for (const p of secrets) assert.ok(p.GenerateSecretString && !p.SecretString, 'value generated by Secrets Manager');
  assert.equal(Object.values(resources).filter((r) => r.Type.startsWith('Custom::') || r.Type === 'AWS::CloudFormation::CustomResource').length, 0);
  const fn = ofType('AWS::Lambda::Function').find((f) => f.Properties!.FunctionName === 'learnloop-prod-learning')!;
  assert.equal(fn.Properties!.Environment.Variables.LOG_PSEUDONYM_SALT_PARAMETER, 'learnloop/prod/log-pseudonym-salt');
  assert.equal(fn.Properties!.Environment.Variables.JWT_SECRET_PARAMETER, 'learnloop/prod/jwt-secret');
});

test('SES: no identities are created; the sender is a parameter', () => {
  assert.equal(Object.values(resources).filter((r) => r.Type.startsWith('AWS::SES::')).length, 0);
  const params = template.toJSON().Parameters;
  assert.ok(params.sesSender);
  const fn = ofType('AWS::Lambda::Function').find((f) => f.Properties!.FunctionName === 'learnloop-prod-admin')!;
  assert.deepEqual(fn.Properties!.Environment.Variables.SES_SENDER, { Ref: 'sesSender' });
});

test('renewal schedule targets the billing function with the renewal job', () => {
  const [rule] = ofType('AWS::Events::Rule');
  assert.equal(rule.Properties!.ScheduleExpression, 'cron(10 0 * * ? *)');
  const target = rule.Properties!.Targets[0];
  assert.deepEqual(JSON.parse(target.Input), { job: 'renew_subscriptions' });
  const billingId = Object.entries(resources).find(([, r]) => r.Properties?.FunctionName === 'learnloop-prod-billing')![0];
  assert.deepEqual(target.Arn, { 'Fn::GetAtt': [billingId, 'Arn'] });
});

test('stack outputs used by deploy and upload tooling', () => {
  const outputs = template.toJSON().Outputs;
  for (const key of ['DistributionId', 'DistributionDomainName', 'WebBucketName', 'StateBucketName', 'AccessLogsBucketName',
    'AppLogsBucketName', 'CloudFrontLogPrefix', 'LogPseudonymSaltSecretName', 'JwtSecretName']) {
    assert.ok(outputs[key], key);
  }
  assert.equal(outputs.CloudFrontLogPrefix.Value, 'cloudfront/');
});

test('synth did not bundle any Lambda code', () => {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else files.push(name);
    }
  };
  walk(outdir);
  assert.ok(!files.some((f) => f.endsWith('.mjs') || f === 'index.js'), `bundled output found: ${files.filter((f) => f.endsWith('.mjs'))}`);
});

test('every taggable resource carries Application=learnloop and env=prod', () => {
  const mustBeTagged = new Set([
    'AWS::Lambda::Function', 'AWS::Logs::LogGroup', 'AWS::S3::Bucket', 'AWS::ApiGatewayV2::Api', 'AWS::ApiGatewayV2::Stage',
    'AWS::CloudFront::Distribution', 'AWS::SSM::Parameter', 'AWS::IAM::Role', 'AWS::SecretsManager::Secret',
    'AWS::Events::Rule',
  ]);
  const hasTags = (tags: any) => {
    if (!tags) return false;
    if (Array.isArray(tags)) {
      const map = Object.fromEntries(tags.map((t: any) => [t.Key, t.Value]));
      return map.Application === 'learnloop' && map.env === 'prod';
    }
    return tags.Application === 'learnloop' && tags.env === 'prod';
  };
  for (const [id, r] of Object.entries(resources)) {
    if (mustBeTagged.has(r.Type)) assert.ok(hasTags(r.Properties?.Tags), `${id} (${r.Type}) is untagged`);
    else if (r.Properties?.Tags) assert.ok(hasTags(r.Properties.Tags), `${id} (${r.Type}) has incomplete tags`);
  }
});

test('GitHub OIDC deploy role is limited to the main branch of one repository', () => {
  const app = new App();
  Tags.of(app).add('Application', 'learnloop');
  const stack = new GithubOidcStack(app, 'Oidc', { env: { account: '123456789012', region: 'us-east-1' }, githubRepo: 'example/learnloop' });
  const t = Template.fromStack(stack).toJSON();
  const role = Object.values(t.Resources as Record<string, any>).find((r) => r.Type === 'AWS::IAM::Role');
  const condition = role.Properties.AssumeRolePolicyDocument.Statement[0].Condition;
  assert.equal(condition.StringEquals['token.actions.githubusercontent.com:aud'], 'sts.amazonaws.com');
  assert.deepEqual(condition.StringLike['token.actions.githubusercontent.com:sub'], [
    'repo:example/learnloop:ref:refs/heads/main',
    'repo:example/learnloop:environment:prod',
    'repo:example/learnloop:environment:preview',
  ]);
  assert.ok(t.Outputs.DeployRoleArn);
  const policy = Object.values(t.Resources as Record<string, any>).find((r) => r.Type === 'AWS::IAM::Policy');
  const actions = policy.Properties.PolicyDocument.Statement.flatMap((s: any) => [s.Action].flat());
  for (const action of ['ssm:GetParameter', 'ssm:PutParameter', 'lambda:InvokeFunction', 's3:PutObject']) assert.ok(actions.includes(action), action);
  assert.equal(role.Properties.RoleName, 'learnloop-github-deploy');
});
