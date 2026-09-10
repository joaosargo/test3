# Shared Infrastructure — `unit-status-query`

This unit is one **embedded in-process module** of a modular monolith
(`logical-components` embedded-module boundary; `components` modular-monolith
architecture; `services` five logical services in one deployable). It owns **no
infrastructure of its own** and instead **shares** the platform resources and
**consumes** the dependency-owned resources of the already-shipped units
(`unit-platform-auth`, `unit-platform-authz`, `unit-request-workflow`). This
document draws the **ownership and access boundaries** so that every shared resource
has a single owner and this read unit's blast radius stays the smallest in the
monolith (`logical-components` LC-5; `reliability-design` blast-radius note). It is
produced because this unit shares/consumes resources across four other units — the
conditional trigger for a `shared-infrastructure` artifact.

## Shared vs Owned vs Consumed — inventory

| Resource | Owner | This unit's relationship | Source |
|----------|-------|--------------------------|--------|
| ECS Fargate cluster + task/service + ALB + VPC | Platform (monolith) | **Shares** — runs as in-process code in the same task | `deployment-architecture`; `components` |
| VPC, subnets, security groups, NAT, Gateway VPC endpoint | Platform (`NetworkStack`) | **Shares** | `deployment-architecture` |
| Session / revocation store | `unit-platform-auth` | **Consumes** (in-process `requireSession`) read-only | `security-design` SEC-D-11; `reliability-design` REL-D-6 |
| Role/Department directory table (DynamoDB) | `unit-platform-authz` | **Consumes** via `AuthzService.decide` in-process; never reads the table directly | `security-design` SEC-D-1; `logical-components` LC-3 |
| **`vacation-requests-<env>` table (DynamoDB)** | **`unit-request-workflow`** | **Consumes** read-only (`GetItem`/`Query`) | `infrastructure-services`; `scalability-design` SCALE-D-6 |
| **`(department, status)` GSI** on that table | **`unit-request-workflow`** (table owner) | **Consumes** read-only (`Query`); this unit's queue read drives the requirement for it | `scalability-design` SCALE-D-7; `infrastructure-services` |
| EventBridge choreography bus | Platform (shared bus) | **Neither publishes nor consumes at MVP** (would subscribe only if the deferred cache is built) | `infrastructure-services` messaging; `security-design` SEC-D-16 |
| CloudWatch / X-Ray observability plane | Platform | **Shares**; adds its own read metrics/alarms | `monitoring-design` |
| CI/CD pipeline (CodePipeline/CodeBuild) | Platform | **Shares** the single monolith pipeline | `cicd-pipeline` |
| Security-header middleware | Platform (auth precedent) | **Reuses** verbatim | `security-design` SEC-D-12 |
| Secrets / SSM parameters | Platform + per-unit namespaces | **Owns none** — reads the shared table/GSI name only; no store credential | `security-design` SEC-D-10; `tech-stack-decisions` Secrets |

## Ownership rule: this unit is a pure reader of the request store

The `vacation-requests-<env>` table is **written exclusively by the workflow
command path** (`shared-infrastructure` for `unit-request-workflow`; single-writer
ownership rule). This unit is the **query half** of the read/command split
(`scalability-design` SCALE-D-5; `logical-components` LC-2) and touches that store
only through the shared `VacationRequestRepository` port, read-only:

- Its IAM grant is **`dynamodb:GetItem` + `dynamodb:Query`** on the table and the
  `(department, status)` GSI — **never** `PutItem`/`UpdateItem`/`DeleteItem`/
  `dynamodb:*` (`security-design` SEC-D-5). A CDK aspect asserts the absence of any
  write action on this unit's task-role statement (`cicd-pipeline` CDK assertion).
- This read-only grant is the **structural guarantee** that the read side cannot
  weaken the append-only, tamper-evident history the command side and `audit-trail`
  rely on (`logical-components` LC-11; `security-design` SEC-D-16). Because this unit
  cannot write, it cannot corrupt persisted state, desynchronise history, or affect
  any other unit's routes (`logical-components` LC-5).
