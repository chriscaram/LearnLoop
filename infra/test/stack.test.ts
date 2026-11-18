import { test as nodeTest } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { App, Tags } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { ENVIRONMENTS, LearnLoopStack, type EnvironmentName } from '../lib/learnloop-stack.js';
import { GithubOidcStack } from '../lib/github-oidc-stack.js';
import { SERVICES } from '../lib/services.js';

// Offline synth: no AWS calls, no Docker and no asset bundling. With an empty
// bundling-stacks list CDK neither runs esbuild nor builds a Docker image.
const outdir = mkdtempSync(path.join(tmpdir(), 'learnloop-cdk-'));
function synth(environmentName?: EnvironmentName) {
  const app = new App({ outdir, context: { 'aws:cdk:bundling-stacks': [] } });
  const stackName = ENVIRONMENTS[environmentName ?? 'prod'].stackName;
  const stack = new LearnLoopStack(app, stackName, {
    env: { account: '123456789012', region: 'us-east-1' }, appVersion: 'a1b2c3d', ...(environmentName ? { environmentName } : {}),
  });
  return Template.fromStack(stack);
}
const resourcesOf = (template: Template) => template.toJSON().Resources as Record<string, { Type: string; Properties?: Record<string, any> }>;

// prod is the default: a stack built without an environment name is prod.
const CASES: { environment: EnvironmentName; template: Template }[] = [
  { environment: 'prod', template: synth() },
  { environment: 'staging', template: synth('staging') },
];

