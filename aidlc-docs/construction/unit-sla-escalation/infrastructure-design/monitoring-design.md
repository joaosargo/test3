# Monitoring & Observability Design — `unit-sla-escalation`

The observability design for the **SLA Reminder and Escalation** unit — metrics,
logs, traces, alerts, dashboards, SLI/SLO tracking, and incident response —
scoped to a **timer-driven background scanner** that no human waits on. It
realises the observability hand-off in `logical-components` (item 5) and the
instrumentation and liveness signals called out in `performance-design`
(per-tick metrics), `reliability-design` (missed-cadence alerting as the primary
reliability signal; liveness SLO), `scalability-design` (cadence/backlog scale
signals), and `security-design` (PII-free logs and codes). It plugs into the
platform CloudWatch/X-Ray observability plane established by
`unit-request-workflow` and `unit-notifications` (`components`, `services`).

The governing observability property, restated from `reliability-design`: because
this unit is a **background scanner with no synchronous caller**, its most
dangerous failure is **silent death** — a scanner that stops ticking is invisible
to users, and a missed nudge surfaces only as a business complaint days later. The
central observability objective is therefore **liveness / missed-cadence
detection**, not user-latency percentiles. Correctness signals (at-most-once,
catch-up) come second; user-facing latency does not apply.

## Metrics & KPIs

Emitted per tick to CloudWatch (custom namespace `VacationApp/SlaEscalation`),
tagged by `env`, `stage` (`TeamLead`/`HR`), `tier` (`Reminder`/`Escalation`), and
outcome code where applicable — the dimensions come straight from the
`runScanTick` pipeline in `business-logic-model` (enumerate → evaluate → dispatch
due tiers → record ledger). These are the metrics `performance-design`
prescribes plus the liveness/scale signals `reliability-design` and
`scalability-design` require:

| Metric | Type | Source / purpose |
|--------|------|------------------|
| `TicksExecuted` | counter | Ticks that ran and returned `ok(scanSummary)` — the **liveness numerator** (`reliability-design` REL-DES-1) |
| `TicksScheduled` | counter (derived from EventBridge Scheduler invocation metric) | Scheduled fires — the **liveness denominator**; the gap is the missed-cadence signal |
| `RunScanTickDurationMs` | histogram (p50/p95/p99) | Tick wall-clock vs the ≤ 30 s budget (`performance-design`); early warning that cadence must not tighten further |
| `RequestsScanned` | gauge/counter per tick | Pending backlog size — the **scale signal** (`scalability-design` load model) |
| `TiersEvaluated` | counter | Evaluation volume (cheap axis) |
| `NoticesDispatched` | counter, by `stage`/`tier`/outcome | Dispatch volume — steady-state near-zero; a spike signals a threshold/config change |
| `DispatchOutcome` | counter, by code (`DISPATCHED`/`RECIPIENT_UNRESOLVED`/`CHANNEL_DEAD_LETTERED`/`WORKFLOW_READ_ERROR`) | Degradation visibility (`performance-design`; `reliability-design` degradation tiers) |
| `LedgerHasFiredLatencyMs` | histogram (p95/p99) | `hasFired` single-key read vs the p95 ≤ 20 ms budget (`performance-design`) |
| `LedgerUnavailable` | counter | Fail-safe-stop events — the ledger is **Critical to this unit** (`reliability-design` REL-DES-11) |
| `CatchUpTiersFired` | counter | Un-fired tiers fired on a recovery tick (`reliability-design` REL-DES-8) — post-downtime health |
| `PolicyLoadFailed` | counter | `MISCONFIGURED_POLICY` at load (`security-design` SEC-DES-10) — should be zero in steady state |

**All metrics are PII-free** — they carry only ids, stage, tier, outcome code, and
timings; no email/name/reason ever enters a metric dimension (`security-design`
SEC-DES-6/7).

## SLI / SLO Tracking

Anchored to the liveness SLO in `reliability-design`, not to request availability:

| SLI | Definition | SLO target | Alert |
|-----|------------|-----------|-------|
| **Scanner liveness** | `TicksExecuted / TicksScheduled` (monthly) | **≥ 99 % of scheduled ticks execute** (`reliability-design` REL-DES-1) | Missed-cadence alarm (below) |
| **Nudge timeliness** (soft) | Due tier dispatched within one cadence of crossing threshold | within ≤ 1 cadence (placeholder 15 min) — soft, thresholds are hours-to-days (`reliability-design` REL-DES-2) | Ticket, not page |
| **At-most-once correctness** | ≤ 1 dispatch per `(requestId, stage, tier)` | 100 % (structural via ledger key) | Duplicate-detection assertion in tests + `NoticesDispatched` anomaly |
| **Tick within budget** | `RunScanTickDurationMs` p99 | ≤ 30 s (`performance-design`) | Warning approaching budget |
| **Ledger read within budget** | `LedgerHasFiredLatencyMs` p95 | ≤ 20 ms (`performance-design`) | Warning on sustained breach |

## Log Strategy

- **Structured JSON to CloudWatch Logs**, matching the platform log format
  (`timestamp`, `level`, `service=sla-escalation`, `event`, `requestId`, `stage`,
  `tier`, `outcomeCode`, tick correlation id) — stdout, never file-based
  (Infrastructure Guide container checklist).
- **PII-free by construction** — logs carry pseudonymous ids and PII-free
  `SlaError` codes only; `redactForLog` is applied at every log/error boundary, and
  because contact PII is structurally absent from the ledger and codes, the log
  surface has nothing to leak (`security-design` SEC-DES-5/6/7).
- **One tick summary line per run** at `info` (requests scanned, tiers evaluated,
  notices dispatched by outcome, duration) — the human-readable counterpart to the
  metrics, keyed by the tick correlation id.
