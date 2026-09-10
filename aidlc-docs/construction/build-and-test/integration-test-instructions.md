# Integration Test Instructions — Vacation Request App

Owner: aidlc-quality-agent. Strategy level: **Comprehensive**. Covers
cross-unit interaction at the module boundaries of the modular monolith and
external-dependency handling through the hexagonal ports. Grounded in the
per-unit [[code-summary]] integration notes and the [[code-generation-plan]]
port contracts.

## Scope

Because this is a modular monolith, "integration" means **in-process module
boundaries**, not network calls between deployed services:

1. **HTTP boundary** — Express routers exercised via `supertest`-style
   in-process requests (the units ship router tests such as
   `workflow/http/workflow-router.test.ts`, `audit/http/audit-router.test.ts`,
   `http/auth-router.test.ts`). Assert status codes and response shapes:
   401 unauthenticated, 403 unauthorized, 200/201 happy path, 404 unknown.
2. **Auth → Authz composition** — guarded routes compose
   `requireSession(...)` → `requirePermission(authz, '<permission>')` →
   handler. Verify the fail-closed ordering: no session ⇒ 401 before any authz
   check; session but no grant ⇒ 403 before any state read.
3. **Choreography event flow** — the workflow publishes `WorkflowEvent`s that
   the audit trail, notifications, and SLA-escalation units consume via the
   `EventPublisher` port. `notifications/notification-choreography.test.ts` is
   the reference: publish a transition event, assert exactly one downstream
   effect (audit record appended / notification enqueued), and assert the
   consumers never call the workflow back.
4. **Command → Authz → State ordering** — a command obtains an authorization
   decision from the PDP **before** any state read/write; a deny touches no
   state (`BR-WF-7`). Assert the deny path leaves the repository unchanged.

## Framework setup

- Same Vitest runner and config as unit tests — integration tests are `*.test.ts`
  files under `src/**/http/` and the choreography test at
  `src/notifications/notification-choreography.test.ts`.
- Real in-process dependencies (in-memory adapters wired through the
  composition root), **not** mocks, so the boundary contract is exercised end
  to end within the process.
- No external services: OIDC IdP, Redis, HRIS, and the event bus are all
  in-memory adapters. This keeps integration tests deterministic and CI-safe.

## How to run

```bash
npm test                                   # runs unit + integration together
npx vitest run src/**/http                 # HTTP-boundary tests only
npx vitest run src/notifications/notification-choreography.test.ts
```

## Coverage targets (Comprehensive)

- Every guarded endpoint has 401 / 403 / happy-path / not-found coverage.
- Every published `WorkflowEvent` type that a consumer subscribes to has a
  choreography test asserting the downstream append/enqueue.
- HTTP router branch coverage may sit below the domain layer (routers are thin);
  the whole-repo branch gate (≥ 75%) still applies to the aggregate.

## Cross-unit interaction matrix (reference)

| Producer | Boundary | Consumer(s) |
|----------|----------|-------------|
| auth (`AuthService`) | `AuthenticatedPrincipal` via `requireSession` | every guarded router |
| authz (`AuthzService.decide`) | `requirePermission` middleware | workflow, status-query, audit, overlap |
| workflow | `WorkflowEvent` via `EventPublisher` | audit-trail, notifications, sla-escalation |
| workflow | request aggregate reads | status-query, overlap-indicator |
| hris | display-only balance read | request UI (display only) |

## Test data & environment

- Each test seeds its own principals, grants, and aggregates through the
  in-memory adapters; no shared mutable state.
- Reset/rebuild adapters in `beforeEach` so ordering never leaks between tests.
- Assert PII-free event payloads at every boundary (pseudonymous ids only).
