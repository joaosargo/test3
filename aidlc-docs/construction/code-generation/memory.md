<!-- INVARIANT: examples are single-line HTML comments so a fresh template parses to total=0 (MEMORY_EMPTY). Do NOT un-comment or split across lines. t100 guards this. -->
> This file is maintained by the orchestrator during stage execution. Add observations at the gate ritual, not by editing here directly.

## Interpretations
- 2026-09-10T14:37:00Z — implemented unit-audit-trail as an in-process module src/audit/ mirroring the shipped src/hris and src/authz hexagonal layout, rather than a standalone service, per deployment-architecture (embedded module of the modular monolith).
- 2026-09-10T14:37:00Z — the AuditService consumes WorkflowEvent via a structural AuditableEvent subset and validates it as an inbound ACL, isolating the record shape from event-shape drift (domain-entities conformist-with-ACL boundary).

## Deviations
- 2026-09-10T14:37:00Z — guarded the auditor read routes with the existing request:view-department permission because no audit:read permission exists in unit-platform-authz and adding one is out of this unit's lane. Revisit if a first-class audit:read permission is introduced upstream.
- 2026-09-10T14:37:00Z — the POST /audit/.../verify endpoint returns HTTP 200 with {integrity:"violated"} for a detected tamper (not a 4xx/5xx), because the auditor must see the tamper verdict + offending record; genuine input faults still return 422.

## Tradeoffs
- 2026-09-10T14:37:00Z — kept the in-memory AuditStore adapter for dev/test and left the durable WORM store, DLQ, integrity-sweep job, and KMS signing seam behind the swappable AuditStore port for infrastructure-design, matching the logical-components handoff.

## Open questions
- 2026-09-10T14:37:00Z — confirm with authz whether the compliance-auditor should have a dedicated audit:read permission (and cross-department scope) rather than reusing request:view-department; currently org-wide read is assumed per functional-design open question.
