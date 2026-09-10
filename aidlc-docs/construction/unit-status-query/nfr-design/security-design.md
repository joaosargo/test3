# Security Design — `unit-status-query`

Concrete security solution design for the **Status Tracking & Query** unit — the
read side of the vacation-request modular monolith. It turns the requirements in
[[security-requirements]] into implementable decisions: the authentication and
authorization pipeline, the fail-closed ordering of a guarded read, encryption
posture, input validation, security headers, PII-gating at projection and log
boundaries, and the compliance controls this read surface carries. It builds on
the guarded-read flows in [[business-logic-model]], the fail-closed / PII rules
in [[business-rules]], the stack and cross-unit contracts in
[[tech-stack-decisions]], and stays coherent with the fail-closed dependency
behaviour in [[reliability-requirements]] and the scoped-read model in
[[scalability-requirements]]; the latency cost of each guard is budgeted in
[[performance-requirements]].

The design's defining constraint, from [[security-requirements]]: this unit
**establishes no identity and owns no authorization policy**. Its entire security
posture is (1) consume the upstream auth/authz guarantees **fail-closed on every
read**, (2) **never leak data or existence** across role/scope boundaries, and
(3) **PII-gate everything it projects and logs**. It is defense-in-depth over
someone else's boundary, never a re-implementation of it.

## Authentication & Authorization Architecture

The guarded-read pipeline is the same `requireSession → requirePermission →
handler` composition the `unit-request-workflow` router uses
([[business-logic-model]] Data Flow; [[tech-stack-decisions]] Integration
contracts), all in-process — no network hop for auth or authz.

```
HTTP request
  → requireSession(...)                         [unit-platform-auth]  no/invalid session → 401
    → requirePermission(authz, '<view-perm>')   [unit-platform-authz] deny → err(forbidden)
      → StatusQueryService.<query>
          → AuthzService.decide(principal, view-perm, { department? })   [authoritative]
          → scope filter using grant.departmentScope (defence-in-depth, BR-SQ-5)
          → PII-gated projection
```

