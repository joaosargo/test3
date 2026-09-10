# Logical Components — `unit-notifications`

The logical infrastructure component inventory for the **Notification** unit —
service boundaries, failure domains, blast-radius mapping, isolation strategy, and
shared-resource identification. This artifact bridges the NFR design decisions
(`performance-design`, `security-design`, `scalability-design`,
`reliability-design`) with the upcoming Infrastructure Design by giving a
component-level view of *where each NFR pattern applies*. It is grounded in the
hexagonal port/adapter seams in `business-logic-model` and the technology ADRs in
`tech-stack-decisions` (`ADR-NOTIF-02` queue, `ADR-NOTIF-03` email port,
`ADR-NOTIF-04` in-app store, `ADR-NOTIF-05` resilience, `ADR-NOTIF-06`
observability), against the load and durability envelope in
`scalability-requirements`, `performance-requirements`, and
`reliability-requirements`, and the PII posture in `security-requirements`.

The unit sits on the **choreography** side: it consumes the workflow's PII-free
`WorkflowEvent`s and never calls back. Every cross-unit reference is by id, not
object graph (least coupling), matching the boundary the workflow unit
established.

## Logical Component Inventory

| # | Logical component | Responsibility | Kind | Realises (ports) |
|---|-------------------|----------------|------|------------------|
| C1 | **Event Subscriber / Enqueuer** (producer-side seam) | On a consumed `WorkflowEvent`, enqueue it for async processing within the ≤3ms budget | Stateless, in the workflow's process (choreography subscription) | subscribes `EventPublisher`; `enqueue` |
| C2 | **Notification Queue** | Durable at-least-once buffer decoupling producer from workers | Stateful infra (in-proc MVP → managed broker per `ADR-NOTIF-02`) | queue transport |
| C3 | **Notification Worker** | Drain queue; run the pipeline: dedupe → resolve → render → dispatch → record | Stateless, horizontally scaled | `NotificationService.handleEvent` |
| C4 | **Recipient Directory Adapter** | Read-only resolve of `PrincipalId`/role→`RecipientContact` (PII), short-TTL in-process cache | Stateless + local cache | `RecipientDirectoryPort` |
| C5 | **Email Channel Adapter** | Dispatch `EmailMessage` to the provider; retry/breaker | Stateless + pooled provider client | `EmailSenderPort` |
| C6 | **In-App Inbox Store** | Persist/read in-app notifications; self-scoped reads; PII bodies encrypted | Stateful (durable store) | `InAppInboxPort` |
| C7 | **Delivery Record Store** | Append-only `NotificationDelivery`; idempotency + dead-letter reconciliation | Stateful (append-only, indexed on `(recipientId, dedupeKey)`) | `NotificationDeliveryRepository` |
| C8 | **Dead-Letter Queue** | Hold `(recipient, channel)` items that exhausted retries; replayable | Stateful infra | DLQ transport |
| C9 | **In-App Read API** | `listForRecipient` / `markRead`, authenticated + self-scoped | Stateless, request/response | `NotificationService` read side |
| C10 | **Crypto Adapter** (shared) | Field-level encryption of persisted PII bodies | Shared platform capability | `CryptoPort` |

## Service Boundaries

- **Producer boundary (C1)** lives inside the workflow process as a choreography
  subscriber. Its *only* job is the tight enqueue (`performance-design` hot path).
  It shares the workflow's failure domain but does nothing that can fail the
  workflow — a failed enqueue is logged and dropped-forward, never thrown back.
- **Delivery boundary (C3–C8)** is the async tier: an independently deployable/
  scalable worker service reachable only via the queue (C2). No synchronous caller
  crosses into it.
- **Read boundary (C9)** is a small authenticated request/response surface over the
  in-app store (C6), self-scoped per principal (`security-design`).

These three boundaries map to the two paths in `performance-design`: C1 = producer
hot path; C3–C8 = async delivery path; C9 = an independent read path.

## Failure Domains

| Failure domain | Components | Isolation | Effect on workflow |
|----------------|-----------|-----------|--------------------|
| **FD-Producer** | C1 | Shares workflow process; guarded to never throw back | None — workflow commits regardless (`reliability-design` non-blocking) |
| **FD-Queue** | C2 | Own infra; durable | Producer degrades to log-and-continue if unreachable; no workflow impact |
| **FD-Worker** | C3, C4 | Stateless pool; any instance replaceable | None; delayed delivery only |
| **FD-Email** | C5 | Own pool + own circuit breaker | None; in-app still delivered |
| **FD-InApp** | C6 | Own pool + own circuit breaker | None; email still sent |
| **FD-Records** | C7, C8 | Own store | Degrades idempotency/DLQ bookkeeping; delivery still attempted |
| **FD-Read** | C9 | Independent request path | None; inbox read unavailable, delivery unaffected |

