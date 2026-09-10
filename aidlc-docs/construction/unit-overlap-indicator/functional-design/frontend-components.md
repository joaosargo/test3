# Vacation Request App — Frontend Components — `unit-overlap-indicator`

> **Conditional artifact.** The stage marks `frontend-components.md` as *only if
> the unit includes frontend/UI*. This unit **does** own a small visible
> surface: the team-lead **overlap badge**. The `unit-request-workflow`
> `frontend-components` already reserves the slot — its `<RequestReviewCard>`
> hosts an `<OverlapIndicatorBadge>` "advisory (unit-overlap-indicator)" — so
> this unit owns that badge component and its data contract, while the host card
> (owned by `unit-request-workflow`) owns layout and the decision controls.

Grounded in the `overlap-indicator` signature of [[component-methods]], the
`overlap-indicator → vacation-request-workflow` boundary in [[components]], and
the side-effect placement in [[services]]. It consumes the
**authorization contract** published by `unit-platform-authz`
(server-authoritative; the client MUST NOT re-derive authorization) and realizes
the single story `story-overlap-indicator` for requirement `req-overlap-indicator`
(from [[requirements]] / [[unit-of-work-story-map]]), which depends on
`story-lead-validate`.

## Design Principles

- **Advisory, never a gate.** The badge is a pure decision aid. It never
  disables, delays, or requires justification for the Validate/Reject controls
  on the host `<RequestReviewCard>` (`BR-ADV-2`; mirrors the balance-hint posture
  in `unit-request-workflow` `frontend-components`).
- **Server-authoritative.** The overlap summary is computed server-side behind
  the same `requirePermission('request:validate')` guard as the review action;
  the client renders what the server returns and performs no client-side
  authorization or scope filtering.
- **Fail-open rendering.** If the overlap request errors or is unavailable, the
  badge renders a neutral "overlap unavailable" state — it never surfaces an
  error that could be mistaken for a blocked decision (`BR-ADV-3`).
- **PII-free.** The badge shows a count and an at-a-glance severity only; it
  never renders owner names, emails, or reasons (`BR-PII-1/2`).

## Component Hierarchy

This unit contributes exactly one leaf component, slotted into the host card
owned by `unit-request-workflow`:

```
<RequestReviewCard>                     // owned by unit-request-workflow (host)
 ├─ <OverlapIndicatorBadge>             // ← OWNED BY THIS UNIT
 ├─ <BalanceHint>                       // owned by unit-hris-balance (advisory)
 └─ <DecisionBar action="validate|reject">   // owned by unit-request-workflow
```

The unit owns the badge and its data-fetching hook only; it does not own the
card, the queue page, or the decision controls (least coupling / highest
cohesion — the advisory widget stays independent of the command UI).

## Component Contracts (props / state / interaction)

### `<OverlapIndicatorBadge>` — the team-lead overlap hint (`story-overlap-indicator`)
- **Props**:
  - `summary?: OverlapSummary` — `{ hasOverlap, overlapCount, overlappingIds, window }`
    from the server (`domain-entities`).
  - `loading: boolean` — request in flight.
  - `unavailable?: boolean` — set when the overlap read failed (fail-open).
- **Local state**: none required beyond an optional tooltip-open flag; the
  component is presentational and derives everything from `summary`.
- **Rendering**:
  - `loading` → subtle skeleton/spinner in the badge slot.
  - `unavailable` → neutral "overlap unavailable" chip (no error styling).
  - `summary.hasOverlap === false` → neutral "No overlap" chip.
  - `summary.hasOverlap === true` → attention chip showing
    `"{overlapCount} overlapping"`; tooltip lists the reviewed `window` and the
    number of overlapping requests (ids are opaque, no PII).
- **Interaction**: the badge is **non-interactive with respect to the workflow** —
  clicking it may open a read-only tooltip/popover, but it exposes **no action**
  that mutates a request. It never gates the sibling `<DecisionBar>`.

### `useOverlapSummary(requestId)` — data hook (owned by this unit)
- **Behaviour**: on mount of a `<RequestReviewCard>` for a lead, issues
  `GET /requests/:id/overlap` (the guarded read endpoint backing
  `OverlapReader.computeOverlap`).
- **Maps the response**:
  - `200` → `{ summary, loading: false }`.
  - non-`200` / network error → `{ unavailable: true, loading: false }`
    (fail-open — never throws into the card).
- The hook is scoped to the lead review view; it is not fetched for the employee
  or HR views (HR sees `Validated` requests and the story scopes overlap to the
  team-lead review of `Submitted` requests, `story-overlap-indicator` depends on
  `story-lead-validate`).

## Interaction Flows (end-to-end, tie to Business Scenarios)

1. **Overlap present (happy advisory path).** Lead opens a `Submitted` request;
   `useOverlapSummary` fetches → badge shows "2 overlapping"; lead still clicks
   Validate or Reject freely (badge never disables the bar).
2. **No overlap.** Fetch returns `overlapCount = 0` → neutral "No overlap" chip.
3. **Overlap unavailable (fail-open).** Fetch errors → "overlap unavailable"
   chip; the Validate/Reject controls remain fully enabled (`BR-ADV-3`).
4. **Non-lead viewer.** The shared `requirePermission('request:validate')` guard
   returns `403` before the overlap read runs; the badge is not rendered for
   non-lead views at all (`BR-SCOPE-1`).

## Form Validation Rules (summary)

This unit renders **no form and collects no input** — it is a read-only badge, so
there are no client-side validation rules to define. All data flows one way
(server → badge). This is called out explicitly to satisfy the section contract
and to document the deliberate absence of any input surface (consistent with the
advisory, read-only posture in `business-rules` `BR-ADV-1`).
