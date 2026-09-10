# Monitoring & Observability Design — `unit-status-query`

Metrics, logs, traces, alerts, and dashboards for the **Status Tracking & Query**
unit on AWS. The observability plane is **inherited** from the modular monolith
(`components`, `services`) — this unit adds read-specific SLIs and alarms and wires
them into the shared CloudWatch/X-Ray plane (`logical-components` "its metrics wired
into the shared observability plane"). It operationalises the read-path SLO in
`reliability-design` (REL-D-1), the per-operation latency budgets in
`performance-design` (PERF-D-14/16), the fail-closed and non-leaking posture in
`reliability-design` / `security-design`, and the store-side scale signal in
`scalability-design` (SCALE-D-11). Structured, PII-free logging is a hard constraint
from `security-design` (SEC-D-15) and `business-logic-model` (role-gated `reason`).

## Metrics & KPIs

Emitted as **CloudWatch custom metrics** (Embedded Metric Format from the shared
Node process), tagged by `operation` and `outcome`, exactly as `performance-design`
PERF-D-14 prescribes (per-operation duration histograms tagged by operation and
outcome code).

RED method for the read path (Well-Architected / infrastructure-guide "RED for
services"):

| Metric | Dimensions | Source design |
|--------|-----------|---------------|
| `StatusQueryCount` (Rate) | `operation` = listOwnRequests/listScopedRequests/getRequestTimeline, `outcome` = ok/forbidden/notFound/invalidInput | `performance-design` PERF-D-14; `reliability-design` REL-D-1 (well-formed err counts as available) |
| `StatusQueryErrors` (Errors) | split business-error (forbidden/notFound/invalidInput) vs system-error (store timeout/fault) | `reliability-design` REL-D-1 SLI definition |
| `StatusQueryDuration` p50/p95/p99 (Duration) | per `operation` | `performance-design` budget table (≤ 150 ms p95 own/timeline; ≤ 200 ms p95 scoped) |
| `StoreReadDuration` p95/p99 | `operation` | `performance-design` aggregate-load budget ≤ 50 ms; `reliability-design` REL-D-3 ~800 ms timeout margin |
| `StoreReadRetries` | `operation` | `reliability-design` REL-D-4 bounded-retry telemetry (transient-store-fault signal) |
| `AuthzDenyCount` | `permission` = view-own/view-team/view-department | `security-design` SEC-D-2 fail-closed denials; probing signal |

Infrastructure USE metrics for the read path are **read from the shared monolith
dashboards** rather than re-emitted: Fargate CPU/memory (the `scalability-design`
SCALE-D-9 scale-out signal), DynamoDB **read**-capacity consumed vs provisioned and
**read throttles** (`scalability-design` SCALE-D-11 store-capacity signal), and ALB
target health. This unit does not own those resources, so it observes their signals
rather than owning their alarms.

**SLI/SLO tracking** (`reliability-design` REL-D-1): SLI =
`(ok + well_formed_business_err) / total` on the read path — a well-formed
`forbidden`/`notFound`/`invalidInput` counts as **available** because the service
responded correctly (`security-design` SEC-D-6/7 non-leaking). SLO = **99.9%
monthly** (placeholder pending the concrete `req-nfr-availability-tbd` figure — open
item carried from `reliability-design`). A CloudWatch error-budget burn-rate alarm
(fast-burn 1h + slow-burn 6h) tracks the ~43 min/month budget, counting **only
system-errors** against the budget, never fail-closed denies.

## Log Strategy

- **CloudWatch Logs**, structured **JSON** to stdout from the shared Fargate task
  (infrastructure-guide log format: timestamp, level, service=`status-query`,
  traceId, operation, outcome, message) — never file-based.
- **PII redaction is mandatory at the log boundary** (`security-design` SEC-D-15;
  `business-logic-model` role-gated `reason`; `req-nfr-security-pii`): principal
  ids, department codes, and free-text `reason` are **never** logged in the clear —
  the `redactForLog` helper in `security-design` reduces them to `[REDACTED]`/`[none]`
  before any sink. All `StatusQueryError` messages are static PII-free constants
  (`security-design` SEC-D-15). A log-scrubbing filter plus a `vitest` assertion
  (mirroring the authz/workflow "no PII in messages" test) guards this in CI.
- **Retention**: 30 days hot in CloudWatch, then export to S3 with a lifecycle
  policy (→ Infrequent Access → Glacier) for cost — **operational** log retention
  only. The **7-year audit retention** (`req-nfr-audit-retention`) is a distinct
  immutable record owned by `audit-trail` — a status **read** is not an audited fact
  (`security-design` SEC-D-16), so these operational read logs are never that record.

## Distributed Tracing

- **AWS X-Ray** (OpenTelemetry-compatible), instrumenting the read path:
  HTTP handler → `requireSession` → `requirePermission` →
  `StatusQueryService.<query>` → `VacationRequestRepository` read → projection
  (infrastructure-guide "instrument HTTP handlers, database calls").
- A single trace spans one query so the contribution of the in-process authz check
  (≤ 5 ms, `performance-design`), the DynamoDB read, and the projection to the
  per-operation p95 budget is attributable — the trace is the primary tool for the
  PERF-D-16 budget-breach investigation.
- Because auth and authz are **in-process** (`business-logic-model` Data Flow), the
  trace has no cross-service span for them; the only remote span is the store read
  (`reliability-design` REL-D-15), which is exactly where a latency breach or
  timeout (REL-D-3) will show.

## Alert Definitions

Alert on **symptoms, not causes** (infrastructure-guide), each with a runbook link
(Well-Architected Operational Excellence). This unit's alerts are scoped to the read
path; store/compute-capacity alerts are owned by the resource owners and only
**referenced** here:

| Alert | Condition | Severity | Rationale |
|-------|-----------|----------|-----------|
| Read system-error rate high | system-error rate > 1% over 5 min | P1 (page) | SLO burn (`reliability-design` REL-D-1) |
| Latency budget breach | p95 `StatusQueryDuration` > operation budget (10 min) | P2 (ticket) | `performance-design` PERF-D-16 — trigger to revisit deferred cache/projection |
| Fast error-budget burn | burn-rate alarm (1h window) | P1 | SLO protection |
| Store-read timeout spike | `StoreReadRetries` / timeout rate >> baseline | P2 | `reliability-design` REL-D-3/4 — store-read health (references workflow-owned DynamoDB throttle alarm) |
| Authz deny spike | `AuthzDenyCount` anomaly | P3 (dashboard) | possible existence-probing (`security-design` threat model: reason-harvesting / cross-scope read) |

- **Fail-closed denies do NOT page.** A `forbidden`/`notFound`/`invalidInput` is a
  correct terminal answer (`reliability-design` REL-D-7; `security-design`
  SEC-D-6/7), so a rise in denies is a **P3 dashboard/probing** signal, never a P1 —
  the read path is behaving correctly by refusing to leak.
- **No advisory-degradation alert.** Unlike the command path, this unit has no
  advisory data (`reliability-design` REL-D-16); there is no partial-render degraded
  mode to alert on — the read either authoritatively shows in-scope data or returns
  a typed error.

## Dashboards

- **Status-query SLO widget** (a panel on the shared monolith SLO dashboard):
  per-operation read rate/errors/duration, live SLO % vs 99.9% target, error-budget
  remaining, and the authz-deny trend for probing visibility.
- **Read-dependency widget**: `StoreReadDuration`/`StoreReadRetries` overlaid on the
  workflow-owned DynamoDB **read**-capacity/throttle panel (`scalability-design`
  SCALE-D-11), so the store-read signal — this unit's only external dependency — is
  visible alongside the resource owner's capacity view.
- **Autoscaling context**: because status-query scales with its host
  (`scalability-design` SCALE-D-9), per-task in-flight **read** count and CPU are
  overlaid on the monolith scale-out threshold on the shared infrastructure
  dashboard; this unit contributes the read-count series, not a separate autoscaling
  policy.

## Incident Response

Runbooks (Well-Architected Operational Excellence) linked from every alert, mapped
to the `reliability-design` failure-mode checklist:

- *Store read timing out / retrying* → reads return a retryable `err` with no
  stale/fabricated view (`reliability-design` REL-D-3/4); the caller may safely
  retry, and the workflow-owned DynamoDB capacity/throttle runbook drives
  remediation — no data-loss or correctness risk on the read side.
- *Latency budget breach sustained* → the PERF-D-16 trigger: evaluate the deferred
  `(department, status)` GSI (if not yet built), then the deferred cache/materialized
  projection (`performance-design` PERF-D-5/6) against **measured** data, not
  speculation.
- *Authz-deny spike* → verify whether it is a legitimate access-pattern change or
  existence-probing (`security-design` threat model); denies are safe by design and
  leak nothing (`security-design` SEC-D-6), so this is investigate-not-page.
- *Fail-closed 401 spike* → verify shared session (`unit-platform-auth`) health; the
  read path being unavailable to unauthenticated callers is deliberate
  (`reliability-design` REL-D-6), not an outage of this unit.
