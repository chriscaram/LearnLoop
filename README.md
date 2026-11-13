# LearnLoop

LearnLoop is an online course platform with a monthly subscription. Learners sign in, browse a catalog of 12 courses, work through lessons and quizzes, track their progress, manage their subscription and read notifications. Staff see a learner list, write to learners and switch feature flags.

It runs on AWS (CloudFront, S3, API Gateway HTTP API, Lambda on Node.js 22) and uses **mock data only**. There is no database and no payment provider: checkout always succeeds and state lives in JSON documents in S3.

## Architecture

```
                 Browser (React SPA)
                        |
                        v
          CloudFront  (standard access logs -> s3://learnloop-prod-access-logs-<account>/cloudfront/)
           |                         |
     /* (default)                 /api/*
           |                         |
           v                         v
   S3 web bucket            API Gateway HTTP API  (access logs -> /aws/apigateway/learnloop-prod)
   (SPA, OAC)                        |
                                     | one route per endpoint, one integration per service
       +-----------+-----------+-----+------+-------------+-----------+
       v           v           v            v             v           v
   identity     catalog     learning     billing    notifications   admin      Lambda: learnloop-prod-<service>
       |           |           |            |             |           |       logs -> /aws/lambda/learnloop-prod-<service>
       +-----------+-----------+-----+------+-------------+-----------+
                                     |
            +------------------------+-------------------------+-----------------+
            v                        v                         v                 v
   s3://learnloop-prod-state-<account>/   SSM parameter        Secrets Manager                SES (sandbox)
   state/<domain>.json                    /learnloop/prod/     learnloop/prod/jwt-secret      welcome, payment_receipt,
   (mock data, conditional writes)        feature-flags        learnloop/prod/log-pseudonym-salt   staff_message

   EventBridge (daily 00:10 UTC) -> billing { "job": "renew_subscriptions" }  (services/billing/src/jobs/renewals.js)
   s3://learnloop-prod-app-logs-<account>/app-logs/  historical application logs in the same format as the Lambda logs
```

## Repository layout

```
package.json             npm workspaces
services/<service>/      one deployable Lambda per directory; the directory name is service.name in logs
  src/handler.js         Lambda entry point
  src/routes.js          method + route template -> handler (also drives the API Gateway routes)
  src/services/*.js      business logic (named exported functions)
  src/repositories/*.js  the only code that touches the state store
  src/jobs/*.js          scheduled jobs (billing: daily renewals)
  test/*.test.js
packages/shared/         logger, auth, feature flags, state store, HTTP helpers, test fakes, flag CLI
web/                     React + Vite single-page app
data/seed/               mock data (JSON), the initial state
tools/dev/               local development server
tools/ops/               operator scripts (state:reset)
infra/                   AWS CDK v2 (TypeScript): the app stack and the GitHub OIDC stack
docs/business/           business documents
```

| Service | Routes |
|---|---|
| identity | `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/me` |
| catalog | `GET /api/courses`, `GET /api/courses/{courseId}`, `POST /api/courses/{courseId}/enrol`, `GET /api/me/enrolments` |
| learning | `GET /api/courses/{courseId}/lessons`, `GET /api/lessons/{lessonId}`, `POST /api/lessons/{lessonId}/progress`, `POST /api/lessons/{lessonId}/quiz`, `GET /api/me/progress` |
| billing | `GET /api/me/subscription`, `POST /api/checkout`, `POST /api/me/subscription/cancel`; job `renew_subscriptions` |
| notifications | `GET /api/me/notifications`, `POST /api/me/notifications/{notificationId}/read`, `GET /api/me/notifications/unread-count` |
| admin (staff) | `GET /api/admin/learners`, `POST /api/admin/learners/{userId}/message`, `GET /api/admin/flags`, `PUT /api/admin/flags/{flagKey}` |

Sessions are HMAC-SHA256 signed tokens (12 hours) in an `HttpOnly`, `Secure`, `SameSite=Lax` cookie. Every account uses the demo password `learnloop-demo`.

## Local development

Requirements: Node.js 22.

```bash
npm ci
npm run dev        # API on http://localhost:3001, web app on http://localhost:5173
npm test           # all workspaces, offline, about 20 seconds
```

