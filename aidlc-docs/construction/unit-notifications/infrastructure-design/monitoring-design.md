# Monitoring & Observability Design — `unit-notifications`

Metrics, logs, traces, alerts, and dashboards for the **Notification** unit on
AWS. The observability plane is inherited from the modular monolith (`components`,
`services`) — this unit adds notification-specific SLIs and alarms. It
operationalises the **99.5% Important-tier delivery SLO** in `reliability-design`
(REL-NOTIF-1/2), the two-path latency budgets in `performance-design` (≤3ms
producer enqueue, ≤ a few seconds async delivery), the queue-depth/age scale
triggers in `scalability-design`, the per-channel breaker/DLQ posture in
`reliability-design`, and the **PII-free structured logging** hard constraint in
`security-design` (BR-PII-1..4). Alert routing follows the failure-domain and
blast-radius boundaries the unit's `logical-components` inventory defines
(FD-Producer, FD-Queue, FD-Worker, FD-Email, FD-InApp, FD-Records, FD-Read), so a
signal pages the owning seam and never the workflow command path. The metric set
is exactly what `tech-stack-decisions` `ADR-NOTIF-06` (observability) requires.

## Metrics & KPIs

Emitted as **CloudWatch custom metrics** (Embedded Metric Format from the Node
worker / producer), tagged by `channel` and `outcome`, plus native SQS/Lambda/
DynamoDB/SES service metrics. This is the metric set the NFR budgets in
`performance-design`, `reliability-design`, and `scalability-design` are verified
against (`ADR-NOTIF-06`):

| Metric | Dimensions | Source design |
|--------|-----------|---------------|
| `EnqueueLatency` p95 (producer hot path) | — | `performance-design` ≤3ms p95 enqueue budget |
| `DeliveryOutcomeCount` (Rate) | `channel` = email/in-app, `outcome` = delivered/skipped/transient/dead-lettered | `reliability-design` REL-NOTIF-1 SLI |
| `EndToEndDeliveryLatency` p95/p99 | `channel` | `performance-design` async budget (concrete SLO TBD) |
| `DispatchLatency` p95 | `channel` (email = SES, in-app = DynamoDB put) | `performance-design`; per-channel bulkhead |
| `CircuitBreakerState` (gauge 0/1) | `channel` | `reliability-design` per-channel breaker |
| `RecipientCacheHitRatio` | — | `performance-design`/`scalability-design` directory load-shedding |
| `RecipientUnresolvedCount` | — | `reliability-design` non-fatal skip (BR-NOTIF-4/8) |
| `DedupeSkipCount` | — | `reliability-design` idempotency (BR-NOTIF-9) — redelivery working correctly |
| `QueueDepth` / `ApproximateAgeOfOldestMessage` | queue C2 | `scalability-design` backpressure + scale signal (native SQS metric) |
| `DlqDepth` | DLQ C8 | `reliability-design` dead-letter; provider-problem signal |

**SLI/SLO tracking** (`reliability-design` REL-NOTIF-1): the delivery SLI is
`(delivered + intentionally_skipped) / total_attempts` **per channel** — an
intentional `skipped(NO_EMAIL_CONTACT)`/`skipped(RECIPIENT_UNRESOLVED)` counts as
a correct outcome; a dead-letter counts **against** the SLO. Target **99.5%**
Important-tier over a rolling window (concrete numeric thresholds/alerting TBD
with ops — `memory.md`). A CloudWatch composite tracks per-channel SLO so an
email-provider outage does not mask healthy in-app delivery (the bulkhead
property).

**Infrastructure USE metrics** (native): SQS depth/age/receives, Lambda
invocations/errors/throttles/duration/concurrency, DynamoDB consumed capacity +
throttles for both tables, SES send/bounce/complaint/reject rates.

## Log Strategy

- **CloudWatch Logs**, structured **JSON** to stdout from the worker/producer
  (timestamp, level, service, traceId, `requestId`, `dedupeKey`, `channel`,
  `outcome`, message) — never file-based (container checklist).
