# Scalability Design — `unit-notifications`

Concrete scaling architecture for the **Notification** unit — how it absorbs the
load envelope in `scalability-requirements` (~500 concurrent users, queue-driven
async delivery, horizontal scaling with backpressure and bounded in-app data
growth) without ever becoming a bottleneck on the workflow command path. The
design is grounded in the choreography-consumer shape from `business-logic-model`,
the async budgets in `performance-requirements`, the non-blocking delivery posture
in `reliability-requirements`, and the queue/broker ADR in `tech-stack-decisions`
(`ADR-NOTIF-02`).

The unit has **no synchronous write-scaling dimension of its own** on the hot
path: the producer only enqueues. All scale pressure lives on the async delivery
tier and its data stores.

Scaling and security are complementary here: the bounded concurrency and
backpressure below are also the denial-of-service containment control called for
in `security-requirements` (an event flood cannot exhaust provider connections).

## Scaling Model — Stateless Queue-Driven Workers

Per `scalability-requirements` the delivery tier is a **stateless, queue-driven**
consumer that scales horizontally in lockstep with (or independently of) the
modular-monolith app tier:

```
producers (workflow commits) ──enqueue──► queue ──►  worker pool (stateless, N instances)
                                            │                    │
                                    depth = backpressure    each: bounded concurrency
                                            │                    │
                                            └──── scale workers on depth ────┘
```

- **Stateless workers.** A worker holds no session or per-event state beyond the
  in-flight batch; any worker can process any event. State that must survive lives
  in the queue, the delivery-record store, and the in-app store — never in the
  worker. This lets workers scale by adding instances behind the queue (no session
  affinity), matching the `scalability-requirements` statelessness posture and the
  platform's stateless-app-tier convention.
- **Queue decouples producer from consumer scale.** Producers (workflow commits)
  and consumers (delivery workers) scale independently — a burst of state changes
  fills the queue and drains at worker capacity rather than blocking the workflow
  (event-driven decoupling; `reliability-requirements` non-blocking invariant).

## Load Distribution & Concurrency

- **Bounded per-worker concurrency.** Each worker processes a batch with a capped
  number of simultaneous channel dispatches so total open provider connections =
  `worker_count × per_worker_concurrency` stays within provider and pool limits.
  This is the primary knob for protecting downstream providers.
- **Competing consumers.** Multiple workers pull from the same queue (competing-
  consumers pattern); the broker's visibility-timeout/lease ensures one worker owns
  an in-flight event, and at-least-once redelivery on worker crash is made safe by
  the idempotency guard (BR-NOTIF-9).
- **Per-channel isolation (bulkhead).** Email and in-app dispatch draw from
  separate connection pools so saturation or slowness in one channel cannot starve
  the other (`reliability-design` picks up the circuit-breaker side of this).

## Backpressure

Per `scalability-requirements` backpressure requirement:

- **Queue depth is the backpressure signal.** Producers never block on delivery;
  they enqueue and return. If workers fall behind, depth grows — bounded by the
  broker's configured maximum — and is the trigger for scaling workers out, not for
  slowing the workflow.
- **Bounded in-flight work.** Workers pull only what their bounded concurrency can
  process, so a large backlog does not translate into unbounded memory or
  connection use per worker.
- **Shed to DLQ, not to the producer.** Events that exhaust retries move to the
  dead-letter queue (`reliability-design`), keeping the main queue draining rather
  than head-of-line blocking.

## Auto-Scaling Rules (queue-depth driven)

| Signal | Threshold (illustrative; tune with ops) | Action |
|--------|------------------------------------------|--------|
| Queue depth sustained above target for N minutes | e.g. depth > 2× steady-state | Scale out worker instances |
| Queue depth near-zero and workers idle | e.g. depth ≈ 0 for M minutes | Scale in to a floor (≥1 for continuous drain) |
| Per-channel dispatch latency rising | provider p95 climbing | Hold worker count; circuit breaker trips (see `reliability-design`) rather than adding connections against a struggling provider |
| DLQ growth | any sustained non-zero rate | Alert ops; do **not** auto-scale to brute-force a failing provider |

Concrete thresholds are set with infrastructure-design against the ~500-concurrent
envelope; auto-scaling keys on **queue depth and age**, not CPU, because the tier
is I/O-bound on external providers.

## Data Growth & Capacity Planning

`scalability-requirements` calls for **bounded in-app data growth**. Two owned
stores grow over time:

| Store | Growth driver | Bounding strategy |
|-------|---------------|-------------------|
| **In-app notifications** (`InAppInboxPort`) | ~ (state changes) × (recipients/event); five transitions/request × ~2 recipients | Bounded retention window (e.g. read+aged notifications archived/pruned after a configured period) + per-recipient pagination on `list`. Retention window TBD with compliance (memory open question). Reads are self-scoped and indexed on `recipientId`, so per-inbox query cost is independent of global volume. |
| **`NotificationDelivery`** (append-only) | one record per (recipient, event) pass | Append-only but bounded by retention/archival tied to the dedupe window need — a delivery record only needs to outlive the possible redelivery window for idempotency, then can be archived. Distinct from the 7-year compliance audit-trail (which this unit does not own). |

- **Indexing for scale-independent reads.** In-app `list` is indexed on
  `(recipientId, read, createdAtMs)` and paginated so inbox reads stay O(page), not
  O(total notifications).
- **Idempotency lookup is O(1)** on `(recipientId, dedupeKey)` regardless of store
  size (see `performance-design`).

## Scaling the Dependencies

- **Directory reads** (`RecipientDirectoryPort`) are shielded by the short-TTL
  in-process cache (`performance-design`) so worker scale-out does not linearly
  multiply load on the directory/IdP system of record — load-shedding, as
  `scalability-requirements` intends.
- **Email/in-app providers** are protected by bounded concurrency + circuit
  breaker; scaling workers never exceeds the configured provider connection budget.

## Verification

- **Load test at the envelope**: drive the ~500-concurrent-user event rate from
  `scalability-requirements` and confirm (a) producer enqueue stays within the 3ms
  budget (`performance-design`), (b) queue depth stabilises at worker capacity
  rather than growing unbounded, and (c) end-to-end delivery stays within the async
  budget.
- **Backpressure test**: inject a slow/failing provider and confirm the main queue
  keeps draining (events shed to DLQ) and producers never block.
- **Scale-out test**: confirm adding worker instances increases drain throughput
  ~linearly (stateless property) up to provider/pool limits.
- **Data-growth test**: confirm retention/pruning bounds in-app store growth and
  that inbox `list` latency is flat as global volume grows (index + pagination).
