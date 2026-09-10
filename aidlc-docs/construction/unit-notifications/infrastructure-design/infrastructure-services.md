# Infrastructure Services — `unit-notifications`

The backing AWS services for the **Notification** unit: the durable notification
queue and dead-letter queue that decouple the producer from the async delivery
workers, the two DynamoDB stores (in-app inbox, delivery records), the email
provider binding, the recipient-directory read integration, and the caching and
service-discovery posture. These choices realise the queue/broker contract in
`logical-components` (C2/C8) and `tech-stack-decisions` `ADR-NOTIF-02`, the
at-least-once idempotent-consumer semantics in `business-logic-model` and
`reliability-design` (BR-NOTIF-9/10/11), the two-path latency model in
`performance-design`, the queue-driven scaling and bounded-growth rules in
`scalability-design`, and the PII-containment rules in `security-design`. They
inherit the modular-monolith grouping of `components` and `services`.

## Messaging — EventBridge rule → SQS queue → worker (choreography)

The workflow unit already publishes its five PII-free domain events onto the
**shared EventBridge choreography bus** via a Streams→EventBridge outbox
(`unit-request-workflow` infrastructure-services). This unit is a **subscriber
only** — it adds nothing to the events and the producer is unaware of it
(`logical-components` shared-resource discipline; `services` choreography). The
subscription is realised as:

```
EventBridge bus ──rule(detail-type ∈ {RequestSubmitted, RequestValidated,
                                      RequestApproved, RequestRejected,
                                      RequestWithdrawn}) ──► SQS queue (C2)
                                                               │  at-least-once
                                                               │  visibility-timeout lease
                                                               ▼
                                              worker (C3): dedupe → resolve → render →
                                                           dispatch email+in-app → record
                                                               │ retry exhausted
                                                               ▼
                                                          SQS DLQ (C8)  ──replay──► worker
```

- **Why SQS in front of the worker (not a bare EventBridge→Lambda target).**
  `reliability-design` and `scalability-design` require a **durable at-least-once
  buffer with a visibility-timeout lease, competing consumers, backpressure by
  depth, and a native dead-letter queue**. Amazon SQS provides all four
  first-class: the EventBridge **rule targets an SQS queue** (C2), the worker
  consumes with the visibility-timeout lease (one worker owns an in-flight event),
  and a **redrive policy** moves poison items to the **SQS DLQ** (C8) after
  `maxReceiveCount = 3` receives — matching the 3-attempt retry ceiling in
  `reliability-design`. EventBridge alone gives fan-out but not the lease/DLQ
  semantics the async tier depends on.
- **At-least-once + idempotency, not exactly-once.** The queue may redeliver;
  correctness comes from the consumer's dedupe guard against the delivery-record
  store (below), per `business-logic-model` and `reliability-design` BR-NOTIF-9.
- **Backpressure by depth.** Producers never block (the enqueue is off-worker,
  fire-and-forget per `performance-design`); if workers fall behind, SQS depth
  grows and is the **scale-out signal** (`scalability-design`), not a source of
  workflow latency.
- **Encryption + PII.** Enqueued events are PII-free by construction
  (`security-design` BR-PII-1); the queue is nonetheless **SSE-encrypted**
  (SSE-SQS or KMS) as defense-in-depth and to keep parity with the platform
  data-protection posture.
- **DLQ is operable and replayable.** DLQ items retain PII-free correlation
  (`requestId`, `dedupeKey`, `eventType`, channel) so ops can inspect; replay is
  safe because delivery is idempotent and per-channel (`reliability-design`
  dead-letter handling). Sustained DLQ growth alerts ops (see `monitoring-design`),
  it is never auto-scaled around (`scalability-design`).

- **Broker-agnostic seam preserved.** The **in-process event bus / in-memory
  queue remains the dev/test default** behind the same port; deployed
  environments wire EventBridge-rule→SQS. This is the identical port/adapter swap
  the platform units use.

## Database — DynamoDB in-app inbox + delivery-record store

Two owned DynamoDB tables, both realising ports the functional design left open
(`ADR-NOTIF-04` in-app store; delivery-record repository):

### `notifications-inapp-<env>` (C6 — in-app inbox)

