# Vacation Request App — Domain Entities — `unit-audit-trail`

Entities, value objects, ports, and relationships for the **Immutable Audit
Trail** unit. Grounded in the `audit-trail` signatures of [[component-methods]],
the component boundary in [[components]] (`audit-trail →
vacation-request-workflow`), and the `unit-audit-trail` definition in
[[unit-of-work]]. The single owned story in [[unit-of-work-story-map]]
(`story-immutable-audit`) and its requirements (`req-immutable-audit-trail`,
`req-constraint-append-only-store`, `req-nfr-audit-retention`, plus
`req-nfr-security-pii` from [[requirements]]) drive the attributes below. The
unit is a choreography side-effect consumer per [[services]] — an event sink, not
a command aggregate.

Design note: identity, RBAC, and the `VacationRequest` aggregate are **not
redefined** here. This unit consumes the `WorkflowEvent` union and the
`PrincipalId` value object already shipped by `unit-request-workflow`
(`src/workflow/domain/events.ts`) and `unit-platform-auth`
(`src/domain/entities.ts`) read-only, and adds only the `AuditRecord` entity and
its supporting value objects — which no upstream unit modelled. This keeps the
customer–supplier boundary clean (audit is the downstream conformist consumer of
the workflow's published event language) and avoids duplicating request or
identity concepts.

## Value Objects

All value objects are immutable; equality is by attribute value (DDD value-object
semantics), consistent with the shipped `LeaveBalance` / `Session` / `Transition`
style.

### `AuditId`
- Opaque, unique identifier of a single audit record (e.g. UUID string).
- Prefer over a bare `string` primitive (value-object-over-primitive heuristic,
  as with `RequestId` / `PrincipalId` / `SessionId` upstream).

### `RecordHash`
- The SHA-256 digest (hex string) of a record's canonical serialization
  (business-rules `BR-AUD-6`, `BR-AUD-6a`).
- `GENESIS` is the reserved sentinel value used as `prevHash` of the first record
  in a partition.

### `EventType` (enum-like value object)
- Members mirror the shipped workflow `WorkflowEventType`: `RequestSubmitted`,
  `RequestValidated`, `RequestApproved`, `RequestRejected`, `RequestWithdrawn`.
- Consumed verbatim from the published event language; not re-invented.

### `AuditError` (value-level failure)
- `code`: `MALFORMED_EVENT` | `INTEGRITY_VIOLATION` | `NOT_FOUND`.
- Optional `field` (for `MALFORMED_EVENT`), `auditId` and `kind`
  (`hash-mismatch` | `broken-link`, for `INTEGRITY_VIOLATION`).
- PII-free message. Mirrors the `SsoError` / `AuthzError` / `HrisError` /
  `WorkflowError` taxonomy convention already shipped; returned inside
  `Result<T, AuditError>` per the existing `result.ts` convention, **not thrown**
  (throwing reserved for infrastructure/misconfiguration).

### `TrailQuery` (read filter value object)
- Optional `department`, `eventType`, `actorId`, `fromMs`, `toMs`.
- The parameter object for `queryTrail`; all fields optional (an empty filter
  returns the whole trail, subject to the auditor's scope).

## Entities

### `AuditRecord` (the unit's core entity — immutable fact)

The single entity this unit owns. It is an **immutable append-only fact**, not a
mutable aggregate: once appended it never changes (business-rules `BR-AUD-5`,
`BR-AUD-5a`). All fields are `readonly`.

| Attribute | Type | Notes |
|-----------|------|-------|
| `auditId` | `AuditId` | Identity; immutable. |
| `eventType` | `EventType` | Which workflow transition produced this fact. |
| `requestId` | `RequestId` | The subject request; the chain-partition key (`BR-AUD-4`). Reused from `unit-request-workflow`. |
| `ownerId` | `PrincipalId` | Requesting employee (pseudonymous, `BR-AUD-8`). Reused from `unit-platform-auth`. |
| `department` | `DepartmentCode` | Owning department (non-PII scoping key). |
| `actorId` | `PrincipalId` | Who performed the transition (owner, lead, or HR). Pseudonymous. |
| `resultingState` | `RequestStatus` | The `to` state of the transition (`BR-AUD-1a`). |
| `rejectedStage` | `WorkflowStage?` | Present iff `eventType == RequestRejected` (`BR-AUD-1b`). |
| `occurredAtMs` | `number` | Business time — when the transition happened (event `atMs`). |
| `recordedAtMs` | `number` | Ingest time — when audit stored it (monotonic, `BR-AUD-3`). |
| `prevHash` | `RecordHash` | Hash of the previous record in the partition, or `GENESIS`. |
| `hash` | `RecordHash` | This record's own digest (`BR-AUD-6`). |
| `retainUntilMs` | `number` | `recordedAtMs + SEVEN_YEARS_MS` (`BR-AUD-7`). |

Behaviour: `AuditRecord` has **no mutating methods**. A pure factory
`AuditRecord.fromEvent(event, prevHash, now)` constructs it and computes `hash`;
a pure `recomputeHash()` is used by `verifyChain`. No I/O lives in the entity.

## Ports

### `AuditStore` (port — append-only persistence)
- `append(record): Promise<void>` — the ONLY write operation. Never overwrites;
  there is deliberately **no `update` and no `delete`** (`BR-AUD-5`).
- `findByKey(eventType, requestId, occurredAtMs): Promise<AuditRecord | null>` —
  supports idempotent ingestion (`BR-AUD-2`).
- `chainHead(requestId): Promise<RecordHash | null>` — the current partition head
  hash for chaining (`BR-AUD-4`).
- `findByRequest(requestId): Promise<AuditRecord[]>` — ordered partition read,
  for `getRequestTrail` and `verifyChain`.
- `query(filter: TrailQuery): Promise<AuditRecord[]>` — filtered read, append
  order preserved.
- Interface lives in the domain/ports layer; the in-memory adapter is the
  dev/test implementation, swappable for a durable append-only / WORM store in
  production (same hexagonal seam as `SessionStore`, `RoleDirectoryPort`,
  `BalanceCache`, `VacationRequestRepository`).

### `WorkflowEventSubscription` (inbound anti-corruption seam)
- The composition root wires this unit's `recordEvent(event: WorkflowEvent)`
  handler to the shipped `EventPublisher` port from `unit-request-workflow`
  (`src/workflow/ports/event-publisher.ts`). A thin inbound mapper translates the
  published `WorkflowEvent` into the `AuditRecord` shape, isolating audit from
  future event-shape drift (conformist-with-ACL context mapping).

## Relationships & Lifecycle

```
unit-request-workflow (event source)
        │  publishes WorkflowEvent per accepted transition (choreography)
        ▼
   EventPublisher port ──subscribe──► recordEvent(event)          [this unit]
        │
        ├─ validate (BR-AUD-1) ─► malformed → AuditError (no write)
        ├─ dedup   (BR-AUD-2) ─► duplicate  → return existing record
        │
        ▼
   AuditRecord.fromEvent(event, prevHash=chainHead ?? GENESIS, now)
        │   computes hash, retainUntilMs
        ▼
   AuditStore.append(record)          (append-only, immutable — BR-AUD-5)
        │
        ▼
   [ per-request hash chain ]  R1(prev=GENESIS) → R2(prev=R1.hash) → R3(prev=R2.hash) → …
        │
        ├─ getRequestTrail / queryTrail ──► compliance-auditor (read-only)
        └─ verifyChain ──────────────────► integrity proof (pure, no write)
```

Lifecycle of a record: **created-on-ingest → appended → retained (7y) → (eligible
for out-of-band purge only after `retainUntilMs`)**. There is no other lifecycle
state; a record is never `Updated` or `Deleted` — those states do not exist in
this unit's model (`BR-AUD-5`, `BR-AUD-7a`).

Cross-unit references use **ids, not object graphs** (least coupling): the record
stores `requestId`, `ownerId`, `actorId`, and `department` as opaque ids/codes —
never the `VacationRequest` aggregate or `AuthenticatedPrincipal` object — exactly
as the `unit-request-workflow` `domain-entities` boundary prescribes for its
downstream consumers.
