---
consumes: [performance-requirements, security-requirements, scalability-requirements, reliability-requirements, tech-stack-decisions, business-logic-model]
unit: unit-audit-trail
stage: nfr-design
---

# Security Design — `unit-audit-trail`

Concrete security design for the **Immutable Audit Trail** unit — the compliance
system-of-record. This design implements the controls enumerated in
`security-requirements` (SEC-AUD-1…14), grounded in the append-only,
hash-chained, PII-minimised model in `business-logic-model`, and consistent with
the SHA-256 / Node-core-`crypto` / hexagonal-`AuditStore` selections in
`tech-stack-decisions`. It intersects `reliability-requirements` (integrity is a
durability property — REL-AUD-8) and `scalability-requirements` (WORM at-rest
protection must hold across the 7-year corpus — SCAL-AUD-5/6). Latency of the
guarded read surface is bounded by `performance-requirements` (PERF-AUD-5), so
the authn/authz composition below adds no scan.

Because the trail is **evidence**, the security posture centres on **integrity
and non-repudiation of the record** and **PII minimisation by construction** —
not on confidentiality of a rich data set (the unit deliberately stores almost
no sensitive data). Like every shipped unit, this unit establishes **no
identity** and owns **no authorization policy**: it consumes those upstream
guarantees fail-closed.

## Authentication & Authorization Architecture

- **SD-AUD-1 — Composed guard, no in-house auth (SEC-AUD-1).** Every auditor
  read endpoint (`getRequestTrail`, `queryTrail`, `verifyChain`) composes the
  shipped middleware chain exactly as the other units do:
  `requireSession(...)` (authn, from `unit-platform-auth`) →
  `requirePermission(authz, '<audit-read-perm>')` (authz, from
  `unit-platform-authz`) → handler. The unit never authenticates a user, never
  re-derives roles, and never issues or validates a session token itself.
- **SD-AUD-2 — Deny-by-default (SEC-AUD-2).** A read is served only after an
  explicit PDP allow. A deny short-circuits with `err(forbidden)` and returns
  **zero records** — there is no permissive fallback branch and no "return
  partial on ambiguous decision" path. This is the fail-closed posture the
  requirements mandate app-wide.
- **SD-AUD-3 — No mutation surface exists (SEC-AUD-3).** Per
  `business-logic-model` and the `AuditStore` port in `tech-stack-decisions`,
  the unit exposes **no** command that mutates business state and the port has
  **no** `update`/`delete`. There is no privileged write/delete endpoint to
  protect, rate-limit, or abuse — the absence of the capability is the control.
- **SD-AUD-4 — Auditor scope enforced by the PDP, never by this unit
  (SEC-AUD-4).** The compliance-auditor persona (Aisha) is assumed org-wide
  under the compliance mandate. If authz later scopes the auditor
  per-department, that scope is enforced by the PDP via the resource descriptor
  `{ department }` passed to `requirePermission`; the unit itself never compares
  departments or filters by role. This keeps authorization single-sourced in
  `unit-platform-authz`.

## Integrity, Immutability & Non-Repudiation Design

This is the unit's defining security property — the operational teeth behind
`req-immutable-audit-trail`.

- **SD-AUD-5 — Contract-level immutability (SEC-AUD-5).** The `AuditStore` port
  exposes `append` + reads only; `AuditRecord` is a frozen `readonly` value.
  Code that attempts to mutate or delete a record cannot compile against the
  port — a type-level guarantee, verified by the `type-check` sensor, not an
  operational promise.
- **SD-AUD-6 — Per-`requestId` tamper-evident hash chain (SEC-AUD-6).** Each
  record stores `prevHash` and its own
  `hash = sha256(canonicalSerialize(fields excluding hash))`, partitioned by
  `requestId`. `verifyChain` recomputes every hash and every link; any
  after-the-fact edit or deletion breaks the chain and is detectable. This is
  computed with Node core `crypto` per `tech-stack-decisions` — no new
  dependency, FIPS-friendly.
- **SD-AUD-7 — Deterministic canonical serialization (SEC-AUD-7).** The hashed
  bytes are produced by a single pure, **version-tagged** canonical serializer
  (stable key order, fixed number formatting) so a record yields the same hash
  across runtimes and Node versions. A format change bumps the version tag
  rather than silently invalidating existing chains; the verifier records which
  tag it used so historical chains verify against the serializer version that
  produced them.
- **SD-AUD-8 — Verification is non-destructive (SEC-AUD-8, REL-AUD-8).**
  `verifyChain` and all reads are side-effect-free; an integrity check leaves
  the trail byte-identical, so it can run on demand or on a schedule without
  altering the evidence. The scheduled sweep cadence (design intent: at least
  daily over recently-written partitions, plus a full sweep post-restore/migration)
  is confirmed with infrastructure-design.
