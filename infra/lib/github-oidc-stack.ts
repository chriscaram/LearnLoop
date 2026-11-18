import { Aws, CfnOutput, Duration, Stack, type StackProps } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import type { Construct } from 'constructs';
import { ENVIRONMENTS, parameterNames, resourcePrefix, type EnvironmentName } from './environments.js';

export interface GithubOidcStackProps extends StackProps {
  /** "owner/repo" */
  githubRepo: string;
  /**
   * Numeric GitHub ids of the owner and the repository. GitHub may issue OIDC
   * subjects in the immutable form repo:<owner>@<ownerId>/<repo>@<repoId>:...;
   * when both ids are given, that form is trusted as well.
   */
  githubOwnerId?: string;
  githubRepoId?: string;
  /** Reuse an existing token.actions.githubusercontent.com provider in the account. */
  existingProviderArn?: string;
}

/** The deploy role GitHub Actions assumes through OIDC. Deployed once by the operator. */
export class GithubOidcStack extends Stack {
  constructor(scope: Construct, id: string, props: GithubOidcStackProps) {
    super(scope, id, props);

    const providerArn = props.existingProviderArn ?? new iam.OidcProviderNative(this, 'GithubProvider', {
      url: 'https://token.actions.githubusercontent.com',
      clientIds: ['sts.amazonaws.com'],
    }).oidcProviderArn;

    const [owner, repo] = props.githubRepo.split('/');
    const repoForms = [props.githubRepo];
    if (props.githubOwnerId && props.githubRepoId) repoForms.push(`${owner}@${props.githubOwnerId}/${repo}@${props.githubRepoId}`);
    const subjects = repoForms.flatMap((r) => [
      `repo:${r}:ref:refs/heads/main`,
      `repo:${r}:environment:prod`,
      `repo:${r}:environment:preview`,
    ]);

    const role = new iam.Role(this, 'DeployRole', {
      roleName: 'learnloop-github-deploy',
      description: 'Assumed by GitHub Actions (main, prod and preview environments) to deploy LearnLoop',
      maxSessionDuration: Duration.hours(1),
      assumedBy: new iam.WebIdentityPrincipal(providerArn, {
        StringEquals: { 'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com' },
        StringLike: {
          'token.actions.githubusercontent.com:sub': subjects,
        },
      }),
    });

    // cdk deploy works through the CDK bootstrap roles
    role.addToPolicy(new iam.PolicyStatement({
      actions: ['sts:AssumeRole'],
      resources: [`arn:${Aws.PARTITION}:iam::${Aws.ACCOUNT_ID}:role/cdk-*`],
    }));
    // The same permissions for every deployment (prod and staging), each scoped to that
    // deployment's own stack and resource names.
    const environments = Object.keys(ENVIRONMENTS) as EnvironmentName[];
    const each = (arn: (environment: EnvironmentName) => string) => environments.map(arn);
    role.addToPolicy(new iam.PolicyStatement({
      actions: ['cloudformation:DescribeStacks'],
      resources: each((e) => `arn:${Aws.PARTITION}:cloudformation:${Aws.REGION}:${Aws.ACCOUNT_ID}:stack/${ENVIRONMENTS[e].stackName}/*`),
    }));
    const webBucketArns = each((e) => `arn:${Aws.PARTITION}:s3:::${resourcePrefix(e)}-web-${Aws.ACCOUNT_ID}`);
    role.addToPolicy(new iam.PolicyStatement({ actions: ['s3:ListBucket'], resources: webBucketArns }));
    role.addToPolicy(new iam.PolicyStatement({ actions: ['s3:PutObject', 's3:DeleteObject', 's3:GetObject'], resources: webBucketArns.map((arn) => `${arn}/*`) }));
    role.addToPolicy(new iam.PolicyStatement({ actions: ['cloudfront:CreateInvalidation', 'cloudfront:GetInvalidation'], resources: ['*'] }));

    // preview.yml / preview-reset.yml / deploy-staging.yml: feature flags, one-off job runs, data reset and read-back
    role.addToPolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameter', 'ssm:PutParameter'],
      resources: each((e) => `arn:${Aws.PARTITION}:ssm:${Aws.REGION}:${Aws.ACCOUNT_ID}:parameter${parameterNames(e).flags}`),
    }));
    role.addToPolicy(new iam.PolicyStatement({
      actions: ['lambda:InvokeFunction'],
      resources: each((e) => `arn:${Aws.PARTITION}:lambda:${Aws.REGION}:${Aws.ACCOUNT_ID}:function:${resourcePrefix(e)}-*`),
    }));
    // s3:GetObject: preview.yml names the learners a job messaged (tools/ops new-notifications.js)
    role.addToPolicy(new iam.PolicyStatement({
      actions: ['s3:PutObject', 's3:GetObject'],
      resources: each((e) => `arn:${Aws.PARTITION}:s3:::${resourcePrefix(e)}-state-${Aws.ACCOUNT_ID}/*`),
    }));

    new CfnOutput(this, 'DeployRoleArn', { value: role.roleArn });
  }
}
