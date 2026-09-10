# CI/CD Pipeline — `unit-notifications`

The build → test → deploy pipeline for the **Notification** unit. Because the unit
is an **embedded consumer of the modular monolith** (`components`, `services`;
`logical-components` producer seam C1 and read seam C9 run in-process, the
delivery tier C3–C8 is additive infra), it does **not** get its own pipeline — its
code, tests, and infra join the monolith's single shared pipeline. This section
specifies how the notification unit's producer/worker code, its Vitest suites, and
its CDK contribution (SQS queue + DLQ, EventBridge rule, SQS→Lambda worker, the two
DynamoDB tables, SES binding) join that pipeline, honouring the team `## Deployment`
and `## Way of Working` rules (trunk-based, squash-merge, deploy-on-merge to
staging, manual-approval production gate) and the tooling locked in
`tech-stack-decisions` (`tsc`, ESLint, Vitest, CDK). It aligns stage-for-stage with
the completed `unit-request-workflow` pipeline so the monolith ships as one unit.

## Pipeline Stages

Realised on **AWS CodePipeline + CodeBuild**, following the standard flow from the
infrastructure-guide and matching the workflow unit's pipeline:

```
[Source] → [Lint] → [Build] → [Unit Test] → [SAST] → [Package] → [Infra synth] →
[Deploy Staging] → [Smoke/E2E] → [Approval Gate] → [Deploy Prod] → [Smoke] → [Monitor]
```

| Stage | Tool / action | Gate | Source design |
|-------|---------------|------|---------------|
| Source | Git trunk (`main`); squash-merged Bolt branches | — | team `## Way of Working` |
| Lint | `npm run lint` (ESLint + `@typescript-eslint`) | fail fast | `tech-stack-decisions` |
| Build | `npm run build` (`tsc`) + `npm run typecheck` | must compile clean | `tech-stack-decisions` |
| Unit Test | `npx vitest run --coverage` | ≥ existing line/branch thresholds | `tech-stack-decisions`; workflow-unit precedent |
| SAST | dependency + static scan (`npm audit` + CodeGuru/Semgrep) | block on high/critical | DevSecOps; infrastructure-guide |
| Package | build **arm64** container image (monolith) + Lambda worker bundle, tag with commit SHA; push to ECR | immutable tag | `deployment-architecture` compute model |
| Infra synth | `cdk synth` + **cfn-nag/checkov** on templates | block on high findings | CDK best-practices |
| Deploy Staging | `cdk deploy --context env=staging` (on merge) | automated | team `## Deployment` |
| Smoke / E2E | health check + notification E2E (workflow event → email recorded + in-app row) against staging SQS/DynamoDB/SES-sandbox | must pass | infrastructure-guide; `business-logic-model` pipeline |
| Approval Gate | **manual approval** (tech lead + product owner) | human sign-off | team `## Deployment` |
| Deploy Prod | `cdk deploy --context env=prod` | automated post-approval | team `## Deployment` |
| Smoke | post-deploy `/health` + one in-app read | must pass | infrastructure-guide |

The notification unit's tests (`src/**/*.test.ts` for the notification service,
worker, and adapters) are auto-globbed by the root `vitest.config.ts` — no new test
config, exactly as the workflow unit found. The unit's CDK contribution is
synthesised and scanned in the same **Infra synth** stage as the rest of the
monolith's stacks (`deployment-architecture` `NotificationStack` + the `DataStack`
table additions).

## Build Configuration

- **Monolith image**: the multi-stage arm64 Dockerfile the platform already ships
  (builder runs `npm ci` + `tsc`; runtime copies `dist/` + prod `node_modules`
  onto a minimal pinned arm64 base, non-root, `/health`). The producer seam (C1)
  and in-app read seam (C9) ride inside this image with no change to the build.
- **Lambda worker bundle**: the delivery worker (C3) is bundled for `arm64`
  (esbuild/CDK `NodejsFunction`), small deployment package to minimise cold starts
  (`performance-design` pooling note; cost-optimisation Lambda guidance).
- **CDK assertion tests** (CDK best-practices) run in Build/Infra synth: assert
  both DynamoDB tables have **encryption + PITR** enabled and **TTL** configured;
  assert the delivery table is **not writable by update/delete** (append-only,
  `security-design`); assert the SQS queue has a **redrive policy to the DLQ** with
  `maxReceiveCount = 3` (matches the `reliability-design` 3-attempt ceiling) and is
  **SSE-encrypted**; assert no security group allows `0.0.0.0/0` ingress.

## Test Automation Integration

Test scenarios trace directly to the unit's NFR designs, mirroring the
verification sections of each:

- **Idempotency test** (`reliability-design`, `business-logic-model` BR-NOTIF-9):
  deliver the same event twice; assert exactly one email + one in-app per recipient
  and a single completed delivery record (in-memory adapters, no AWS).
- **Channel-isolation / bulkhead test** (`reliability-design` BR-NOTIF-7): force the
  email adapter to fail; assert in-app still delivered and email dead-lettered after
  the configured attempts.
- **Circuit-breaker test** (`reliability-design`): drive 5 consecutive email
  failures; assert the breaker opens, sends fail fast, half-open probes close it.
- **Non-blocking test** (`business-logic-model`, `reliability-design` REL-NOTIF-2):
  assert a channel failure returns inside the batch result and never throws back to
  / blocks the workflow commit.
- **Enqueue-budget micro-benchmark** (`performance-design`): assert the producer
  `enqueue` stays well within 3ms and that no channel I/O is reachable synchronously
  (the in-memory email/in-app adapters assert they are never called during the
  workflow commit).
- **Cache-effectiveness test** (`performance-design`, `scalability-design`): assert
  the directory port is called once per unique recipient within a TTL window under a
  multi-event burst.
- **PII-in-logs assertion** (`security-design` BR-PII-2/4): assert no email/display
  name/body appears in any log or delivery record — only pseudonymous ids and codes.
- **Staging E2E**: exercises the **real** EventBridge-rule→SQS→Lambda worker path,
  the DynamoDB in-app + delivery tables (dedupe `GetItem`, append-only write), the
  DLQ redrive, and SES-sandbox send, so the at-least-once + idempotency + per-channel
  DLQ guarantees are verified against real infra before the production gate.
- **DLQ-replay test** (`reliability-design`): dead-letter an item, replay, assert
  idempotent completion of only the still-failed channel.

## Deployment Strategy

- **Rolling deployment** for the monolith on ECS Fargate (producer C1, read C9) —
  stateless tasks, no session affinity, backward-compatible additive changes
  (infrastructure-guide "rolling"; `deployment-architecture`).
- **Lambda worker** deploys via CDK with **versioned aliases**; the SQS event-source
  mapping points at the alias, so a new worker version rolls in and can be rolled
  back by re-pointing the alias — no in-flight loss because un-acked SQS messages
  remain on the queue and redeliver (at-least-once), made safe by idempotency
  (`reliability-design`).
- **Schema compatibility**: DynamoDB is schemaless per item; new attributes are
  additive and delivery records are append-only, so mixed-version workers stay
  compatible — a reason blue-green's double infra cost is unnecessary here.
- **Rollback**: redeploy the previous immutable image/worker tag; because delivery
  is idempotent and per-channel, a rollback cannot double-send or corrupt in-flight
  events. `DataStack` table changes use `removalPolicy: RETAIN` so a compute
  rollback never touches the in-app or delivery tables.
- **Feature flags**: channel-level enablement (e.g. rolling out a new event type's
  template, or gating the in-app channel independently of email) ships behind an
  SSM-parameter flag so it can be toggled without a redeploy — consistent with the
  workflow unit's SSM-flag pattern.

## Secrets Management in CI/CD

- **No secrets in the repo, image, worker bundle, or env-baked config**
  (`security-design` "no secrets in code" / PII rules; team `## Security`): the
  Lambda worker and Fargate task reach SQS, both DynamoDB tables, SES, and KMS via
  their **task/execution IAM roles** (least-privilege), never access keys.
- **Least-privilege IAM** (CDK best-practices; DevSecOps): the worker role grants
  `sqs:ReceiveMessage/DeleteMessage/GetQueueAttributes` on the queue,
  `dynamodb:GetItem/PutItem/Query` on the in-app table, `dynamodb:GetItem/PutItem`
  on the delivery table (**no** `UpdateItem`/`DeleteItem` — append-only), `ses:SendEmail`,
  and `kms:Encrypt/Decrypt` on the notification KMS key — **no wildcards**. The
  producer seam gets only `events:PutEvents`-equivalent enqueue rights via the
  EventBridge-rule→SQS wiring (it does not need direct queue send if the rule owns
  the target). CodeBuild/CodePipeline roles are scoped to ECR push and
  `cdk deploy` on the named stacks only.
- **Runtime configuration** (queue URL, table names, SES identity/config-set, KMS
  ARN, cache TTLs, retention windows, feature flags) comes from **SSM Parameter
  Store / Secrets Manager** under the `notifications/*` namespace, read at start
  (`infrastructure-services` service discovery); the app reads references, never
  literals.
- **cfn-nag/checkov** in Infra synth block a merge that would introduce an
  over-broad IAM policy, an unencrypted queue/table, a missing DLQ redrive, or a
  public ingress rule — the DevSecOps guardrails enforced in the pipeline rather
  than advisory.