for (const { environment, template } of CASES) {
  const prefix = `learnloop-${environment}`;
  const applicationTag = ENVIRONMENTS[environment].applicationTag;
  const resources = resourcesOf(template);
  const ofType = (type: string) => Object.values(resources).filter((r) => r.Type === type);
  const test = (name: string, fn: () => void) => nodeTest(`${environment}: ${name}`, fn);

  test('one Lambda per service with the required runtime settings and environment', () => {
    const fns = ofType('AWS::Lambda::Function').filter((f) => String(f.Properties?.FunctionName ?? '').startsWith(`${prefix}-`));
    assert.deepEqual(fns.map((f) => f.Properties!.FunctionName).sort(), Object.keys(SERVICES).map((s) => `${prefix}-${s}`).sort());
    for (const fn of fns) {
      const p = fn.Properties!;
      assert.equal(p.Runtime, 'nodejs22.x');
      assert.deepEqual(p.Architectures, ['arm64']);
      assert.equal(p.MemorySize, 512);
      assert.equal(p.Timeout, p.FunctionName === `${prefix}-learning` ? 120 : 10);
      assert.equal(p.LoggingConfig.LogFormat, 'JSON');
      for (const key of ['APP_ENV', 'APP_VERSION', 'STATE_BUCKET', 'FLAGS_PARAMETER', 'LOG_PSEUDONYM_SALT_PARAMETER']) {
        assert.ok(key in p.Environment.Variables, `${p.FunctionName} ${key}`);
      }
      assert.equal(p.Environment.Variables.APP_ENV, environment);
      assert.equal(p.Environment.Variables.APP_VERSION, 'a1b2c3d');
    }
  });

  test('log groups exist explicitly with 90-day retention', () => {
    const names = ofType('AWS::Logs::LogGroup').map((g) => [g.Properties!.LogGroupName, g.Properties!.RetentionInDays]);
    for (const service of Object.keys(SERVICES)) assert.deepEqual(names.find(([n]) => n === `/aws/lambda/${prefix}-${service}`), [`/aws/lambda/${prefix}-${service}`, 90]);
    assert.deepEqual(names.find(([n]) => n === `/aws/apigateway/${prefix}`), [`/aws/apigateway/${prefix}`, 90]);
  });

  test('all service functions share one execution role with AdministratorAccess (first iteration)', () => {
    template.hasResourceProperties('AWS::IAM::Role', {
      RoleName: `${prefix}-lambda-role`,
      ManagedPolicyArns: [{ 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':iam::aws:policy/AdministratorAccess']] }],
    });
    const roleIds = new Set(ofType('AWS::Lambda::Function').filter((f) => String(f.Properties?.FunctionName ?? '').startsWith(`${prefix}-`)).map((f) => JSON.stringify(f.Properties!.Role)));
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
    const access = named(`${prefix}-access-logs-`);
    assert.equal(access.OwnershipControls.Rules[0].ObjectOwnership, 'BucketOwnerPreferred');
    assert.equal(access.BucketEncryption.ServerSideEncryptionConfiguration[0].ServerSideEncryptionByDefault.SSEAlgorithm, 'AES256');
    assert.equal(access.LifecycleConfiguration.Rules[0].ExpirationInDays, 120);
    assert.equal(named(`${prefix}-app-logs-`).LifecycleConfiguration.Rules[0].ExpirationInDays, 120);
    assert.ok(named(`${prefix}-state-`));
    assert.ok(named(`${prefix}-web-`));
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
    template.hasResourceProperties('AWS::SSM::Parameter', { Name: `/learnloop/${environment}/feature-flags`, Type: 'String', Tier: 'Standard' });
    const secrets = ofType('AWS::SecretsManager::Secret').map((r) => r.Properties!);
    assert.deepEqual(secrets.map((p) => p.Name).sort(), [`learnloop/${environment}/jwt-secret`, `learnloop/${environment}/log-pseudonym-salt`]);
    for (const p of secrets) assert.ok(p.GenerateSecretString && !p.SecretString, 'value generated by Secrets Manager');
    assert.equal(Object.values(resources).filter((r) => r.Type.startsWith('Custom::') || r.Type === 'AWS::CloudFormation::CustomResource').length, 0);
    const fn = ofType('AWS::Lambda::Function').find((f) => f.Properties!.FunctionName === `${prefix}-learning`)!;
    assert.equal(fn.Properties!.Environment.Variables.LOG_PSEUDONYM_SALT_PARAMETER, `learnloop/${environment}/log-pseudonym-salt`);
    assert.equal(fn.Properties!.Environment.Variables.JWT_SECRET_PARAMETER, `learnloop/${environment}/jwt-secret`);
  });

  test('SES: no identities are created; the sender is a parameter', () => {
    assert.equal(Object.values(resources).filter((r) => r.Type.startsWith('AWS::SES::')).length, 0);
    const params = template.toJSON().Parameters;
    assert.ok(params.sesSender);
    const fn = ofType('AWS::Lambda::Function').find((f) => f.Properties!.FunctionName === `${prefix}-admin`)!;
    assert.deepEqual(fn.Properties!.Environment.Variables.SES_SENDER, { Ref: 'sesSender' });
  });

  test('renewal schedule targets the billing function with the renewal job', () => {
    const rule = ofType('AWS::Events::Rule').find((r) => r.Properties!.Name === `${prefix}-renew-subscriptions`)!;
    assert.equal(rule.Properties!.ScheduleExpression, 'cron(10 0 * * ? *)');
    const target = rule.Properties!.Targets[0];
    assert.deepEqual(JSON.parse(target.Input), { job: 'renew_subscriptions' });
    const billingId = Object.entries(resources).find(([, r]) => r.Properties?.FunctionName === `${prefix}-billing`)![0];
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

  test(`every taggable resource carries Application=${applicationTag} and env=${environment}`, () => {
    const mustBeTagged = new Set([
      'AWS::Lambda::Function', 'AWS::Logs::LogGroup', 'AWS::S3::Bucket', 'AWS::ApiGatewayV2::Api', 'AWS::ApiGatewayV2::Stage',
      'AWS::CloudFront::Distribution', 'AWS::SSM::Parameter', 'AWS::IAM::Role', 'AWS::SecretsManager::Secret',
      'AWS::Events::Rule',
    ]);
    const hasTags = (tags: any) => {
      if (!tags) return false;
      if (Array.isArray(tags)) {
        const map = Object.fromEntries(tags.map((t: any) => [t.Key, t.Value]));
        return map.Application === applicationTag && map.env === environment;
      }
      return tags.Application === applicationTag && tags.env === environment;
    };
    for (const [id, r] of Object.entries(resources)) {
      if (mustBeTagged.has(r.Type)) assert.ok(hasTags(r.Properties?.Tags), `${id} (${r.Type}) is untagged`);
      else if (r.Properties?.Tags) assert.ok(hasTags(r.Properties.Tags), `${id} (${r.Type}) has incomplete tags`);
    }
  });
}

const [prodCase, stagingCase] = CASES;
const physicalNames = (template: Template) => new Set(Object.values(resourcesOf(template)).flatMap((r) => {
  const p = r.Properties ?? {};
  return [p.BucketName, p.FunctionName, p.Name, p.LogGroupName, p.RoleName, p.ApiName?.toString()]
    .filter((v) => v !== undefined).map((v) => JSON.stringify(v))
    .filter((v) => !v.includes('"Fn::GetAtt"') && !v.includes('"Ref"')); // references, not names
}));

nodeTest('prod and staging share no physical resource name', () => {
  const prod = physicalNames(prodCase.template);
  const shared = [...physicalNames(stagingCase.template)].filter((n) => prod.has(n));
  assert.deepEqual(shared, []);
});

nodeTest('staging has the same outputs as prod, pointing at its own resources', () => {
  const prod = prodCase.template.toJSON().Outputs;
  const staging = stagingCase.template.toJSON().Outputs;
  assert.deepEqual(Object.keys(staging).sort(), Object.keys(prod).sort());
  const resources = resourcesOf(stagingCase.template);
  const target = (key: string) => {
    // the resource the output refers to (Ref or Fn::GetAtt, possibly nested in Fn::Join)
    const value = JSON.stringify(staging[key].Value);
    const id = /"(?:Ref|Fn::GetAtt)":\[?"([A-Za-z0-9]+)"/.exec(value)?.[1];
    return id && resources[id] ? JSON.stringify(resources[id].Properties) : value;
  };
  for (const [key, name] of [['FeatureFlagsParameter', '/learnloop/staging/feature-flags'],
    ['LogPseudonymSaltSecretName', 'learnloop/staging/log-pseudonym-salt'], ['JwtSecretName', 'learnloop/staging/jwt-secret']]) {
    assert.ok(target(key).includes(`"${name}"`), `${key}: ${target(key)}`);
  }
  for (const [key, bucket] of [['StateBucketName', 'state'], ['WebBucketName', 'web'], ['AppLogsBucketName', 'app-logs'], ['AccessLogsBucketName', 'access-logs']]) {
    assert.ok(target(key).includes(`learnloop-staging-${bucket}-`), `${key}: ${target(key)}`);
  }
});

nodeTest('the prod application tag stays learnloop; staging is learnloop-staging', () => {
  assert.equal(ENVIRONMENTS.prod.stackName, 'LearnLoopProd');
  assert.equal(ENVIRONMENTS.prod.applicationTag, 'learnloop');
  assert.equal(ENVIRONMENTS.staging.stackName, 'LearnLoopStaging');
  assert.equal(ENVIRONMENTS.staging.applicationTag, 'learnloop-staging');
});

nodeTest('GitHub OIDC deploy role is limited to the main branch of one repository', () => {
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
  for (const action of ['ssm:GetParameter', 'ssm:PutParameter', 'lambda:InvokeFunction', 's3:PutObject', 's3:GetObject']) assert.ok(actions.includes(action), action);

  const withIds = new GithubOidcStack(new App(), 'OidcIds', {
    env: { account: '123456789012', region: 'us-east-1' }, githubRepo: 'example/learnloop', githubOwnerId: '111', githubRepoId: '222',
  });
  const idRole = Object.values(Template.fromStack(withIds).toJSON().Resources as Record<string, any>).find((r) => r.Type === 'AWS::IAM::Role');
  const idSubjects = idRole.Properties.AssumeRolePolicyDocument.Statement[0].Condition.StringLike['token.actions.githubusercontent.com:sub'];
  assert.ok(idSubjects.includes('repo:example/learnloop:environment:prod'));
  assert.ok(idSubjects.includes('repo:example@111/learnloop@222:environment:prod'));
  assert.ok(idSubjects.includes('repo:example@111/learnloop@222:environment:preview'));
  assert.ok(idSubjects.includes('repo:example@111/learnloop@222:ref:refs/heads/main'));
  assert.equal(role.Properties.RoleName, 'learnloop-github-deploy');
});

nodeTest('GitHub OIDC deploy role reaches prod and staging resources by name, nothing broader', () => {
  const stack = new GithubOidcStack(new App(), 'OidcScope', { env: { account: '123456789012', region: 'us-east-1' }, githubRepo: 'example/learnloop' });
  const t = Template.fromStack(stack).toJSON();
  const policy = Object.values(t.Resources as Record<string, any>).find((r) => r.Type === 'AWS::IAM::Policy');
  // Fn::Join of literal parts and pseudo-parameter refs -> a readable ARN
  const flat = (v: any): string => (typeof v === 'string' ? v
    : v['Fn::Join'] ? v['Fn::Join'][1].map(flat).join(v['Fn::Join'][0])
      : v.Ref ? `{${v.Ref}}` : JSON.stringify(v));
  const grants = new Map<string, string[]>();
  for (const s of policy.Properties.PolicyDocument.Statement) {
    const key = [s.Action].flat().sort().join(',');
    grants.set(key, [...(grants.get(key) ?? []), ...[s.Resource].flat().map(flat)]);
  }
  const arn = (service: string, rest: string) => `arn:{AWS::Partition}:${service}:{AWS::Region}:{AWS::AccountId}:${rest}`;
  assert.deepEqual(Object.fromEntries(grants), {
    'sts:AssumeRole': ['arn:{AWS::Partition}:iam::{AWS::AccountId}:role/cdk-*'],
    'cloudformation:DescribeStacks': [arn('cloudformation', 'stack/LearnLoopProd/*'), arn('cloudformation', 'stack/LearnLoopStaging/*')],
    's3:ListBucket': ['arn:{AWS::Partition}:s3:::learnloop-prod-web-{AWS::AccountId}', 'arn:{AWS::Partition}:s3:::learnloop-staging-web-{AWS::AccountId}'],
    's3:DeleteObject,s3:GetObject,s3:PutObject': ['arn:{AWS::Partition}:s3:::learnloop-prod-web-{AWS::AccountId}/*', 'arn:{AWS::Partition}:s3:::learnloop-staging-web-{AWS::AccountId}/*'],
    'cloudfront:CreateInvalidation,cloudfront:GetInvalidation': ['*'],
    'ssm:GetParameter,ssm:PutParameter': [arn('ssm', 'parameter/learnloop/prod/feature-flags'), arn('ssm', 'parameter/learnloop/staging/feature-flags')],
    'lambda:InvokeFunction': [arn('lambda', 'function:learnloop-prod-*'), arn('lambda', 'function:learnloop-staging-*')],
    's3:GetObject,s3:PutObject': ['arn:{AWS::Partition}:s3:::learnloop-prod-state-{AWS::AccountId}/*', 'arn:{AWS::Partition}:s3:::learnloop-staging-state-{AWS::AccountId}/*'],
  });
  // trust is unchanged: the main branch and the prod and preview environments
  const role = Object.values(t.Resources as Record<string, any>).find((r) => r.Type === 'AWS::IAM::Role');
  assert.deepEqual(role.Properties.AssumeRolePolicyDocument.Statement[0].Condition.StringLike['token.actions.githubusercontent.com:sub'], [
    'repo:example/learnloop:ref:refs/heads/main',
    'repo:example/learnloop:environment:prod',
    'repo:example/learnloop:environment:preview',
  ]);
});
