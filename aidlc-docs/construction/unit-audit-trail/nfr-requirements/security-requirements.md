---
consumes: [business-logic-model, business-rules, requirements]
unit: unit-audit-trail
stage: nfr-requirements
---

# Security Requirements — `unit-audit-trail`

Security NFRs for the **Immutable Audit Trail** unit — the compliance
system-of-record. Because the trail is *evidence*, its security posture centres
on **integrity and non-repudiation of the record** and on **PII minimisation**,
more than on confidentiality of a rich data set (the unit deliberately stores
almost no sensitive data). Requirements trace to the tamper-evidence and
append-only design in the unit's `business-logic-model` (Integrity Verification
Workflow, append-only event sink), the immutability, hash-chain, and PII rules
in its `business-rules` (`BR-AUD-5`, `BR-AUD-5a`, `BR-AUD-6`, `BR-AUD-6a`,
`BR-AUD-8`, `BR-AUD-9`), and the security/audit NFRs in `requirements`
(`req-nfr-security-pii`, `req-immutable-audit-trail`,
`req-constraint-append-only-store`).

Like the shipped units, this unit establishes **no** identity and owns **no**
authorization policy: authentication is delegated to `unit-platform-auth` and
authorization to the `unit-platform-authz` PDP. It consumes those upstream
guarantees fail-closed and protects the evidence it owns.

## Authentication & Authorization

- **SEC-AUD-1 — No in-house auth; guarded read surface.** The auditor query
  endpoints (`getRequestTrail`, `queryTrail`, `verifyChain`) compose
  `requireSession(...)` (auth) → `requirePermission(authz, '<audit-read-perm>')`
  (authz) → handler, exactly as the shipped units do. The unit never
  authenticates a user or re-derives roles.
- **SEC-AUD-2 — Deny-by-default on the read surface.** An auditor read is served
  only after an explicit PDP allow; a deny short-circuits with `err(forbidden)`
  and returns no records. There is no permissive branch. This matches the
  fail-closed posture the `requirements` mandate across the app
  (`req-rbac-three-roles-hr-scoping`).
- **SEC-AUD-3 — Read-only exposure; no mutation surface exists.** Per the unit's
  `business-logic-model` and `business-rules` `BR-AUD-5`, the unit exposes no
  command that mutates business state and the `AuditStore` port has **no**
  `update`/`delete`. There is therefore no privileged write/delete endpoint to
  protect or abuse — the absence of the capability is itself the control.
- **SEC-AUD-4 — Auditor scope (org-wide, pending confirmation).** The
  compliance-auditor persona (Aisha) is assumed to read across all departments
  under the org-wide audit mandate (functional-design open question). If
  authz later scopes the auditor per-department, scope MUST be enforced by the
  PDP via the resource descriptor `{ department }` — the unit itself never
  compares departments.

## Integrity, Immutability & Non-Repudiation

This is the unit's defining security property — the operational teeth behind
`req-immutable-audit-trail`.

- **SEC-AUD-5 — Contract-level immutability (`req-constraint-append-only-store`).**
  Per `business-rules` `BR-AUD-5`/`BR-AUD-5a`, the `AuditStore` port exposes
  `append` and reads only; records are frozen `readonly` value objects. Code that
  attempts to mutate or delete a record cannot compile against the port —
  immutability is a type-level guarantee, not an operational promise.
- **SEC-AUD-6 — Tamper-evident hash chain (`req-immutable-audit-trail`).** Each
  record stores `prevHash` and its own `hash = sha256(canonicalSerialize(fields
  excluding hash))` (`business-rules` `BR-AUD-6`), partitioned per `requestId`
  (`BR-AUD-4`). `verifyChain` recomputes every hash and every link; any
  after-the-fact edit or deletion breaks the chain and is detectable. This
  upgrades "we promise not to change it" to "you can prove it was not changed."
