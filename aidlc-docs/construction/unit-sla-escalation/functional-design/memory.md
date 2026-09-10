# Functional Design — memory — `unit-sla-escalation`

> Running log for the functional-design stage of unit-sla-escalation.
> Add observations at the gate ritual, not by editing here directly.

## Interpretations
- 2026-09-10T14:46:24Z — treated the SLA "clock" as elapsed time since the request entered its current *pending* state (Submitted→awaiting TeamLead, Validated→awaiting HR), read from the workflow aggregate's append-only transition history (`atMs` of the latest transition); context: unit-request-workflow exposes `history: Transition[]` with per-transition `atMs`, so no new timestamp field is needed.
- 2026-09-10T14:46:24Z — modelled the unit as a periodic scanner (timer-driven) rather than an event-driven consumer, because reminders/escalations fire on the *absence* of a transition (elapsed time), which events cannot signal; context: the notifications unit is event-driven, this unit is the timer half explicitly deferred by unit-notifications.
- 2026-09-10T14:46:24Z — reused the notifications send seam (`EmailSenderPort`/`InAppInboxPort`) as read-only downstream ports rather than re-implementing delivery; context: unit-notifications business-logic-model states "this unit exposes the send capability; SLA owns the scheduling".

## Deviations
- 2026-09-10T14:46:24Z — no separate durable event contract introduced; the unit reads pending requests through a workflow query port and sends through the notification seam, so it defines only its own escalation-policy value objects and an append-only reminder-ledger; context: least-coupling, mirrors how unit-notifications avoided redefining the event union.

## Tradeoffs
- 2026-09-10T14:46:24Z — chose an idempotent reminder-ledger keyed by (requestId, stage, tier) over storing "last reminded at" on the request; context: the workflow aggregate is owned by another unit and must not be mutated by this side-effect unit, so escalation bookkeeping lives in this unit's own append-only store.
- 2026-09-10T14:46:24Z — thresholds and tiers modelled as injected configuration (business hours vs wall-clock deferred) rather than hardcoded; context: req-sla-reminder-escalation gives no numeric SLA, and the raw intent gives none — kept configurable, flagged as open question.

## Open questions
- 2026-09-10T14:46:24Z — concrete SLA thresholds (reminder at N hours, escalate at M hours) and whether the clock is business-hours-aware are unspecified by requirements/intent; assumed injected config with placeholder defaults, to confirm with product/HR.
- 2026-09-10T14:46:24Z — escalation *target* (who is notified on breach: the pending actor's manager? HR? a fixed ops mailbox?) is unspecified; assumed "the next escalation contact resolved via the notification RecipientDirectoryPort role-in-department lookup", to confirm.
- 2026-09-10T14:46:24Z — scanner cadence and the deployed scheduler binding (cron/EventBridge Scheduler) are an infrastructure-design concern; functional design fixes only the port shape.
