<!-- functional-design stage memory — unit-platform-authz -->

## Interpretations
- 2026-09-10T12:14:31Z — QUESTION-ONLY vs ARTIFACT-ONLY vs Full mode: no orchestrator-provided answered-questions file exists on disk and no prior question phase is evidenced, so ran in Full mode but resolved the small number of genuine design questions by inference from the dependency unit's shipped code (unit-platform-auth) rather than blocking, since those decisions are already fixed by the established codebase conventions.
- 2026-09-10T12:14:31Z — the boundary contract is already fixed by shipped code: unit-platform-auth forwards RawClaims { role?, department?, email? } across the AuthenticatedPrincipal boundary WITHOUT interpreting them (see src/domain/entities.ts). unit-platform-authz therefore owns: (a) resolving those raw claims into the three-role model, (b) per-department HR scoping, (c) PII protection/encryption. Designed the domain model to consume AuthenticatedPrincipal/RawClaims verbatim rather than redefining identity.
- 2026-09-10T12:14:31Z — treated authorization as a fail-closed policy-decision component (deny-by-default) mirroring the auth unit's fail-closed posture, using a Result<Decision, AuthzError> return shape consistent with the existing domain/result.ts convention.

## Deviations
- 2026-09-10T12:14:31Z — the runtime's methodology MCP tools (create_artifact, link_artifacts, send_output, collect_metric, get_artifact, etc.) are NOT present in the actual available tool set for this session. The output contract requires recording each artifact via create_artifact; that tool cannot be invoked. Wrote the four functional-design artifacts to the working tree under aidlc-docs/construction/unit-platform-authz/functional-design/ as the only available persistence, and surfaced the tool-availability gap explicitly instead of silently producing nothing.

## Tradeoffs
- 2026-09-10T12:14:31Z — modelled RBAC as a static role→permission matrix plus a dynamic per-department scoping predicate rather than a full policy engine (e.g. OPA/Cedar). The MVP has exactly three roles and one scoping dimension (department); a policy-engine dependency is unjustified complexity for that surface and would add an external runtime the auth unit deliberately avoided. Documented the seam so a policy engine can replace the matrix later without changing callers.
- 2026-09-10T12:14:31Z — chose application-layer field-level encryption for PII at rest expressed behind a CryptoPort abstraction, over relying solely on storage-tier encryption, so the requirement (req-nfr-security-pii) is satisfiable and testable within the unit regardless of the eventual datastore.

## Open questions
- 2026-09-10T12:14:31Z — confirm the exact source claim(s) that carry role and department in the corporate IdP assertion (claim names, single vs multi-valued role) — modelled a configurable claim-mapping to avoid hard-coding.
- 2026-09-10T12:14:31Z — confirm whether an HR approver may be scoped to more than one department; modelled scoping as a set of department codes to allow it, defaulting to a single-element set.
