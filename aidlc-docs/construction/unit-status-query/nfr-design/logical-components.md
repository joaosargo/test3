# Logical Components — `unit-status-query`

Logical infrastructure component inventory for the **Status Tracking & Query**
unit — the read/query side of the vacation-request modular monolith. This
artifact bridges the NFR design decisions with Infrastructure Design by giving a
component-level view of **where** the performance, security, scalability, and
reliability patterns apply: the component inventory, service boundaries, failure
domains, blast-radius map, isolation strategy, and shared-resource ownership. It
builds on the guarded-read architecture in [[business-logic-model]], the
scope/PII/pure-read rules in [[business-rules]], and the stack and cross-unit
contracts in [[tech-stack-decisions]]; each component references the applicable
budgets in [[performance-requirements]], the fail-closed posture in
[[security-requirements]] and [[reliability-requirements]], and the stateless
scale model in [[scalability-requirements]].

The structural fact from [[tech-stack-decisions]] and [[business-logic-model]]:
this unit is an **embedded in-process module** of the modular monolith, not a
separate service. It **owns no infrastructure of its own** — no store, no queue,
no bus, no secrets. Its logical components are code seams (a service, a set of
projections, a router) that **consume** shared and dependency-owned resources
read-only. That is what keeps its blast radius the smallest of any unit in the
monolith.

## Component Inventory

| Logical component | Kind | Responsibility | Owns / Consumes | NFR pattern applied |
|-------------------|------|----------------|-----------------|---------------------|
| `StatusQueryService` | In-process domain service | Orchestrates the three guarded reads (authorize → load → scope-filter → project) | Owns none; consumes ports | Stateless scale-out (SCALE-D-1); fail-closed (REL-D-5/6); one authz + one read per query (PERF-D-3) |
| Read projections (`RequestStatusView` / `RequestSummaryView` / `RequestTimelineView`) | Pure functions | Project the aggregate/history into PII-lean, role-gated shapes | Owns the projection logic | Bounded O(1)-in-transitions cost (PERF-D-1); PII gating (SEC-D-13/14) |
| Status-query HTTP router | Express router (in-process) | Mounts `requireSession → requirePermission → handler`; validates input | Consumes shared HTTP stack | Input validation (SEC-D-8/9); security headers (SEC-D-12) |
| `VacationRequestRepository` read binding | Consumed port (read-only) | `findById` / `findByOwner` / `findByDepartmentAndStatus` against the shared store | **Consumes** (owned by `unit-request-workflow`) | Timeout + bounded retry (REL-D-3/4); `(department, status)` index (SCALE-D-7); least-privilege read grant (SEC-D-8) |
| `AuthzService.decide` binding | Consumed in-process call | The authoritative permit/deny + `departmentScope` grant | **Consumes** (owned by `unit-platform-authz`) | Fail-closed deny (REL-D-5); O(1) in-process (SCALE-D-2) |
| `requireSession` binding | Consumed middleware | Authenticated principal on guarded routes | **Consumes** (owned by `unit-platform-auth`) | Fail-closed 401 (REL-D-6) |
| Read metrics/instrumentation | Observability hooks | Per-operation latency histograms + outcome tags | Consumes shared CloudWatch/X-Ray plane | Latency SLO tracking (PERF-D-14); budget-breach alarm (PERF-D-16) |