- **SD-AUD-9 — WORM at-rest write-protection in production (SEC-AUD-9).** The
  durable `AuditStore` adapter is backed by a store whose write semantics enforce
  append-only at the **storage layer** (object-lock / retention-policy / WORM),
  so immutability holds even against an operator with store credentials — not
  only against application code. This closes the operator-credential threat that
  the type-level port alone cannot. The concrete storage class is an
  infrastructure-design decision under the procurement gate
  (`tech-stack-decisions`, `req-constraint-build-gate`); this design asserts the
  requirement and the seam.
- **SD-AUD-10 — Non-repudiation seam kept open (SEC-AUD-10).** The MVP uses the
  hash chain for tamper-*evidence*. Cryptographic signing (KMS/managed-key
  signature over each record's `hash`, or periodic Merkle-root anchoring) for
  non-*repudiation* is a reversible enhancement layered behind the same
  `AuditStore` + canonical-serializer seam, deferred to infrastructure-design.
  The record shape reserves room for an optional `signature`/`keyId` without a
  chain migration, honouring "reversibility over perfection".

## Data Protection & PII Design

- **SD-AUD-11 — PII minimisation by construction (SEC-AUD-11).** The audit mapper
  copies only the pseudonymous ids and non-PII fields the inbound `WorkflowEvent`
  already carries (`requestId`, `ownerId`, `actorId`, `department`, `status`,
  `atMs`, `rejectedStage`). It **never** enriches with subject email, employee
  name, or free-text reason — the mapper has no dependency on any PII source, so
  enrichment is structurally impossible, not merely forbidden.
- **SD-AUD-12 — PII-free codes and logs (SEC-AUD-12).** `AuditError`
  codes/messages are machine-readable and PII-free; every log line this unit
  emits is id-only, mirroring the upstream units' logging posture. Log
  statements are reviewed against this rule and the `linter` sensor guards
  obvious violations in any TS snippet.
- **SD-AUD-13 — Encryption in transit and at rest (SEC-AUD-13).** All auditor
  HTTP is over TLS (terminated at the shared ALB per the workflow unit's
  deployment posture); the durable store encrypts records at rest. Even though
  records are pseudonymous, `ownerId`/`actorId`/`department` are treated as
  protected employee data and covered by encryption. The in-memory dev/test
  adapter is non-persistent and out of scope for at-rest encryption.
- **SD-AUD-14 — No secrets in code (SEC-AUD-14).** Durable-store credentials and
  any future signing key references are injected from the environment / secrets
  manager, never hard-coded — consistent with the shipped `ADR-AUTH-04`
  convention and the team `## Security` rule.

## Threat Model & Mitigations (STRIDE — evidence boundary)

| Threat | Vector | Mitigation (this design) |
|--------|--------|--------------------------|
| **Tampering** — after-the-fact edit/delete | App code | No-mutation port (SD-AUD-5) — cannot compile |
| **Tampering** — storage-layer edit by operator | Store credentials | WORM/object-lock at rest (SD-AUD-9) + hash-chain detection (SD-AUD-6) |
| **Tampering** — re-hash after tampering | Rewrite whole partition | Canonical + version-tagged verify (SD-AUD-7); optional signing defeats even full re-hash (SD-AUD-10) |
| **Repudiation** — "the record was forged" | Dispute of authenticity | Hash chain now; KMS signing seam reserved (SD-AUD-10) |
| **Information disclosure** — PII exfiltration via read | Compromised/over-scoped reader | PDP deny-by-default (SD-AUD-2); pseudonymous records expose no direct PII (SD-AUD-11); TLS (SD-AUD-13) |
| **Spoofing** — forged/malformed inbound event | Bus injection | Fail-closed shape validation (`business-logic-model` BR-AUD-1) → `malformedEvent`, nothing appended, dead-lettered |
| **Denial of service** — duplicate-event flood | At-least-once replay/replay attack | Idempotent dedup → exactly one record (`business-logic-model` BR-AUD-2); duplicate path is a single point read |
| **Elevation of privilege** — read without allow | Missing/short-circuited guard | Composed `requireSession → requirePermission` on every endpoint (SD-AUD-1) |

## Compliance Controls Summary

- **Integrity + non-repudiation:** hash chain (SD-AUD-6/7) + reserved signing
  seam (SD-AUD-10), continuously re-verifiable (SD-AUD-8) — satisfies
  `req-immutable-audit-trail` and `req-constraint-append-only-store`.
- **Retention (GDPR storage-limitation boundary):** 7-year `retainUntilMs` per
  record, WORM-protected against early purge (SD-AUD-9,
  `reliability-requirements` REL-AUD-10, `scalability-requirements` SCAL-AUD-6);
  purge is out-of-band and post-retention only.
- **PII / GDPR data-minimisation:** pseudonymous-by-construction records
  (SD-AUD-11), id-only logs (SD-AUD-12), encryption in transit + at rest
  (SD-AUD-13) — satisfies `req-nfr-security-pii`.