`npm run dev` runs all six service handlers in one Node process behind a small router that builds API Gateway HTTP API events. State is in memory, loaded from `data/seed/` (restart to reset). SSM, Secrets Manager and SES are faked. Application logs are printed to the console in the same JSON format as in AWS. Use `npm run dev -- --api-only` to start only the API.

## Logging

All services log through `packages/shared/src/logger.js`: one JSON object per line on stdout. Each HTTP request writes exactly one `"kind": "request"` line when it completes. Business actions also write `"kind": "event"` lines, using a closed list of event names. Operational warnings and errors use `"kind": "log"` with a fixed message and an `error.type`. Field names use the dotted form (`service.name`, `http.route`, `user.id`, …).

- `user.id` / `session.id` are pseudonymised: `"u_" + hex(HMAC-SHA256(salt, id)).slice(0, 16)` (and `"s_"` for sessions). The salt is the Secrets Manager secret `learnloop/prod/log-pseudonym-salt`. Any tooling that writes logs in this format must use the same function and salt, so that one learner always has the same `user.id`.
- Records are built from an allowlist of fields. Names, emails, passwords, tokens, cookies, query strings, IP addresses, request bodies, free text and money amounts are never written. The logger tests check this.
- `user.id` and `session.id` are absent for anonymous requests. Scheduled jobs (renewals) log with `actor_type: "system"`, the subscriber's `user.id` and no `session.id`.

## Deploying

Everything goes to `us-east-1`. Resources are tagged `Application=learnloop` and `env=prod`.

1. **Bootstrap CDK** once per account: `cd infra && npx cdk bootstrap aws://<account>/us-east-1`.
2. **GitHub OIDC deploy role.** The operator deploys this once with local admin credentials:
   ```bash
   cd infra
   npx cdk --app "npx tsx bin/github-oidc.ts" deploy -c githubRepo=<owner>/<repo>
   # if GitHub issues id-based subjects (repo:<owner>@<ownerId>/<repo>@<repoId>:...):
   #   ... -c githubOwnerId=<numeric owner id> -c githubRepoId=<numeric repo id>
   # if the account already has the GitHub OIDC provider:
   #   ... -c existingOidcProviderArn=arn:aws:iam::<account>:oidc-provider/token.actions.githubusercontent.com
   ```
   The output `DeployRoleArn` is the role GitHub Actions assumes. It trusts that repository's `main` branch and its `prod` and `preview` environments.
3. **SES.** Before the first deploy, verify the sender address and your own recipient address in the SES console (the account stays in the SES sandbox). The stack does not create or verify SES identities. It only takes the sender as the `sesSender` parameter. The `@example.com` demo addresses cannot receive mail, so set `emailRecipientOverride` to your verified recipient to receive all demo email there. If SES rejects a message, the notification is still created and the API reports `"email": "failed"`.
4. **GitHub configuration** (repository environments `prod` and `preview`), repository variables only, no secrets: `AWS_DEPLOY_ROLE_ARN`, `SES_SENDER`, and optionally `EMAIL_RECIPIENT_OVERRIDE`.
5. **Push to `main`.** `.github/workflows/deploy.yml` runs the tests, builds `web`, runs `cdk deploy` with `APP_VERSION` set to the short commit SHA, syncs `web/dist` to the web bucket and invalidates CloudFront (the steps live in the reusable `_deploy.yml`; it can also be started by hand). `.github/workflows/ci.yml` runs `npm ci && npm test` on every push and pull request. No long-lived AWS keys are used anywhere.

CDK stack parameters: `sesSender` and `emailRecipientOverride` (optional).

**Secrets.** CDK creates two Secrets Manager secrets with generated values: `learnloop/prod/jwt-secret` (signs session tokens) and `learnloop/prod/log-pseudonym-salt`. The functions receive the secret names in `JWT_SECRET_PARAMETER` and `LOG_PSEUDONYM_SALT_PARAMETER`. To read the salt: `aws secretsmanager get-secret-value --secret-id learnloop/prod/log-pseudonym-salt --query SecretString --output text`.

**Access logs.** The access-logs bucket has ACLs enabled (`BucketOwnerPreferred`) and SSE-S3 encryption, which is what CloudFront standard logging requires. The distribution logs to that bucket under the prefix `cloudfront/`. The stack outputs `AccessLogsBucketName` and `CloudFrontLogPrefix` name the location.

