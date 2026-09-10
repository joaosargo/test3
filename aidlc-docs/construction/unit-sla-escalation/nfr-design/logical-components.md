# Logical Components — `unit-sla-escalation`

The logical infrastructure component inventory for the **SLA Reminder and
Escalation** unit — service boundaries, failure domains, blast-radius mapping,
isolation strategy, and shared-resource identification. This artifact bridges the
NFR design decisions (`performance-design`, `security-design`,
`scalability-design`, `reliability-design`) with the upcoming Infrastructure
Design by giving a component-level view of *where each NFR pattern applies*. It
is grounded in the hexagonal port/adapter seams in `business-logic-model` (Data
Flow, SLA Scan Pipeline) and the technology choices in `tech-stack-decisions`
(`SchedulerPort`, `ReminderLedgerRepository`, reuse of the notification seam),
against the load and durability envelope in `scalability-requirements`,
`performance-requirements`, and `reliability-requirements`, and the PII posture in
`security-requirements`.

The unit sits on the **choreography / side-effect** side: it fires on the
*absence* of a transition (elapsed pending time), reads the workflow read-only,
and never calls back. Every cross-unit reference is **by id, not object graph**
(least coupling), matching the boundary the workflow and notification units
established.

## Logical Component Inventory

| # | Logical component | Responsibility | Kind | Realises (ports) |
|---|-------------------|----------------|------|------------------|
| C1 | **Scheduler Trigger** | Invoke `runScanTick(nowMs)` on a cadence (cron / EventBridge Scheduler in prod; in-process/manual in dev/test) | Stateful infra binding (external trigger) | `SchedulerPort` |
| C2 | **Scan Orchestrator** (`runScanTick`) | Per tick: enumerate → evaluate → dispatch due tiers → record ledger; returns `ok(scanSummary)` | Stateless compute (single instance MVP) | `SlaScanService.runScanTick` |
| C3 | **SLA Evaluator** (`evaluate`) | Pure classification `OnTrack \| ReminderDue \| EscalationDue` from elapsed time + policy | Stateless, pure (zero I/O) | `SlaScanService.evaluate` |
| C4 | **Escalation Policy Provider** | Load/validate the injected `EscalationPolicy` (thresholds, tiers, business-hours flag); fail-closed at load | Stateless + in-process config cache | `EscalationPolicy` load |
| C5 | **Workflow Pending Query Adapter** | Read-only narrowed `listPending` / `findById` → PII-free `PendingRequestView` | Stateless, read-only client | `WorkflowPendingQueryPort` |
| C6 | **Reminder Ledger Store** | Append-only at-most-once decision trail; `hasFired` (single-key read) + `record` (append) | Stateful (durable append-only, keyed `(requestId, stage, tier)`) | `ReminderLedgerRepository` |
| C7 | **Recipient Directory Adapter** (reused) | Read-only resolve of owner/escalation target via the notifications directory | Stateless, read-only client | `RecipientDirectoryPort` (owned by `unit-notifications`) |
| C8 | **Dispatch Seam** (reused) | Hand SLA-flavoured messages to the notification transport; inherit its retry/DLQ/breaker | Stateless send client into another unit's seam | `EmailSenderPort` / `InAppInboxPort` (owned by `unit-notifications`) |
| C9 | **Optional Debug Read** | Guarded `evaluate`-for-one-request status read (no mutation, PII-free output) | Stateless, request/response | composes on `requireSession → requirePermission` (owned by platform) |

C1/C2/C3/C4/C6 are **owned by this unit**; C5/C7/C8 are **consumed seams** owned
by upstream units; C9 composes on the platform auth seam.

## Service Boundaries

- **Trigger boundary (C1)** is the external scheduler binding. Its only job is to
  invoke `runScanTick` on cadence; the concrete binding is deferred to
  infrastructure-design behind `SchedulerPort` (`tech-stack-decisions` Scheduling).
- **Scan boundary (C2–C4, C6)** is the unit's core: a stateless orchestrator over
  a pure evaluator, a cached policy, and the durable ledger. This is the only
  boundary that holds this unit's own durable state (C6).
