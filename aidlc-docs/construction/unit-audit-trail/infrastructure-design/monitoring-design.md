---
consumes: [performance-design, security-design, scalability-design, reliability-design, logical-components, components, services, business-logic-model]
unit: unit-audit-trail
stage: infrastructure-design
---

# Monitoring & Observability Design — `unit-audit-trail`

Metrics, logs, traces, alerts, and dashboards for the **Immutable Audit Trail**
unit on AWS. The observability plane is inherited from the modular monolith
(`components`, `services`) — this unit adds audit-specific SLIs and alarms onto
that shared CloudWatch/X-Ray plane (`logical-components` shared-resource
inventory). It operationalises the completeness SLO in `reliability-design`
(RD-AUD-1) and read-surface SLO (RD-AUD-2), the ingest/read latency budgets in
`performance-design` (the budget table), the fail-closed and degradation posture
in `reliability-design` / `security-design`, and the scale triggers in
`scalability-design` (SC-AUD-13). Structured, **PII-free** logging is a hard
constraint from `security-design` (SD-AUD-12) and `business-logic-model` (id-only
records). Alert routing follows the failure-domain boundaries in
`logical-components` (FD-1…FD-5), so a signal pages only the owning concern.

## Metrics & KPIs

Emitted as **CloudWatch custom metrics** (Embedded Metric Format from the Node
process), tagged by `operation` and `outcome`, matching the instrumentation
`performance-design` "Measurement & Benchmarks" prescribes.

The dominant SLO here is **completeness, not latency** (`reliability-design`
RD-AUD-1): no accepted transition may ever be silently lost.

| Metric | Dimensions | Source design |
|--------|-----------|---------------|
| `AuditIngestCount` (Rate) | `eventType`, `outcome` = ok/duplicate/malformed | `performance-design` PD-AUD-2/4 measurement note |
| `AuditIngestDuration` p50/p95/p99 | `eventType` | `performance-design` budget (≤ 20 ms p95 / ≤ 50 ms p99 ingest) |
| `AuditTrailCompleteness` (gauge) | `recorded / emitted` reconciled over a window | `reliability-design` RD-AUD-1 (primary SLO; target 1.0) |
| `AuditIngestLagAge` (queue backlog age) | SQS `ApproximateAgeOfOldestMessage` | `scalability-design` SC-AUD-13 scale-out signal |
| `AuditDlqDepth` | ingest DLQ | `reliability-design` RD-AUD-5 (malformed/poison detection) |
| `AuditQueryDuration` p95/p99 | `operation` = getRequestTrail/queryTrail/verifyChain, `resultSize` | `performance-design` read budgets (≤ 100 ms / ≤ 500 ms / ≤ 300 ms p95) |
| `AuditReadOutcome` | `outcome` = ok/forbidden/notFound | `reliability-design` RD-AUD-2 (well-formed err counts as available) |
| `AuditAuthzDeny` | `permission` | `security-design` SD-AUD-2 fail-closed denials |
| `IntegritySweepResult` | `outcome` = intact/hashMismatch/brokenLink, `partitions` | `reliability-design` RD-AUD-8, `security-design` SD-AUD-8 |

Infrastructure USE metrics (resources): DynamoDB consumed vs provisioned capacity
+ throttles + GSI read latency (`scalability-design` SC-AUD-14 leading
indicator), SQS depth/age, S3 Object Lock write errors, ingest Lambda/poller
errors + duration, and the shared Fargate CPU/memory the monolith already emits.

**SLI/SLO tracking**:
- **Completeness (primary, RD-AUD-1)**: SLI = `AuditTrailCompleteness`; target
  **1.0** — any sustained gap is a **compliance incident**, not a budget spend.
- **Read-surface availability (RD-AUD-2)**: SLI =
  `successful_or_expected-error responses / total`; target **99.5% monthly**
  (error budget ≈ 3.6 h, spent on store maintenance / cold-tier reads).

## Log Strategy

- **Structured JSON to CloudWatch Logs**, one line per ingest/read outcome,
  carrying `timestamp, level, unit=audit-trail, operation, outcome, requestId,
  auditId, occurredAtMs` — **id-only, never PII** (`security-design` SD-AUD-12;
  the `linter` sensor guards obvious violations). `AuditError` codes are
  machine-readable and PII-free.
