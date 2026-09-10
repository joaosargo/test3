---
consumes: [performance-design, security-design, scalability-design, reliability-design, logical-components, components, services, business-logic-model]
unit: unit-audit-trail
stage: infrastructure-design
---

# CI/CD Pipeline — `unit-audit-trail`

The build → test → deploy pipeline for the **Immutable Audit Trail** unit.
Because the unit is an **embedded in-process module** of the modular monolith
(`logical-components` embedded-module boundary; `components`, `services` — audit
is a choreography side-effect consumer, not a separate deployable), it does
**not** get its own pipeline. It is built, tested, and shipped inside the
monolith's single pipeline. This section specifies how the audit unit's code,
tests, and infra join that shared pipeline, honouring the team `## Deployment`
and `## Way of Working` rules (trunk-based, squash-merge, deploy-on-merge to
staging, manual-approval production gate) and the tooling locked in
`tech-stack-decisions` (`tsc`, ESLint, Vitest, CDK). It preserves the
non-functional guarantees the NFR designs demand — completeness
(`reliability-design` RD-AUD-1), immutability (`security-design` SD-AUD-5/9), and
bounded ingest/read cost (`performance-design`) — as pipeline gates, not
afterthoughts.

## Pipeline Stages

Realised on **AWS CodePipeline + CodeBuild**, following the standard stage flow
from the infrastructure-guide:

```
[Source] → [Lint] → [Build] → [Unit Test] → [SAST] → [Package] → [Infra synth] →
[Deploy Staging] → [Smoke/E2E] → [Approval Gate] → [Deploy Prod] → [Smoke] → [Monitor]
```

| Stage | Tool / action | Gate | Source design |
|-------|---------------|------|---------------|
| Source | Git trunk (`main`); squash-merged Bolt branches | — | team `## Way of Working` |
| Lint | `npm run lint` (ESLint + `@typescript-eslint`) | fail fast; **guards id-only logging** (`security-design` SD-AUD-12) | `tech-stack-decisions` |
| Build | `npm run build` (`tsc`) + `npm run typecheck` | must compile clean; **enforces the no-mutation `AuditStore` port** (`security-design` SD-AUD-5 — mutation cannot compile) | `tech-stack-decisions` |
| Unit Test | `npx vitest run --coverage` | ≥ 80% line / 75% branch; **must include the idempotent-duplicate and integrity-violation paths** | `tech-stack-decisions`; `performance-design` PD-AUD-4 smoke note |
| SAST | dependency + static scan (`npm audit` + CodeGuru/Semgrep) | block on high/critical | DevSecOps; infrastructure-guide |
| Package | build **arm64** container image, tag with commit SHA; push to ECR | immutable tag | `deployment-architecture` compute model |
| Infra synth | `cdk synth` + **cfn-nag/checkov** on the templates | block on high findings; **assert audit table SSE-KMS + PITR, S3 Object Lock, no `TX#` mutate grant** | CDK best-practices; `security-design` SD-AUD-9 |
| Deploy Staging | `cdk deploy --context env=staging` (on merge) | automated | team `## Deployment` (deploy-on-merge) |
| Smoke / E2E | health check + audit critical path: **publish a workflow event → assert exactly one recorded record → `verifyChain` intact** against staging DynamoDB/SQS | must pass | `business-logic-model` `recordEvent`/`verifyChain`; `reliability-design` RD-AUD-4 |
| Approval Gate | **manual approval** (tech lead + product/compliance owner) | human sign-off | team `## Deployment` (prod gate) |
| Deploy Prod | `cdk deploy --context env=prod` | automated post-approval | team `## Deployment` |
| Smoke | post-deploy `/health` + one guarded read | must pass | infrastructure-guide |

The audit unit's tests (`src/**/*.test.ts` for the audit domain/adapters) are
auto-globbed by the root `vitest.config.ts` — no new test config, consistent with
the shipped units and the workflow unit's pipeline.

## Deployment Strategy

- **Rolling deployment** of the shared Fargate service (ECS rolling update with
  `minimumHealthyPercent`/`maximumPercent` so at least the min task count stays
  in service). The audit unit is **stateless** code
  (`scalability-design` SC-AUD-1), so mixed-version tasks during a rollout are
  safe: the `AuditRecord` shape and canonical serializer are **version-tagged**
  (`security-design` SD-AUD-7), so a new task version verifies old chains against
  the serializer version that produced them — no chain migration on deploy.
- **Backward-compatible data changes only** on the audit store: because the store
  is **append-only** (`security-design` SD-AUD-5), a deploy never rewrites
  existing records; new fields are additive and the canonical-serializer version
  tag isolates hash reproducibility. This is why blue-green is unnecessary here —
  there is no schema cutover to atomically switch.
- **Stateful resources deploy rarely and separately** (`deployment-architecture`
  stack split): the `DataStack` (audit table, GSI, S3 Object Lock bucket) carries
  `removalPolicy: RETAIN` in prod and changes far less often than the stateless
  `ComputeStack`, so most deploys never touch the evidence store.

## Rollback Procedures

- **Compute rollback**: redeploy the previous ECS task-definition revision
  (immutable ECR tag) — instant and safe because tasks are stateless.
- **Data has no rollback, by design**: the audit store is append-only and WORM
  (`security-design` SD-AUD-9), so there is **nothing to roll back** — a bad
  deploy cannot have mutated or deleted evidence. If a deploy wrote *malformed*
  records, they remain (append-only) and are flagged by the integrity sweep;
  remediation is a forward-only corrective record plus an incident write-up,
  never a delete.
- **Infra rollback**: CDK/CloudFormation stack rollback for the `ComputeStack`
  and `EventingStack`; the `DataStack`'s `RETAIN` policy guarantees the table and
  WORM bucket survive any stack rollback (no accidental evidence loss).

## Secrets Management in CI/CD

- **No secrets in the pipeline or image** (`security-design` SD-AUD-14): the
  durable-store credentials, KMS key ARNs, and any future signing-key references
  are resolved at task start from **SSM Parameter Store / Secrets Manager**, not
  baked into the container or CodeBuild env.
- CodeBuild assumes a **least-privilege deploy role** (scoped to the audit unit's
  stacks); the deploy role can create the WORM bucket but the **application task
  role cannot delete `TX#` items or shorten Object Lock retention** — the
  least-privilege split that makes append-only structural (`security-design`
  SD-AUD-5/9; enforced by the CDK aspect in `deployment-architecture`).
- Cost-allocation tags (`Service=audit-trail`, `Project`, `Environment`, `Team`,
  `CostCenter`) are applied by the CDK tagging aspect and verified at the Infra
  synth stage, so the audit store/queue/job cost is attributable within the
  shared monolith bill (`logical-components` cost-allocation note).

## Feature Flags & Progressive Enablement

- The **KMS-backed signing seam** (`security-design` SD-AUD-10) is behind a
  config flag on the same `AuditStore` seam, so non-repudiation signing can be
  enabled progressively (staging → prod) without a code branch or chain
  migration — the reversible-enhancement posture the design reserves.
- The **ingest consumer form** (in-task poller vs dedicated Lambda,
  `deployment-architecture` compute model) is a composition-root wiring choice
  behind the port, flag-selectable per environment without touching domain code.
