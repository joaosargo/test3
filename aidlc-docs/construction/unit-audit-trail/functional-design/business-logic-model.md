# Vacation Request App — Business Logic Model — `unit-audit-trail`

Functional design for the **Immutable Audit Trail** unit — the compliance
system-of-record for every state change in the vacation-request workflow. This
unit is a **pure event sink and query surface**: it owns no command that mutates
business state. It subscribes to the workflow's past-tense domain events and
appends one immutable `AuditRecord` per accepted transition, then serves those
records read-only to the compliance auditor.

Scope is bound to the single story the [[unit-of-work-story-map]] assigns to
`unit-audit-trail`:

- `story-immutable-audit` — Immutable append-only audit trail (covers
  `req-immutable-audit-trail`, `req-constraint-append-only-store`,
  `req-nfr-audit-retention`), persona `compliance-auditor` (Aisha).

Per the [[unit-of-work]] decomposition, `unit-audit-trail` **depends on
`unit-request-workflow`** (the event source) and is otherwise standalone. The
[[components]] architecture places `audit-trail` with the dependency
`audit-trail → vacation-request-workflow`, and the [[services]] artifact routes
audit as a **choreography side-effect consumer** — it reacts to events the
command path emits and never sits on the synchronous command path itself. The
public method shapes are fixed by the `audit-trail` section of
[[component-methods]] and are the contract this model elaborates. The full
requirement text lives in [[requirements]] (`req-immutable-audit-trail`,
`req-constraint-append-only-store`, `req-nfr-audit-retention`,
`req-nfr-security-pii`).

## Design Approach

The audit trail is modelled as an **append-only event log** (event-sink
pattern, aligned with the event-driven audit-trail guidance): the
`unit-request-workflow` unit emits a `WorkflowEvent` per accepted transition on
the `EventPublisher` port (see the shipped `src/workflow/ports/event-publisher.ts`
and `src/workflow/domain/events.ts`), and this unit **subscribes** to that port
and transforms each event into exactly one immutable `AuditRecord`. The unit
never calls the workflow unit back and never mutates a request — it only
observes and records, preserving the least-coupling choreography boundary the
[[services]] artifact prescribes.

Three properties are non-negotiable and drive the whole design:

1. **Append-only (`req-constraint-append-only-store`).** The persistence port
   exposes `append` and reads only — there is no `update` and no `delete`
   method. Immutability is a *contract-level* guarantee (the port cannot express
   mutation), not merely an operational policy.
2. **Tamper-evidence (`req-immutable-audit-trail`).** Each record carries the
   hash of the previous record in its partition, forming a hash chain. Any
   after-the-fact edit or deletion breaks the chain and is detectable by a pure
   `verifyChain` walk. This upgrades "we promise not to change it" to "you can
   prove it was not changed."
3. **Retention (`req-nfr-audit-retention`).** Records are retained for **seven
   years** and MUST NOT be purged before their retention expiry. Functional
   design asserts the invariant; the durable WORM/retention storage class is
   decided downstream at infrastructure-design.

Error handling follows the shipped `Result<T, E>` convention
(`src/domain/result.ts`): expected failures (malformed event, integrity
verification failure) are returned as `Result.err` values with a machine-readable
PII-free code — never thrown. Throwing is reserved for infrastructure/programmer
error, mirroring the auth, authz, and workflow units already shipped.

PII posture (`req-nfr-security-pii`): the incoming `WorkflowEvent` already
carries only pseudonymous ids (`requestId`, `ownerId`, `actorId`), `department`,
`status`, and `atMs` — no email, no free-text reason. The audit unit records
**exactly those fields** and never enriches with subject PII, so the trail is
compliance-safe by construction.

## Ingestion Workflow — record a transition (`recordEvent`)

Input: a `WorkflowEvent` delivered by the `EventPublisher` subscription. Output:
`Result<AuditRecord, AuditError>`. Ingestion is **idempotent** — choreography
buses may deliver an event more than once (per the event-driven guidance), so a
duplicate is a no-op returning the already-stored record, not a second row.

