# Code Generation — memory (unit-platform-authz)

## Interpretations
- 2026-09-10T12:48:00Z — Built authz as an additive in-process library under `src/authz/`; the existing tree is unit-platform-auth. Grounded the co-location decision in deployment-architecture-unit-platform-authz (in-process PDP on the shared app tier), matching the codebase's hexagonal port/adapter/service layout.
- 2026-09-10T12:48:00Z — Sourced role/department from SSO claims first, RoleDirectoryPort as fallback only, per performance-design-unit-platform-authz claim-sourcing; keeps the hot path network-free.

## Deviations
- 2026-09-10T12:48:00Z — Merged the planned separate authz-error.ts into authz-decision.ts so the error, grant, and deny-reason types live in one cohesive module; fewer cross-imports.
- 2026-09-10T12:48:00Z — No new vitest config (plan Step 11); root vitest.config.ts already globs src/**/*.test.ts.

## Tradeoffs
- 2026-09-10T12:48:00Z — Chose explicit non-inheriting role grants (team-lead is NOT implicitly employee) over a hierarchical model; simpler deny-by-default reasoning and auditability, at the cost of listing permissions per role. Grounded in security-design-unit-platform-authz deny-by-default.
- 2026-09-10T12:48:00Z — Collapsed "unknown principal" and "directory error" into a single DIRECTORY_UNAVAILABLE deny to avoid leaking directory-membership state; trades a little diagnostic granularity for the fail-closed / no-enumeration posture.

## Open questions
- 2026-09-10T12:48:00Z — The exact IdP claim names for role/department are assumed (`role`, `department`) from unit-platform-auth's RawClaims; confirm against the real IdP claim mapping before production (config is injectable so no code change needed).
- 2026-09-10T12:48:00Z — HR multi-department scope is modelled as a string[]; confirm whether an HR approver can span multiple departments or exactly one, which would tighten the ABAC check.
