# Vacation Request App — Frontend Components — `unit-notifications`

> **Conditional artifact.** The stage marks `frontend-components.md` as *only if
> the unit includes frontend/UI*. `unit-notifications` **does own a small UI
> surface**: the **in-app notification** half of `req-notifications-email-inapp`
> is user-visible (a bell/inbox with unread count, a list, and mark-read). The
> **email** half is headless (an outbound adapter, no UI). This document defines
> the in-app components only and records that the email channel renders nothing.

Grounded in the `notification` signatures of [[component-methods]], the
subscriber boundary in [[components]] (`notification → vacation-request-workflow`),
the choreography placement in [[services]], and the single owned story in
[[unit-of-work-story-map]] (`story-notifications`) covering
`req-notifications-email-inapp` from [[requirements]], scoped by the
`unit-notifications — Notification` definition in [[unit-of-work]]. It consumes
the **authorization contract** published by `unit-platform-authz`
(server-authoritative; the client MUST NOT re-derive authorization) and the
session established by `unit-platform-auth`.

## Design Principles

- **In-app only; email is headless.** The email channel is an outbound adapter
  (`EmailSenderPort`) with no client surface. Only the in-app inbox is rendered
  here.
- **Self-scoped, server-authoritative.** A user sees only their **own**
  notifications (`business-rules` `BR-NOTIF-12`); the server enforces the scope,
  the client never filters for security. Unauthenticated → redirect to the SSO
  login owned by `unit-platform-auth` (`401`); a cross-scope read attempt returns
  `403` and renders a generic empty/not-permitted state.
- **Advisory, non-blocking.** Notifications reflect state that already happened
  (choreography, `BR-NOTIF-8`); the inbox is informational and never gates a
  workflow action. It links to the underlying request (owned by
  `unit-request-workflow`) but does not itself mutate request state.
- **Idempotent reads.** `markRead` is idempotent (`BR-NOTIF-12`); the UI may
  optimistically mark-read and reconcile without fear of double effects.

## Component Hierarchy

```
<AppShell>                          // session-guarded container (shared)
 └─ <NotificationBell>              // header affordance: unread count badge
     └─ <NotificationInbox>         // dropdown/panel: the recipient's own notifications
          ├─ <NotificationList>
          │    └─ <NotificationItem> // title, request link, timestamp, read/unread
          └─ <MarkAllReadButton>
```

`<NotificationBell>` mounts in the shared app header alongside the role-driven
nav; the inbox is the same for every role because it is keyed on the viewing
principal, not their role (unlike the workflow queues, which are role-scoped).

## Component Contracts (props / state / interaction)

### `<NotificationBell>`
- **Props**: `unreadCount: number`, `onOpen()`.
- **State**: `open: boolean`.
- **Interaction**: polls or subscribes for the unread count from the guarded
  in-app endpoint; renders a badge when `unreadCount > 0`; opening mounts
  `<NotificationInbox>`.

### `<NotificationInbox>` — list (`story-notifications`)
- **Props**: `notifications: InAppNotification[]`, `loading: boolean`,
  `error?: NotificationError`.
- **Local state**: `unreadOnly` filter toggle.
- **Interaction**: on open → `GET /notifications?unreadOnly=` (self-scoped
  server-side, `BR-NOTIF-12`); on `403` render generic "nothing to show" (never
  raw reason/PII, `BR-PII-2`); on `401` the app redirects to SSO login.

### `<NotificationItem>`
- **Props**: `id`, `title`, `requestId`, `eventType`, `read: boolean`,
  `createdAtMs`, `onMarkRead(id)`, `onOpenRequest(requestId)`.
- **Interaction**: clicking the item → `PATCH/POST /notifications/:id/read`
  (idempotent, `BR-NOTIF-12`) and navigates to the underlying request view owned
  by `unit-request-workflow`; unread items render with an emphasis style.
- **PII**: the title/body are the server-rendered, PII-minimal strings; the
  client displays them verbatim and never receives raw email/reason material
  beyond what the viewer is entitled to see (`req-nfr-security-pii`).

### `<MarkAllReadButton>`
- **Props**: `onMarkAllRead()`, `disabled: boolean` (no unread).
- **Interaction**: marks the visible unread set read (idempotent); optimistic
  update with reconcile on the server response.

## Interaction Flows (end-to-end, tie to Business Scenarios)

1. **Happy path — submit → validate → approve.** As each transition fires
   (choreography), the owner accrues in-app notifications; the bell badge
   increments; opening the inbox lists them newest-first; clicking one marks it
   read and opens the request. The team lead sees a "request awaiting validation"
   item on `RequestSubmitted`; HR sees "request awaiting approval" on
   `RequestValidated` (`BR-NOTIF-3`).
2. **Rejection.** On `RequestRejected` the owner gets an in-app item noting the
   stage (`TeamLead`/`HR`) — a PII-free machine-rendered message, no raw reason
   PII in the badge/title.
3. **Duplicate delivery (bus redelivery).** A redelivered event does not create a
   second inbox item — the server dedupes per `(recipient, dedupeKey)`
   (`BR-NOTIF-9`), so the UI count stays correct with no client logic.
4. **Email-down, in-app-up (graceful degradation).** If the email provider is
   failing, the in-app inbox still populates normally — the channels are
   independent (`BR-NOTIF-7`); the UI is unaffected by the email outage.
5. **Unauthorized read edge.** A crafted request for another principal's inbox
   returns `403`; the UI (which only ever requests the current principal's inbox)
   renders the generic empty state — security is server-side (`BR-NOTIF-12`).

## Form Validation Rules (summary)

The in-app surface is **read + mark-read only** — it has no data-entry form, so
there are no field-level validation rules. The only client action contracts are:

| Action | Rule | Source |
|--------|------|--------|
| open inbox | requires an authenticated session; self-scoped server-side | BR-NOTIF-12 |
| mark read | idempotent; targets only the viewer's own notification id | BR-NOTIF-12 |
| open request link | navigates to the request view; no mutation here | choreography boundary |

All client behaviour is advisory; the server is the source of truth, enforces
self-scope, and dedupes delivery. No client-side authorization filtering is
relied upon for security.
