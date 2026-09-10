# Build Instructions — Vacation Request App (modular monolith)

Owner: aidlc-quality-agent (lead) with aidlc-devsecops-agent (security input).
Grounded in the per-unit `code-generation-plan` and `code-summary` artefacts
(see [[code-generation-plan]] and [[code-summary]] for the auth unit, and the
sibling `code-summary` documents for `unit-request-workflow`,
`unit-platform-authz`, `unit-hris-balance`, `unit-audit-trail`,
`unit-overlap-indicator`, `unit-notifications`, `unit-status-query`, and
`unit-sla-escalation`).

The whole repository is a single TypeScript/Node.js 20 modular monolith. All
eight units share one `package.json`, one `tsconfig.json`, one ESLint config,
and one Vitest config — there is **one** build and **one** test run for the
whole repo, not per-unit builds.

## Prerequisites

- **Node.js ≥ 20** (`engines.node` in `package.json`; verified against v20 and
  newer). Check with `node --version`.
- **npm** (ships with Node). Check with `npm --version`.
- No database, Redis, or live IdP is required to build or to run the test
  suite: every external dependency (OIDC IdP, session store, HRIS, event bus)
  sits behind a hexagonal port with an in-memory adapter for tests, per the
  per-unit `code-summary` "key implementation decisions".

## Dependency installation

```bash
npm install          # installs deps + devDeps from package-lock.json (pinned)
```

Runtime deps: `express`, `cookie`, `jose`, `openid-client`.
Dev deps: `typescript`, `vitest`, `@vitest/coverage-v8`, `eslint` +
`@typescript-eslint/*`, and the `@types/*` packages.

All versions are pinned in `package.json` / `package-lock.json`; do not use
open ranges. If `npm install` reports advisories, record them but do not
`npm audit fix --force` as part of the build — breaking-change bumps go through
a scoped dependency-update task, not the build gate.

## Environment setup

The build and the test suite need **no** environment variables — ports are
injected with in-memory adapters under test. Runtime (`npm start` /
`server.ts`) reads secrets from the environment; see `.env.example` for the
required keys (`OIDC_ISSUER_URL`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`,
`OIDC_REDIRECT_URI`, `SESSION_SIGNING_KEY`, `PORT`). Never commit real secrets;
they are injected from a managed secret manager at runtime (ADR-AUTH-04).

## Build commands

```bash
npm run typecheck    # tsc -p tsconfig.json --noEmit  (strict mode, no emit)
npm run lint         # eslint . --ext .ts
npm run build        # tsc -p tsconfig.json  → emits dist/
```

`tsconfig.json` runs in `strict` mode with `noUnusedLocals`,
`noUnusedParameters`, and `noFallthroughCasesInSwitch`. A clean `typecheck` is
the load-bearing signal that the code is internally consistent across units.

## Build verification steps

1. `npm run typecheck` exits 0 (no type errors).
2. `npm run lint` exits 0 (ESLint clean; `@typescript-eslint/no-explicit-any`
   is `error`, so any `any` fails the build).
3. `npm run build` exits 0 and populates `dist/` with compiled `.js`, `.d.ts`,
   and source maps.
4. Delete `dist/` after verification if you are not packaging an artefact —
   the workspace disk is small and `dist/` is a regenerable output.

## Troubleshooting common build issues

- **`tsc: not found` / `eslint: not found`** — dependencies are not installed
  in this checkout. Run `npm install` first. (The `node_modules` directory may
  be a runtime-managed symlink; do not delete it — just `npm install` through
  it.)
- **Type error in one unit after editing a shared port** — the units share
  `src/domain` and `src/ports` types; a port signature change ripples across
  every consumer. Re-run `npm run typecheck` and fix all call sites, not just
  the edited unit.
- **`no space left on device`** — stop emitting `dist/`, remove any stale
  `dist/` or coverage output, and re-run only the step you need.
- **ESLint fails on `any`** — replace with a precise type or a documented
  `unknown` + narrowing; the project forbids `any` by policy.
