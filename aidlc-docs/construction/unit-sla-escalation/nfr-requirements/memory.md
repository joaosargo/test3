# NFR Requirements — memory — `unit-sla-escalation`

> Running log for the nfr-requirements stage of unit-sla-escalation.
> Add observations at the gate ritual, not by editing here directly.

## Interpretations
- 2026-09-10T14:56:30Z — treated availability as **scanner-tick liveness** (≥99% of scheduled ticks run) rather than synchronous request availability, because this unit is a timer-driven, off-the-command-path scanner with no user request to keep available; context: business-logic-model `Workflow S-A` returns a `ScanSummary` and never drives a workflow transition (BR-SLA-8).
- 2026-09-10T14:56:30Z — scoped the reminder-ledger retention to an **operational** horizon explicitly distinct from the 7-year `req-nfr-audit-retention` window, because the ledger captures SLA decisions (operational fact trail), not compliance evidence, which lives in the separate `unit-audit-trail`; context: business-logic-model "Own durable state" calls the ledger distinct from both the audit trail and the notification delivery record.
- 2026-09-10T14:56:30Z — set the notice-timeliness objective to "within one scan cadence of threshold crossing" (soft SLO) since thresholds are hours-to-days and a one-cadence (placeholder 15 min) delay is immaterial to `req-sla-reminder-escalation`.

## Deviations
- 2026-09-10T14:56:30Z — did not define a user-facing p95/p99 request-latency table like the synchronous units (unit-request-workflow); instead split response-time targets into the pure `evaluate` function and the background batch tick, because there is no interactive request on this unit's primary path; context: mirrors the choreography/side-effect placement the notifications unit used.
- 2026-09-10T14:56:30Z — recorded artifacts as markdown files in `aidlc-docs/construction/unit-sla-escalation/nfr-requirements/` matching the on-disk convention of every sibling unit (unit-request-workflow, unit-audit-trail, unit-status-query), since the `create_artifact` MCP surface described in the execution environment is not present in this runtime's tool set and the deterministic sensors inspect `aidlc-docs/`.

## Tradeoffs
- 2026-09-10T14:56:30Z — chose "single stateless scanner, scale by cadence first; idempotent fan-out only if needed" over designing for horizontal partitioning up front, because at the projected internal-LOB scale (tens–low-hundreds pending) a single instance is ample and the ledger dedupe key makes later fan-out safe without distributed locking; context: reused the workflow unit's stateless-horizontal posture but noted dispatch volume tracks threshold-crossings, not backlog.
- 2026-09-10T14:56:30Z — treated the durable ledger as **Critical to this unit** (fail-fast toward not-spamming if the ledger is unavailable) while treating scheduler/workflow-read/directory/transport as **Important**, biasing degradation toward never sending duplicate nudges over always sending on time.

## Open questions
- 2026-09-10T14:56:30Z — concrete SLA thresholds per stage/tier and business-hours-vs-wall-clock mode remain unspecified (inherited from functional-design memory); illustrative defaults (TeamLead 24h/48h, HR 48h/96h) drive the cadence-vs-threshold ratio but must be confirmed with product/HR before nfr-design hardens numbers.
- 2026-09-10T14:56:30Z — scan **cadence** and production **scheduler binding** (cron / EventBridge Scheduler) are placeholder (15 min) pending infrastructure-design; the tick-liveness SLO and missed-cadence alerting depend on the confirmed cadence.
- 2026-09-10T14:56:30Z — the escalation **target** (pending actor's manager / HR-ops mailbox / fixed contact) remains an injected-resolver open question inherited from functional design; it affects the recipient-mis-targeting threat surface in security-requirements.
- 2026-09-10T14:56:30Z — the concrete `req-nfr-concurrency` and `req-nfr-availability-tbd` figures in `requirements` are still TBD; performance/scalability/reliability targets use placeholders keyed to them.