- **PII redaction is mandatory at every serialization boundary** (`security-design`
  BR-PII-2/4): `redactForLog` ensures logs, error `cause`, metrics, and DLQ
  correlation carry **only pseudonymous ids and PII-free machine codes**
  (`RECIPIENT_UNRESOLVED`, `NO_EMAIL_CONTACT`, `CHANNEL_TRANSIENT`,
  `CHANNEL_DEAD_LETTERED`) — never email, display name, or notification body. A
  log-scrubbing filter plus a `vitest` assertion (mirroring the platform "no PII in
  messages" test) guards this in CI. The **bus and DLQ carry no PII by
  construction** (`security-design` BR-PII-1), so broker-side logging/replay is
  PII-free too.
- **Retention**: 30 days hot, export to S3 (→ Infrequent Access → Glacier) for
  cost — **operational** logs only. Distinct from the in-app/delivery-record
  retention (bounded via DynamoDB TTL, `infrastructure-services`) and from the
  7-year immutable **audit-trail** owned by `unit-audit-trail`, which these
  operational logs are **not** (`security-design` audit-vs-operational-trail
  distinction).

## Distributed Tracing

- **AWS X-Ray** (OpenTelemetry-compatible). **Trace context propagates from the
  originating workflow command onto the EventBridge event** (per
  `unit-request-workflow` monitoring-design), so the async delivery span is
  correlated to the command that triggered it — cross-unit trace continuity
  without coupling.
- The worker trace spans the async pipeline: `receive (SQS)` → `dedupe (GetItem)`
  → `resolve recipients (cached / directory)` → `render` → `dispatch email (SES)`
  + `dispatch in-app (DynamoDB put)` → `record delivery`. This attributes the
  end-to-end async budget (`performance-design`) across its stages and shows which
  channel dominates `max(email, in-app)` wall-clock.

## Alert Definitions

Alert on **symptoms, not causes** (infrastructure-guide), each with a runbook
link (Well-Architected Operational Excellence). Routing respects the
`logical-components` failure domains — **none of these page the workflow command
path** (the choreography boundary caps blast radius at delivery
latency/completeness):

| Alert | Condition | Severity | Rationale |
|-------|-----------|----------|-----------|
| DLQ non-empty / growing | `DlqDepth` > 0 sustained | P2 (ticket) | `reliability-design` dead-letter — provider problem; replay after fix (never auto-scale — `scalability-design`) |
| Delivery SLO burn (per channel) | per-channel SLI < 99.5% over window | P2 | `reliability-design` REL-NOTIF-1 |
| Queue backlog / age high | `ApproximateAgeOfOldestMessage` or `QueueDepth` above target for N min | P2 | `scalability-design` scale-out trigger; workers falling behind |
| Circuit breaker open | `CircuitBreakerState` = open sustained | P2 | `reliability-design` — a channel is shedding; the other still delivers |
| Enqueue latency breach | producer `EnqueueLatency` p95 > 3ms | P3 (dashboard) | `performance-design` hot-path budget — risk of touching workflow commit |
| SES bounce/complaint rate high | SES bounce/complaint above SES threshold | P2 | deliverability + SES account-health protection |
| Lambda worker error/throttle spike | worker errors or throttles > baseline | P2 | delivery tier health (`scalability-design` concurrency limit) |
| DynamoDB throttling (either table) | `ThrottledRequests` > 0 (5 min) | P3 | capacity; degrades idempotency/inbox writes → retried |
| RecipientUnresolved spike | `RecipientUnresolvedCount` >> baseline | P3 | directory health / misconfiguration; skips are non-fatal |

Auto-scaling of the worker keys on **queue depth and age**, not CPU, because the
tier is I/O-bound on external providers (`scalability-design`); a rising
per-channel dispatch latency **holds** worker count and lets the breaker trip
rather than adding connections against a struggling provider.

## Dashboards

- **Delivery SLO dashboard**: per-channel delivered/skipped/dead-lettered rates,
  live per-channel SLI vs 99.5% target, end-to-end delivery latency p95/p99,
  dedupe-skip rate (idempotency working), recipient-unresolved rate.
- **Queue & worker dashboard**: `QueueDepth` and `ApproximateAgeOfOldestMessage`
  overlaid on the scale-out threshold (`scalability-design`), Lambda
  concurrency/errors/throttles, DLQ depth with replay status.
- **Channel-health dashboard**: per-channel circuit-breaker state, SES
  send/bounce/complaint, DynamoDB in-app write latency/throttles, recipient-cache
  hit ratio (directory load-shedding effectiveness).

## Incident Response

- **Runbooks** linked from every alert (Well-Architected Operational Excellence),
  mapped to the `reliability-design` failure-mode checklist:
  - *Email provider (SES) outage* → email breaker opens, sends fail fast to DLQ,
    **in-app delivery continues** (BR-NOTIF-7); alert on DLQ growth; replay
    dead-lettered email items after SES recovers (idempotent — safe).
  - *In-app store (DynamoDB) down* → in-app retried then dead-lettered, **email
    still sent**; replay after recovery.
  - *Queue/EventBridge delay* → producer non-blocking (workflow committed
    regardless — `reliability-design` REL-NOTIF-2); events durable in SQS, drain
    resumes; no workflow impact.
  - *DLQ filling* → inspect PII-free correlation, fix provider, **replay** (safe
    because delivery is idempotent per-channel).
  - *Recipient directory outage* → short-TTL cache absorbs blips; unresolved →
    non-fatal skip; transient errors retried.
  - *CryptoPort unavailable* → in-app persist **fails closed** (no plaintext PII),
    retried/dead-lettered (`security-design` BR-PII-3).
- **MTTR** is the operational-excellence KPI; game-days periodically inject an
  SES outage and a worker-down backlog to validate the runbooks and confirm the
  bulkhead (one channel down never takes the other) and non-blocking
  (`business-logic-model` guarantee) properties hold.
