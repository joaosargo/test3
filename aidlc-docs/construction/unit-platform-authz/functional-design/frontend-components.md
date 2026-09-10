# Vacation Request App — Frontend Components — `unit-platform-authz`

> **Conditional artifact.** The stage marks `frontend-components.md` as
> *only if the unit includes frontend/UI*. `unit-platform-authz` (Authorization
> & RBAC + PII protection) is a **backend policy/enforcement unit with no UI of
> its own**. This document records that determination and the authorization
> contract the frontend consumes, so downstream UI units have a single source of
> truth. It intentionally defines **no owned components**.

Basis for the determination, traced to inputs:

- The [[components]] boundary places `authorization-rbac` as a server-side
  decision component (`authorization-rbac → auth-sso-adapter`); no view surface.
- The [[component-methods]] `authorization-rbac` signatures are all
  decision/resolution methods — no rendering or form contract.
- The [[unit-of-work]] definition `unit-platform-authz — Authorization and RBAC`
  scopes the unit to authorization and PII, not presentation.
- The two owned stories in [[unit-of-work-story-map]]
  (`story-rbac-role-access`, `story-pii-protection`) and their requirements
  (`req-rbac-three-roles-hr-scoping`, `req-nfr-security-pii` from
  [[requirements]]) are enforcement concerns; the visible screens they influence
  are owned by other units (the login page by `unit-platform-auth`, request and
  status screens by `unit-request-workflow` / `unit-status-query`).
- The [[services]] artifact places this unit on the synchronous command path
  behind the API, not in a client tier.

## Ownership Determination

**No frontend components are owned by this unit.** No component hierarchy,
props/state design, form-validation rules, or client-side routing is defined
here. Any UI change required to reflect authorization outcomes is realized in the
consuming units' components, not here.

Rationale (least coupling / highest cohesion): folding role-gated UI widgets into
this unit would couple a pure backend policy engine to presentation and duplicate
view logic that already belongs to the workflow/status units. The unit stays
cohesive as an authorization decision + PII-protection boundary.

## Consumed Authorization Contract (for UI units)

Although this unit renders nothing, its decisions shape what consuming UIs may
show. UI units integrate against this contract (server-authoritative — the
client MUST NOT re-derive authorization; the server decision is the source of
truth):

- **Role-driven affordances.** The API surfaces the resolved `Role`
  (`Employee` | `TeamLead` | `HR`) so consuming screens can *hint* which actions
  to display (e.g. a team lead sees a "Validate" control, HR sees "Approve /
  Reject"). This is a UX hint only; every action is still authorized server-side.
- **Scope-driven lists.** List/query endpoints return only in-scope resources
  (self / own team / authorized departments) per the scoping rules
  (`business-rules.md` BR-AUTHZ-5/6/7); the UI does not filter for security.
- **Deny handling.** A `Deny` decision surfaces to the UI as an HTTP `403` with a
  PII-free machine reason code (`ACTION_NOT_PERMITTED`, `OUT_OF_SCOPE`, …), and
  an unauthenticated request as `401` (owned upstream by `unit-platform-auth`).
  Consuming UIs render a generic "not permitted" state — never the raw reason
  text with any principal PII (BR-PII-2 / BR-PII-5).
- **No PII leakage to the client.** Per `req-nfr-security-pii`, responses this
  unit gates carry redacted principal references, so UIs never receive raw email
  or names beyond what the viewing principal is already entitled to see.

Consuming UI units (out of scope for this unit, listed for traceability):
`unit-request-workflow` (submit/validate/approve screens), `unit-status-query`
(status tracking views), `unit-overlap-indicator` (team-lead overlap hint).
