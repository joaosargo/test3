# Performance Design — `unit-notifications`

Concrete performance architecture for the **Notification** unit — the caching,
async-decoupling, resource-pooling, and budget-enforcement decisions that satisfy
the `performance-requirements` for this unit. This design realises the split the
requirements draw between a **tight synchronous enqueue budget on the producer hot
path** and a **looser asynchronous delivery budget off the hot path**, grounded in
the choreography-consumer shape defined in `business-logic-model` (the unit is a
pure event consumer, never on the synchronous command path) and the ADRs in
`tech-stack-decisions` (`ADR-NOTIF-02` queue/broker, `ADR-NOTIF-06`
observability).

It also honours the non-blocking invariants in `reliability-requirements`
(delivery failure never blocks a workflow transition), the load envelope in
`scalability-requirements` (~500 concurrent users, queue-driven horizontal
scaling), and the PII-minimisation rules in `security-requirements` (no PII on the
bus, contact resolved late).

## Latency Budgets & The Two-Path Model

The single most important performance decision: **nothing the notification unit
does may add latency to a workflow state transition.** Per `performance-requirements`
the producer-side work is bounded to a tight synchronous enqueue budget; all
channel I/O happens later on the async worker.

| Path | Work | Budget (p95) | Rationale |
|------|------|--------------|-----------|
| **Producer hot path** (in the workflow commit) | Serialize the PII-free `WorkflowEvent` and hand it to the queue port (`enqueue`) | **≤3ms p95** (per `performance-requirements` synchronous-enqueue budget) | The workflow already committed (`business-logic-model`, workflow `BR-INV-5`); enqueue must be a fire-and-forget local operation, never a blocking network round-trip to a channel provider. |
| **Async delivery path** (off hot path, worker) | dedupe check → resolve recipients → render templates → dispatch email + in-app → record delivery | **end-to-end target ≤ a few seconds p95** (looser async budget; concrete SLO TBD per `performance-requirements`) | Users tolerate seconds of delivery latency; the async budget is dominated by external provider latency, not our code. |

- **Enqueue is local and cheap.** In the MVP the queue is in-process (`ADR-NOTIF-02`),
  so `enqueue` is an in-memory append — trivially inside 3ms. In production the
  enqueue targets a managed broker; to keep the synchronous side within budget the
  producer publishes through a **connection-pooled, pre-warmed client** and does
  **not** wait for delivery confirmation beyond the broker's durable-accept ack
  (at-least-once, per `reliability-requirements`).
- **No synchronous fan-out.** Recipient resolution, template rendering, and
  provider calls are explicitly excluded from the hot path. This is the direct
  performance expression of the choreography boundary in `business-logic-model`.

## Async Processing Architecture

The delivery pipeline runs on queue-driven workers, matching `scalability-requirements`
(stateless, queue-driven async model) and `ADR-NOTIF-02`:

```
workflow commit ──enqueue(WorkflowEvent, PII-free)──► queue (in-proc MVP → managed broker)
                                                          │  (at-least-once)
                                                          ▼
                                             NotificationWorker.handle(event)
      ┌───────────────────────────────────────────────────┴───────────────────────────┐
      │ 1. dedupe guard (hasDelivery)   2. resolve recipients (cached)                  │
      │ 3. render templates (cached)    4. dispatch email + in-app (independent)        │
      │ 5. record NotificationDelivery (append-only)                                    │
      └─────────────────────────────────────────────────────────────────────────────────┘
```

- **Batch draining, bounded concurrency.** Workers pull events in small batches
  and process them with a bounded per-worker concurrency limit so a burst of state
  changes does not open an unbounded number of simultaneous provider connections
  (backpressure, per `scalability-requirements`).
- **Independent channel dispatch.** Email and in-app dispatch run concurrently per
  recipient (`business-logic-model` step 4; `security-requirements`/reliability
  BR-NOTIF-7), so per-event wall-clock latency is `max(email, in-app)`, not their
  sum.

## Caching Strategy

