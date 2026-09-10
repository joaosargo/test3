# Infrastructure Services — `unit-sla-escalation`

The infrastructure-service selections for the **SLA Reminder and Escalation**
unit — the durable store, the scheduler, the consumed upstream seams, secrets and
configuration, and service discovery — with sizing, access patterns, and
integration boundaries. It realises the component inventory in `logical-components`
(C1–C9) against the load and durability envelope in `scalability-design`,
`performance-design`, and `reliability-design`, and the PII / least-privilege
posture in `security-design`. The single-key store shape and no-new-transport
stance trace to `business-logic-model` (Own durable state, reused send seam) and
the platform grouping in `components` and `services`.

The defining property (from `services`): this unit is on the **choreography /
side-effect** side. It **owns exactly one durable service — the reminder ledger —
and one control-plane service — the scheduler.** Everything else it needs
(pending requests, recipient directory, email/in-app transport) is a **consumed
seam** owned by an upstream unit and reused verbatim, so this unit provisions no
database replica, no queue, and no email binding of its own.

## Service Inventory — owned vs consumed

| Service | Role | Owner | AWS realisation |
|---------|------|-------|-----------------|
| **Reminder ledger (C6)** | Append-only at-most-once decision trail | **This unit** | Amazon DynamoDB `sla-reminder-ledger-<env>` |
| **Scheduler (C1)** | Fire `runScanTick` on cadence | **This unit** | Amazon EventBridge Scheduler schedule + least-privilege role |
| Workflow pending query (C5) | Read-only pending-request view | `unit-request-workflow` | In-process read against its `vacation-requests-<env>` scoped read |
| Recipient directory (C7) | Resolve owner / escalation target | `unit-notifications` | Reused `RecipientDirectoryPort` (its directory + cache) |
| Dispatch transport (C8) | Send email / in-app notice | `unit-notifications` | Reused `EmailSenderPort` / `InAppInboxPort` (its SES + in-app store) |
| Escalation policy config | Thresholds / tiers / business-hours flag | This unit (config) | SSM Parameter Store `sla-escalation/*` |
| Secrets | Any ledger/scheduler credentials | Platform secrets manager | SSM / Secrets Manager, injected |

## Database Design — the Reminder Ledger (Amazon DynamoDB)

DynamoDB is selected for the ledger because the access pattern is a **pure
single-key point read (`hasFired`) plus single-row append (`record`)** — the exact
key-value shape DynamoDB serves at single-digit-millisecond latency
(`performance-design` `hasFired` p95 ≤ 20 ms / p99 ≤ 50 ms), and because it matches
the platform's existing DynamoDB + KMS + PITR posture (`unit-request-workflow` /
`unit-notifications` infrastructure). A relational store would add join/schema
machinery the workload never uses; a broker/queue does not fit because there is no
event to consume (`business-logic-model` Inbound).

### Table `sla-reminder-ledger-<env>`

| Property | Value | Rationale / source |
|----------|-------|--------------------|
| Partition key | `PK = REQ#<requestId>` | Groups all ledger rows for one request; enables per-request read if needed |
| Sort key | `SK = STAGE#<stage>#TIER#<tier>` | Completes the `(requestId, stage, tier)` idempotency key (`business-logic-model` step 4; `reliability-design` REL-DES-4) |
| Item attributes | `requestId`, `stage`, `tier`, `outcomeCode`, `firedAtMs`, `expireAt` | **PII-free by construction** — no email/name/reason field exists (`security-design` SEC-DES-6) |
| `hasFired` read | `GetItem` on the composite key | Single-key point read within the p95 ≤ 20 ms budget (`performance-design`) |
| `record` write | `PutItem` (conditional `attribute_not_exists(PK)` optional) | Write-once append; the key guarantees at-most-once (`business-logic-model`; `reliability-design`) |
| Append-only | Only `GetItem`/`PutItem`/`Query` granted; `UpdateItem`/`DeleteItem` **denied** by IAM + CDK aspect | Structural append-only invariant (`security-design` SEC-DES-9) |
| Encryption at rest | SSE with KMS (AWS-managed minimum) | `security-design` SEC-DES-7 |
| Retention | **DynamoDB TTL** on `expireAt` — operational horizon (default 90 d after terminal, confirm with ops), **not** the 7-year audit window | `scalability-design` Data Growth; `reliability-design` REL-DES-12 |
| Durability | PITR enabled (prod) | Survives restart → at-most-once holds across recovery (`reliability-design` REL-DES-10) |
| Capacity mode | dev in-memory; staging on-demand; prod on-demand (or provisioned+autoscaling if write rate warrants) | Writes occur only on threshold crossings → low, bursty (`scalability-design`) |

