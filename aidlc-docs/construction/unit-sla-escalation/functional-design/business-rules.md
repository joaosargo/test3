# Vacation Request App — Business Rules — `unit-sla-escalation`

Decision rules, SLA policy, idempotency invariants, and edge cases for the **SLA
Reminder and Escalation** unit. Rules trace to `req-sla-reminder-escalation`
(from [[requirements]]) via the single story the [[unit-of-work-story-map]]
assigns to this unit (`story-sla-escalation`). Rule shapes align with the
delivery signatures this unit reuses from [[component-methods]] (`notification`
section) and the choreography/side-effect placement in [[services]]; the
scanning boundary is fixed by the `unit-sla-escalation — SLA Reminder and
Escalation` definition in [[unit-of-work]], which makes this unit **depend on**
`unit-request-workflow` (pending-request source) and `unit-notifications` (send
seam) as defined in [[components]].

Convention: rule ids are stable — `BR-SLA-*` for scan/policy/delivery rules,
`BR-PII-*` for PII rules (extending the taxonomy shipped by
`unit-platform-authz`, `unit-request-workflow`, and `unit-notifications`). Every
rule is **non-blocking with respect to the workflow**: an SLA notice failure is
retried and dead-lettered, never propagated back as a workflow error — the
request was already sitting, and a failed nudge cannot corrupt request state.

## Scan & Eligibility Rules

- **BR-SLA-1 (Only awaiting-actor requests are in scope).** A request is SLA-
  eligible only while its `RequestStatus` (from `unit-request-workflow`) is
  **awaiting an actor**: `Submitted` (awaiting `TeamLead`) or `Validated`
  (awaiting `HR`). `Approved`, `Rejected`, and `Withdrawn` are terminal and never
  scanned (`BR-SLA-9`). This directly realises "reminder and escalation" on the
  two-stage workflow without inventing a new state.
- **BR-SLA-2 (The SLA clock is per-stage, read from the transition history).**
  Elapsed pending time for a request is measured from the `atMs` of the
  `Transition` that put it into its current pending status — the latest
  transition *into* `Submitted` or `Validated`, read read-only from the workflow
  aggregate's append-only `history` (`unit-request-workflow` `domain-entities`
  `Transition.atMs`). Advancing `Submitted → Validated` **stops** the `TeamLead`
  clock and **starts** a fresh `HR` clock. No new timestamp is added to the
  request; this unit never mutates the aggregate.
- **BR-SLA-3 (Elapsed time is policy-configurable: wall-clock vs business
  hours).** `clock.elapsed(enteredAtMs, nowMs, policy.businessHours?)` computes
  elapsed either as raw wall-clock or business-hours-aware (weekends/holidays
  excluded) per the injected policy. MVP default is wall-clock; business-hours is
  a policy flag (see `memory.md` open question). The clock is **injected** for
  deterministic tests (same pattern as the workflow/notification clocks).
- **BR-SLA-9 (Terminal and just-transitioned requests self-heal).** If a request
  transitions or is withdrawn between scans, the next `listPending()` simply no
  longer returns it and no further notices fire — no cancellation logic is
  required; the scan derives eligibility freshly each tick from live state.

## SLA Policy & Tier Rules

- **BR-SLA-4 (Ordered tiers per stage).** The `EscalationPolicy` defines, per
  stage (`TeamLead`, `HR`), an **ordered** threshold set:
  `Reminder` (a gentle nudge) fires after `reminderAfterMs`; `Escalation`
  (breach) fires after `escalateAfterMs`, with `reminderAfterMs <
  escalateAfterMs`. `classify(stage, elapsed)` returns the **highest** tier whose
  threshold `elapsed` has crossed: `OnTrack` → `ReminderDue` → `EscalationDue`.
- **BR-SLA-4a (Thresholds are injected configuration, not hardcoded).**
  `req-sla-reminder-escalation` specifies the *behaviour* (remind, then escalate)
  but no numeric SLA; the raw intent gives none. Thresholds and tier count are
  therefore configuration with documented placeholder defaults (illustrative:
  `TeamLead` reminder 24h / escalate 48h; `HR` reminder 48h / escalate 96h), to
  be confirmed with product/HR (`memory.md`). The policy is validated at load:
  monotonic increasing thresholds per stage, else a misconfiguration throw (the
  one place throwing is allowed, mirroring the shipped units).
- **BR-SLA-5 (Recipient by tier).** `Reminder` targets the **pending actor** for
  the stage — the team lead (for `Submitted`) or HR (for `Validated`) — resolved
  via the notifications `RecipientDirectoryPort.resolveActor(department, role)`,
  optionally copying the owner for transparency. `Escalation` additionally targets
  the **escalation contact** (e.g. the pending actor's manager / a fixed HR-ops
  mailbox) — the concrete target is an open question (`memory.md`), modelled as an
  injected `escalationContactResolver` so the policy, not the code, decides.
