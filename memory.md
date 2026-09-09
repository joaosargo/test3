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