- **Bounded, linear growth.** At most one row per fired `(requestId, stage, tier)`
  — ≤ 4 per request (2 stages × 2 tiers) — so `records ≈ requests × up-to-4`,
  linear in request count, never in time or scan frequency (`scalability-design`
  Capacity Planning). TTL prunes terminal requests, keeping the table bounded.
- **No secondary index required at MVP.** All reads are single-key `hasFired`
  lookups; a per-request `Query` on `PK` is available for the debug read without a
  GSI (`performance-design` — no N+1, single-key only).
- **The in-memory adapter stays the dev/test default** behind
  `ReminderLedgerRepository`; DynamoDB is wired only in deployed environments — the
  same swap the shipped units use.

## Scheduler Service (Amazon EventBridge Scheduler)

The `SchedulerPort` (C1) binds to **Amazon EventBridge Scheduler** in
staging/prod:

- **Schedule**: `rate(15 minutes)` baseline (placeholder from `performance-design`
  / `scalability-design`; the cadence-vs-threshold ratio keeps tick cost negligible
  while firing a 24h-class reminder within a small fraction of the threshold).
  Cadence is per-env CDK context, tunable **before** adding scan instances
  (`scalability-design` scaling triggers).
- **Target**: the monolith task's scan entry (MVP) or the scan Lambda (scaled
  path, `deployment-architecture`).
- **Least-privilege role**: the schedule's execution role may invoke only the scan
  target — nothing else (`security-design` SEC-DES-1).
- **Durability & observability over an in-process timer**: EventBridge Scheduler
  emits invocation metrics, so a **missed / failed schedule is externally visible**
  — the foundation for the missed-cadence alarm that is this unit's primary
  reliability signal (`reliability-design`; wired in `monitoring-design`).
- **Idempotent under replay**: a duplicate trigger is harmless — the ledger key
  dedupes and the unit mutates no business state (`reliability-design` REL-DES-4;
  `security-design` threat-model "replay / forged scheduler trigger").

## Caching Layer

Caching is deliberately minimal, per `performance-design` (the scan hot path is
zero-I/O and the tick is background):

| Candidate | Decision | Rationale |
|-----------|----------|-----------|
| `EscalationPolicy` | **In-process cache for the tick lifetime** (load once at start / on config change) | Read every request, immutable during a tick; fail-closed at load on misconfiguration (`security-design` SEC-DES-10; `performance-design` caching table) |
| Pending-request view | **No cache — one fresh batch read per tick** | Eligibility must be derived freshly each tick from live workflow state (`reliability-design` REL-DES-5 self-healing); a stale cache would fire against advanced/withdrawn requests |
| `hasFired` ledger lookups | **No application cache** | Single-key reads already within budget; a cache risks a stale "not fired" → duplicate nudge — correctness over speed (`performance-design`) |
| Recipient / contact PII | **Never cached in this unit** | Resolved late and transiently; any directory-side cache is owned by `unit-notifications`, not re-implemented here (`security-design` SEC-DES-7) |

No ElastiCache / managed cache is provisioned — the one deliberate cache is
in-process computed config.

## Messaging Infrastructure — none owned