- **Retention**: 30 days hot / 90 days warm in CloudWatch (infrastructure-guide);
  the *evidence itself* has its own 7-year WORM retention in the audit store —
  operational logs are **not** the compliance record and must not be conflated
  with it.
- **DLQ payloads** are logged id-only with the rejection reason so malformed
  events can be triaged without exposing event contents.

## Tracing

- **AWS X-Ray** on the shared plane. The ingest path is traced from the SQS
  poll → `recordEvent` → dedup lookup → chain-head read → `append` (DynamoDB +
  S3), so a slow segment is attributable (`performance-design` PD-AUD-2 O(1)
  breakdown). Read handlers are traced through
  `requireSession → requirePermission → store read` to confirm the guard adds no
  scan (`security-design` SD-AUD-1).
- Because ingest is off the command path (`performance-design` PD-AUD-1), the
  audit trace is a **separate segment tree** from the workflow command trace —
  correlated by `requestId` but never inflating the command latency budget.

## Alert Definitions

Alarms route by failure domain (`logical-components` FD-1…FD-5); severity per the
infrastructure-guide (P1 page / P2 ticket / P3 dashboard):

| Alarm | Condition | Severity | Failure domain |
|-------|-----------|----------|----------------|
| **Completeness gap** | `AuditTrailCompleteness < 1.0` sustained over the reconcile window | **P1** | Ingest / store (RD-AUD-1) |
| **Ingest DLQ non-empty** | `AuditDlqDepth > 0` | **P1** | FD-3 bus/subscription; RD-AUD-5 |
| **Integrity violation** | `IntegritySweepResult` = hashMismatch/brokenLink | **P1** | FD-5 tamper/corruption (SD-AUD-6/8) |
| **Ingest lag high** | `AuditIngestLagAge > 30 s` sustained | **P2** | FD-3; scale-out signal (SC-AUD-13) |
| **Store outage / throttle** | DynamoDB throttles or `append` error rate up | **P2** | FD-2 durable store |
| **`queryTrail` regression** | `AuditQueryDuration` p95 > 500 ms | **P2** | GSI regression (SC-AUD-7) |
| **Read availability breach** | RD-AUD-2 SLI < 99.5% burn | **P2** | FD-2/FD-4 read surface |
| **WORM write failure** | S3 Object Lock put errors | **P2** | FD-2 (SD-AUD-9) |

- A **completeness gap** and an **integrity violation** are the two page-worthy
  compliance signals — everything else the async, buffered design tolerates for a
  bounded window (`reliability-design` degradation table).
- Every alert links a runbook (integrity-incident response, DLQ triage, cold-tier
  read latency).

## Dashboards

- **Compliance dashboard**: `AuditTrailCompleteness` trend, integrity-sweep
  pass/fail history, DLQ depth, 7-year corpus growth vs the linear capacity
  projection (`scalability-design` SC-AUD-10). This is the auditor/operator view
  that the completeness-first SLO demands.
- **Ingest dashboard**: ingest rate + duration histogram by `eventType`/outcome,
  queue depth/age, duplicate-short-circuit rate (`performance-design` PD-AUD-4).
- **Read dashboard**: `AuditQueryDuration` by operation, authz-deny rate, GSI
  read latency vs corpus size (the `queryTrail` regression watch,
  `scalability-design` SC-AUD-7).

## Incident Response

- **Completeness gap** → reconcile `emitted` (workflow's `BR-INV-5` event count)
  against `recorded`; replay from the SQS/bus buffer or DLQ; the idempotent guard
  makes replay safe (`reliability-design` RD-AUD-4). A confirmed lost transition
  is a compliance incident with mandatory write-up.
- **Integrity violation** → freeze the affected partition, run a full
  `verifyChain`, restore from PITR / S3 Object Lock versioned copy, re-verify
  post-restore (`reliability-design` RD-AUD-8/11); the WORM tier means the
  authoritative copy cannot itself have been altered (`security-design`
  SD-AUD-9).
- **DLQ non-empty** → inspect id-only reason, correct upstream event-shape drift,
  redrive; nothing is dropped silently (`reliability-design` RD-AUD-5).
- Recovery objectives (`reliability-design` RD-AUD-12): **RPO ≈ 0** for committed
  records (append-only + at-least-once redelivery), **RTO of the read surface ≤ a
  few hours** (compliance reads tolerate a recovery window) — confirmed jointly
  with the `unit-request-workflow` store owner.