- **SEC-D-1 — No in-house auth, no re-derived roles/scope.** The unit consumes
  the shipped `AuthenticatedPrincipal` and `AuthzService.decide` surface verbatim
  and re-implements neither authentication nor RBAC
  ([[security-requirements]] SEC-SQ-1; [[business-rules]] `BR-SQ-1/3`;
  [[tech-stack-decisions]] "consume … read-only; never re-derive roles or
  scope").
- **SEC-D-2 — Authorize before any data touch.** No projection is computed and no
  repository row is returned before `AuthzService.decide` returns a permit; a deny
  short-circuits with `err(forbidden)` and reads no data
  ([[security-requirements]] SEC-SQ-2; [[business-rules]] `BR-SQ-1`). There is no
  permissive default and no public read on any branch.
- **SEC-D-3 — Least-privilege view permission by query intent.** The permission
  handed to the PDP is the narrowest that could authorize the read —
  `request:view-own` (employee own-list), `request:view-team` (team-lead queue),
  `request:view-department` (HR department view) — drawn only from the shipped
  closed permission set; the unit invents none
  ([[security-requirements]] SEC-SQ-3; [[business-rules]] `BR-SQ-2`).
- **SEC-D-4 — Scope decided by the PDP, re-asserted here as defence-in-depth.** HR
  per-department ABAC and lead own-team scoping are decided entirely by
  `AuthzService.decide` from the `{ department }` resource descriptor; the unit
  applies only a narrow row filter from the returned `grant.departmentScope` that
  may **narrow or confirm, never widen** ([[security-requirements]] SEC-SQ-4;
  [[business-rules]] `BR-SQ-5`).
- **SEC-D-5 — Read-only, no mutation/escalation surface.** The unit exposes no
  command and cannot transition, edit, or re-open a request
  ([[security-requirements]] SEC-SQ-5; [[business-rules]] `BR-SQ-15`), so there is
  no override or privilege-escalation surface on the read side.

## Non-Leaking Existence & Scope Semantics

- **SEC-D-6 — Non-leaking existence.** A `getRequestTimeline` for an id the caller
  may not see never confirms the id exists: the combined `notFound`/`forbidden`
  posture is identical to the command side's "unknown request id" edge case, so
  read and command leak nothing differently ([[security-requirements]] SEC-SQ-6;
  [[business-logic-model]] Query C "order matters and is fail-closed";
  [[business-rules]] `BR-SQ-4`).
- **SEC-D-7 — Omit out-of-scope rows, never per-row deny.** A scoped list simply
  does not contain rows outside the caller's scope; there is no per-row
  `forbidden` that would reveal a row's existence. Only a whole-query
  authorization failure yields `err(forbidden)`
  ([[security-requirements]] SEC-SQ-7; [[business-rules]] `BR-SQ-7`).

## Input Validation Strategy

All query input is validated **before** any store read and returned as typed
`Result.err(invalidInput, <field>)` values, never thrown
([[business-rules]] `BR-SQ-12/13/14`; [[tech-stack-decisions]] `Result<T,E>`):

- **SEC-D-8 — Closed-set status filter.** An optional `status` filter must be a
  member of the closed `RequestStatus` set (`Submitted`, `Validated`, `Approved`,
  `Rejected`, `Withdrawn`); any other value → `err(invalidInput, "status")`
  ([[business-rules]] `BR-SQ-12`). This is an allow-list, not a sanitiser.
- **SEC-D-9 — Required scope key for queues.** `listScopedRequests` requires a
  non-empty `department` → else `err(invalidInput, "department")`
  ([[business-rules]] `BR-SQ-13`). `getRequestTimeline` requires a non-empty
  `requestId` → else `err(invalidInput, "requestId")` ([[business-rules]]
  `BR-SQ-14`). Validated values are passed as parameters to the port, never
  interpolated into a query string, so there is no query-injection surface.

## Encryption & Transport

- **SEC-D-10 — TLS in transit, encryption at rest (inherited).** All HTTP is
  TLS-terminated at the shared ALB in front of the modular monolith; the durable
  append-only store's at-rest encryption is owned by `unit-request-workflow` and
  infrastructure-design ([[security-requirements]] SEC-SQ-11). This unit adds no
  new persistence, so it introduces **no new at-rest surface** and needs no
  secrets of its own — it reads through the shared port, not a store credential
  ([[tech-stack-decisions]] Secrets).
- **SEC-D-11 — Session cookie hardening is upstream.** Session integrity, cookie
  flags, replay/CSRF protection are owned by `unit-platform-auth` and consumed via
  `requireSession`; forged/replayed sessions are out of this unit's scope
  ([[security-requirements]] SEC-SQ threat table "Replay / forged session").

## Security Headers

- **SEC-D-12 — Reuse the shared security-header middleware.** Read routes mount
  the monolith's existing security-header middleware (the `src/http/security-headers`
  precedent shipped with `unit-platform-auth`): `Strict-Transport-Security`,
  `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, a restrictive
  `Content-Security-Policy`, and `Cache-Control: no-store` on JSON read responses
  so PII-bearing projections are not cached by intermediaries or the browser
  ([[security-requirements]] SEC-SQ-9/11). The unit adds no bespoke header stack;
  consistency with the shipped surface is the rule ([[tech-stack-decisions]]
  "adopt the shipped stack").

## PII Gating & Data Protection

- **SEC-D-13 — Role-gated free-text `reason` at projection time.** A
  `Transition`'s free-text `reason` (possible incidental PII) is included in a
  `TimelineEntry` only when the caller is entitled to it, and is **omitted** (not
  a placeholder that leaks its existence) otherwise; machine-readable status/stage
  codes are always PII-free and always returned
  ([[security-requirements]] SEC-SQ-8; [[business-rules]] `BR-SQ-6`).
- **SEC-D-14 — PII-lean projections by construction.** `RequestSummaryView` and
  `RequestTimelineView` carry opaque ids, department codes, dates, and the
  role-gated `reason` only — never names, emails, or other free text
  ([[security-requirements]] SEC-SQ-9; [[business-rules]] `BR-SQ-9`).
- **SEC-D-15 — Redact PII at every log boundary.** Principal ids, department
  codes, and free-text reasons are redacted at every log boundary, and all
  `StatusQueryError` messages are static PII-free constants
  ([[security-requirements]] SEC-SQ-10; [[business-rules]] `BR-SQ-16`), mirroring
  the upstream `BR-PII-*` posture.

The helper below centralises the two PII decisions (SEC-D-13 role gate,
SEC-D-15 log redaction) as pure typed functions consistent with
[[business-logic-model]] shapes:

```typescript
type RequestStatus =
  | 'Submitted'
  | 'Validated'
  | 'Approved'
  | 'Rejected'
  | 'Withdrawn';