The per-channel circuit breakers and separate connection pools (`reliability-design`
bulkheads) make **FD-Email and FD-InApp independent** — the defining
graceful-degradation property (BR-NOTIF-7).

## Blast-Radius Mapping

| Failure | Blast radius | Containment |
|---------|-------------|-------------|
| A worker instance crashes | In-flight events on that worker only | Stateless + at-least-once redelivery + idempotency; another worker resumes |
| Email provider outage | Email channel only, all recipients | Email breaker opens → fail fast → DLQ; in-app unaffected; ops alerted |
| In-app store outage | In-app channel + inbox reads | In-app breaker opens → DLQ; email unaffected |
| Directory outage | Recipient resolution (both channels) | Short-TTL cache absorbs transient blips; unresolved → skip (non-fatal); retried |
| Queue outage | New delivery latency | Durable broker retries publish; producer non-blocking; workflow unaffected |
| Crypto adapter outage | Persisted-PII in-app writes | Fail closed (no plaintext) → retry/DLQ (`security-design`) |
| DLQ growth | Operational, not user-blocking | Alert + replay when provider recovers |

Critically, **no failure in any C-component has a blast radius that reaches the
workflow command path** — the choreography boundary caps the radius at "notification
delivery latency/completeness," per `reliability-requirements`.

## Component Isolation Strategy

- **Stateless workers (C3)** scale horizontally with no affinity (`scalability-design`).
- **Per-channel bulkheads** (C5 vs C6): separate connection pools + circuit breakers
  (`reliability-design`), plus a separate budget for directory reads (C4).
- **Backpressure at the queue** (C2): depth is the scaling signal; producers never
  block (`scalability-design`).
- **PII containment as an isolation concern**: PII is confined to C4 (transient,
  in-process cache), C5's outbound message, and C6's encrypted bodies; it never
  enters C1/C2 (bus stays PII-free), C7/C8 (records/DLQ are PII-free codes), or logs
  (`security-design` BR-PII-1..4).

## Shared Resource Identification

| Resource | Shared with | Boundary discipline |
|----------|-------------|---------------------|
| `EventPublisher` choreography bus | `unit-request-workflow` (producer) + `unit-audit-trail` and other consumers | This unit **subscribes only**; adds nothing to events; unaware producers stay decoupled |
| `CryptoPort` (C10) | Platform (mirrors authz `BR-PII-3`) | Consumed as a shared capability; fail-closed on unavailability |
| Identity / `AuthenticatedPrincipal` | `unit-platform-auth` | Consumed read-only on the C9 read path; no auth logic here |
| Recipient directory backing store | IdP / HRIS / internal directory | Read-only via C4; **infrastructure-design decides the concrete source** (memory open question) |
| Send capability (C5/C6 ports) | `unit-sla-escalation` (downstream, out of scope) | That unit reuses these ports for timed reminders; this unit owns the send capability, not the scheduling |

## Hand-off to Infrastructure Design

Infrastructure Design should provision/decide:

1. **Concrete broker** for C2 + **DLQ** for C8 satisfying: at-least-once delivery,
   visibility-timeout/lease, durable persistence, dead-lettering (per
   `reliability-design`, `ADR-NOTIF-02`).
2. **Worker compute** for C3 with **queue-depth-based auto-scaling** (per
   `scalability-design` rules), floor ≥1.
3. **Durable stores** for C6 (in-app, encryption-at-rest + field-level via C10) and
   C7 (append-only, indexed `(recipientId, dedupeKey)`), with **bounded retention**
   (TBD with compliance).
4. **Email provider** binding for C5 with pooled client + provider credentials in
   managed secrets (mirroring platform `ADR-AUTH-04`).
5. **Recipient directory** source binding for C4.
6. **Observability** wiring (`ADR-NOTIF-06`): enqueue latency, per-channel dispatch
   latency + breaker state, queue depth, DLQ depth, cache hit ratio — the metrics
   the NFR budgets in `performance-design`/`reliability-design`/`scalability-design`
   are verified against.
