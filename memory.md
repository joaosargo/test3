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
- 2026-09-09T23:47Z — SLA reminder/escalation is a functional requirement but story-sla-escalation is could-have; I include it in notification/interaction specs as a should-render surface but keep it out of the core queue chrome. Confirm at application-design.