This unit **owns no queue, topic, or bus**. It is *not* an EventBridge subscriber
(unlike `unit-notifications`) because it fires on the **absence** of a transition —
elapsed time — which no broker message can signal (`business-logic-model` Inbound;
`tech-stack-decisions` rejected a broker-driven design). Dispatch of the due notice
is handed to the **reused `unit-notifications` send seam** (C8), which owns its own
SQS queue, DLQ, retry, and circuit breaker (`BR-SLA-12`; `logical-components` C8) —
this unit neither defines nor duplicates that transport. The scheduler (above) is
the unit's only inbound trigger.

## External Service Integrations (consumed seams)

- **Workflow pending read (C5)** — read-only, **in-process** call returning the
  narrowed PII-free `PendingRequestView` (`requestId`, `ownerId`, `department`,
  `status`, transition timestamps); **never** the mutating `VacationRequest`
  aggregate (`business-logic-model` Pending-request read; `security-design`
  SEC-DES-2). Maps onto the workflow's `findByDepartmentAndStatus`; one batch read
  per cadence, offloadable to a read replica / status projection if isolation is
  ever needed (`scalability-design`).
- **Recipient directory (C7)** — reused `RecipientDirectoryPort` from
  `unit-notifications`; the SLA unit does not derive who may receive a notice
  (`security-design` SEC-DES-3). Escalation target is an injected
  `escalationContactResolver` so audience widening is a reviewed config change.
- **Dispatch transport (C8)** — reused `EmailSenderPort` / `InAppInboxPort`; the
  SLA unit builds SLA-flavoured messages from its own templates and hands them to
  the **same** transport, inheriting retry/DLQ/breaker (`BR-SLA-12`).
- **Contact PII** flowing through C7/C8 is resolved **late, transiently, and never
  persisted or logged** in this unit (`security-design` SEC-DES-7) — it never
  reaches the ledger, the scan core, or the logs.

## Secrets & Configuration Management

- **Escalation policy** (thresholds per stage/tier, business-hours flag) lives in
  **SSM Parameter Store** under `sla-escalation/*`, loaded once per tick and
  validated **fail-closed** — a non-monotonic / incomplete policy throws
  `MISCONFIGURED_POLICY` at load and no tick runs (`security-design` SEC-DES-10;
  `business-logic-model` `BR-SLA-4a`). Concrete thresholds are confirmed with
  product/HR (illustrative defaults: `TeamLead` 24h/48h, `HR` 48h/96h).
- **Secrets** (any ledger/scheduler/transport credentials) are injected from the
  environment or Secrets Manager, **never hard-coded** (`security-design`
  SEC-DES-8; `ADR-AUTH-04` precedent; Construction-phase Security guardrail).
- **Escalation-target policy** (`escalationContactResolver` configuration) is
  config, so widening the audience is a reviewed change, never a code branch
  (`security-design` SEC-DES-3).

## Service Discovery

No new service-discovery infrastructure. C5/C7/C8 are **in-process module calls**
against upstream units in the same monolith deployable (`components`
modular-monolith), so there is no DNS/mesh lookup. The scheduler (C1) references
its target by ARN in CDK. The ledger (C6) is referenced by table name resolved
from CDK context per environment. This matches the port/adapter wiring every
shipped unit uses — bindings are composed at the composition root, not discovered
at runtime.

## Cost Notes

- The **ledger** is the only per-unit line item with steady cost: on-demand
  DynamoDB with low, bursty writes (only threshold crossings) and single-key reads
  — a few cents/month at MVP scale; TTL deletes are free (no write cost).
- The **scheduler** is effectively free at a 15-minute cadence (~ 2,880
  invocations/month).
- The **scan compute** is in-process at MVP → no incremental compute cost; a scaled
  scan Lambda (`arm64`) would bill only per short invocation on the cadence.
- All owned resources carry the mandatory cost-allocation tags
  (`Service=sla-escalation`) — see `shared-infrastructure`.