- **SEC-AUD-7 — Deterministic canonical serialization (`BR-AUD-6a`).** The bytes
  hashed are produced by a single pure, version-tagged canonical serializer
  (stable key order, fixed number formatting) so a record yields the same hash
  across runtimes; a format change bumps the tag rather than silently
  invalidating existing chains. The verifier is byte-reproducible.
- **SEC-AUD-8 — Verification is non-destructive (`BR-AUD-9`).** `verifyChain`
  and all reads are side-effect-free; running an integrity check leaves the trail
  byte-identical, so verification can run on demand or on a schedule without
  altering the evidence it inspects.
- **SEC-AUD-9 — At-rest write-protection in production.** The production
  `AuditStore` adapter must be backed by a store whose write semantics enforce
  append-only at the storage layer (e.g. WORM / object-lock / retention policy),
  so immutability holds even against an operator with store credentials — not
  only against application code. The concrete storage class is an
  infrastructure-design decision (functional-design open question); this NFR
  asserts the requirement.
- **SEC-AUD-10 — Non-repudiation seam (deferred).** The MVP uses a hash chain for
  tamper-*evidence*; cryptographic signing (managed keys / KMS) for
  non-*repudiation* is a reversible enhancement behind the same `AuditStore` seam,
  deferred to nfr-design/infrastructure-design per the functional-design tradeoff
  note. The hash-chain design does not preclude adding signatures later.

## Data Protection & PII

- **SEC-AUD-11 — PII minimisation by construction (`req-nfr-security-pii`).** Per
  `business-rules` `BR-AUD-8`, the unit records only the pseudonymous ids and
  non-PII fields the inbound `WorkflowEvent` already carries (`requestId`,
  `ownerId`, `actorId`, `department`, `status`, `atMs`). It never stores subject
  email, employee name, or free-text reason, and the audit mapper never enriches
  with subject PII — so the trail is compliance-safe by construction and its
  confidentiality blast radius is minimal.
- **SEC-AUD-12 — PII-free codes and logs.** `AuditError` codes/messages are
  machine-readable and PII-free; log lines emitted by this unit are id-only
  (`business-rules` `BR-AUD-8`), mirroring the `BR-INV-6` / `BR-PII-*` posture of
  the upstream units.
- **SEC-AUD-13 — Encryption in transit and at rest.** All auditor HTTP is over
  TLS; the durable production store encrypts records at rest
  (`req-nfr-security-pii`). Even though records are pseudonymous, `ownerId`/
  `actorId`/`department` are treated as protected employee data. The in-memory
  dev/test adapter is non-persistent and out of scope for at-rest encryption.
- **SEC-AUD-14 — No secrets in code.** Any store credentials the durable adapter
  needs are injected from the environment or a secrets manager, never hard-coded
  — consistent with the shipped `ADR-AUTH-04` convention and the team `## Security`
  rule.

## Threat Considerations

- **After-the-fact record edit or deletion** → structurally prevented by the
  no-mutation port (SEC-AUD-5) and detectable by the hash chain (SEC-AUD-6) even
  if the storage layer is compromised; WORM at-rest write-protection (SEC-AUD-9)
  closes the operator-credential path.
- **Chain forgery / re-hashing after tampering** → detectable because
  `verifyChain` recomputes from canonical bytes (SEC-AUD-7); an attacker would
  have to re-hash every subsequent record in the partition, and signing
  (SEC-AUD-10) would defeat even that.
- **Duplicate-event injection** → idempotent dedup (`business-rules` `BR-AUD-2`)
  yields exactly one stored record, so a replayed event cannot inflate or
  distort the trail.
- **Malformed / spoofed event** → fail-closed validation (`business-rules`
  `BR-AUD-1`) rejects it with `AuditError.malformedEvent`; nothing is appended
  and the chain is never corrupted by a bad event.
- **Unauthorized trail read / PII exfiltration** → denied by the PDP before any
  record is returned (SEC-AUD-2); and because records are pseudonymous
  (SEC-AUD-11), even a successful read exposes no direct subject PII.