interface LoggableReadContext {
  operation: string;
  principalId: string;
  department?: string;
  reason?: string;
}

// SEC-D-15: redact every PII-bearing field before it reaches a log sink.
function redactForLog(ctx: LoggableReadContext): Record<string, string> {
  return {
    operation: ctx.operation,
    principalId: '[REDACTED]',
    department: ctx.department !== undefined ? '[REDACTED]' : '[none]',
    reason: ctx.reason !== undefined ? '[REDACTED]' : '[none]',
  };
}

// SEC-D-8: closed-set allow-list; unknown values never reach the store.
function isKnownStatus(value: string): value is RequestStatus {
  const allowed: readonly RequestStatus[] = [
    'Submitted',
    'Validated',
    'Approved',
    'Rejected',
    'Withdrawn',
  ];
  return (allowed as readonly string[]).includes(value);
}
```

## Compliance Controls

- **SEC-D-16 — Reads are not audited facts; integrity is preserved.** No query
  writes, appends a transition, or emits an event
  ([[security-requirements]] SEC-SQ-12; [[business-rules]] `BR-SQ-15`), so the read
  side cannot corrupt the append-only history the immutable `audit-trail` depends
  on. A status view is not an audited event — `audit-trail` records transitions,
  not views.
- **SEC-D-17 — Derived status cannot silently drift.** The current `status` in any
  projection is the `to` of the latest `Transition` read through the port, never
  an independently stored column ([[security-requirements]] SEC-SQ-13;
  [[business-rules]] `BR-SQ-8`), so a view can never disagree with the command
  side's truth and there is no divergent column to tamper with.
- **SEC-D-18 — GDPR-aligned data minimisation.** The PII-lean projection
  (SEC-D-14), role-gated reason (SEC-D-13), and log redaction (SEC-D-15) together
  satisfy the `req-nfr-security-pii` data-minimisation posture for a read surface
  that carries employee PII; the 7-year retention obligation lives with
  `audit-trail` and the durable store, not this stateless reader.

## Threat Model & Mitigations

| Threat | Mitigation | Trace |
|--------|-----------|-------|
| Cross-employee read | `view-own` grants self scope only; row filter re-asserts owner identity | SEC-D-3/4; [[security-requirements]] SEC-SQ-3 |
| Cross-department read (HR) | PDP per-department ABAC denies before any row is projected | SEC-D-2/4; [[security-requirements]] SEC-SQ-2/4 |
| Existence-probing an unknown/out-of-scope id | Non-leaking `notFound`/`forbidden`; no existence confirmation | SEC-D-6; [[security-requirements]] SEC-SQ-6 |
| Reason-text harvesting | Role-gated omission — unentitled caller cannot tell a reason exists | SEC-D-13; [[security-requirements]] SEC-SQ-8 |
| Query injection via filter/params | Closed-set allow-list + parameterised port calls; no string interpolation | SEC-D-8/9 |
| PII leak via logs | Redact at every log boundary; static PII-free error constants | SEC-D-15; [[security-requirements]] SEC-SQ-10 |
| Authz PDP unavailable | Fail-closed: read **denies** (`err(forbidden)`), never falls open | SEC-D-2; [[reliability-requirements]] REL-SQ-3 |
| Replay / forged session | Out of scope — owned by `unit-platform-auth`, consumed via `requireSession` | SEC-D-11; [[security-requirements]] SEC-SQ threat table |
