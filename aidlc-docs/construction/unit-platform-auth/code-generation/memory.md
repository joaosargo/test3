<!-- code-generation stage memory — unit-platform-auth -->

## Interpretations
- 2026-09-10T11:59:22Z — chose TypeScript + Node.js + Express as the host stack; tech-stack-decisions ADR-AUTH-02 deferred the exact language but bound it to "first-class OIDC/SAML + secure-cookie + crypto library ecosystem", and the stage's own linter/type-check sensors target **/*.{ts,tsx} (eslint + tsc). Node.js + Express + openid-client satisfies both.
- 2026-09-10T11:59:22Z — used openid-client (certified OIDC/OAuth2 library) for the protocol handshake per ADR-AUTH-01 (never hand-roll). SAML is documented as a fallback port but OIDC is implemented as the primary protocol since business-logic-model marks OIDC preferred.
- 2026-09-10T11:59:22Z — session store abstracted behind a SessionStore port with an in-memory implementation for the walking skeleton; production wiring to a Redis-class shared cache (ADR-AUTH-03) is left as a documented adapter seam, not hard-coded, to keep the unit independently testable.
- 2026-09-10T11:59:22Z — stateless signed session token implemented with jose (JWT sign/verify) per performance-design ADR (in-process validation, no store round-trip on hot path); revocation checked against the SessionStore port.

## Deviations
- 2026-09-10T11:59:22Z — did not stand up a live IdP or real Redis; IdP config and JWKS come through an injected OidcClientPort and the session store through a SessionStore port, so happy-path and fail-closed tests run without external infra. This respects the "IdP selection is a human/procurement decision" open item in tech-stack-decisions.

## Tradeoffs
- 2026-09-10T11:59:22Z — picked a hexagonal (ports/adapters) layout over a framework-coupled one so the eight-check validation algorithm and session policy are unit-testable in isolation; slight extra boilerplate accepted for the fail-closed test coverage the security-design mandates.

## Open questions
- 2026-09-10T11:59:22Z — confirm host language/framework and the managed cache + secret-manager products (tech-stack-decisions open decisions 2 & 3) before infrastructure hardening; current code targets Node/Express with pluggable ports.
