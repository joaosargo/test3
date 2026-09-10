# CI/CD Pipeline — `unit-sla-escalation`

The build, test, and deployment pipeline for the **SLA Reminder and Escalation**
unit. Because this unit is an **embedded module of the modular monolith**
(`components`, `services`), it **shares the single platform pipeline** that the
`unit-request-workflow` and `unit-notifications` `cicd-pipeline` documents
established — it does not stand up a parallel pipeline. This document records what
the shared pipeline must additionally build, test, and provision for this unit:
the **EventBridge Scheduler binding** and the **DynamoDB reminder ledger**
(`deployment-architecture`, `infrastructure-services`), plus the unit-specific test
gates that protect its correctness invariants (`reliability-design`,
`security-design`).

The stage cadence follows the team `## Deployment` rule — **deploy on merge to
staging; production behind a manual approval gate** — and the standard pipeline
shape in the Infrastructure Guide.

## Pipeline Stages

```
[Source] → [Lint] → [Build/Typecheck] → [Unit Test] → [SAST] →
[CDK Synth + Assert] → [Package] → [Deploy Staging] → [Smoke/Tick Test] →
[Approval Gate] → [Deploy Production] → [Post-Deploy Verify]
```

| Stage | This unit's contribution | Gate |
|-------|--------------------------|------|
| **Source** | Trunk-based; short-lived branch → squash-merge to `main` (org `## Way of Working`) | — |
| **Lint** | ESLint + `@typescript-eslint` over `src/sla-escalation/**` (`tech-stack-decisions` Tooling) | Fail-fast < 30 s |
| **Build / Typecheck** | `tsc --noEmit` (strict) — the `SlaTier` classification and `Result<T, SlaError>` errors are compile-checked (`tech-stack-decisions`) | Any error blocks |
| **Unit Test** | Vitest suite (below) — correctness invariants | Any failure blocks; coverage ≥ 80 % line / 75 % branch (`tech-stack-decisions`) |
| **SAST** | Static security scan; secret-scan asserts no hard-coded credentials (`security-design` SEC-DES-8) | Block on high/critical |
| **CDK Synth + Assert** | Synthesize the `SlaEscalationStack` + `DataStack` ledger addition; run CDK assertion tests (below) | Block on assertion failure |
| **Package** | Part of the monolith artifact (in-process scan) + CDK template; tag with commit SHA | — |
| **Deploy Staging** | Automated on merge; `--context env=staging` | Auto |
| **Smoke / Tick Test** | Post-deploy: assert the EventBridge Scheduler schedule is enabled and one `runScanTick` runs green against the staging ledger (below) | Block promotion |
| **Approval Gate** | **Manual** approval (tech lead + product owner) per team `## Deployment` | Human |
| **Deploy Production** | `--context env=prod` after approval | Gated |
| **Post-Deploy Verify** | Confirm scheduler enabled, ledger table present with PITR/TTL/encryption, first prod tick emits `TicksExecuted` | Alarm-backed |

## Build Configuration

- **`tsc`** (no bundler — a server-side background module), reusing the root
  `tsconfig.json`; the scan module lives under `src/sla-escalation/**` and folds
  into the monolith build (`tech-stack-decisions` Build).
- **CDK v2 (TypeScript)** synth for the `SlaEscalationStack` (scheduler + role, and
  the scan Lambda on the scale path) and the `DataStack` ledger table addition
  (`deployment-architecture` IaC approach). Infra and app share one build/review
  flow.
- Cache dependencies aggressively; the unit adds **no new runtime dependency**
  (adopts the shipped stack — `tech-stack-decisions`), so build time is unchanged.

## Test Automation Integration

The Vitest suite encodes the correctness invariants from `reliability-design`,
`security-design`, `performance-design`, and `scalability-design`. These are the
gates that matter for a unit whose failures are otherwise invisible:

- **At-most-once / idempotency** — two ticks over the same due state → exactly one
  dispatch and one `ReminderRecord` per `(requestId, stage, tier)`
  (`reliability-design` REL-DES-4; `security-design` SEC-DES-9 anti-spam).
- **Catch-up ordering** — simulate a missed reminder cadence so a request is past
  escalation → the recovery tick fires reminder *then* escalation, each once, in
  order (`reliability-design` REL-DES-8; `business-logic-model` `BR-SLA-6a`).
- **Self-healing** — advance/withdraw a request between ticks → it drops from
  `listPending()`, no notice/cancellation fires (`reliability-design` REL-DES-5).
- **Non-blocking** — force `WORKFLOW_READ_ERROR` / channel failure → the tick
  returns `ok`/records the value and never throws back to a workflow transition
  (`reliability-design` REL-DES-3/7; `business-logic-model` `BR-SLA-8`).
- **Ledger-loss fail-safe** — make the ledger unavailable → the tick dispatches
  nothing and retries next cadence rather than sending un-guarded
  (`reliability-design` REL-DES-11).
