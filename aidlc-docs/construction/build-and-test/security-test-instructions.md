# Security Test Instructions — Vacation Request App

Owner: aidlc-devsecops-agent (security lead) with aidlc-quality-agent. Warranted
because every unit ships `security-requirements` NFRs and the system's core
posture is **fail-closed authentication + deny-by-default authorization + a
PII-free immutable audit trail**. Grounded in the per-unit security-requirements
NFRs and the [[code-summary]] fail-closed notes (and the port contracts in
[[code-generation-plan]]); traces to `req-nfr-security-pii`,
`req-sso-authentication`, `req-constraint-sso-mandatory`,
`req-rbac-three-roles-hr-scoping`, and `req-immutable-audit-trail`.

## Static analysis (SAST) and dependency scanning

```bash
npm run lint            # eslint — no-explicit-any:error acts as a light SAST gate
npm audit --production  # dependency CVE scan against the pinned lockfile
```

- Treat any **high/critical** advisory in a **runtime** dependency as a blocking
  finding; triage transitive/dev-only advisories but do not auto-`fix --force`
  in the build (breaking bumps go through a scoped update task).
- Pin all dependencies (already done in `package-lock.json`); flag any unusual
  or typosquat-looking package name before adding it.
- Add an SCA step (e.g. `npm audit` or a scanner action) to CI as a gate.

## Authentication testing (fail-closed)

Validate against the auth unit's eight ordered assertion checks
(`services/auth-service.test.ts` is the reference; extend as security tests):

- Missing / malformed / expired session token ⇒ **401**, never a fallback to a
  local credential path (there is no in-house auth on any branch —
  `req-constraint-sso-mandatory`).
- Tampered signed session token (bad signature, altered claims) ⇒ rejected by
  `jose` verification.
- Revoked session (present in the revocation set) ⇒ rejected even if the
  signature is valid.
- Logout is idempotent and revokes server-side; a replayed post-logout token is
  rejected.
- Callback assertion validation: state/nonce mismatch, wrong issuer, wrong
  audience ⇒ rejected fail-closed.

## Authorization testing (deny-by-default)

- **No grant ⇒ 403** before any state read or write; assert the repository is
  untouched on deny (`BR-WF-7`).
- **No cross-role inheritance** — employee token cannot reach team-lead or HR
  endpoints; team-lead cannot reach HR approve/reject.
- **Per-department HR scoping** — an HR approver scoped to department A cannot
  read or act on department B's requests (horizontal-privilege / IDOR check).
- **Role-transition guards** — team lead can validate/reject only; HR can
  approve/reject only, no override (`req-hr-approve-reject-no-override`).

## Injection & input-validation testing (DAST-style)

- Fuzz path params and query filters on `/audit`, `/status`, and workflow
  routes (`department`, `eventType`, `actorId`, `from`, `to`, `requestId`) with
  oversized, malformed, and control-character inputs ⇒ 400/422, never a 500 or a
  leaked stack trace.
- Confirm no reflected input in error responses; error bodies expose no
  internal detail.

## Session cookie hardening

- Assert the session cookie is set `HttpOnly`, `Secure`, `SameSite` per
  `config/session-policy.ts`, with the configured max-age; verify security
  headers middleware (`http/security-headers.ts`) is applied on responses.

## PII protection

- Assert audit records and event payloads hold **only pseudonymous ids** — no
  email, name, or free-text reason (`BR-AUD-8`, `req-nfr-security-pii`).
- Grep test/fixtures and logs for accidental PII; no PII in DEBUG/INFO logs.

## Audit integrity (tamper-evidence)

- `verifyChain` fails when a record's stored hash is altered (mutate a record,
  expect detection).
- No `update`/`delete` exists at the `AuditStore` contract — assert append-only
  by construction (`req-constraint-append-only-store`).

## How to run

```bash
npm run lint
npm audit --production
npx vitest run -t "401|403|fail-closed|verifyChain|revoked|scope"
```

## Targets

- 100% of guarded endpoints have a 401 and a 403 negative test.
- Every fail-closed branch in `AuthService` and every deny branch in the
  command services has a dedicated assertion.
- Zero unresolved high/critical CVEs in runtime dependencies at the release gate.
