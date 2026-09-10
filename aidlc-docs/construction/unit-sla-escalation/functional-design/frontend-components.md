# Vacation Request App — Frontend Components — `unit-sla-escalation`

> **Conditional artifact.** The stage marks `frontend-components.md` as *only if
> the unit includes frontend/UI*. `unit-sla-escalation` is a **headless,
> timer-driven back-end unit**: it scans for overdue requests and dispatches
> reminder/escalation notices through the **existing** `unit-notifications` send
> seam. It introduces **no new user-facing screen, form, or component of its
> own.** This document records that decision explicitly and describes the one
> reused surface (the in-app inbox owned by `unit-notifications`) so the boundary
> is unambiguous.

Grounded in the delivery signatures this unit reuses from [[component-methods]]
(`notification` section), the side-effect boundary in [[components]], the
choreography placement in [[services]], and the single owned story in
[[unit-of-work-story-map]] (`story-sla-escalation`) covering
`req-sla-reminder-escalation` from [[requirements]], scoped by the
`unit-sla-escalation — SLA Reminder and Escalation` definition in
[[unit-of-work]]. It consumes the session established by `unit-platform-auth`
only indirectly, via the notification surface it reuses.

## Why This Unit Has No Own UI

- **Timer-driven, not user-driven.** The unit's only trigger is a scheduler tick
  (`SchedulerPort`), not a user action. There is no page a user opens to "run an
  SLA scan"; the behaviour is background scheduling
  (`business-logic-model` Design Approach).
- **Output rides the existing channels.** A reminder or escalation is delivered
  as an **email** and an **in-app** notification through the reused
  `EmailSenderPort` / `InAppInboxPort` (`unit-notifications` `domain-entities`
  ports). The user *sees* the escalation in the notification bell/inbox that
  `unit-notifications` already renders — this unit adds a new *reason to notify*,
  not a new place to look.
- **Least coupling / no duplicate surface.** Building a second inbox here would
  duplicate `unit-notifications`' `<NotificationBell>` / `<NotificationInbox>`
  and violate the least-coupling boundary the `components` architecture
  established. The SLA notice is just another `InAppNotification` in the same
  self-scoped inbox.

## Reused Surface (owned by `unit-notifications`)

SLA reminders and escalations appear in the **existing** in-app inbox without any
new component:

- `<NotificationBell>` / `<NotificationInbox>` / `<NotificationItem>` — defined in
  `unit-notifications` `frontend-components`; an SLA notice is rendered by the same
  `<NotificationItem>` because it is an `InAppNotification` with an SLA-flavoured,
  server-rendered, **PII-free** title/body (`BR-PII-1/2`).
- **Self-scoped, server-authoritative.** The reused inbox is keyed on the viewing
  principal (`BR-NOTIF-12`); an escalation targeted at a team lead or HR appears
  only in *that* recipient's inbox. This unit relies on the notification unit's
  self-scope enforcement and adds no client-side authorization.
- **Advisory, non-blocking.** As with all notifications, an SLA item reflects a
  fact (a request has been waiting too long) and never gates a workflow action
  (`BR-SLA-8`); clicking it navigates to the underlying request view owned by
  `unit-request-workflow`.

## Interaction Flows (via the reused inbox)

1. **Reminder appears.** A request sits in `Submitted` past the `TeamLead`
   reminder threshold; on the next scan tick the team lead accrues an in-app
   "request awaiting your validation — reminder" item (and an email). It renders in
   the existing bell/inbox; the SLA unit contributes only the content and timing
   (`BR-SLA-5`).
2. **Escalation appears.** The same request crosses the escalation threshold; the
   escalation contact accrues an in-app "request breached SLA" item. The earlier
   reminder is **not** retracted (`BR-SLA-11`); both are distinct inbox items.
3. **No duplicate on re-scan.** Overlapping/retried scan ticks do not create a
   second item — the ledger dedupes per `(requestId, stage, tier)` (`BR-SLA-6`),
   so the inbox count stays correct with no client logic.
4. **Request resolves.** Once the request is validated/approved/withdrawn it exits
   SLA scope (`BR-SLA-9`); no further items appear — the inbox simply stops
   accruing SLA notices for it.

## Form Validation Rules (summary)

This unit exposes **no data-entry form and no client action of its own** — it is
headless. There are therefore no field-level validation rules to define here. The
only user interactions with SLA output are the *reused* notification actions
(open inbox, mark read, open request link), whose contracts are owned by
`unit-notifications` `frontend-components` and are unchanged by this unit:

| Action | Rule | Owner |
|--------|------|-------|
| view SLA notice | appears in the self-scoped inbox; server-authoritative | `unit-notifications` (`BR-NOTIF-12`) |
| mark read | idempotent; targets only the viewer's own notification id | `unit-notifications` (`BR-NOTIF-12`) |
| open request link | navigates to the request view; no mutation | `unit-request-workflow` |

All SLA behaviour is server-side and timer-driven; the client renders reused,
PII-free notification content only.