- **Consumed-seam boundary (C5, C7, C8)** is strictly read-only-plus-send into
  upstream units: the workflow read (C5) is a narrowed view of the mutating
  aggregate; the directory (C7) and dispatch (C8) seams are reused verbatim from
  `unit-notifications`. No synchronous caller crosses *into* this unit on the
  primary path — the scheduler is the only entry point.
- **Debug boundary (C9)** is an optional small authenticated read that exposes
  only PII-free evaluation output; it is not on the scan path.

These boundaries map to the two paths in `performance-design`: the pure
evaluation path (C3, p99 ≤ 1 ms) and the batch-tick path (C2 over C5/C6/C7/C8,
≤ 30 s per tick).

## Failure Domains

| Failure domain | Components | Isolation | Effect on workflow |
|----------------|-----------|-----------|--------------------|
| **FD-Scheduler** | C1 | External trigger; missed ticks recovered by catch-up | None — a missed tick is recovered next cadence (`reliability-design` REL-DES-8) |
| **FD-Scan** | C2, C3, C4 | Stateless single instance; restartable with no warm-up | None — the scanner never drives a transition (`BR-SLA-8`) |
| **FD-WorkflowRead** | C5 | Read-only client; error becomes a `WORKFLOW_READ_ERROR` value | None — workflow availability is independent (REL-DES-3) |
| **FD-Ledger** | C6 | Own durable store; **critical to this unit** | None to workflow; this unit fails-safe (stops dispatching) to avoid duplicate nudges (REL-DES-11) |
| **FD-Directory** | C7 | Reused notifications seam | None — unresolvable → `RECIPIENT_UNRESOLVED`, batch continues |
| **FD-Dispatch** | C8 | Reused notifications seam (owns its own breaker/DLQ) | None — transient failure retried/dead-lettered *there*; in-app copy still lands |
| **FD-DebugRead** | C9 | Independent guarded request path | None — debug read unavailable, scan unaffected |

The defining reliability property: **the ledger (FD-Ledger) is the only domain
this unit will stop for** — correctness (at-most-once) outranks liveness there
(`reliability-design` degradation table). Every other domain degrades to a
recorded value and the batch continues.

## Blast-Radius Mapping

