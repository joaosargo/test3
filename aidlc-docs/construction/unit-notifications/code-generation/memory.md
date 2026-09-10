# Code Generation — memory (unit-notifications)

Running log for the code-generation stage of `unit-notifications`.

## Interpretations
- 2026-09-10T14:40:00Z — treated the in-app inbox as `requireSession`-guarded only (no `requirePermission`); the authz permission set is closed and owned by unit-platform-authz, and frontend-components specifies the inbox is viewer-keyed, not role-keyed. Self-scope enforced in the service.
- 2026-09-10T14:40:00Z — retry-with-backoff (`BR-NOTIF-10`) is represented at the port/outcome level (transient failure → DeadLettered outcome) rather than implementing an in-process backoff loop; concrete backoff belongs to the durable-bus consumer at infrastructure-design (reliability-design ADR-NOTIF-05). The idempotency guarantee is what the unit code owns.

## Deviations
- 2026-09-10T14:40:00Z — did not modify the shared composition root (app.ts/server.ts); matched the shipped unit-request-workflow / unit-hris-balance convention of encapsulating the router + subscriber behind index.ts for a later composition stage. Keeps the unit lane isolated per the fan-out instruction.
- 2026-09-10T14:40:00Z — no per-unit vitest config (planned Step 11); the root vitest.config.ts already globs src/**/*.test.ts.

## Tradeoffs
- 2026-09-10T14:40:00Z — at-least-once + consumer idempotency over exactly-once across email + a separate in-app store (business-logic-model / BR-NOTIF-9 tradeoff). Simpler, deterministic reconciliation.
- 2026-09-10T14:40:00Z — encoded the dedupe key with a SHA-256 base64url hash (mirrors src/domain/crypto.ts style) rather than a bare string concat, so it is opaque and fixed-length for a future durable store key.

## Open questions
- 2026-09-10T14:40:00Z — RecipientDirectoryPort backing store (IdP / HRIS / internal directory) is an infrastructure decision, still open (functional-design). In-memory double used for dev/test.
- 2026-09-10T14:40:00Z — approver-copy defaults (BR-NOTIF-5) are configurable and defaulted OFF; confirm the desired default with product before hardening.
- 2026-09-10T14:40:00Z — in-app notification retention/localization deferred (functional-design open questions).
