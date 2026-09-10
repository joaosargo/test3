# Vacation Request App — Frontend Components — `unit-request-workflow`

> **Conditional artifact.** The stage marks `frontend-components.md` as *only if
> the unit includes frontend/UI*. Unlike `unit-platform-authz` (a headless
> policy unit), `unit-request-workflow` **owns visible screens**: the
> [[unit-of-work-story-map]] assigns it the three action stories
> (`story-submit-request`, `story-lead-validate`, `story-hr-approve`), and the
> `unit-platform-authz` `frontend-components` determination explicitly names
> "request and status screens" as owned by `unit-request-workflow`. This
> document therefore defines a real component hierarchy.

Grounded in the `vacation-request-workflow` signatures of [[component-methods]],
the endpoints implied by the [[components]] boundary, and the command path in
[[services]]. It consumes the **authorization contract** published by
`unit-platform-authz` (server-authoritative; the client MUST NOT re-derive
authorization) and covers the request/decision UI for
`req-submit-vacation-request`, `req-team-lead-approve-reject`,
`req-hr-approve-reject-no-override`, and the status surface for
`req-status-tracking` from [[requirements]].

## Design Principles

- **Server-authoritative.** Role-driven affordances are UX *hints* only; every
  action is authorized server-side (per the authz `frontend-components`
  "Consumed Authorization Contract"). The UI shows a control only when the
  resolved `Role` suggests it, but a `403` with a PII-free reason is always
  handled gracefully.
- **Fail-closed rendering.** Unauthenticated → the app redirects to the SSO login
  owned by `unit-platform-auth` (`401`). Unauthorized action → generic "not
  permitted" state (`403`), never the raw reason with PII (BR-PII-2/5 upstream).
- **Optimistic-concurrency aware.** Decision forms submit the request's
  `expectedVersion`; a `STALE_STATE` (409-class) response prompts a re-fetch with
  a "this request changed, review again" banner (BR-INV-3).
- **Balance/overlap are advisory.** Displayed balance (`unit-hris-balance`) and
  overlap hint (`unit-overlap-indicator`) are decision aids; they never disable
  the submit or decision buttons (`req-display-only-balance`).

## Component Hierarchy

```
<AppShell>                         // session-guarded route container
 ├─ <RoleContext.Provider>         // holds resolved Role from /auth/me (hint only)
 │
 ├─ EMPLOYEE view
 │   ├─ <SubmitRequestPage>
 │   │    └─ <VacationRequestForm>  // dates + reason; client validation mirrors BR-VAL-*
 │   └─ <MyRequestsList>           // owner's requests (status-tracking data)
 │        └─ <RequestStatusBadge>  // Submitted/Validated/Approved/Rejected/Withdrawn
 │
 ├─ TEAM-LEAD view
 │   └─ <LeadQueuePage>            // Submitted requests for own team
 │        └─ <RequestReviewCard>
 │             ├─ <OverlapIndicatorBadge>   // advisory (unit-overlap-indicator)
 │             ├─ <BalanceHint>             // advisory (unit-hris-balance)
 │             └─ <DecisionBar action="validate|reject">
 │
 └─ HR view
     └─ <HrQueuePage>              // Validated requests in HR's department scope
          └─ <RequestReviewCard>
               └─ <DecisionBar action="approve|reject">
```

`<RequestReviewCard>` and `<DecisionBar>` are shared between the lead and HR
views — the only difference is the permitted action pair, driven by props, so the
review UI stays cohesive (design-for-change, not duplication).

## Component Contracts (props / state / interaction)

### `<VacationRequestForm>` — submit (`story-submit-request`)
- **Props**: `onSubmit(input: { startDate, endDate, reason? })`,
  `balanceHint?` (advisory), `submitting: boolean`, `error?: WorkflowError`.
- **Local state**: `startDate`, `endDate`, `reason`, per-field validation errors.
- **Client validation (mirrors server BR-VAL-1..4; server remains authoritative)**:
  both dates required and well-formed; `startDate <= endDate`; `startDate` not in
  the past; `reason` length ≤ 1000. Client validation is UX only — the server
  re-validates.
- **Interaction**: on submit → `POST /requests` with the body; on `200` route to
  `<MyRequestsList>` with a success toast; on `400` map `WorkflowError.field` to
  the offending input; on `403` show generic not-permitted.

### `<DecisionBar>` — lead & HR gates (`story-lead-validate`, `story-hr-approve`)
- **Props**: `action: 'validate' | 'reject' | 'approve' | 'reject'`,
  `requestId`, `expectedVersion`, `onDecision(decision, reason?)`,
  `pending: boolean`.
- **State**: optional `reason` text (required-by-UX on reject, optional on
  validate/approve), confirm-dialog open flag.
- **Interaction**: primary button issues the stage command
  (`POST /requests/:id/validate` | `/reject` | `/approve`) with `expectedVersion`;
  on `200` refresh the card to its new terminal/next state; on `409`/`STALE_STATE`
  show the "request changed — review again" banner and re-fetch; on `403` show
  not-permitted. No override control is ever rendered — the UI offers only
  forward/reject, matching `req-hr-approve-reject-no-override` and
  `req-team-lead-approve-reject`.

### `<RequestStatusBadge>` / `<MyRequestsList>` — status (`req-status-tracking`)
- **Props**: `status: RequestStatus`, `history?: Transition[]` (timeline).
- Renders the current status and, on expand, the append-only transition timeline
  (who acted, when, stage, reason) sourced from the persisted history this unit
  owns and `status-tracking` serves.

### `<RoleContext.Provider>`
- Loads the resolved `Role` from the guarded `/auth/me`-class endpoint and exposes
  it to gate which views/controls render. **Hint only** — never a security
  boundary.

## Interaction Flows (end-to-end, tie to Business Scenarios)

1. **Happy path (submit → validate → approve).** Employee submits → request shows
   `Submitted`; team lead opens queue, sees overlap/balance hints, clicks
   Validate → `Validated`; HR opens queue, clicks Approve → `Approved`; employee's
   list badge updates; notifications fire (out of unit).
2. **Lead rejection (unhappy).** Lead clicks Reject with a reason → `Rejected`
   (stage `TeamLead`); HR never sees it; employee list shows rejected + reason.
3. **HR rejection (unhappy).** HR clicks Reject on a `Validated` request →
   `Rejected` (stage `HR`).
4. **Concurrency edge.** Two HR approvers open the same `Validated` request; the
   first approves; the second's Approve returns `STALE_STATE` → banner + re-fetch
   shows it is already `Approved`, decision bar disabled (BR-INV-3).
5. **Unauthorized edge.** An employee crafts a request to `/requests/:id/approve`
   → server `403`; UI (which never rendered that control) handles the response as
   generic not-permitted. Security is server-side; the missing button is only UX.
6. **Withdraw edge.** Owner withdraws a still-`Submitted` request → `Withdrawn`;
   lead queue no longer lists it (BR-WF-9).

## Form Validation Rules (summary)

| Field | Rule | Source |
|-------|------|--------|
| startDate | required, valid date, not past | BR-VAL-1/3 |
| endDate | required, valid date, `>= startDate` | BR-VAL-1/2 |
| reason (submit) | optional, ≤ 1000 chars | BR-VAL-4 |
| reason (reject) | UX-required, ≤ 1000 chars | UX + BR-WF-5 |
| expectedVersion | sent on every decision | BR-INV-3 |

All client rules are advisory; the server is the source of truth and re-runs
every rule. No client-side authorization filtering is relied upon for security.
