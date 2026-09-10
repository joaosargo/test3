# Vacation Request App — Frontend Components — `unit-audit-trail`

Frontend design for the **Immutable Audit Trail** unit. This unit is primarily a
backend event sink; its **only** UI surface is a **read-only audit inspection
view** for the `compliance-auditor` persona (Aisha) — there is no create, edit,
or delete UI, by design (`req-constraint-append-only-store`,
`req-immutable-audit-trail`). This artifact is included because
`story-immutable-audit` in [[unit-of-work-story-map]] gives the auditor a
first-class inspection need; it is deliberately thin, consistent with the
choreography-consumer role in [[services]] and the `audit-trail` read signatures
in [[component-methods]]. The component boundary
(`audit-trail → vacation-request-workflow`) from [[components]] and the
`unit-audit-trail` definition in [[unit-of-work]] bound the scope; the driving
requirements are `req-immutable-audit-trail`, `req-nfr-audit-retention`, and
`req-nfr-security-pii` from [[requirements]].

The app ships static HTML surfaces (`public/login.html`, `public/requests.html`)
plus a small server-rendered/fetch pattern; this view follows that same
lightweight pattern rather than introducing a heavy SPA framework — matching the
shipped tech posture.

## Component Hierarchy

```
AuditTrailPage                         (route: /audit, guarded — auditor only)
├── AuditFilterBar                     (department, event type, actor, date range)
├── IntegrityBanner                    (result of verifyChain for the current view)
└── AuditRecordTable                   (read-only, append-order)
    └── AuditRecordRow  (× n)          (one immutable record per row)
```

- **AuditTrailPage** — top-level container. On mount, calls the read API and
  renders results; owns filter state and the integrity-check trigger. Guarded by
  the shipped auth + authz middleware (`requireSession` → `requirePermission`);
  an unauthorized visitor fails closed with `401`/`403`, never sees the page.
- **AuditFilterBar** — controlled inputs for `TrailQuery` fields (all optional).
  Emits a `TrailQuery` object upward; never mutates data.
- **IntegrityBanner** — shows `verifyChain` outcome: green "chain intact" or red
  "integrity violation at record N" — the visible teeth of tamper-evidence.
- **AuditRecordTable / AuditRecordRow** — render the returned `AuditRecord[]`
  read-only. Columns: occurred-at, event type, resulting state, actor id
  (pseudonymous), department, record hash (truncated). No row action buttons —
  there is nothing to edit or delete.

## Props / State Design

State is minimal and unidirectional; the page holds it, children are controlled.

```ts
// Read-only DTO the API returns — mirrors AuditRecord (domain-entities), id-only per BR-AUD-8.
interface AuditRecordView {
  readonly auditId: string;
  readonly eventType: string;
  readonly requestId: string;
  readonly department: string;
  readonly actorId: string;        // pseudonymous — never a name/email (req-nfr-security-pii)
  readonly resultingState: string;
  readonly rejectedStage?: string; // present only for RequestRejected
  readonly occurredAtMs: number;
  readonly recordedAtMs: number;
  readonly hash: string;
}

interface TrailFilter {
  readonly department?: string;
  readonly eventType?: string;
  readonly actorId?: string;
  readonly fromMs?: number;
  readonly toMs?: number;
}

interface AuditPageState {
  readonly filter: TrailFilter;
  readonly records: readonly AuditRecordView[];
  readonly integrity: 'unknown' | 'intact' | 'violated';
  readonly loading: boolean;
  readonly errorCode?: string;     // PII-free code from AuditError, never raw text
}
```

- `records` is `readonly` end-to-end — the UI cannot express a mutation, which
  reinforces the append-only contract at the presentation layer.
- `errorCode` carries only the machine-readable `AuditError.code`
  (`MALFORMED_EVENT` / `INTEGRITY_VIOLATION` / `NOT_FOUND`) — no PII, matching the
  backend PII posture (`BR-AUD-8`).

## Interaction Flows

1. **View a request's trail (happy path)**: auditor opens `/audit`, enters a
   `requestId` (or filters), the page calls `GET /audit/requests/:requestId` →
   renders the ordered `AuditRecordRow`s. Empty result renders an explicit
   "no audit records" empty-state, not an error.
2. **Verify integrity**: auditor clicks "Verify chain"; the page calls
   `POST /audit/requests/:requestId/verify` → `IntegrityBanner` shows intact or
   the offending `auditId`. This is the primary trust action for the persona.
3. **Filtered query**: auditor sets `AuditFilterBar` fields → page calls
   `GET /audit?department=…&eventType=…&from=…&to=…` → table re-renders.
4. **Unhappy paths**:
   - Unauthorized → guarded route returns `401`/`403`; the page is never served
     (fail closed).
   - Unknown request id → `NOT_FOUND` code → friendly "no such request" message.
   - Integrity violation → red banner naming the record; the records still render
     (the auditor must see the tampered evidence, not have it hidden).

## Form Validation Rules

The only inputs are read filters (no data-entry forms — there is nothing to
submit into the trail). Client-side validation is limited to:

- **Date range**: if both `fromMs` and `toMs` are set, `fromMs <= toMs`; else a
  non-blocking inline hint (the query still runs, server clamps).
- **Event type**: constrained to the five known `EventType` members via a
  dropdown — free text is not accepted, so a malformed filter cannot be built.
- **All filters optional**: an empty filter is valid and returns the full trail
  (subject to the auditor's scope). No required-field validation exists because
  the view issues reads only.

Because every interaction is a read, there is **no optimistic update, no
concurrency token, and no submit-then-reconcile flow** — the presentation layer
has no path that writes to the audit trail, which is exactly the property
`req-constraint-append-only-store` demands, enforced all the way to the UI.
