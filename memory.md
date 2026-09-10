# AI-DLC Product Agent — user-stories Stage Memory

## Interpretations
- 2026-09-09T23:37Z — Authored artifact content locally and delegated the actual create_artifact/link_artifacts recording to the `aidlc` subagent, which holds the runtime MCP surface; my own tool list lacks those MCP tools. Content was recorded verbatim.
- 2026-09-09T23:37Z — Used the compiled graph context (requirement gists + derived-item ids) as the requirements source of truth, since the requirements body lives in the artifact graph and not on the working-tree disk.

## Deviations
- 2026-09-09T23:37Z — Added a CONSUMES edge from user-stories-assessment → requirements and → team-practices (not only stories/personas); the assessment prose genuinely references both. Can be pruned if the coverage model expects the assessment to not consume them.

## Tradeoffs
- 2026-09-09T23:37Z — Chose breakdown "by workflow step across personas" (vertical slices) over by-persona or by-domain; keeps each story an end-to-end demoable slice aligned with the team's walking-skeleton-first practice. Alternative (by-persona) risked horizontal-layer stories.
- 2026-09-09T23:37Z — Set SLA reminder/escalation as could-have and overlap-indicator/notifications/balance as should-have to keep the must-have set to the core two-stage approval critical path (SSO → RBAC → submit → validate → approve → audit + PII), so the MVP/walking-skeleton boundary stays thin.

## Open questions
- 2026-09-09T23:37Z — req-nfr-availability-tbd is a dependency (targets not set) and req-nfr-concurrency has a capacity target still to confirm; no dedicated stories authored for these pending NFR quantification — confirm at nfr-requirements.
- 2026-09-09T23:37Z — Confirm story `covers:` requirement ids resolve against the live requirements artifact item ids (authored from graph-context derived items).

---

# AI-DLC Delivery Agent — Memory Diary

## Intent: Vacation Request App (enterprise, ideation phase)

### Stage: team-formation (2026-09-09)
Role: aidlc-delivery-agent (senior engineering manager — team formation, mob composition, skill-gap analysis).

**Inputs consumed:** scope-document, intent-backlog (14 proto-Units, PU-00..PU-12 + NFRs), feasibility-assessment (risk-analysis, recommended-architecture-direction, feasibility-verdict).

**Key situational facts:**
- Enterprise greenfield BUILD path (conditional on build-vs-buy gate PU-00 clearing).
- NO human team roster supplied. Working assumption: adopt an AI-mob / stream-aligned default composition; slot human specialists where domain/compliance judgment is mandatory (SSO/identity, HR/compliance, procurement).
- MVP = thin vertical slice PU-01→PU-07 (SSO/RBAC → submit → lead-validate → HR-approve → audit → status/notify), no hard deadline.
- Skills needed: SSO/RBAC (SAML/OIDC), workflow/state-machine engineering, immutable/append-only audit store, responsive web UI, GDPR/SOC2 compliance, procurement/build-vs-buy analysis.

**Decisions:**
- Did not block on missing roster (user directive + no roster = default AI-mob composition).
- Applied Team Topologies: one stream-aligned mob primary; enabling (identity/compliance) + platform (cloud/infra) support as-needed. Two-pizza sizing.

**Outputs produced:** team-formation-questions, team-assessment, skill-matrix, mob-composition.

**Kept learning:** In greenfield enterprise ideation with no roster, default to AI-mob stream-aligned composition and record human-specialist slots as dependencies rather than blocking the pipeline.

---

# AI-DLC Design Agent — refined-mockups Stage Memory

## Interpretations
- 2026-09-09T23:47Z — I lack direct MCP graph tools; delegated all artifact reads and all create_artifact/link_artifacts/send_output/collect_metric recording to the `aidlc` subagent which holds the runtime MCP surface. Authored artifact content myself; the subagent records it verbatim.
- 2026-09-09T23:47Z — Designed the refined mockups to the AUTHORITATIVE `requirements` artifact (post-Q4 resolution) rather than the older `wireframes`/`user-flow`, per the message precedence rule (recorded artifacts refine the raw request; requirements is the later resolution). Requirements mandate: strict two-stage approve/reject-only, half-day granularity, SLA reminder/escalation, NO `returned` state, NO HR override.

## Deviations
- 2026-09-09T23:47Z — Dropped the `RETURNED` state and the HR `Override` action that appear in the `wireframes` and `user-flow` artifacts. Reason: the `requirements` functional-requirements section (Q4 resolution) explicitly removes both from v1. Screens 5 (Team Lead) and 6 (HR) are re-specified as Approve/Reject-only. This is a scope reconciliation, not a design preference — flagged as a clarifying question to the human.
- 2026-09-09T23:47Z — Added half-day granularity to the New Request form (start/end + AM/PM half-day toggles) because requirements specify half-day granularity (Q3); the wireframe form showed whole-day only.

## Tradeoffs
- 2026-09-09T23:47Z — Chose an inline decision panel on the Request Detail screen (rather than a separate modal per action) for Validate/Approve/Reject, reserving modals only for the irreversible Approve confirmation. Keeps the decision in context with the request data (recognition over recall) and avoids nested modals. Alternative (modal-per-action) rejected as heavier and more click-costly.
- 2026-09-09T23:47Z — Mapped to a generic design-system token set (spacing scale 4/8/16/24/32/48, role-based semantic color tokens) rather than naming a specific component library, since no design system was specified in inputs. Keeps developer-agent free to pick the stack; tokens are framework-agnostic.