| Failure | Blast radius | Containment |
|---------|-------------|-------------|
| Scheduler misses cadences | Nudge timeliness only (delayed ≤ downtime) | Catch-up fires each un-fired tier once on recovery (`BR-SLA-6a`); no lost or duplicated nudge |
| Scan instance crashes mid-tick | In-flight tick only | Stateless + idempotent ledger; next tick re-derives from live state; already-fired tiers skipped (`BR-SLA-6`) |
| Workflow read outage | This tick's dispatch (none) | `WORKFLOW_READ_ERROR` recorded, retry next cadence; workflow untouched |
| Ledger outage | This unit's dispatch capability | **Fail-safe: dispatch nothing, retry** — bias toward not-spamming over duplicate nudges (REL-DES-11) |
| Directory unresolvable target | One recipient/tier | `RECIPIENT_UNRESOLVED` recorded; other requests/tiers unaffected; never guesses a fallback (`security-design` SEC-DES-3) |
| Notification provider outage | Notice delivery latency/completeness | Retried/dead-lettered by the notification seam (its blast radius, not this unit's); in-app copy still lands |
| Misconfigured policy | Whole unit at load | Fail-closed `MISCONFIGURED_POLICY` throw — never scans with a broken policy (`BR-SLA-4a`) |

Critically, **no failure in any C-component reaches the `unit-request-workflow`
command path or corrupts request/audit state** — the choreography boundary caps
the radius at "reminder timeliness / completeness" (`reliability-requirements`
blast-radius; `security-requirements` SEC-SLA-4 no state effect).

## Component Isolation Strategy

- **Stateless scan tier (C2/C3)** scales/restarts with no affinity and no warm-up
  (`scalability-design` single-stateless-scanner; `reliability-design` REL-DES-9).
- **Pure evaluator (C3)** is isolated from all I/O — the zero-I/O core that meets
  the p99 ≤ 1 ms budget and is exhaustively unit-testable (`performance-design`).
- **Ledger as the sole owned durable state (C6)** — the only stateful component
  this unit owns; isolated behind `ReminderLedgerRepository` so the in-memory
  dev/test adapter swaps for a durable prod store with no scan-logic change
  (`tech-stack-decisions` Persistence).
- **Consumed seams (C5/C7/C8) carry their own isolation** — the notification
  seam's per-channel breakers/bulkheads/DLQ live in `unit-notifications`; this
  unit deliberately does **not** re-implement them (least coupling, no new
  transport).
- **PII containment as isolation** — PII is confined to C7's transient resolution
  and C8's outbound message; it never enters C2/C3/C4 (work from pseudonymous ids),
  C6 (PII-free ledger by construction), C5 (narrowed PII-free view), or logs
  (`security-design` SEC-DES-6/7).
- **No-locking concurrency isolation** — fan-out safety comes from the ledger
  dedupe key, not distributed locks, so multiple C2 instances over disjoint/
  overlapping partitions stay correct without coordination (`scalability-design`).

## Shared Resource Identification

| Resource | Shared with | Boundary discipline |
|----------|-------------|---------------------|
| Workflow pending read (C5) | `unit-request-workflow` (owner) | **Read-only narrowed view** (`findByDepartmentAndStatus`); one batch read per cadence; never the mutating aggregate; offloadable to a read replica if isolation needed (`performance-design`, `scalability-design`) |
| Recipient directory (C7) | `unit-notifications` (owner) | Consumed read-only; this unit does not derive who may receive — reuses the shared resolution (`security-design` SEC-DES-3) |
| Dispatch transport (C8) | `unit-notifications` (owner) | Reused **verbatim**; inherits retry/DLQ/breaker; no new transport (`tech-stack-decisions` Integration; `BR-SLA-12`) |
| Identity / request value objects | `unit-platform-auth`, `unit-request-workflow` | `PrincipalId`, `RequestId`, `RequestStatus`, `WorkflowStage`, `Transition`, `DepartmentCode` reused read-only, by id, never redefined (`tech-stack-decisions` Integration) |
| Auth guard (C9) | `unit-platform-auth` / `unit-platform-authz` | Optional debug read composes on `requireSession → requirePermission`; no auth logic here (`security-design` SEC-DES-4) |
| Secrets (ledger / scheduler / transport creds) | Platform secrets manager | Injected from env / secrets manager, never hard-coded (`security-design` SEC-DES-8; `ADR-AUTH-04` precedent) |

## Hand-off to Infrastructure Design

Infrastructure Design should provision/decide:

1. **Scheduler binding** for C1 (cron / EventBridge Scheduler) satisfying the
   cadence (placeholder 15 min) with a **least-privilege principal** and
   missed-cadence observability (`reliability-design` REL-DES-1;
   `security-design` SEC-DES-1).
2. **Durable append-only ledger store** for C6 satisfying: single-key `hasFired`
   read within the p95 ≤ 20 ms budget (`performance-design`), append-only (no
   update/delete), at-rest encryption, keyed `(requestId, stage, tier)`, and an
   **operational** (not 7-year audit) retention/backup horizon
   (`scalability-design`, `reliability-design`).
3. **Scan compute** for C2 — single stateless instance at MVP, with a designed-in
   (not activated) partition-by-department fan-out path that needs no distributed
   locking (`scalability-design`).
4. **Seam wiring** for C5/C7/C8 — the read-only workflow query binding and the
   reused `unit-notifications` directory + dispatch seams (no new transport).
5. **Observability** wiring: `runScanTick` duration histogram; counters for
   requests scanned / tiers evaluated / notices dispatched (tagged by
   `stage`/`tier`/outcome code); and the **missed-cadence alert** that is the
   primary reliability watchdog for this background unit (`performance-design`,
   `reliability-design`).
6. **Escalation-target policy** source for the injected `escalationContactResolver`
   so audience widening is a reviewed config change (`security-design` SEC-DES-3
   open question).
