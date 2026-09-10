# Infrastructure Design — memory (`unit-sla-escalation`)

Running log for the infrastructure-design stage. Entries under the four standard
headings with ISO 8601 timestamps.

## Interpretations

- 2026-09-10T15:14:00Z — Selected **EventBridge Scheduler** (not a Fargate-internal `setInterval`) for the `SchedulerPort` binding (C1); the deciding factor was observability, not scheduling features — a managed scheduler emits invocation metrics, making a silently-dead scanner detectable, which `reliability-design` names the primary reliability risk for this background unit.
- 2026-09-10T15:14:05Z — Chose **DynamoDB** for the reminder ledger (C6) with `PK=REQ#<requestId>`, `SK=STAGE#<stage>#TIER#<tier>`; the single-key `hasFired`/`record` pattern maps directly to DynamoDB and matches the platform's existing DynamoDB+KMS+PITR posture; no GSI needed at MVP.
- 2026-09-10T15:14:10Z — Treated `shared-infrastructure.md` as **applicable** (produced it): the unit shares platform compute/VPC/KMS/identity and consumes the notifications send seam + workflow read, so the conditional shared-infra artifact is warranted.
- 2026-09-10T15:14:15Z — Scan compute default is **in-process in the monolith task** (scheduler invokes `runScanTick`), with a **scheduled scan Lambda** (not an SQS worker) as the designed-in-but-not-activated scale path — deliberately different from the notification unit's SQS→Lambda worker because this unit fires on elapsed time, not on an event.

## Deviations

- 2026-09-10T15:14:20Z — The runtime execution-environment prose said methodology outputs must go through an MCP `create_artifact` tool and that no `aidlc-docs/` filesystem exists. In this environment that toolset is **not available** and `aidlc-docs/` **does** exist on disk with sibling units' infrastructure-design artifacts already present. Followed the concrete on-disk convention used by `unit-notifications` and `unit-request-workflow` (5 markdown files under `infrastructure-design/`) so the outputs are actually recorded and match the stage's declared output paths.
- 2026-09-10T15:14:25Z — Did not open an approval-gate question (runtime owns the gate out-of-band per the execution environment); ended with a summary instead.

## Tradeoffs

- 2026-09-10T15:14:30Z — EventBridge Scheduler over in-process timer: +external durability/observability (missed-cadence metric) vs +one managed dependency. Chose the managed scheduler because the missed-cadence signal is the unit's top reliability concern.
- 2026-09-10T15:14:35Z — DynamoDB on-demand (not provisioned) for the ledger in staging/prod at MVP: writes are low and bursty (only threshold crossings), so on-demand minimises idle cost; provisioned+autoscaling is noted as the escalation if write rate ever warrants it.
- 2026-09-10T15:14:40Z — Kept the scan **in-process** at MVP rather than a standalone Lambda from day one: fewer moving parts and topology parity now, with a clean stateless split path later — accepting that the in-process scan shares the monolith's failure domain (mitigated because it never throws back into a workflow commit).

## Open questions

- 2026-09-10T15:14:45Z — Confirm the concrete scan **cadence** (placeholder 15 min) and whether partitioned fan-out is warranted at the real `req-nfr-concurrency` figure.
- 2026-09-10T15:14:48Z — Confirm the ledger's **operational retention / TTL horizon** (default 90 d after terminal) and backup cadence with ops — explicitly distinct from the 7-year audit window.
- 2026-09-10T15:14:51Z — Confirm concrete SLA **thresholds** per stage/tier from product/HR and the **escalation-target policy** (`escalationContactResolver`) so audience widening stays a reviewed config change.
- 2026-09-10T15:14:54Z — Confirm the DynamoDB ledger's production single-key read/append latency so the `hasFired` p95 ≤ 20 ms budget holds.