- **Retention**: 30 d hot / 90 d archived (platform default; Infrastructure Guide),
  distinct from the ledger's operational TTL and from the 7-year compliance
  `audit-trail` (`reliability-design` REL-DES-12).

## Distributed Tracing

- **AWS X-Ray**, reusing the platform tracing plane. A tick is one trace: the
  scheduler-invoked `runScanTick` root segment, with subsegments for the workflow
  pending read (C5), each ledger `hasFired`/`record` (C6), and each dispatch into
  the notification seam (C8) — so a slow tick or a slow dependency is
  attributable (`performance-design` batch-tick model; `logical-components` C5/C6/C8
  boundaries).
- Tracing **crosses into the reused notification seam** for the dispatch tail; the
  send's own retry/DLQ tracing lives in `unit-notifications` (`BR-SLA-12`), so this
  unit's trace ends at the seam hand-off.
- Trace annotations are PII-free (ids/stage/tier/outcome only).

## Alert Definitions

Severity per the Infrastructure Guide (P1 page / P2 ticket / P3 dashboard); every
alert links a runbook. Alerts fire on **symptoms**, not raw resource metrics.

| Alert | Condition | Severity | Rationale |
|-------|-----------|----------|-----------|
| **Missed-cadence / scanner dead** | `TicksExecuted` == 0 over N consecutive expected cadences (e.g. 2× the 15-min cadence with no successful tick), or `TicksExecuted/TicksScheduled` < 99 % | **P1 page** | The **primary reliability signal** — a silently dead scanner is the main risk (`reliability-design` health-checks; a background unit no human watches) |
| **Ledger unavailable (fail-safe stop)** | `LedgerUnavailable` > 0 | **P1 page** | The ledger is Critical-to-this-unit; the scanner stops dispatching to avoid duplicate nudges — dispatch is halted until it recovers (`reliability-design` REL-DES-11) |
| **Policy misconfigured at load** | `PolicyLoadFailed` > 0 | **P2 ticket** | Fail-closed — the unit will not scan under a broken policy (`security-design` SEC-DES-10); needs config fix |
| **Tick approaching budget** | `RunScanTickDurationMs` p99 > 20 s (2/3 of the 30 s budget) sustained | **P2 ticket** | Cadence must not tighten further / consider fan-out (`scalability-design` scaling triggers) |
| **Elevated dispatch failures** | `DispatchOutcome{RECIPIENT_UNRESOLVED|CHANNEL_DEAD_LETTERED}` rate above baseline | **P2/P3** | Directory or channel degradation; the batch continues (values, not failures) but sustained rates need investigation (`reliability-design` degradation tiers) |
| **Ledger read latency breach** | `LedgerHasFiredLatencyMs` p95 > 20 ms sustained | **P3 dashboard** | Store-side tuning signal (`performance-design`; `scalability-design` ledger-store limit) |

Note the deliberate **absence** of a user-facing latency/error-rate page — there
is no synchronous user path to alert on (`security-design` SEC-DES-1;
`reliability-design` REL-DES-1).

## Dashboard Specifications

A single **SLA Escalation** CloudWatch dashboard (contributing to the platform
`MonitoringStack`, `deployment-architecture`):

- **Liveness row** (top, most important): `TicksExecuted` vs `TicksScheduled`
  timeline; time-since-last-successful-tick single-value widget; liveness-SLO
  gauge. This is the first thing an operator sees.
- **Throughput row**: `RequestsScanned` (backlog trend / scale signal),
  `TiersEvaluated`, `NoticesDispatched` stacked by `stage`/`tier`.
- **Health row**: `DispatchOutcome` by code; `LedgerUnavailable`;
  `PolicyLoadFailed`; `CatchUpTiersFired` (post-downtime recovery visibility).
- **Latency row**: `RunScanTickDurationMs` p50/p95/p99 vs the 30 s budget line;
  `LedgerHasFiredLatencyMs` p95 vs the 20 ms budget line.

## Incident Response

- **Scanner dead (P1)** — runbook: check EventBridge Scheduler last-invocation
  metric and the schedule's enabled state; check the scan target (task/Lambda)
  health; on restart, the **next tick self-heals via catch-up** (fires each
  un-fired tier once, in order — `reliability-design` REL-DES-8), so recovery is
  "restore the trigger, verify the next tick runs green" — no manual replay, no
  duplicate risk (the ledger dedupes).
- **Ledger unavailable (P1)** — runbook: the unit has already **failed safe**
  (dispatched nothing, no duplicate nudges — `reliability-design` REL-DES-11);
  restore DynamoDB availability; the next tick resumes and catch-up covers the gap.
  Verify no `UpdateItem`/`DeleteItem` occurred (append-only invariant intact,
  `security-design` SEC-DES-9).
- **Policy misconfigured (P2)** — the unit fail-closed at load and is not scanning;
  fix the SSM `sla-escalation/*` policy to be monotonic/complete and redeploy/
  reload (`security-design` SEC-DES-10).
- **Elevated dispatch failures (P2/P3)** — inspect `DispatchOutcome` codes:
  `RECIPIENT_UNRESOLVED` points at the directory/escalation-target config
  (`security-design` SEC-DES-3); `CHANNEL_DEAD_LETTERED` is a
  `unit-notifications`-owned transport incident (its DLQ/runbook), not this unit's —
  the SLA tick still returned `ok` and the in-app copy still landed (`BR-SLA-12`).
- **No user-facing incident path** — a failure here degrades *nudge timeliness /
  completeness only*; it never corrupts request/audit state or blocks a workflow
  transition (`logical-components` blast-radius; `security-design` SEC-DES-5). This
  bounds the incident severity ceiling for the unit.
