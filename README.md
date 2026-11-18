# LearnLoop

LearnLoop is an online course platform with a monthly subscription. Learners sign in, browse a catalog of 12 courses, put courses in a cart and check out, work through lessons and quizzes, track their progress, manage their subscription, read notifications and ask the team questions. Some learners are employees of enterprise customer accounts that require them to complete certain courses by a date. Staff see a learner list, look up an employee's required training, answer learner questions, write to learners and switch feature flags.

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
packages/shared/         logger, auth, feature flags, state store, HTTP helpers, test fakes
web/                     React + Vite single-page app
data/seed/               mock data (JSON), the initial state
tools/dev/               local development server
tools/ops/               operator scripts (state:reset, flag, notifications:since, list-jobs, list-flags)
infra/                   AWS CDK v2 (TypeScript): the app stack (prod and staging) and the GitHub OIDC stack
docs/business/           business documents
```

| Service | Routes |
|---|---|
| identity | `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/me` |
| catalog | `GET /api/courses`, `GET /api/courses/{courseId}`, `POST /api/courses/{courseId}/enrol`, `GET /api/me/enrolments`, `GET /api/me/cart`, `POST /api/me/cart/items`, `DELETE /api/me/cart/items/{courseId}` |
| learning | `GET /api/courses/{courseId}/lessons`, `GET /api/lessons/{lessonId}`, `POST /api/lessons/{lessonId}/progress`, `POST /api/lessons/{lessonId}/quiz`, `GET /api/me/progress` |
| billing | `GET /api/me/subscription`, `POST /api/checkout`, `POST /api/me/subscription/cancel`; job `renew_subscriptions` |
| notifications | `GET /api/me/notifications`, `POST /api/me/notifications/{notificationId}/read`, `GET /api/me/notifications/unread-count`, `GET /api/me/support-requests`, `POST /api/me/support-requests` |
| admin (staff) | `GET /api/admin/learners` (`?organization=<id>` for one enterprise account's employees), `GET /api/admin/learners/{userId}/training`, `POST /api/admin/learners/{userId}/message`, `GET /api/admin/flags`, `PUT /api/admin/flags/{flagKey}`, `GET /api/admin/support-requests` (`?status=open` by default, or `answered`), `POST /api/admin/support-requests/{requestId}/reply`; job `check_support_backlog` |

Sessions are HMAC-SHA256 signed tokens (12 hours) in an `HttpOnly`, `Secure`, `SameSite=Lax` cookie. Every account uses the demo password `learnloop-demo`.

**Cart.** Signed out, the cart is kept in the browser (localStorage). At sign-in the web app merges it into the account's cart (`/api/me/cart`) once; from then on the server holds it, so it follows the learner to other devices. Enrolling in a course, at checkout or from the course page, takes it out of the cart. The wishlist stays in the browser.

**Enterprise accounts and required training.** An enterprise customer account is an `organizations` record (`id`, `name`, `created_at`). Its employees are ordinary learners whose user record also has `organization_id`, `department` (their team) and `manager_id` (the user id of their manager, who is an employee of the same account; `null` for a manager). The account's required courses are `training_assignments` records: `id`, `organization_id`, `user_id`, `course_id`, `assigned_at`, `due_at` and `required_pass_score` (a percentage). An assignment's status is worked out when it is read (`services/admin/src/services/training.js`, `trainingState`): **completed** once every lesson of the course is completed and every quiz in it has an attempt scoring at least `required_pass_score` (`completedAt` is when the last of those happened, `completedOnTime` compares it with `due_at`); otherwise **overdue** after `due_at`, **in_progress** when the employee has any lesson or quiz activity on the course, else **assigned**. Quiz attempts are the learner's `quiz_results` on the course's lessons; a learner may take a quiz again. Staff open an employee's required training from Admin → Learners → Training (`GET /api/admin/learners/{userId}/training`: the employee, their organization, team and manager, and per assignment the status, completion, lessons done, quiz attempts and how many were below the pass score). Reminders to employees use the ordinary staff message (`POST /api/admin/learners/{userId}/message`, event `staff_message_sent`).

**Notifications.** Each record in `notifications` has `id`, `user_id`, `type` (`welcome`, `payment_receipt`, `new_course_published`, `staff_message`, `support_reply`), `title`, `body`, `link` (the page it opens, or `null`), `created_at` and `read_at` (`null` until the learner opens it; `POST /api/me/notifications/{notificationId}/read` sets it once and logs `notification_opened`). A notification written by an automated job may also carry `applied_by_agent: true`; `npm run notifications:since` reports it.

**Help and support.** Learners ask the team a question from the Help page (topic: billing, certificate, account, course_content or other, plus their text) and read the replies there. Staff answer from Admin, under Support requests (open questions oldest first). A reply also creates an inbox notification.

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

Everything goes to `us-east-1`. The prod stack is `LearnLoopProd`; its resources are tagged `Application=learnloop` and `env=prod`. (Staging is a separate stack, see [Staging](#staging).)

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
   The output `DeployRoleArn` is the role GitHub Actions assumes. It trusts that repository's `main` branch and its `prod` and `preview` environments, and may deploy both `LearnLoopProd` and `LearnLoopStaging`.
3. **SES.** Before the first deploy, verify the sender address and your own recipient address in the SES console (the account stays in the SES sandbox). The stack does not create or verify SES identities. It only takes the sender as the `sesSender` parameter. The `@example.com` demo addresses cannot receive mail, so set `emailRecipientOverride` to your verified recipient to receive all demo email there. If SES rejects a message, the notification is still created and the API reports `"email": "failed"`.
4. **GitHub configuration** (repository environments `prod` and `preview`), repository variables only, no secrets: `AWS_DEPLOY_ROLE_ARN`, `SES_SENDER`, and optionally `EMAIL_RECIPIENT_OVERRIDE`.
5. **Push to `main`.** `.github/workflows/deploy.yml` runs the tests, builds `web`, runs `cdk deploy` with `APP_VERSION` set to the short commit SHA, syncs `web/dist` to the web bucket and invalidates CloudFront (the steps live in the reusable `_deploy.yml`; it can also be started by hand). `.github/workflows/ci.yml` runs `npm ci && npm test` on every push and pull request. No long-lived AWS keys are used anywhere.

CDK stack parameters: `sesSender` and `emailRecipientOverride` (optional).

**Secrets.** CDK creates two Secrets Manager secrets with generated values: `learnloop/prod/jwt-secret` (signs session tokens) and `learnloop/prod/log-pseudonym-salt`. The functions receive the secret names in `JWT_SECRET_PARAMETER` and `LOG_PSEUDONYM_SALT_PARAMETER`. To read the salt: `aws secretsmanager get-secret-value --secret-id learnloop/prod/log-pseudonym-salt --query SecretString --output text`.

**Access logs.** The access-logs bucket has ACLs enabled (`BucketOwnerPreferred`) and SSE-S3 encryption, which is what CloudFront standard logging requires. The distribution logs to that bucket under the prefix `cloudfront/`. The stack outputs `AccessLogsBucketName` and `CloudFrontLogPrefix` name the location.

**Previews of `ga/*` branches.** When a `ga/<id>` pull request gets the `ga-verified` label, `preview.yml` deploys the PR merged into the current `main` (`refs/pull/<number>/merge`, so an older branch never rolls back later changes to `main`; a PR that conflicts with `main` is not deployed and gets a comment saying so) to `LearnLoopProd`, switches the flag `ga-<id>` on, runs once every scheduled job the branch registers that `main` does not (found by invoking each function with `{"listJobs": true}`; `node tools/ops/src/list-jobs.js <checkout>` gives the same list from a checkout), and comments the result on the PR, including the names of the learners the jobs messaged (demo data; `npm run notifications:since -- <ISO time>` lists them with their emails, using local AWS credentials). Closing such a PR without merging runs `preview-reset.yml`: it redeploys `main`, switches the flag off and runs `npm run state:reset`. Both can be started by hand from the Actions tab. All workflows that deploy prod share the `deploy-prod` concurrency group.

**Offline tests.** `npm test` synthesizes the stacks with asset bundling disabled. It needs no AWS access, no Docker and no esbuild. Real deploys bundle each function locally with esbuild (an `infra` devDependency).

## Staging

`LearnLoopStaging` is a second, independent deployment of the same code: its own CloudFront distribution and URL, HTTP API, functions (`learnloop-staging-*`), buckets (`learnloop-staging-{web,state,access-logs,app-logs}-<account>`), secrets (`learnloop/staging/jwt-secret`, `learnloop/staging/log-pseudonym-salt`, generated by the stack like prod's), flag parameter (`/learnloop/staging/feature-flags`) and state. Its resources are tagged `Application=learnloop-staging` and `env=staging`; prod keeps `Application=learnloop` and `env=prod`. It has the same stack outputs as prod.

- **Deploying.** Push to the `staging` branch, or start **Deploy staging** (`.github/workflows/deploy-staging.yml`) by hand with any ref. It tests and deploys that commit to `LearnLoopStaging`, switches on every `ga-*` flag the deployed code reads (`node tools/ops/src/list-flags.js <checkout>` lists them), runs every scheduled job the staging functions register once (optional when started by hand) and writes the result to the run summary. It uses the `preview` environment and its own `deploy-staging` queue, so it never waits for a prod deploy.
- **URL.** The `DistributionDomainName` output of the stack (also in the run summary):
  ```bash
  aws cloudformation describe-stacks --stack-name LearnLoopStaging \
    --query "Stacks[0].Outputs[?OutputKey=='DistributionDomainName'].OutputValue" --output text
  ```
- **Operator tools.** Set `LEARNLOOP_STACK=LearnLoopStaging`; without it the tools act on `LearnLoopProd`:
  ```bash
  LEARNLOOP_STACK=LearnLoopStaging npm run flag -- list
  LEARNLOOP_STACK=LearnLoopStaging npm run state:reset
  LEARNLOOP_STACK=LearnLoopStaging npm run notifications:since -- 2026-11-17T00:00:00Z
  ```
- **By hand:** `cd infra && npx cdk deploy LearnLoopStaging --parameters sesSender=<verified sender>`, then sync `web/dist` to the `WebBucketName` output and invalidate the `DistributionId` output, as `_deploy.yml` does.

## Mock data

`data/seed/*.json` is the initial state: users, courses, lessons, enrolments, progress, subscriptions, notifications, quiz results, carts, support requests, organizations (enterprise accounts) and training assignments. Lambda bundles include these files. Each state domain is copied into the state bucket the first time it is read, and `npm run state:reset` restores them. The files are generated by a separate repository, `learnloop-demo-tools`, which also uploads historical logs to the app-logs bucket and to the access-logs bucket under `cloudfront/`.

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

Flags are a JSON map `{ "<flagKey>": { "enabled": true|false } }` in the SSM parameter `/learnloop/prod/feature-flags` (`/learnloop/staging/feature-flags` for staging). Code calls `isEnabled(flagKey, { userId })` from `packages/shared/src/flags.js`. Values are cached for 30 seconds. An unknown key returns `false`, and so does a read failure (which also logs a warning). It never throws. This is the standard way to ship a feature dark. The example in use is `new_catalog_filters`, which gates the category filter on `/courses`.

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
npx cdk destroy LearnLoopProd      # and LearnLoopStaging
npx cdk --app "npx tsx bin/github-oidc.ts" destroy -c githubRepo=<owner>/<repo>
```

The four S3 buckets are retained on purpose (logs and state). Empty and delete them when you no longer need them:

```bash
for b in web state access-logs app-logs; do
  aws s3 rb "s3://learnloop-prod-$b-<account>" --force   # learnloop-staging-$b-<account> for staging
done
```

The two secrets are deleted with the stack (Secrets Manager schedules deletion with a recovery window). Delete the SES identities you verified in the SES console when you are done.