- The unit maintains **no read model of its own** at MVP — the synchronous on-demand
  projection reads the same rows the command side wrote (`reliability-design`
  REL-D-11; `tech-stack-decisions` Read Model), so read and command are structurally
  incapable of disagreeing.

## The `(department, status)` GSI — shared-resource ownership

The one infrastructure element this unit's requirements **drive** but does **not
own** is the `(department, status)` secondary index (`scalability-design`
SCALE-D-7):

- **Owned by `unit-request-workflow`** because it lives on that unit's table; a
  consumer cannot create an index on a table it does not own. This unit registers the
  *need* (the `listScopedRequests` queue read) and consumes the index read-only.
- **Provisioned in the workflow unit's `DataStack`** (`deployment-architecture` IaC
  approach), not a parallel stack. Whether to build it at MVP or defer is confirmed
  jointly with the workflow unit against the concrete `req-nfr-concurrency` figure —
  the recommendation in `infrastructure-services` is to build it because it removes
  the only scan risk on the read surface at negligible DynamoDB cost.
- **Cost of the GSI** (extra read/write capacity + storage on the workflow table) is
  attributed to the request-store line item the workflow unit owns, tagged
  `Service=request-workflow`, even though this unit's queue read is what justifies it
  — a shared-cost note surfaced for FinOps attribution.

## Consumed in-process dependencies (no infrastructure added)

- **Session validation** (`unit-platform-auth`) and the **authz decision**
  (`unit-platform-authz`) are in-process library calls, not network services
  (`business-logic-model` Data Flow; `logical-components` LC-3), so this unit adds no
  infrastructure for them. Both are **Critical** dependencies that fail **closed** —
  no session → 401 (`reliability-design` REL-D-6), cannot authorize → deny
  (`reliability-design` REL-D-5; `security-design` SEC-D-2). Their stores (auth
  session/revocation, authz directory) are owned and sized by those units; this unit
  only relies on their availability, which — because they are in-process — is the
  same as the process's own availability (`reliability-design` REL-D-2).
- **No cross-unit table access.** This unit never reads the authz directory table
  directly (it goes through `AuthzService.decide`) and never reaches past the
  workflow repository port into workflow internals (`tech-stack-decisions`
  integration; `logical-components` LC-9) — the ports are the anti-corruption
  membrane.

## Blast-radius & failure-domain boundaries

- A failure **in this unit** affects only in-flight **reads** on the faulting
  instance; because it performs no writes it **cannot corrupt persisted state**,
  cannot desynchronise history, and cannot affect the command path, the audit trail,
  notifications, or any other unit's routes (`logical-components` LC-5;
  `reliability-design` blast-radius note). Stateless instances mean clients retry on
  another task via the shared ALB (`reliability-design` REL-D-17).
- A failure **of a consumed resource** degrades this unit predictably and
  fail-closed, never leaking: request-store read fault → retryable `err`, no
  stale/fabricated view (`reliability-design` REL-D-3/4); authz cannot decide → deny
  (REL-D-5); no session → 401 (REL-D-6). The blast radius under any dependency
  failure is *availability* (reads deny or 401), never *confidentiality*
  (`logical-components` LC-7).
- **Read pressure cannot starve the command path.** This unit holds no connection
  pool of its own (`performance-design` PERF-D-7) and takes no lock
  (`performance-design` PERF-D-10), so heavy read load consumes shared store **read**
  IOPS and shared CPU — absorbed by the autoscaler (`scalability-design` SCALE-D-9)
  and the store-capacity signal (SCALE-D-11) — but never blocks a write
  (`logical-components` LC-6).

## Cost-allocation ownership

This unit adds **no standalone billable resource**, so it carries **no line item of
its own** — its cost is folded into the shared monolith bill. It still propagates the
mandatory cost-allocation tags on the resources it touches
(`Project`, `Environment`, `Team`, `Service=status-query`, `CostCenter`) via the CDK
tagging aspect (`deployment-architecture`) so that its read-metric and log volume are
attributable within the shared plane. The only cost this unit *drives* onto another
owner's line item is the optional `(department, status)` GSI capacity on the
workflow-owned table (above) and its CloudWatch read-metric/log volume on the shared
observability plane — both explicitly surfaced here for FinOps traceability.
