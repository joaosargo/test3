# Vacation Request App — Business Rules — `unit-audit-trail`

Decision rules, validation logic, invariants, and policies for the **Immutable
Audit Trail** unit. Each rule is grounded in the requirements
(`req-immutable-audit-trail`, `req-constraint-append-only-store`,
`req-nfr-audit-retention`, `req-nfr-security-pii` in [[requirements]]), the
single owned story `story-immutable-audit` in [[unit-of-work-story-map]], the
`audit-trail` component boundary in [[components]] (`audit-trail →
vacation-request-workflow`), the `audit-trail` method signatures in
[[component-methods]], the choreography side-effect posture in [[services]], and
the unit definition in [[unit-of-work]]. Rules complement the flows in
`business-logic-model` and the shapes in `domain-entities`.

Rule id convention: `BR-AUD-n`. Rules are the single source of truth for the
guards referenced by id from the other artifacts.

## Validation Rules

### BR-AUD-1 — Event shape validation (fail closed)
An inbound event is accepted only if `type` is one of the five known
`WorkflowEventType` members (`RequestSubmitted`, `RequestValidated`,
`RequestApproved`, `RequestRejected`, `RequestWithdrawn`) **and** every required
field (`requestId`, `ownerId`, `department`, `actorId`, `status`, `atMs`) is
present and well-formed. `atMs` must be a finite non-negative epoch-ms number.
Any failure returns `AuditError.malformedEvent(field)` and the record is NOT
written — an unrecordable event never silently vanishes and never corrupts the
chain.

### BR-AUD-1a — Status/type consistency
`resultingState` recorded MUST equal the event's `status`, and `status` MUST be
the terminal-or-intermediate value the event type declares (`RequestApproved →
Approved`, `RequestRejected → Rejected`, etc., per the shipped
`src/workflow/domain/events.ts` discriminated union). A mismatch is a malformed
event (BR-AUD-1).

### BR-AUD-1b — `rejectedStage` presence
`rejectedStage` is present **iff** `eventType == RequestRejected` (mirrors the
workflow `RequestRejected` event carrying `rejectedStage`). Present on any other
type, or absent on a rejection, is malformed.

## Idempotency & Ordering Rules

### BR-AUD-2 — Idempotent ingestion
The dedup key is `(eventType, requestId, occurredAtMs)`. If a record with this
key already exists, `recordEvent` returns the existing record unchanged and
appends nothing. This makes at-least-once choreography delivery safe (duplicate
delivery ⇒ exactly one stored record).

### BR-AUD-3 — Append order is monotonic and never reordered
Records are appended in ingest order and never re-sequenced. `recordedAtMs` is
monotonic non-decreasing within a partition. Business ordering for display uses
`occurredAtMs` (the transition's own time); storage/chain ordering uses append
order. The two are kept distinct so out-of-order delivery cannot rewrite history.

### BR-AUD-4 — Per-request chain partition
The hash chain is partitioned by `requestId`: each request has its own ordered
sub-chain. The first record in a partition links to the `GENESIS` sentinel hash.
This bounds `verifyChain` to a single request's records and avoids a global
serialization bottleneck.

## Immutability & Integrity Invariants

### BR-AUD-5 — Append-only, no mutation (`req-constraint-append-only-store`)
The `AuditStore` port exposes `append` and read operations **only**. There is no
`update` and no `delete` operation anywhere in the unit's public or port surface.
Immutability is enforced at the type/contract level, not by convention — code
that attempts to mutate a record cannot compile against the port.

### BR-AUD-5a — Records are frozen value objects
An `AuditRecord`, once constructed, is immutable (`readonly` fields; deep-frozen
in dev). No field is ever edited after `append`. This is the record-level
counterpart to the store-level BR-AUD-5.

### BR-AUD-6 — Tamper-evident hash chain (`req-immutable-audit-trail`)
Every record stores `prevHash` (the hash of the previous record in its partition,
or `GENESIS` for the first) and its own `hash = sha256(canonicalSerialize(fields
excluding hash))`. `verifyChain(requestId)` recomputes each hash and checks each
link; any mismatch or broken link yields
`AuditError.integrityViolation(auditId, kind)`. This makes any post-hoc edit or
deletion detectable.

### BR-AUD-6a — Canonical serialization
The bytes hashed are produced by a single deterministic canonical serializer
(stable key order, fixed number formatting) so the same record always yields the
same hash across runtimes. The serializer is pure and version-tagged; a future
format change bumps the tag rather than silently invalidating old chains.

## Retention & Purge Policy

### BR-AUD-7 — Seven-year retention (`req-nfr-audit-retention`)
Every record carries `retainUntilMs = recordedAtMs + SEVEN_YEARS_MS`. A record
MUST NOT be purged before `retainUntilMs`. Functional design asserts this
invariant; the durable storage class that enforces it (WORM / object-lock /
retention policy) is an infrastructure-design decision (open question in
`memory.md`).

### BR-AUD-7a — No early deletion path
Because the store has no `delete` (BR-AUD-5), there is no code path that can
remove a record before retention expiry. Any future retention-expiry purge is a
separate, out-of-band lifecycle job operating on `retainUntilMs`, never a runtime
capability of this unit.

## Security & PII Rules

### BR-AUD-8 — PII minimisation (`req-nfr-security-pii`)
The unit records only the pseudonymous ids and non-PII fields the `WorkflowEvent`
already carries (`requestId`, `ownerId`, `actorId`, `department`, `status`,
`atMs`). It never stores subject email, employee name, or free-text reason
material — the inbound event does not carry them, and the audit mapper does not
enrich. Log lines emitted by this unit are likewise id-only.

### BR-AUD-9 — Reads are non-mutating and side-effect-free
`getRequestTrail`, `queryTrail`, and `verifyChain` never write. Running a query
or an integrity check leaves the trail byte-identical, so audit reads can be run
freely (including on a schedule) without altering the evidence they inspect.

## Rule → Requirement / Story Traceability

| Rule(s) | Requirement | Story |
|---|---|---|
| BR-AUD-5, BR-AUD-5a, BR-AUD-7a | `req-constraint-append-only-store` | `story-immutable-audit` |
| BR-AUD-6, BR-AUD-6a, BR-AUD-9 | `req-immutable-audit-trail` | `story-immutable-audit` |
| BR-AUD-7, BR-AUD-7a | `req-nfr-audit-retention` | `story-immutable-audit` |
| BR-AUD-8 | `req-nfr-security-pii` | `story-immutable-audit` |
| BR-AUD-1..4 | `req-immutable-audit-trail` (completeness of the fact stream) | `story-immutable-audit` |

Every rule traces to `story-immutable-audit` and the requirements the
[[unit-of-work-story-map]] assigns to `unit-audit-trail`; no orphan rules.
