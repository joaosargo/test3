# CI/CD Pipeline — `unit-request-workflow`

The build → test → deploy pipeline for the **Vacation Request Workflow** unit.
Because the unit is an **embedded in-process module** of the modular monolith
([[logical-components]] ADR-WF-COMP-01; [[components]], [[services]]), it does
**not** get its own pipeline — it is built, tested, and shipped inside the
monolith's single pipeline. What this section specifies is how the workflow
unit's code, tests, and infra join that shared pipeline, honouring the team
`## Deployment` and `## Way of Working` rules (trunk-based, squash-merge,
deploy-on-merge to staging, manual-approval production gate) and the tooling
locked in `tech-stack-decisions` (`tsc`, ESLint, Vitest, CDK).

## Pipeline Stages

Realised on **AWS CodePipeline + CodeBuild** (aligns with the team rule's
CodePipeline reference), following the standard stage flow from the
infrastructure-guide:

```
[Source] → [Lint] → [Build] → [Unit Test] → [SAST] → [Package] →
[Deploy Staging] → [Smoke/E2E] → [Approval Gate] → [Deploy Prod] → [Smoke] → [Monitor]
```

| Stage | Tool / action | Gate | Source design |
|-------|---------------|------|---------------|
| Source | Git trunk (`main`); squash-merged Bolt branches | — | team `## Way of Working` |
| Lint | `npm run lint` (ESLint + `@typescript-eslint`) | fail fast | `tech-stack-decisions` |
| Build | `npm run build` (`tsc`) + `npm run typecheck` | must compile clean | `tech-stack-decisions` |
| Unit Test | `npx vitest run --coverage` | ≥ 80% line / 75% branch (existing thresholds) | `tech-stack-decisions`; authz precedent (60→ green suite) |
| SAST | dependency + static scan (e.g. `npm audit` + CodeGuru/Semgrep) | block on high/critical | DevSecOps; infrastructure-guide |
| Package | build **arm64** container image, tag with commit SHA; push to ECR | immutable tag | [[deployment-architecture]] compute model |
| Infra synth | `cdk synth` + **cfn-nag/checkov** on the templates | block on high findings | CDK best-practices (infra testing in CI) |
| Deploy Staging | `cdk deploy --context env=staging` (on merge) | automated | team `## Deployment` (deploy-on-merge) |
| Smoke / E2E | health check + critical-path E2E (submit→validate→approve) against staging DynamoDB | must pass | infrastructure-guide; [[business-logic-model]] Workflows A/B/C |
| Approval Gate | **manual approval** (tech lead + product owner) | human sign-off | team `## Deployment` (prod gate) |
| Deploy Prod | `cdk deploy --context env=prod` | automated post-approval | team `## Deployment` |
| Smoke | post-deploy `/health` + one read | must pass | infrastructure-guide |

The workflow unit's tests (`src/**/*.test.ts` for the workflow service and its
adapters) are auto-globbed by the root `vitest.config.ts` — no new test config,
exactly as the authz unit found (`tech-stack-decisions` tooling note). The
unit's CDK contribution (the DynamoDB request table, EventBridge rules, Streams
forwarder) is synthesised and scanned in the same **Infra synth** stage as the
rest of the monolith's stacks.

## Build Configuration

- **Multi-stage Dockerfile**: builder stage runs `npm ci` + `tsc`; runtime stage
  copies `dist/` + production `node_modules` onto a minimal, pinned arm64 base
  image, runs as a **non-root user**, exposes `/health` (container checklist from
  the infrastructure-guide). Image is small (server-side unit, no bundler —
  `tech-stack-decisions`).
- **CDK assertion tests** (CDK best-practices) run in the Build/Infra stage: assert
  the request table has **encryption + PITR enabled**, `TX#` items are not
  writable by an update/delete policy (append-only, [[security-design]]
  SEC-WF-10), and no security group allows `0.0.0.0/0` ingress
  ([[deployment-architecture]] networking).

## Test Automation Integration

- **Unit/component tests** (Vitest): each workflow component covers the happy
  path + ≥ 2 error/edge cases (team Testing Standards; authz precedent), driving
  the state-machine guards and `Result.err` paths from [[business-rules]]
  (`BR-WF-*`, `BR-VAL-*`, `BR-INV-*`).
- **Optimistic-concurrency smoke** ([[performance-design]] "Measurement"): a test
  drives N concurrent `leadDecision` calls at one request and asserts exactly one
  succeeds and the rest return `staleState` ([[business-rules]] `BR-INV-3`,
  [[reliability-design]] REL-WF-5) — validated in-memory in CI, no AWS needed.
- **Staging E2E**: exercises the real DynamoDB adapter (conditional-write
  concurrency, append-only history) and the Streams→EventBridge outbox
  ([[infrastructure-services]]) so the same-logical-commit guarantee
  ([[business-rules]] `BR-INV-5`) is verified against real infra before the
  production gate.

## Deployment Strategy

- **Rolling deployment** on ECS Fargate (infrastructure-guide "rolling: stateless
  services, backward-compatible changes"). The workflow service is stateless
  ([[scalability-design]]) and all state is in DynamoDB, so replacing tasks
  incrementally is safe; no session affinity to preserve
  ([[deployment-architecture]]).
- **Schema compatibility**: DynamoDB is schemaless per item; new attributes are
  additive and the append-only `TX#` model never rewrites history
  ([[business-rules]] `BR-INV-4`), so rolling mixed-version tasks stay compatible
  — a key reason blue-green's double infra cost is unnecessary here.
- **Rollback**: redeploy the previous image tag (immutable SHA tags make this
  deterministic); because state is append-only and transitions are
  version-guarded ([[reliability-design]] REL-WF-6 idempotent-safe retries), a
  rollback cannot corrupt in-flight requests. `DataStack` changes use
  `removalPolicy: RETAIN` so a compute rollback never touches the request table.
- **Feature flags**: the owner-withdraw path (`BR-WF-9`, an open question in the
  functional design) ships behind an SSM-parameter flag so it can be enabled
  independently of a redeploy.

## Secrets Management in CI/CD

- **No secrets in the repo, image, or env-baked config** ([[security-design]]
  SEC-WF-9, `req-nfr-security-pii`, team `## Security` rule): DynamoDB access is
  via the Fargate **task IAM role** (least-privilege — `GetItem`/`PutItem`/
  `Query` on the request table + `ConditionCheck`; **no** `dynamodb:*`, no
  `DeleteItem`/`UpdateItem` on `TX#` items), not access keys.
- The **CodeBuild role** and **CodePipeline role** are scoped to only the actions
  they need (ECR push, `cdk deploy` on the named stacks) — CDK best-practices
  least-privilege; wildcard policies are treated as defects.
- Runtime configuration (table name, bus name, KMS ARN, feature flags) comes from
  **SSM Parameter Store / Secrets Manager**, read at task start
  ([[infrastructure-services]] service discovery). Rotation of any store
  credential is Secrets-Manager-managed; the app reads the reference, never the
  literal.
- **cfn-nag/checkov** in the Infra synth stage block a merge that would introduce
  an over-broad IAM policy, an unencrypted table, or a public ingress rule —
  making the DevSecOps guardrails enforceable in the pipeline rather than advisory.