Two read-heavy inputs dominate the async path; both are cached with short TTLs
(cache-aside), consistent with the caching posture the platform units already use
and the load-shedding intent in `scalability-requirements`.

| Cached item | Location | TTL | Invalidation | Why |
|-------------|----------|-----|--------------|-----|
| **Recipient contact resolution** (`RecipientDirectoryPort.resolve`, `resolveActor`) | In-process per-worker cache | Short (e.g. 60–120s) | TTL expiry only | Directory (IdP/HRIS) lookups are the most expensive external read on the delivery path; a burst of events about the same request/department re-resolves the same recipients. Caching sheds load from the directory system of record. **PII note:** cached `RecipientContact` holds email/displayName — the cache is in-process, memory-only, never logged, and never persisted (`security-requirements` BR-PII-2). |
| **Rendered templates** (`NotificationTemplate` by `WorkflowEventType`) | In-process, effectively static | Process lifetime | Redeploy | Templates are keyed by the five event types and change only on deploy; compile/parse once. |

- **Never cache PII to a shared store.** Contact caching is strictly per-worker
  in-memory; it is never written to Redis-class shared cache, honouring
  `security-requirements` PII rules. The shared store is reserved for the
  idempotency/dedupe surface (below).
- **Set a TTL on everything.** No unbounded caches (stale contact = wrong-address
  delivery risk).

## Idempotency & Dedupe Performance

`business-logic-model` and BR-NOTIF-9 require an at-least-once, idempotent
consumer. The dedupe check (`hasDelivery(recipientId, dedupeKey)`) is on the hot
part of the async path and must be O(1):

- The delivery record store is indexed on the composite `(recipientId, dedupeKey)`
  so the guard is a single point lookup, not a scan.
- In production the dedupe lookup is served from the shared cache/store fronting
  `NotificationDeliveryRepository`; the `dedupeKey = hash(requestId, eventType, atMs)`
  is precomputed once per event.

## Resource Pooling & Connection Management

Per the NFR-design connection-pooling pattern and `ADR-NOTIF-03`/`ADR-NOTIF-04`
(provider ports):

- **Email provider client**: a bounded connection pool (keep-alive HTTP/SMTP) sized
  to worker concurrency × buffer; connect timeout 5s, read timeout tuned to the
  provider. Pooling avoids per-send TLS handshakes on the delivery path.
- **In-app store / delivery repository**: a bounded DB/connection pool sized per
  `poolSize = worker_concurrency × avg_op_seconds × 1.5`.
- **Broker publisher (producer side)**: a pre-warmed, pooled client so the ≤3ms
  enqueue budget is not paid as a cold-connect cost on the first event after idle.

## Performance Budgets Summary

| Operation | Budget | Enforcement |
|-----------|--------|-------------|
| `enqueue` (producer hot path) | ≤3ms p95 | Local append (MVP) / pooled broker publish; measured in the workflow-unit's own budget accounting |
| Recipient resolution (cached hit) | sub-ms | In-process cache |
| Recipient resolution (cache miss) | ≤ directory timeout | Timeout-bounded external read + cache populate |
| Template render | sub-ms | Precompiled templates |
| End-to-end async delivery | ≤ a few seconds p95 (concrete SLO TBD) | Worker batch + bounded concurrency |

## Verification

- **Enqueue budget**: micro-benchmark the producer `enqueue` path in isolation
  (in-memory adapter) to confirm it stays well within 3ms; assert no channel I/O is
  reachable synchronously (the in-memory `EmailSenderPort`/`InAppInboxPort`
  adapters record calls, so a test asserts they are never invoked during the
  workflow commit).
- **Cache effectiveness**: assert the directory port is called once per unique
  recipient within a TTL window under a multi-event burst (cache-hit test).
- **Async throughput**: load-test the worker at the ~500-concurrent-user envelope
  from `scalability-requirements` and confirm end-to-end delivery stays within the
  async budget; observe queue depth stays bounded (backpressure).
- **Observability** (`ADR-NOTIF-06`): emit enqueue latency, per-channel dispatch
  latency, cache hit ratio, and queue depth as metrics so budgets are continuously
  verifiable in production.