- **Pure `evaluate` exhaustiveness** — deterministic injected clock across
  `OnTrack | ReminderDue | EscalationDue` boundaries (`performance-design` p99 ≤ 1
  ms pure core).
- **PII-free ledger** — append across all outcome codes → every persisted record
  holds only ids/stage/tier/outcome/timestamp (`security-design` SEC-DES-6).
- **Fail-closed policy** — load a non-monotonic policy → `MISCONFIGURED_POLICY`
  throws at load, no tick runs (`security-design` SEC-DES-10).
- **Tick-budget smoke at scale** — one `runScanTick` over a synthetic pending set of
  `N` (top of the projected range) completes within ≤ 30 s (`performance-design`,
  `scalability-design`).
- **Fan-out safety** (scale path) — two scanners over overlapping department slices
  against a shared ledger → each `(requestId, stage, tier)` fires exactly once
  (`scalability-design`, no distributed lock).

The in-memory scheduler and in-memory ledger adapters keep the whole suite
AWS-free and deterministic (`tech-stack-decisions`), so tests run in the standard
CI stage with no cloud credentials.

### CDK Assertion Tests

Fine-grained CDK assertions (CDK best-practice "test security properties, critical
config") guard the infra the pipeline provisions:

- Ledger table has **SSE (KMS) encryption** and **PITR** enabled
  (`security-design` SEC-DES-7; `reliability-design` REL-DES-10).
- Ledger IAM grants **only** `GetItem`/`PutItem`/`Query`; `UpdateItem`/`DeleteItem`
  are **absent** (append-only, `security-design` SEC-DES-9).
- Ledger has a **TTL attribute** configured (`expireAt`) — operational retention,
  not the 7-year window (`reliability-design` REL-DES-12).
- EventBridge Scheduler role is **least-privilege** — invoke only the scan target
  (`security-design` SEC-DES-1).
- No security group allows `0.0.0.0/0` ingress; required cost-allocation tags
  (`Service=sla-escalation`) present (compliance aspect,
  `deployment-architecture`).

## Deployment Strategy

- **Rolling** for the in-process scan (it deploys with the monolith task — the
  scan is a stateless module, backward-compatible, no version-mixing hazard because
  the ledger key makes overlapping old/new ticks idempotent —
  `reliability-design` REL-DES-4). This matches the monolith's deployment strategy;
  the SLA module rides the same task rollout.
- **Ledger schema is additive-only** — a new attribute never breaks an existing
  key; the append-only contract means no destructive migration
  (`security-design` SEC-DES-9). `removalPolicy: RETAIN` in prod protects the table
  across stack updates (`deployment-architecture`).
- **Scheduler cadence changes** are config (CDK context), applied via the normal
  deploy — no code change (`infrastructure-services`).
- **Scale-path activation** (splitting the scan into a scheduled Lambda) is a
  stack change behind the `SchedulerPort`, deployable without touching scan logic
  (`scalability-design`).

## Rollback Procedures

- **App/scan rollback**: redeploy the previous monolith task image (rolling). Safe
  at any point — the ledger dedupe key guarantees a rolled-back scanner re-running a
  tick fires nothing already fired (`reliability-design` REL-DES-4); catch-up covers
  any tick missed during the rollout (`reliability-design` REL-DES-8). **No data
  migration to reverse** — the ledger is append-only and forward-compatible.
- **Ledger rollback**: none required — the table is retained and append-only; there
  is no destructive change to undo. Point-in-time recovery (PITR) is available for
  disaster recovery, not routine rollback (`deployment-architecture`).
- **Scheduler rollback**: disable or revert the schedule (config); the next enabled
  tick self-heals via catch-up — no nudge is lost, none duplicated.
- **Failure containment**: a bad deploy degrades *nudge timeliness only* and cannot
  corrupt request/audit state (`logical-components` blast-radius), so rollback is
  low-risk and reversible — matching the reversibility posture in
  `tech-stack-decisions`.

## Feature Flags

- The whole unit is a **could-have** (`story-sla-escalation`); it can be gated
  behind a **scheduler-enabled flag** (the EventBridge Scheduler schedule's
  enabled/disabled state) so the scan can be dark-launched or paused with zero code
  change and no impact on the workflow (non-blocking, `business-logic-model`
  `BR-SLA-8`). Disabling the schedule is the cleanest kill-switch; catch-up recovers
  any due tiers once re-enabled.

## Secrets Management in CI/CD

- **No secrets in the pipeline or artifact** — the SAST/secret-scan gate blocks any
  hard-coded credential (`security-design` SEC-DES-8; Construction-phase Security
  guardrail).
- Runtime configuration (escalation policy, cadence) is read from **SSM Parameter
  Store** at deploy/runtime, not baked into the image (`infrastructure-services`
  Secrets & Configuration).
- The pipeline's deploy role and the scheduler/scan runtime roles are distinct
  least-privilege IAM roles; the scan role's only data grant is the ledger's
  read/append (`security-design` SEC-DES-1) — enforced by the CDK assertion tests
  above.
