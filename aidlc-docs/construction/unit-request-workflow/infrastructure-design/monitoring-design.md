# Monitoring & Observability Design — `unit-request-workflow`

Metrics, logs, traces, alerts, and dashboards for the **Vacation Request
Workflow** unit on AWS. The observability plane is inherited from the modular
monolith ([[components]], [[services]]) — this unit adds workflow-specific SLIs
and alarms. It operationalises the SLO in [[reliability-design]]
(REL-WF-1 command-path availability), the latency budgets in
[[performance-design]] (per-command p95/p99), the fail-closed and
degradation posture in [[reliability-design]] / [[security-design]], and the
scale triggers in [[scalability-design]]. Structured, PII-free logging is a hard
constraint from [[security-design]] (SEC-WF-6/7) and [[business-rules]]
(`BR-INV-6`). Alert routing follows the failure-domain and blast-radius
boundaries the unit's [[logical-components]] inventory defines, so a signal pages
only the owning module.

## Metrics & KPIs

Emitted as **CloudWatch custom metrics** (Embedded Metric Format from the Node
process), tagged by `operation` and `outcome`, matching the instrumentation
[[performance-design]] "Measurement & Benchmarks" prescribes (a per-command
duration histogram tagged by operation and outcome code).

RED method for the command path (Well-Architected / infrastructure-guide "RED
for services"):

| Metric | Dimensions | Source design |
|--------|-----------|---------------|
| `WorkflowCommandCount` (Rate) | `operation` = submit/leadDecision/hrDecision, `outcome` = ok/forbidden/invalidInput/illegalTransition/staleState/notFound | [[performance-design]], [[reliability-design]] (well-formed err counts as available) |
| `WorkflowCommandErrors` (Errors) | split business-error vs system-error | REL-WF-1 SLI definition |
| `WorkflowCommandDuration` p50/p95/p99 (Duration) | per `operation` | [[performance-design]] budget table (≤ 200 ms p95 / ≤ 400 ms p99 for commands; ≤ 50 ms `findById`) |
| `StaleStateConflicts` | per `operation` | [[business-rules]] `BR-INV-3`; expected-but-watched (optimistic-concurrency contention) |
| `AuthzDenyCount` | `permission` | [[security-design]] SEC-WF-2 fail-closed denials |
| `EventPublishLag` | `event-type` | Streams→EventBridge outbox latency ([[infrastructure-services]]) |
| `DlqDepth` | forwarder DLQ | poison-event detection |

Infrastructure USE metrics (resources): Fargate CPU/memory utilisation,
DynamoDB consumed vs provisioned capacity + throttles, ALB 5xx + target health,
Lambda outbox errors/duration.

**SLI/SLO tracking** ([[reliability-design]] REL-WF-1): SLI =
`(ok + well_formed_business_err) / total` on the command path; SLO = **99.9%
monthly** (placeholder pending the concrete `req-nfr-availability-tbd` figure —
open item carried from [[reliability-design]]). A CloudWatch **error-budget burn
rate** alarm (fast-burn 1h + slow-burn 6h windows) tracks consumption of the
~43 min/month budget.

## Log Strategy

- **CloudWatch Logs**, structured **JSON** to stdout from the Fargate task
  (infrastructure-guide log format: timestamp, level, service, traceId,
  operation, outcome, message) — never file-based (container checklist).
- **PII redaction is mandatory at the log boundary** ([[security-design]]
  SEC-WF-7, [[business-rules]] `BR-INV-6`, `req-nfr-security-pii`): the free-text
  `reason`, employee names, and emails are **never** logged; logs carry only
  pseudonymous ids (`requestId`, `ownerId` ref, `department`) and PII-free error
  codes ([[business-logic-model]] error handling). A log-scrubbing filter and a
  code-review rule enforce this; a `vitest` assertion (mirroring the authz "no
  PII in messages" test) guards it in CI.
- **Retention**: 30 days hot in CloudWatch, then export to S3 with a lifecycle
  policy (→ Infrequent Access → Glacier) for cost — this is **operational** log
  retention only. The **7-year audit retention** (`req-nfr-audit-retention`,
  [[reliability-design]] REL-WF-9) is a distinct, immutable record owned by the
  `audit-trail` unit, **not** these operational logs — see
  [[shared-infrastructure]].

## Distributed Tracing

- **AWS X-Ray** (OpenTelemetry-compatible), instrumenting the command path:
  HTTP handler → `requireSession` → `requirePermission` → workflow service →
  DynamoDB call → event publish (infrastructure-guide "instrument HTTP handlers,
  database calls, queue operations").
- A single trace spans `submitRequest`/`leadDecision`/`hrDecision` so the
  contribution of the authz check, the DynamoDB read/write, and the outbox
  publish to the ≤ 200 ms p95 budget ([[performance-design]]) is attributable.
- Trace context propagates onto the emitted EventBridge event so the async
  `audit-trail`/`notification` consumers can be correlated to the originating
  command (cross-unit trace continuity without coupling).

## Alert Definitions

Alert on **symptoms, not causes** (infrastructure-guide), each with a runbook
link (Well-Architected Operational Excellence):

| Alert | Condition | Severity | Rationale |
|-------|-----------|----------|-----------|
| Command error-rate high | system-error rate > 1% over 5 min | P1 (page) | SLO burn ([[reliability-design]] REL-WF-1) |
| Latency budget breach | p95 `WorkflowCommandDuration` > 200 ms (10 min) | P2 (ticket) | [[performance-design]] budget |
| Fast error-budget burn | burn-rate alarm (1h window) | P1 | SLO protection |
| DynamoDB throttling | `ThrottledRequests` > 0 (5 min) | P2 | capacity / [[scalability-design]] store-side limit |
| Outbox DLQ non-empty | `DlqDepth` > 0 | P2 | event delivery ([[infrastructure-services]]); risk to audit/notification |
| Stale-state spike | `StaleStateConflicts` >> baseline | P3 (dashboard) | unexpected contention ([[business-rules]] `BR-INV-3`) |
| Authz deny spike | `AuthzDenyCount` anomaly | P3 | possible probing ([[security-design]] threat considerations) |
| Task unhealthy | ALB healthy-host < desired | P1 | [[reliability-design]] multi-AZ health |

Advisory-dependency degradation (HRIS balance / overlap down) is **not** a
command-path alert — those degrade non-blockingly ([[reliability-design]]
REL-WF-2), so they surface as dashboard-only (P3) signals owned by their units,
never paging on the workflow path.

## Dashboards

- **Workflow SLO dashboard**: command rate/errors/duration by operation, live
  SLO % vs 99.9% target, error-budget remaining, stale-state and authz-deny
  trends.
- **Infrastructure dashboard**: Fargate CPU/mem + task count vs autoscaling
  bounds, DynamoDB capacity/throttles, ALB 5xx/latency/target health, outbox
  Lambda + DLQ.
- **Autoscaling context** ([[scalability-design]] scale-out trigger): the
  dashboard overlays per-task in-flight command count and CPU against the
  scale-out threshold so capacity decisions are visible; concrete thresholds are
  confirmed against the `req-nfr-concurrency` figure (open item).

## Incident Response

- **Runbooks** (Well-Architected Operational Excellence, ops knowledge) linked
  from every alert. Key scenarios map to the [[reliability-design]] failure-mode
  checklist:
  - *DynamoDB throttling / unavailable* → command returns a retryable error, no
    partial write (REL-WF-8, `BR-INV-3/4`); scale capacity, no data-loss risk.
  - *Outbox DLQ filling* → events not reaching audit/notification; replay from
    DLQ after fixing the consumer — the committed state is intact, so replay is
    safe and idempotent (REL-WF-6).
  - *Elevated stale-state* → investigate concurrent-approver contention; expected
    behaviour, not corruption (exactly one transition commits — REL-WF-5).
  - *Fail-closed spike (403s)* → verify the authz PDP / directory read health;
    denies are safe by design ([[security-design]] SEC-WF-2, REL-WF-3).
- **MTTR** is the operational-excellence KPI; game-days periodically inject
  DynamoDB throttling and consumer-down scenarios to validate the runbooks
  (Well-Architected reliability testing).
