<!-- nfr-design stage memory — unit-notifications -->

## Interpretations
- 2026-09-10T14:01:10Z — Execution mode: no orchestrator-provided answered-questions file exists on disk for this unit, and no prior nfr-design question phase is evidenced. Ran in Full mode but resolved the design questions by inference from the nfr-requirements gists (compiled graph context), the shipped functional-design for this unit, and the completed unit-request-workflow nfr pattern — rather than blocking with ask_question, matching the precedent set by the completed functional-design run for this unit.
- 2026-09-10T14:01:10Z — nfr-requirements for unit-notifications are not present as files on disk (only unit-request-workflow's are). Sourced the performance/reliability/scalability/security requirement substance from the compiled graph context gists and section lists supplied in the stage prompt, and grounded the designs against them by slug.

## Deviations
- 2026-09-10T14:01:10Z — The runtime's methodology MCP tools (create_artifact, link_artifacts, send_output, collect_metric, get_artifact, etc.) are NOT present in this session's actual tool set. The output contract asks to record each artifact via create_artifact; that tool cannot be invoked. Following the precedent set by this unit's functional-design and by unit-request-workflow / unit-platform-authz, wrote the five nfr-design artifacts to the working tree under aidlc-docs/construction/unit-notifications/nfr-design/ as the only available persistence, and surfaced the tool-availability gap explicitly rather than silently producing nothing.

## Tradeoffs
- 2026-09-10T14:01:10Z — Split latency budgets into a tight synchronous enqueue path (producer hot path, ≤3ms p95 per performance-requirements) and a loose asynchronous delivery path (off hot path). Designed the enqueue as the only thing on the workflow's critical path; all channel I/O (email provider, in-app store, directory resolution) is deferred to the async worker so a slow provider never touches the workflow commit.
- 2026-09-10T14:01:10Z — Chose a per-channel circuit breaker + bounded exponential-backoff-with-jitter retry + dead-letter queue over unbounded retry, consistent with reliability-requirements (Important-tier, 99.5% delivery SLO) and BR-NOTIF-7/10. Per-channel isolation (bulkhead) means an email-provider outage cannot starve in-app delivery.
- 2026-09-10T14:01:10Z — Kept the design broker-agnostic (queue behind a port), matching tech-stack-decisions ADR-NOTIF-02 (MVP in-process → managed queue). The scalability and reliability designs specify the properties the production broker must satisfy (at-least-once, visibility timeout, DLQ) rather than pinning a concrete AWS service, which is infrastructure-design's call.

## Open questions
- 2026-09-10T14:01:10Z — Confirm the concrete async-delivery SLO figures (p95/p99 end-to-end delivery latency, DLQ alert thresholds) with product/ops; performance-requirements marks several as TBD and this design carries proportionate placeholders.
- 2026-09-10T14:01:10Z — Confirm in-app notification retention window and delivery-record retention jointly with infrastructure-design and compliance (distinct from the 7-year audit-trail retention); the scalability design assumes a bounded retention with archival.