```
recordEvent(event):
  1. validate event shape (see business-rules BR-AUD-1):
        - type is one of the five known WorkflowEventType members
        - requestId, ownerId, department, actorId, status, atMs all present/well-formed
        invalid → err(AuditError.malformedEvent(field))        [fail closed]
  2. compute dedup key = (event.type, event.requestId, event.atMs)   (BR-AUD-2)
        if a record with this key already exists → return ok(existingRecord)  [idempotent]
  3. read the current chain head (last appended record's hash) for the partition
        (partition = requestId, so each request has its own ordered sub-chain — BR-AUD-4)
  4. build AuditRecord:
        auditId       = new AuditId
        eventType     = event.type
        requestId     = event.requestId
        ownerId       = event.ownerId            (pseudonymous)
        department    = event.department
        actorId       = event.actorId            (pseudonymous)
        resultingState= event.status
        rejectedStage = event.rejectedStage      (present only for RequestRejected)
        occurredAtMs  = event.atMs               (business time — when the transition happened)
        recordedAtMs  = now()                    (ingest time — when audit stored it)
        prevHash      = chainHead ?? GENESIS
        hash          = sha256(canonicalSerialize(all fields above except hash))
        retainUntilMs = recordedAtMs + SEVEN_YEARS_MS                (BR-AUD-6)
  5. append via AuditStore.append (append-only; never overwrites)
        infra failure → reject the promise (caller treats as infra error)
  6. return ok(record)
```

The event → record mapping is total: every one of the five `WorkflowEvent`
types (`RequestSubmitted`, `RequestValidated`, `RequestApproved`,
`RequestRejected`, `RequestWithdrawn`) produces one record, so no transition is
ever silently unaudited — the workflow unit's `BR-INV-5` (event-per-transition)
is completed on the sink side here.

## Query Workflow — read the trail (`getRequestTrail` / `queryTrail`)

The compliance auditor persona reads the trail; the unit exposes read-only
queries matching the `audit-trail` section of [[component-methods]]:

```
getRequestTrail(requestId):
  1. AuditStore.findByRequest(requestId) → ordered AuditRecord[] (by occurredAtMs, then chain order)
  2. return ok(records)                    (empty list is a valid answer, not an error)

queryTrail(filter):     // filter: optional department, date range, eventType, actorId
  1. AuditStore.query(filter) → AuditRecord[] (append-order preserved)
  2. return ok(records)
```

Reads are non-mutating and return fully-formed `AuditRecord`s (repository rule).
Whether the auditor sees all departments or is department-scoped is an open
question in `memory.md` (assumed org-wide for the compliance mandate).

## Integrity Verification Workflow (`verifyChain`)

A pure, side-effect-free walk that proves the trail has not been tampered with —
the operational teeth behind `req-immutable-audit-trail`.

```
verifyChain(requestId):
  1. records = AuditStore.findByRequest(requestId)   (chain order)
  2. expectedPrev = GENESIS
  3. for each record in order:
        - recompute hash from its fields; if != record.hash        → err(integrityViolation(auditId, 'hash-mismatch'))
        - if record.prevHash != expectedPrev                        → err(integrityViolation(auditId, 'broken-link'))
        - expectedPrev = record.hash
  4. return ok(void)     // chain intact
```

`verifyChain` reads nothing outside the store and never writes — it is safe to
run on demand (auditor request) or on a schedule.

## Data Flow & Integration Points

- **Inbound (choreography, from `unit-request-workflow`)**: the composition root
  subscribes this unit's `recordEvent` handler to the shipped `EventPublisher`
  port. The unit consumes the `WorkflowEvent` union verbatim from
  `src/workflow/domain/events.ts`; it does **not** redefine those events (anti-
  corruption via a thin inbound mapper only, to keep the audit record shape
  independent of any future event-shape drift).
- **Persistence (append-only)**: behind an `AuditStore` port with `append` +
  read methods only — no update/delete. The in-memory adapter is the dev/test
  implementation; production swaps a durable append-only / WORM store
  (infrastructure-design owns the choice), same hexagonal seam as `SessionStore`,
  `RoleDirectoryPort`, `BalanceCache`, and `VacationRequestRepository`.
- **Outbound**: none. The audit trail is a terminal sink and read surface; it
  emits no domain events and calls no other unit — the lowest-coupling position
  in the [[services]] topology.
- **To the auditor UI**: the read-only query surface (see `frontend-components`)
  calls `getRequestTrail` / `queryTrail` / `verifyChain` only.

This model elaborates only what `unit-audit-trail` owns; identity, RBAC, and the
`VacationRequest` aggregate remain owned upstream and are referenced by id, never
duplicated (least-coupling boundary preserved).