- **Key schema**: `PK = RCPT#<recipientId>`, `SK = NOTIF#<createdAtMs>#<notificationId>`.
  This makes `listForRecipient` a single-partition `Query` that is **self-scoped by
  construction** (`security-design` self-scope; a query is physically bounded to
  one recipient's partition) and naturally ordered newest-first. `unreadOnly` is
  served by a sparse GSI on `(recipientId, read)` or an attribute filter — reads
  stay **O(page)**, not O(total) (`scalability-design` indexed + paginated reads).
- **PII at rest**: `title`/`body` may embed contact/reason context, so they are
  **field-level encrypted via `CryptoPort` (C10, KMS-backed)** before write;
  a `CryptoPort`-unavailable write **fails closed** and is retried/dead-lettered
  rather than persisting plaintext (`security-design` BR-PII-3). SSE-at-rest is
  layered underneath as defense-in-depth.
- **Bounded growth**: **DynamoDB TTL** on an `expireAt` attribute prunes read/aged
  notifications after the retention window (illustrative 90d; TBD with compliance —
  `scalability-design`, `memory.md`) at no write cost.

### `notifications-delivery-<env>` (C7 — delivery records)

- **Key schema**: `PK = RCPT#<recipientId>`, `SK = DK#<dedupeKey>` where
  `dedupeKey = hash(requestId, eventType, atMs)`. The idempotency guard
  (`hasDelivery`) is a single **`GetItem`** — O(1) regardless of table size
  (`performance-design`, `scalability-design`).
- **Append-only integrity**: records are **write-once**; the IAM policy and a CDK
  aspect forbid `UpdateItem`/`DeleteItem`, making append-only structural, not
  conventional (`reliability-design` BR-NOTIF-11; `security-design`
  STRIDE-Tampering). Per-channel `ChannelOutcome` is recorded so a redelivery can
  complete only the still-failed channel (`reliability-design`).
- **PII-free**: delivery records carry only pseudonymous ids and machine codes
  (`RECIPIENT_UNRESOLVED`, `NO_EMAIL_CONTACT`, `CHANNEL_TRANSIENT`,
  `CHANNEL_DEAD_LETTERED`) — `security-design` BR-PII-4.
- **Bounded**: **DynamoDB TTL** (illustrative 30d, ≥ the redelivery/dedupe window)
  — distinct from the 7-year compliance audit-trail owned by `unit-audit-trail`,
  which this unit does not own.

Both tables: **SSE with KMS**, **PITR enabled**, on-demand capacity in
dev/staging (zero idle cost — cost-optimisation), provisioned + autoscaling in
prod. In-memory adapters remain the dev/test default behind the ports.

## Email provider — Amazon SES (C5)

`EmailSenderPort` binds to **Amazon SES** in deployed environments:

- **Managed, pooled, TLS.** SES is reached over TLS (`security-design`
  encryption-in-transit); the SDK client is a **bounded, pre-warmed connection
  pool** sized to worker concurrency × buffer (`performance-design` resource
  pooling) so no per-send TLS handshake is paid on the delivery path.
- **Bounces/complaints feed outcomes.** SES bounce/complaint notifications
  (via SNS) surface hard rejects as `skipped(NO_EMAIL_CONTACT)` / non-retryable
  4xx, feeding the retry/skip classification in `reliability-design` rather than
  retrying a permanently bad address.
- **Verified domain + DKIM** in prod (deliverability + anti-spoofing); sandbox or
  a verified test domain in staging.
- **Per-channel bulkhead**: the SES client pool and the email circuit breaker are
  **independent** of the in-app store's pool/breaker (`reliability-design`
  bulkhead), so an SES outage trips only the email breaker and in-app delivery
  continues (BR-NOTIF-7).

## Caching

Two read-heavy inputs on the async delivery path are cached, per
`performance-design` — both **in-process, per-worker, short-TTL, memory-only**:

- **Recipient contact resolution** (`RecipientDirectoryPort.resolve`) — TTL
  ~60–120s. This **sheds load from the directory/IdP system of record**
  (`scalability-design`) so worker scale-out does not linearly multiply directory
  reads. **PII note**: the cached `RecipientContact` (email, displayName) is
  in-process only, **never written to a shared cache** (no Redis-class store) and
  **never logged** (`security-design` BR-PII-2).
- **Rendered templates** — effectively static, keyed by `WorkflowEventType`,
  compiled once per process lifetime; invalidated on redeploy.
- **The idempotency/dedupe lookup is NOT a cache** — it is an authoritative
  `GetItem` against the delivery-record store (`performance-design`). The shared
  store is reserved for that durable idempotency surface, never for PII.

## Recipient directory integration (C4)

`RecipientDirectoryPort` is a **read-only** resolve of `principalId`/role →
`RecipientContact`, protected by the short-TTL in-process cache above and a
timeout-bounded read with a small breaker (`reliability-design` directory tier:
transient error retried, unresolved recipient → `skipped(RECIPIENT_UNRESOLVED)`,
non-fatal). The concrete backing source (platform IdP vs HRIS vs internal
directory) is an **infrastructure open item** (`logical-components` hand-off;
`memory.md`); the assumed binding is read-through to the platform IdP/directory
the auth unit already integrates, reached over the existing egress path.

## External service integrations & boundaries

- **Producer coupling is the EventBridge bus only.** This unit holds an
  EventBridge **rule** that targets its SQS queue for the five `detail-type`s; it
  has **no** permission on the workflow's request table and the workflow has no
  permission on this unit's queue/stores (`services` choreography; the bus is the
  anti-corruption membrane, per `unit-request-workflow` shared-infrastructure).
- **`unit-sla-escalation` (downstream, out of scope)** reuses this unit's send
  capability (the same `EmailSenderPort`/`InAppInboxPort` seam) on a timer; this
  unit owns the **send capability**, not the scheduling (`logical-components`
  shared-resource table; `business-logic-model`).
- **`CryptoPort` (C10)** is consumed as a shared platform capability (mirrors
  authz `BR-PII-3`), fail-closed on unavailability.

## Service Discovery & Configuration

- In-process seams (producer C1, in-app read C9) resolve peers by import within
  the monolith — no service discovery (`logical-components` embedded boundary).
- Queue URL, DLQ ARN, table names, SES config-set/identity, KMS key ARNs, cache
  TTLs, and retention windows are injected via **SSM Parameter Store /
  Secrets Manager** and read at start (`security-design` "no secrets in code" /
  no PII in config); the CDK stack writes them under a `notifications/*` namespace
  and the worker reads them, so nothing is hardcoded.