There is deliberately **no** row here for a store, cache, queue, or bus: the unit
owns none ([[tech-stack-decisions]] "no new persistence, no new port, no read
cache at MVP"; [[business-rules]] `BR-SQ-15`).

## Service Boundaries

- **LC-1 — One nameable responsibility.** The unit answers exactly one question —
  *"what is the status/history of this request or these requests, for this
  role?"* ([[business-logic-model]] scope). It holds no command, no state, no
  event emission ([[business-rules]] `BR-SQ-15`), satisfying the architecture
  guide's "single, nameable responsibility" boundary test.
- **LC-2 — Read/command split is the primary boundary.** This unit is the query
  half of a CQRS-leaning split; the command half is `unit-request-workflow`. The
  boundary is enforced structurally: this unit's store grant is read-only
  `Query`/`GetItem`, never write ([[security-requirements]] SEC-SQ-5;
  [[scalability-requirements]] SCALE-D-5; workflow shared-infrastructure
  single-writer rule). A change to how status is *read* never ripples to how it is
  *written*.
- **LC-3 — Authorization boundary is external.** The unit does not own RBAC; it
  consumes `AuthzService.decide` and treats the grant as authoritative
  ([[business-rules]] `BR-SQ-1/3`; [[tech-stack-decisions]] Integration). The
  who-may-see boundary lives in `unit-platform-authz`, not here.
- **LC-4 — Public surface is three query methods.** The contract is the three
  `status-tracking` signatures ([[business-logic-model]] Query Flows); a future
  cache or materialized projection is added **behind** the repository port without
  changing this surface ([[performance-requirements]] PERF-D-5/6;
  [[scalability-requirements]] SCALE-D-12) — no back-channel coupling.

## Failure Domains

| Failure domain | Contains | Failure behaviour | Trace |
|----------------|----------|-------------------|-------|
| Status-query module (this unit) | `StatusQueryService`, projections, router | A code fault affects only in-flight reads on the faulting instance; stateless → retry elsewhere | REL-D-17; [[reliability-requirements]] Failure-Mode Checklist |
| Shared request store (workflow-owned) | `vacation-requests-<env>` table + `(department, status)` index | Read fails/times out → this unit returns retryable `err`, no stale/fabricated data | REL-D-3/4; [[reliability-requirements]] REL-SQ-5 |
| Authz PDP (in-process, authz-owned) | grant-table decision | Cannot decide → this unit **denies** (`err(forbidden)`) | REL-D-5; [[security-requirements]] SEC-SQ-2 |
| Auth session (in-process, auth-owned) | session validation | No/invalid session → 401 | REL-D-6 |
| Shared compute task (platform-owned) | ECS Fargate task hosting the monolith | Task loss → ALB drains, multi-AZ absorbs; stateless reads retry | REL-D-17; [[scalability-requirements]] SCALE-D-1 |

Because auth and authz are **in-process** ([[business-logic-model]] Data Flow),
their failure domain is the same process — there is no independent network
dependency for this unit to lose besides the store read.

## Blast-Radius Map

- **LC-5 — Smallest blast radius in the monolith.** This unit performs no writes
  ([[business-rules]] `BR-SQ-15`), so a fault in it **cannot corrupt persisted
  state**, cannot desynchronise the append-only history, and cannot affect the
  command path, the audit trail, notifications, or any other unit's routes
  ([[reliability-requirements]] Failure-Mode Checklist "Blast radius";
  [[security-requirements]] SEC-SQ-12). The worst case is degraded/failed *reads*
  on one instance, which retry elsewhere.
- **LC-6 — Read pressure cannot starve the command path.** The unit holds no
  connection pool of its own (PERF-D-7) and takes no lock (PERF-D-10;
  [[business-rules]] `BR-SQ-15/17`), so heavy read load consumes shared store read
  IOPS and shared compute CPU — pressure that the autoscaler
  ([[scalability-requirements]] SCALE-D-9) and the store-capacity signal
  (SCALE-D-11) absorb — but never blocks a write via a lock or a starved write
  pool.
- **LC-7 — A PDP/session outage degrades reads to deny/401, not to a leak.** Under
  any dependency failure the blast radius is *availability* (reads deny or 401),
  never *confidentiality* (no data leaks across scope) — fail-closed by design
  ([[reliability-requirements]] REL-SQ-3/4; [[security-requirements]] SEC-SQ-2).

## Component Isolation Strategy

- **LC-8 — Isolation by statelessness, not by process.** The unit is isolated from
  its siblings not by running in a separate container but by holding **no shared
  mutable state**: it reads through a port and returns a projection
  ([[scalability-requirements]] SCALE-D-1; [[tech-stack-decisions]] Hexagonal). Two
  concurrent reads, or a read concurrent with a command-side write, cannot
  interfere ([[performance-requirements]] NFR-SQ-PERF-4; [[business-rules]]
  `BR-SQ-17`).
- **LC-9 — Anti-corruption ports isolate change.** All external interaction goes
  through ports — `VacationRequestRepository`, `AuthzService`, `requireSession` —
  so a change to the store technology, the authz internals, or the auth session
  format is absorbed at the adapter, not in `StatusQueryService`
  ([[tech-stack-decisions]] Read Model & Persistence Access; [[business-logic-model]]
  Data Flow).
- **LC-10 — The task boundary is the bulkhead.** With no dedicated pool, the
  bulkhead is the shared task/instance level (REL-D-9); a status-query fault is
  contained by the instance and the multi-AZ compute posture, not by a per-unit
  resource partition.

## Shared Resource Identification

| Shared resource | Owner | This unit's relationship | NFR reference |
|-----------------|-------|--------------------------|---------------|
| ECS Fargate task + ALB + VPC | Platform (monolith) | **Shares** — runs as in-process code | SCALE-D-1/4; [[scalability-requirements]] |
| `vacation-requests-<env>` table + `(department, status)` index | `unit-request-workflow` | **Consumes** read-only (`Query`/`GetItem`) | SEC-D-8; SCALE-D-6/7; [[reliability-requirements]] REL-SQ-5 |
| Authz grant-table decision (`AuthzService`) | `unit-platform-authz` | **Consumes** in-process; never reads the directory table directly | LC-3; [[security-requirements]] SEC-SQ-1/4 |
| Session validation (`requireSession`) | `unit-platform-auth` | **Consumes** in-process | REL-D-6; [[security-requirements]] SEC-SQ-1 |
| CloudWatch / X-Ray observability plane | Platform | **Shares**; adds its own read metrics/alarms | PERF-D-14/16 |
| Security-header middleware | Platform (auth precedent) | **Reuses** verbatim | SEC-D-12 |
| Secrets / SSM parameters | Platform + per-unit namespaces | **Owns none** — reads through the shared port, no store credential | SEC-D-10; [[tech-stack-decisions]] Secrets |

- **LC-11 — Single-writer guarantee protects the shared store.** The unit's
  read-only grant is what makes the append-only single-writer invariant hold across
  the read/command split: this unit cannot `UpdateItem`/`DeleteItem`, so it cannot
  weaken the tamper-evidence the command side and `audit-trail` rely on
  ([[security-requirements]] SEC-SQ-12; [[business-rules]] `BR-SQ-8/15`; workflow
  shared-infrastructure ownership rule).
- **LC-12 — Deferred read-optimization stays inside the shared boundary.** If a read
  cache or materialized projection is later added ([[performance-requirements]]
  PERF-D-5/6; [[scalability-requirements]] SCALE-D-12), it is provisioned as a new
  shared/owned resource at infrastructure-design **behind the existing port** — this
  logical-components inventory is where that future component would be registered,
  with its own failure domain (Advisory tier, REL-D-16) and blast radius (miss/down →
  fall through to the on-demand projection, correctness unaffected).

## Handoff to Infrastructure Design

This inventory tells infrastructure-design that `unit-status-query` needs:
**no new provisioned resource at MVP** — only a read-only grant
(`Query`/`GetItem`) on the workflow-owned `vacation-requests-<env>` table and its
`(department, status)` index (SCALE-D-7), a mount point on the shared ALB/router,
and its metrics wired into the shared observability plane (PERF-D-14). The only
*conditional* resource is the deferred read cache / materialized projection
(LC-12), to be provisioned only against measured read/write divergence
([[performance-requirements]] PERF-D-16; [[scalability-requirements]] SCALE-D-11).