- **BR-SLA-11 (Escalation supersedes but does not replace a prior reminder).**
  Reaching `EscalationDue` does not retract an already-sent `Reminder`; the
  reminder was a fact at its time. Both tiers are recorded independently in the
  ledger (a request can legitimately have a `Reminder` record *and* an
  `Escalation` record for the same stage).

## Idempotency & Delivery Rules

- **BR-SLA-6 (At-most-once per (requestId, stage, tier)).** Each tier fires at
  most once for a given request+stage. Before dispatching, the scan checks the
  append-only ledger: if a `ReminderRecord` exists for `(requestId, stage,
  tier)`, that tier is skipped. This makes overlapping/retried scan ticks
  idempotent — the correctness guarantee is the ledger key, not exactly-once
  scheduling (mirrors notifications `BR-NOTIF-9`).
- **BR-SLA-6a (Catch-up fires skipped lower tiers once).** If a request is first
  seen already past the escalation threshold (e.g. the scanner was down), the scan
  fires each *un-fired* tier up to the current one exactly once (reminder then
  escalation), so a nudge is never silently swallowed by a coarse scan cadence.
- **BR-SLA-7 (Append-only reminder ledger).** Every fired tier appends one
  `ReminderRecord`; records are never mutated or deleted (operational fact trail).
  This is distinct from the compliance `audit-trail` (owned by `unit-audit-trail`)
  and from the notification unit's `NotificationDelivery` record — it captures
  *SLA decisions*, not raw channel sends.
- **BR-SLA-8 (Non-fatal, non-blocking).** No scan outcome — success, skip, or
  send failure — ever blocks or reverses a workflow transition. This unit runs on
  a timer, entirely off the synchronous command path (choreography, per
  [[services]]). Failures are values inside the `ScanSummary`, not thrown/blocking
  errors.
- **BR-SLA-12 (Delivery reuses the notification seam; retry/dead-letter is
  inherited).** Dispatch goes through `unit-notifications`' `EmailSenderPort` /
  `InAppInboxPort`; a transient channel failure is retried with backoff and, on
  exhaustion, dead-lettered — this unit does not re-implement transport reliability
  (`BR-NOTIF-7/10` apply to the send). The ledger records the *decision to send*;
  the notification delivery record (if any) records the *send outcome*.

## PII Protection Rules

- **BR-PII-1 (Scan works from pseudonymous ids only).** The pending-request query
  view carries only `requestId`, `ownerId`, `department`, `actorId`, `status`, and
  transition timestamps — no email, name, or free-text reason (upstream workflow
  `BR-INV-6`; consistent with the PII-free bus of `unit-notifications`
  `BR-PII-1`). This unit adds no PII to any request it observes.
- **BR-SLA-10 / BR-PII-4 (Ledger is PII-free).** `ReminderRecord` stores only
  `requestId`, `stage`, `tier`, a PII-free outcome code
  (`DISPATCHED`, `RECIPIENT_UNRESOLVED`, `CHANNEL_DEAD_LETTERED`), and `firedAtMs`
  — never contact details. All machine codes are PII-free (mirroring notifications
  `BR-PII-4` and audit `BR-AUD-8`).
- **BR-PII-2 (Contact PII resolved late, never logged).** Recipient/escalation
  contact (email, display name) exists only transiently while building the
  outbound SLA message via the notifications directory port; it MUST NOT appear in
  logs, error `cause`, or the ledger — `redactForLog` at every boundary
  (extending notifications `BR-PII-2`).

## Validation & Edge Cases

- **Request advances between scans** → next `listPending()` no longer returns it;
  the finished stage's timers stop; the new stage's clock starts from its own
  transition (`BR-SLA-2/9`). No explicit cancellation.
- **Request withdrawn / decided before any reminder** → excluded next tick; no
  notice sent (`BR-SLA-1/9`).
- **Scanner missed several cadences (downtime)** → catch-up fires each un-fired
  tier once, in order, on the next successful tick (`BR-SLA-6a`); no duplicate
  reminders for tiers already in the ledger (`BR-SLA-6`).
- **Overlapping / double-fired scheduler tick** → deduped by the ledger key; each
  tier still fires at most once (`BR-SLA-6`).
- **Escalation contact unresolvable** → recorded `RECIPIENT_UNRESOLVED`, batch
  continues; the reminder (if separately targeted) is unaffected (`BR-SLA-5/8`).
- **Email provider persistent failure on a notice** → dead-lettered by the
  notification seam after bounded retries; the SLA scan itself still succeeds and
  the in-app copy still lands (`BR-SLA-12`, notifications `BR-NOTIF-7/10`).
- **Misconfigured policy (non-monotonic or missing stage thresholds)** → fails at
  load with a misconfiguration throw (the one allowed throw), never silently
  scanning with a broken policy (`BR-SLA-4a`, fail-closed).
- **A request whose pending stage has no configured tier** (policy covers only
  the other stage) → treated `OnTrack`; no notice — the policy, not the code,
  decides coverage (`BR-SLA-4`).
