# Reliability Design — `unit-notifications`

Concrete resilience architecture for the **Notification** unit — the delivery
semantics, retry/circuit-breaker/dead-letter configuration, degradation tiers,
health checks, and recovery decisions that satisfy the unit's
`reliability-requirements` (Important-tier, 99.5% delivery SLO, retries,
dead-lettering, circuit breaking, idempotency, never blocking a workflow
transition). The design is grounded in the at-least-once idempotent-consumer shape
in `business-logic-model`, the delivery rules in the unit's business rules
(surfaced via `security-requirements`/functional design BR-NOTIF-7..11), the
resilience ADR in `tech-stack-decisions` (`ADR-NOTIF-05` retry & circuit breaker,
`ADR-NOTIF-06` observability), and the async budgets in `performance-requirements`.

The governing invariant, restated from `reliability-requirements`: **a
notification failure never blocks or reverses the source workflow transition.** By
the time this unit sees an event, the workflow has already committed
(`business-logic-model`; workflow same-logical-commit rule). Reliability here means
delivering *eventually and idempotently*, and failing *loudly to a dead-letter*
rather than losing silently or leaking back to the command path.

## Availability / Delivery SLO

- **REL-NOTIF-1 — Important-tier delivery SLO.** Target **99.5%** successful
  delivery per channel over a rolling window (per `reliability-requirements`
  Important-tier), measured as
  `delivered_or_intentionally_skipped / total_attempts` — an
  intentional `skipped(NO_EMAIL_CONTACT)` or `skipped(RECIPIENT_UNRESOLVED)` counts
  as a correct outcome, a dead-letter counts against the SLO. Concrete numeric
  thresholds/alerting TBD with ops (memory open question).
