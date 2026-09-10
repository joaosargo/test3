# Security Design — `unit-overlap-indicator`

Concrete security design for the **Overlap Indicator**. It realises the controls
in [[security-requirements]] (`security-requirements-unit-overlap-indicator`)
within the fail-open, read-only behaviour of [[business-logic-model]] and the
stack fixed by [[tech-stack-decisions]] (ADR-OVL-01..06). Performance, scaling,
and reliability designs for this unit sit alongside; where they interact
(e.g. cache contents, degradation) the PII and authorization rules here are
authoritative.

Security posture in one line, from [[security-requirements]]: this unit
**introduces no new trust boundary**. It authenticates via the shared session
(consuming `unit-platform-auth`), authorizes via the shared PDP (consuming
`unit-platform-authz`), emits **aggregate-only** output, and fails **open** with
a low blast radius because it can neither write nor gate anything.

## Authentication & Authorization Architecture

- **Authentication is inherited, never re-implemented.** The overlap read runs
  only behind the same `requireSession(...)` pipeline that guards the lead review
  screen; there is no in-house credential path on any branch, consistent with the
  SSO-mandatory constraint the platform enforces. An unauthenticated caller is
  stopped with `401` before any overlap logic executes.
- **Authorization is consumed, not re-derived** (`BR-SCOPE-1`,
  [[security-requirements]]). The read is guarded by
  `requirePermission(authz, 'request:validate')` — the exact permission that
  authorizes the lead's review action. This unit makes **no independent
  role/scope decision**; a non-lead who reaches the endpoint is denied `403` at
  the shared guard before any read (server-authoritative).
- **Scope follows the reviewed request** (`BR-SCOPE-2`). The comparison
  department is taken from the reviewed request the lead is already authorized to
  act on; the unit never widens scope to another department. There is no
  parameter by which a caller can request overlap for a department the PDP did
  not authorize — the department is derived from the request, not from client
  input.
- **Defence in depth.** The guard order is `session → permission → department-
  scoped read`; each layer fails closed on the auth axis even though the unit's
  own compute failures fail open. Authentication/authorization failure and
  advisory-read failure are deliberately different failure modes.

## Data Protection & PII

The controlling rules are `BR-PII-1..3` from the functional design and the PII
constraints in [[security-requirements]] (`req-nfr-security-pii`).

- **Aggregate + pseudonymous output only.** `OverlapSummary` carries
  `overlapCount`, `hasOverlap`, opaque `overlappingIds` (`RequestId`s), and the
  reviewed `window` — **never** subject names, emails, or free-text reasons
  (`BR-PII-1`). The badge reveals *that* and *how much* overlap exists, not
  *whose* leave (`BR-PII-2`).
- **No new PII at rest.** The unit owns no datastore (ADR-OVL-04); the only
  transient PII-adjacent data is the in-process cache of candidate requests,
  which holds ids/dates/status for computation and is short-TTL, per-instance,
  and never persisted. Cache entries must carry no subject names or free-text.
- **Encryption in transit.** All traffic (browser ⇄ app tier ⇄ workflow seam)
  rides the platform's TLS-everywhere posture; the unit adds no plaintext
  channel of its own.
- **PII-free errors** (`BR-PII-3`). `OverlapError` carries a machine-readable
  `code` (`NOT_FOUND` | `READ_FAILED`) only, mirroring the shipped
  `WorkflowError` / `AuthzError` / `SsoError` taxonomy — no request details,
  ids, or subject data in messages.
- **Log hygiene.** Logs may record the `code`, the department scope key, and
  timing; they must **not** log `overlappingIds`, subject identifiers, or full
  candidate payloads. Aggregate counts are acceptable for observability.

## Input Validation & Web Security Controls

- **Minimal, typed input surface.** The only input is a `RequestId` (or an
  explicit `OverlapQuery` of `department` + `DateRange` + optional
  `selfRequestId`). Validate that `requestId` is a well-formed id and reject
  malformed input with a typed error before any read — no string is interpolated
  into a query (the workflow seam takes typed value objects, not raw SQL).
- **No injection surface of its own.** The unit issues no ad-hoc queries; it
  calls typed repository read methods (`findById`,
  `findByDepartmentAndStatus`), so there is no SQL/NoSQL injection vector to
  defend beyond what the workflow unit already owns.
- **CSRF/XSS handled at the shared HTTP edge.** The read is a safe idempotent
  operation reached through the same guarded router as the review screen; it
  relies on the platform's existing security-header and session-cookie
  hardening. The `OverlapSummary` is data-only (counts + ids), so the client
  renders it as a badge with standard output encoding — no HTML is produced by
  this unit.
- **Self-exclusion is enforced server-side** (`BR-OV-4`): the reviewed request
  is excluded from its own count in the service, not trusted from the client.

## Threat Model & Blast Radius

| Threat (STRIDE) | Exposure | Control |
|-----------------|----------|---------|
| Spoofing | Impersonate a lead to read overlap | Blocked by inherited SSO session (`401`) — no local auth path. |
| Tampering | Alter workflow state via this unit | Structurally impossible — read-only, no write verb, INV-OV-2. |
| Repudiation | Deny an action | N/A — the unit emits no domain events/audit facts (`BR-ADV-4`); nothing to repudiate. |
| Information disclosure | Learn *whose* leave overlaps | Aggregate + pseudonymous ids only (`BR-PII-1/2`); scope pinned to the authorized department (`BR-SCOPE-2`). |
| Denial of service | Overload via repeated reads | Short-TTL cache + single-flight coalescing + 300 ms fail-open timeout cap resource use (see [[performance-requirements]] budgets and the load-shedding model in [[scalability-requirements]]); failure is advisory. |
| Elevation of privilege | Non-lead reads overlap | Denied `403` at the shared `request:validate` guard (`BR-SCOPE-1`); no independent scope decision. |

**Blast radius: low.** Because the unit cannot write, cannot gate, and emits
nothing, the worst-case security failure is disclosure of *aggregate* overlap
counts within a department the viewer is already authorized to act on — and even
that is bounded by the pseudonymous, aggregate-only output contract. A total
compromise of this unit cannot corrupt workflow state, forge audit facts, or
block a decision (fail-open per [[reliability-requirements]], INV-OV-1/2).