**Previews of `ga/*` branches.** When a `ga/<id>` pull request gets the `ga-verified` label, `preview.yml` deploys the PR merged into the current `main` (`refs/pull/<number>/merge`, so an older branch never rolls back later changes to `main`; a PR that conflicts with `main` is not deployed and gets a comment saying so) to `LearnLoopProd`, switches the flag `ga-<id>` on, runs once every scheduled job the branch registers that `main` does not (found by invoking each function with `{"listJobs": true}`; `node tools/ops/src/list-jobs.js <checkout>` gives the same list from a checkout), and comments the result on the PR, including the names of the learners the jobs messaged (demo data; `npm run notifications:since -- <ISO time>` lists them with their emails, using local AWS credentials). Closing such a PR without merging runs `preview-reset.yml`: it redeploys `main`, switches the flag off and runs `npm run state:reset`. Both can be started by hand from the Actions tab. All deploying workflows share the `deploy-prod` concurrency group.

**Offline tests.** `npm test` synthesizes the stacks with asset bundling disabled. It needs no AWS access, no Docker and no esbuild. Real deploys bundle each function locally with esbuild (an `infra` devDependency).

## Mock data

`data/seed/*.json` is the initial state: users, courses, lessons, enrolments, progress, subscriptions, notifications and quiz results. Lambda bundles include these files. Each state domain is copied into the state bucket the first time it is read, and `npm run state:reset` restores them. The files are generated by a separate repository, `learnloop-demo-tools`, which also uploads historical logs to the app-logs bucket and to the access-logs bucket under `cloudfront/`.

## Demo logins

All accounts use the password `learnloop-demo`.

| Email | Role |
|---|---|
| `ana.moreno@example.com` | learner |
| `marco.bellini@example.com` | learner |
| `sofia.lindqvist@example.com` | staff |
| `daniel.okafor@example.com` | staff |
| `priya.nair@example.com` | staff |

The other learner accounts are listed in `data/seed/users.json`.

## Feature flags

Flags are a JSON map `{ "<flagKey>": { "enabled": true|false } }` in the SSM parameter `/learnloop/prod/feature-flags`. Code calls `isEnabled(flagKey, { userId })` from `packages/shared/src/flags.js`. Values are cached for 30 seconds. An unknown key returns `false`, and so does a read failure (which also logs a warning). It never throws. This is the standard way to ship a feature dark. The example in use is `new_catalog_filters`, which gates the category filter on `/courses`.

```bash
npm run flag -- list
npm run flag -- new_catalog_filters off
npm run flag -- new_catalog_filters on
```

Staff can also toggle flags on the Admin page, under Feature flags. Changes made there are logged as `feature_flag_changed`.

## Resetting state

```bash
npm run state:reset     # writes data/seed/*.json back to s3://<state bucket>/state/
```

## Cost notes

At demo traffic the stack stays well under 5 USD a month. The costs are mostly S3 storage for logs (a few hundred MB, expired after 120 days), CloudWatch Logs ingestion and storage (90-day retention), and CloudFront and Lambda requests, which mostly fall within the free tier. The two Secrets Manager secrets cost about 0.80 USD a month. The SSM standard parameter, SES sandbox and the HTTP API are negligible at this volume. CloudFront uses price class 100.

## Known shortcuts

- **IAM:** all six functions share one execution role, `learnloop-prod-lambda-role`, which has `AdministratorAccess`. This is a deliberate first-iteration shortcut. Per-service least-privilege roles are planned as a hardening step, and the application code only uses the resources named in its environment.
- The state store keeps whole JSON documents per domain. That suits mock data at demo scale, not production traffic.

## Teardown

```bash
cd infra
npx cdk destroy LearnLoopProd
npx cdk --app "npx tsx bin/github-oidc.ts" destroy -c githubRepo=<owner>/<repo>
```

The four S3 buckets are retained on purpose (logs and state). Empty and delete them when you no longer need them:

```bash
for b in web state access-logs app-logs; do
  aws s3 rb "s3://learnloop-prod-$b-<account>" --force
done
```

The two secrets are deleted with the stack (Secrets Manager schedules deletion with a recovery window). Delete the SES identities you verified in the SES console when you are done.