- **REL-NOTIF-2 — Decoupled from command-path availability.** The unit's
  availability is independent of the workflow's: the workflow commits and returns
  regardless of notification health (`reliability-requirements` non-blocking;
  workflow `reliability-requirements` classifies notification consumers as the
  Important tier — "missed delivery is a consumer-side retry concern, not a command
  failure").

## Delivery Semantics & Idempotency

- **At-least-once + consumer idempotency.** The queue delivers at-least-once; the
  consumer guarantees correctness via the dedupe guard, not via exactly-once
  (`business-logic-model`; BR-NOTIF-9). `dedupeKey = hash(requestId, eventType,
  atMs)`; if a `NotificationDelivery` already exists for `(recipientId, dedupeKey)`
  that recipient is skipped — redelivery is a no-op.
- **Per-channel outcome recording.** Each `(recipient, channel)` outcome is recorded
  separately (`ChannelOutcome`), so redelivery can complete only the channel that
  previously failed rather than re-sending an already-delivered channel.
- **Append-only delivery record.** `NotificationDelivery` is never mutated
  (BR-NOTIF-11), making idempotency and dead-letter reconciliation deterministic
  after any restart.

## Retry Policy (per channel)

Per `ADR-NOTIF-05` and the NFR-design retry pattern:

```
attempt delays: 200ms, 400ms, 800ms  (exponential, base 200ms, factor 2)
                + full jitter on each delay
max attempts:   3 (then dead-letter)
retryable:      provider 5xx, 429 (honour Retry-After if present), timeouts, connection reset
non-retryable:  4xx validation (bad address) → skip with PII-free code, do NOT retry
```

- **Jitter is mandatory** to avoid synchronised retry storms across workers under a
  common provider blip (thundering-herd avoidance).
- **Idempotent retries.** Because the dedupe key is per (recipient, event) and
  channel outcomes are recorded, a retried send cannot double-deliver a channel
  that already succeeded.
- **Only transient failures retry** — a permanent bad-address (`NO_EMAIL_CONTACT` /
  provider hard-reject) is an intentional skip, not a retry.

## Circuit Breaker (per channel, per provider)

Per `ADR-NOTIF-05` and the resilience-patterns matrix — breakers are
**per-dependency**, never global:

| Parameter | Value |
|-----------|-------|
| Failure threshold | 5 consecutive failures |
| Open duration | 30s |
| Half-open probes | 3 |

- **Closed → Open** when the email (or in-app store) provider crosses the failure
  threshold; while **Open**, that channel's sends fail fast and route straight to
  retry-scheduling/DLQ without hammering a down provider.
- **Half-open** admits a few probes; success closes the breaker, failure re-opens.
- **Independent breakers** mean an email-provider outage trips only the email
  breaker — in-app delivery continues (the graceful-degradation core of
  BR-NOTIF-7).

## Bulkhead Isolation

Separate connection pools and (bounded) concurrency budgets per channel
(email vs in-app) and a separate budget for directory resolution, so exhaustion or
latency in one dependency cannot consume the resources the others need
(`performance-design` pooling; `scalability-design` bounded concurrency, which
sizes these budgets against the load envelope in `scalability-requirements`).

## Dead-Letter Handling

- **Bounded retries → DLQ.** On retry exhaustion (or an open breaker past a hold),
  the `(recipient, channel)` is dead-lettered (`CHANNEL_DEAD_LETTERED`) —
  BR-NOTIF-10. The event is never retried forever and never lost silently.
- **DLQ is operable.** Dead-lettered items retain PII-free correlation
  (`requestId`, `dedupeKey`, `eventType`, channel) so ops can inspect, and are
  **replayable**: because delivery is idempotent, replaying a DLQ item re-attempts
  only the still-failed channel for the still-un-delivered recipient.
- **Alerting.** Sustained DLQ growth alerts ops (`ADR-NOTIF-06`); it is a signal of
  a provider problem, not something to auto-scale around (`scalability-design`).

## Graceful Degradation Tiers

Mapping each dependency to a tier and behaviour (NFR-design degradation model):

| Dependency | Tier | Degradation behaviour |
|-----------|------|-----------------------|
| Queue / broker | Critical to *this unit* (but not to the workflow) | If enqueue fails on the producer side, the producer logs and moves on — the workflow still commits (non-blocking); a durable broker with retry-on-publish minimises loss. In-process MVP shares the app lifecycle. |
| Email provider | Important | Down → email retried, then dead-lettered; **in-app copy still delivered** (BR-NOTIF-7). |
| In-app store | Important | Down → in-app retried, then dead-lettered; **email still sent**. |
| Recipient directory | Important | Unresolvable recipient → `skipped(RECIPIENT_UNRESOLVED)`, batch still succeeds for resolvable recipients (BR-NOTIF-4/8); transient directory error is retried. |
| `CryptoPort` (for persisted PII body) | Fail-closed | Unavailable → in-app persist fails and is retried/dead-lettered rather than writing plaintext PII (`security-design` BR-PII-3). |

The whole unit is the **Important** tier from the workflow's perspective: it must
degrade gracefully, never bring down or block the Critical command path.

## Health Checks

- **Shallow (liveness)**: worker process up, queue subscription active.
- **Deep (readiness)**: can reach the queue, the delivery-record store, and at least
  one channel; report per-channel breaker state. A deep check that finds all
  channels' breakers Open is *degraded*, not dead — the unit still drains and
  dead-letters correctly.
- Health/breaker state and DLQ depth are exported as metrics (`ADR-NOTIF-06`).

## Recovery & Durability

- **Restart-safe.** Workers are stateless; on restart they resume pulling from the
  durable queue. In-flight events not acked are redelivered (at-least-once) and made
  safe by idempotency (BR-NOTIF-9).
- **No lost transitions.** Because notification is downstream of an
  already-committed transition, unit recovery never affects workflow correctness;
  worst case is delayed or dead-lettered delivery, reconcilable from the append-only
  `NotificationDelivery` trail.
- **DLQ replay** is the recovery procedure for a provider outage: once the provider
  is healthy, replay dead-lettered items (idempotent, so safe).

## Failure-Mode Checklist

- **Email provider transient 5xx** → retry w/ backoff+jitter; in-app unaffected;
  succeeds or dead-letters after 3 attempts.
- **Email provider sustained outage** → breaker opens, email fails fast to DLQ;
  in-app delivery continues; ops alerted on DLQ growth.
- **Duplicate event (bus redelivery / worker crash re-pull)** → deduped per
  recipient; no double send.
- **In-app store down** → in-app retried/dead-lettered; email still sent.
- **Recipient unresolvable** → skipped (non-fatal); other recipients still notified.
- **Worker crash mid-batch** → un-acked events redelivered; idempotency prevents
  re-send of already-recorded channels.
- **Blast radius** → confined to notification delivery latency/completeness for
  in-flight events on the affected worker; zero impact on workflow state.

## Verification

- **Idempotency test**: deliver the same event twice; assert exactly one email +
  one in-app per recipient and a single completed `NotificationDelivery`.
- **Channel-isolation test**: force the email adapter to fail; assert in-app still
  delivered and email dead-lettered after the configured attempts.
- **Circuit-breaker test**: drive 5 consecutive email failures; assert the breaker
  opens, subsequent sends fail fast, and half-open probes close it on recovery.
- **Non-blocking test**: assert a channel failure returns inside the batch result
  and never throws back to / blocks the workflow commit
  (`business-logic-model` guarantee).
- **DLQ replay test**: dead-letter an item, then replay; assert idempotent
  completion of only the failed channel.
