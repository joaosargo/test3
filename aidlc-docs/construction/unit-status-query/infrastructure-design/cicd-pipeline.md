# CI/CD Pipeline — `unit-status-query`

The build → test → deploy pipeline for the **Status Tracking & Query** unit.
Because the unit is an **embedded in-process module** of the modular monolith
(`logical-components` embedded-module boundary; `components`, `services`), it does
**not** get its own pipeline — it is built, tested, and shipped inside the
monolith's single pipeline. This section specifies how the read unit's code, tests,
and its one infrastructure change (the read-only IAM grant + conditional GSI) join
that shared pipeline, honouring the team `## Deployment` / `## Way of Working` rules
(trunk-based, squash-merge, deploy-on-merge to staging, manual-approval production
gate) and the tooling locked in `tech-stack-decisions` (`tsc`, ESLint, Vitest, CDK).
The pipeline realises the read-path budgets in `performance-design`, the fail-closed
posture in `reliability-design`, the PII/least-privilege rules in `security-design`,
and the stateless scale model in `scalability-design`.

## Pipeline Stages

Realised on **AWS CodePipeline + CodeBuild**, following the standard stage flow from
the infrastructure-guide (identical to the `unit-request-workflow` pipeline — the
same single monolith pipeline):

```
[Source] → [Lint] → [Build] → [Unit Test] → [SAST] → [Package] → [Infra synth] →
[Deploy Staging] → [Smoke/E2E] → [Approval Gate] → [Deploy Prod] → [Smoke] → [Monitor]
```

| Stage | Tool / action | Gate | Source design |
|-------|---------------|------|---------------|
| Source | Git trunk (`main`); squash-merged Bolt branches | — | team `## Way of Working` |
| Lint | `npm run lint` (ESLint + `@typescript-eslint`) | fail fast | `tech-stack-decisions` |
| Build | `npm run build` (`tsc`) + `npm run typecheck` | must compile clean | `tech-stack-decisions` |
| Unit Test | `npx vitest run --coverage` | ≥ 80% line / 75% branch | `tech-stack-decisions`; monolith precedent |
| SAST | dependency + static scan (`npm audit` + CodeGuru/Semgrep) | block on high/critical | DevSecOps; infrastructure-guide |
| Package | build **arm64** container image, tag with commit SHA; push to ECR | immutable tag | `deployment-architecture` compute model |
| Infra synth | `cdk synth` + **cfn-nag/checkov** on the templates | block on high findings | CDK best-practices (infra testing in CI) |
| Deploy Staging | `cdk deploy --context env=staging` (on merge) | automated | team `## Deployment` |
| Smoke / E2E | health check + read-path E2E against staging DynamoDB | must pass | infrastructure-guide; `business-logic-model` Query Flows |
| Approval Gate | **manual approval** (tech lead + product owner) | human sign-off | team `## Deployment` |
| Deploy Prod | `cdk deploy --context env=prod` | automated post-approval | team `## Deployment` |
| Smoke | post-deploy `/health` + one read | must pass | infrastructure-guide |

The status-query unit's tests (`src/**/*.test.ts` for the read service, projections,
router, and adapter) are auto-globbed by the root `vitest.config.ts` — **no new test
config** (`tech-stack-decisions` tooling note; monolith precedent). The unit's CDK
contribution (the read-only IAM statement and, if built, the `(department, status)`
GSI definition on the workflow table) is synthesised and scanned in the same
**Infra synth** stage as the rest of the monolith's stacks — it stands up no new
stack (`deployment-architecture` IaC approach).

## Build Configuration

- **No separate Dockerfile.** The read unit ships inside the monolith's existing
  multi-stage arm64 image (builder runs `npm ci` + `tsc`; runtime copies `dist/` +
  production `node_modules`, runs as **non-root**, exposes `/health`) — this unit
  adds source files, not a build target (`deployment-architecture` compute model).
- **CDK assertion tests** (CDK best-practices) in the Build/Infra stage assert the
  read boundary is intact: the status-query task-role statement grants **only**
  `dynamodb:GetItem`/`Query` on the request table + GSI and contains **no**
  `PutItem`/`UpdateItem`/`DeleteItem`/`dynamodb:*` (`security-design` SEC-D-5;
  `logical-components` LC-11). This is the executable form of the single-writer
  invariant across the read/command split. Inherited encryption/PITR/no-public-ingress
  assertions continue to run tree-wide.

