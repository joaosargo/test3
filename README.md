# Vacation Request App — `unit-platform-auth`

SSO authentication & session adapter for the vacation-request modular monolith.
This unit establishes **authenticated identity only** — role/department
authorization is owned by `unit-platform-authz` (downstream), and audit events
are emitted to `unit-audit-trail`.

Implements story `story-sso-login`, satisfying `req-sso-authentication` and
`req-constraint-sso-mandatory`.

## Design grounding

- `business-logic-model` — the `beginLogin` / `completeLogin` / `endSession`
  contract and session lifecycle.
- `security-design` — the eight ordered fail-closed assertion checks, session
  cookie hardening, and PII rules.
- `performance-design` — in-process stateless session-token validation on the
  hot path with a shared revocation cache.
- `tech-stack-decisions` — certified OIDC library (never hand-rolled),
  managed secrets, stateless signed token + shared store.

## Stack

TypeScript + Node.js 20 + Express, `openid-client` (certified OIDC), `jose`
(session token signing). Hexagonal layout: the `AuthService` depends on
`OidcClientPort`, `SessionStore`, and `TokenSigner` ports so the validation
logic is unit-testable without a live IdP or Redis.

```
src/
  domain/       entities, value objects, Result, SsoError, crypto helpers
  ports/        OidcClientPort, SessionStore, TokenSigner (anti-corruption)
  services/     AuthService — ordered fail-closed validation + session lifecycle
  adapters/     openid-client, jose signer, in-memory store (swap for Redis in prod)
  http/         Express router, session middleware, security headers
  config/       session + cookie policy
  app.ts        composition root
  server.ts     production entry (reads secrets from env)
public/login.html   SSO-only login page (no local credential form)
```

## Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/auth/login` | Start the SSO handshake; 302 redirect to the IdP |
| GET | `/auth/callback` | Validate the IdP assertion, mint the session cookie |
| POST | `/auth/logout` | Revoke the session server-side (idempotent) |
| GET | `/auth/me` | Return the authenticated principal (guarded) |

Unauthenticated access to guarded routes fails closed with `401` — there is no
in-house credential path on any branch.

## Develop

```bash
npm install
npm run typecheck   # tsc --noEmit
npm run lint        # eslint
npm test            # vitest (33 tests)
npx vitest run --coverage
npm run build       # emit dist/
```

## Configuration

Secrets and IdP config are injected from the environment at runtime (never
committed). See `.env.example`. The in-memory session store is for local dev
and tests; production wires a Redis-class shared cache behind `SessionStore`.
