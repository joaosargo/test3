<!-- INVARIANT: examples are single-line HTML comments so a fresh template parses to total=0 (MEMORY_EMPTY). Do NOT un-comment or split across lines. t100 guards this. -->
> This file is maintained by the orchestrator during stage execution. Add observations at the gate ritual, not by editing here directly.

## Interpretations
- 2026-09-10T13:42:17Z — treated audit-trail as an event-sourced sink, not a command aggregate; it owns no mutable domain state, only append-only AuditRecords projected from the workflow WorkflowEvent stream via the EventPublisher port. Grounded in unit-request-workflow events.ts (5 event types) and services choreography posture.
- 2026-09-10T13:42:17Z — generated a frontend-components artifact even though the unit is primarily a backend sink, because story-immutable-audit's persona (compliance-auditor Aisha) needs a read-only inspection surface; kept it thin (one read-only query view, no mutation UI) to stay honest to the CONDITIONAL clause.
- 2026-09-10T13:42:17Z — interpreted "immutable/append-only" as enforced by BOTH a no-update/no-delete port contract AND an optional tamper-evident hash chain (prev-hash linkage) so integrity is verifiable, not merely policy-asserted.

## Deviations
- 2026-09-10T13:42:17Z — no ask_question issued; the unit scope, event contract, and requirements were unambiguous from the shipped request-workflow code and the requirements/component-methods inputs. Retention duration (7 years) is fixed by req-nfr-audit-retention, so no clarification was needed.

## Tradeoffs
- 2026-09-10T13:42:17Z — chose hash-chain tamper-evidence over full cryptographic signing (KMS) for MVP integrity; signing is deferred to nfr-design/infrastructure-design. Rationale: hash chain gives detect-tampering in-process with zero external dependency; signing adds non-repudiation but needs managed keys. Reversible seam kept via AuditStore port.
- 2026-09-10T13:42:17Z — chose to make ingestion idempotent by (eventType, requestId, atMs) dedup key rather than requiring exactly-once bus delivery; matches the "events may be delivered more than once" choreography reality and keeps the append-only store clean.

## Open questions
- 2026-09-10T13:42:17Z — confirm with compliance whether the 7-year retention requires WORM/legal-hold storage semantics (S3 Object Lock class) — decided at infrastructure-design; functional design only asserts the append-only + no-purge-before-retention invariant.
- 2026-09-10T13:42:17Z — confirm whether the auditor read view must expose cross-department records or be department-scoped like HR; assumed compliance-auditor sees all departments (org-wide audit mandate), pending authz confirmation.