## Test Automation Integration

- **Unit/component tests** (Vitest): each read query covers the happy path + ≥ 2
  error/edge cases — deny (`forbidden`), out-of-scope **omission** (not per-row
  deny), unknown/non-leaking id (`notFound`), and invalid input
  (`invalidInput, <field>`) — driving the guarded-read guards and `Result.err` paths
  from `business-logic-model` and `security-design` (SEC-D-6/7/8/9). Because reads
  are pure with no state setup/teardown (`performance-design` PERF-D-15), these are
  fast and deterministic in-memory.
- **Non-leaking-semantics test** (`security-design` SEC-D-6): an unauthorized caller
  requesting a real id gets the same `notFound`/`forbidden` shape as for a
  non-existent id — asserted so existence is never confirmed across scope.
- **PII-redaction assertion** (`security-design` SEC-D-15): a test asserts no
  principal id, department code, or free-text `reason` reaches a log sink in the
  clear — the CI guard for the log-boundary rule.
- **Read smoke as the load gate** (`performance-design` PERF-D-15): a smoke issues N
  concurrent `listScopedRequests` against one department and asserts stable scoping
  and in-budget latency; the **staging E2E** exercises the real DynamoDB read adapter
  (and the `(department, status)` GSI `Query` when present) before the production
  gate. Because reads take no lock (`performance-design` PERF-D-10;
  `reliability-design`), the smoke needs no concurrency-conflict setup.

## Deployment Strategy

- **Rolling deployment** on ECS Fargate (infrastructure-guide "rolling: stateless
  services, backward-compatible changes"). The read service is stateless
  (`scalability-design` SCALE-D-1; `performance-design` PERF-D-11) with no session
  affinity, so replacing tasks incrementally is safe — the same strategy the whole
  monolith uses (`deployment-architecture`).
- **Backward-compatible by construction.** The read unit adds new route prefixes and
  a read-only grant; it changes no schema and writes nothing
  (`security-design` SEC-D-5), so mixed-version tasks during a rollout are trivially
  compatible — a read route either exists on a task or 404s until the roll completes,
  with no data-consistency risk (reads derive from committed truth,
  `reliability-design` REL-D-11).
- **GSI change is decoupled from compute deploy.** If the `(department, status)` GSI
  is built, its creation is a `DataStack` change on the workflow-owned table
  (`removalPolicy: RETAIN`), applied and back-filled **before** the read code that
  queries it is enabled — an additive, ordered change, never coupled to a compute
  rollback. A rollback of the read compute never touches the table or the index.
- **Rollback**: redeploy the previous immutable image tag. Because this unit
  persists nothing and holds no state (`reliability-design` REL-D-18), a rollback of
  the read routes cannot corrupt anything — the worst case is the read routes
  reverting to the prior version.
- **Feature-flag the queue read on the GSI**: gating `listScopedRequests`'s use of
  the GSI behind an SSM-parameter flag lets the index be built and validated
  independently of enabling the query path — matching the monolith's SSM feature-flag
  precedent (`unit-request-workflow` `cicd-pipeline`).

## Secrets Management in CI/CD

- **No secrets owned, none baked** (`security-design` SEC-D-10;
  `tech-stack-decisions` Secrets; team `## Security` rule): this unit holds **no**
  store credential — DynamoDB read access is via the Fargate **task IAM role**
  (least-privilege `GetItem`/`Query` on the request table + GSI, **never** write, no
  `dynamodb:*`), not access keys. There is no per-unit secret to rotate.
- The **CodeBuild** and **CodePipeline** roles remain the monolith's, scoped to only
  the actions they need (ECR push, `cdk deploy` on the named stacks) — CDK
  best-practices least-privilege; wildcard policies are treated as defects.
- Runtime configuration (the shared request-table/GSI name, the queue-read feature
  flag) comes from **SSM Parameter Store**, read at task start
  (`infrastructure-services` service discovery) — nothing hardcoded.
- **cfn-nag/checkov** in the Infra synth stage block a merge that would widen this
  unit's grant to a write action, introduce an unencrypted resource, or add a public
  ingress rule — making the DevSecOps read-only guardrail enforceable in the pipeline
  rather than advisory.