## Open questions
- 2026-09-09T23:47Z — Confirm with human: the wireframes/user-flow depict RETURNED + HR override but requirements remove them for v1. I designed to requirements (no RETURNED, no override). Surfaced as a clarifying question before the gate.
- 2026-09-09T23:53Z — RESOLVED: human selected "Design to requirements: approve/reject only, no RETURNED state, no HR override (recommended)". Proceeding on that basis; RETURNED and override are fully removed from the refined mockups and interaction spec.
- 2026-09-09T23:47Z — SLA reminder/escalation is a functional requirement but story-sla-escalation is could-have; I include it in notification/interaction specs as a should-render surface but keep it out of the core queue chrome. Confirm at application-design.

---

# AI-DLC AWS Platform Agent — infrastructure-design Stage Memory (unit-platform-auth)

## Interpretations
- 2026-09-10T10:44:00Z — Chose ECS Fargate (containers) over Lambda for the app tier: the modular-monolith host runs a long-lived web process with an in-process JWKS cache and a ≤5ms hot-path validation budget, which fits a warm container fleet better than per-request Lambda cold starts. Serverless recorded as a documented alternative.
- 2026-09-10T10:44:00Z — Selected ElastiCache for Redis (Serverless) as the shared session/revocation store per tech-stack-decisions ADR-AUTH-03 (Redis-class, HA/Multi-AZ, TTL eviction, fail-closed reads).
- 2026-09-10T10:44:00Z — Residency region left parameterized (config-driven, region-pinned) because the availability/residency region is TBD upstream (Q11); infra written region-agnostic with a single mandated-region pin at deploy time rather than blocking.
- 2026-09-10T10:44:00Z — CDK (TypeScript) selected as IaC per AWS CDK Best Practices knowledge; network/data/compute/monitoring stack split by lifecycle.

## Deviations
- 2026-09-10T10:44:00Z — Produced shared-infrastructure.md even though this run is single-unit-scoped: the session/revocation store and managed secrets store are explicitly cross-unit shared resources per logical-components (revocation visibility across units, cross-cutting secrets), so the CONDITIONAL artifact applies.

## Tradeoffs
- 2026-09-10T10:44:00Z — ElastiCache Redis Serverless over a fixed 2-node cluster for dev/staging: pay-per-use suits the bursty low login volume and ~500-user footprint; production may pin a Multi-AZ replication group if steady-state cost modelling favours reserved nodes. Documented in infrastructure-services.
- 2026-09-10T10:44:00Z — ARM/Graviton (arm64) Fargate for ~20% price-performance gain; the certified OIDC library must be arch-portable (it is — pure managed-runtime), so no x86 lock-in.

## Open questions
- 2026-09-10T10:44:00Z — Mandated residency region and the composite availability target (Q11) still TBD upstream; confirm before environment-provisioning hardens region pin and Multi-AZ count.
- 2026-09-10T10:44:00Z — Confirm corporate IdP reachability from private subnets (public IdP endpoint via NAT vs. private connectivity) at environment-provisioning.

---

# AI-DLC Developer Agent — code-generation Stage Memory (unit-request-workflow)

## Interpretations
- 2026-09-10T13:36Z — The `create_artifact`/`send_output`/`collect_metric` MCP tools are NOT in this run's tool surface, so the `code-generation-plan` and `code-summary` methodology artifacts were written to their on-disk construction paths under `aidlc-docs/construction/unit-request-workflow/code-generation/` instead of being recorded through the graph. Source CODE was written to the working tree as intended.
- 2026-09-10T13:36Z — The stage's "delegate to Task subagent" step is a no-op in this runtime (subagents forbidden, no Task tool); the developer generated all code directly.
- 2026-09-10T13:36Z — Department for a submitted request is taken from the resolved authz grant's departmentScope[0] when present, else the principal's department claim, else 'UNKNOWN'; the owner never supplies department (BR-INV-1).

## Deviations
- 2026-09-10T13:36Z — HTTP integration test uses Node built-in `fetch` + ephemeral `http.Server` (matching shipped `auth-router.test.ts`) rather than adding a `supertest` dev dependency, honouring the no-new-dependency tech-stack decision.
- 2026-09-10T13:36Z — Did NOT modify `src/app.ts`; `buildWorkflowRouter` is exported ready-to-mount and left as a composition-root integration point to avoid changing the shipped single-unit composition prematurely.

## Tradeoffs
- 2026-09-10T13:36Z — Optimistic concurrency (version token) over locking, per tech-stack-decisions (low contention: one lead then one HR approver per request).
- 2026-09-10T13:36Z — In-memory append-only repository/publisher adapters now; durable store/bus deferred to infrastructure-design behind the same ports (reversible, procurement-gated).

## Open questions
- 2026-09-10T13:36Z — Withdraw is permitted only from Submitted (conservative BR-WF-9 default) — confirm whether withdraw-after-validation should be allowed.
- 2026-09-10T13:36Z — Composition root must attach a `principalClaims` bag to the request for claim-based role resolution (authz defaultPrincipalResolver contract); confirm where the session pipeline populates it in production wiring.
