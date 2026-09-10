# NFR Design — memory — `unit-status-query`

Running log for the nfr-design stage of `unit-status-query`. Entries are appended
under the four standard headings with ISO 8601 timestamps.

## Interpretations

- 2026-09-10T14:03:40Z — Ran this stage in **ARTIFACT mode** (Steps 5–8): the
  nfr-requirements memory shows questions were already collected/approved and the
  five nfr-requirements inputs plus functional-design inputs are present on disk,
  with no `nfr-design-questions.md` to author. Designed solutions directly from the
  answered requirements rather than re-opening a question phase.
- 2026-09-10T14:03:40Z — Treated the six `consumes:` slugs
  (`performance-requirements`, `security-requirements`, `scalability-requirements`,
  `reliability-requirements`, `tech-stack-decisions`, `business-logic-model`) as the
  upstream-coverage set and cited each as a `[[wikilink]]` in **every** output, plus
  `[[business-rules]]` as the governing rule source, so the upstream-coverage sensor
  and the artifact graph stay traceable.
- 2026-09-10T14:03:40Z — Grounded infrastructure-facing decisions (ECS Fargate
  shared task, ALB, workflow-owned `vacation-requests-<env>` DynamoDB table,
  in-process auth/authz, CloudWatch/X-Ray, EventBridge bus) in the already-shipped
  `unit-request-workflow` infrastructure-design, since this unit consumes those
  resources read-only and owns none of its own.

## Deviations

- 2026-09-10T14:03:40Z — Persisted the five design artifacts
  (performance/security/scalability/reliability/logical-components) as markdown files
  under `aidlc-docs/construction/unit-status-query/nfr-design/` rather than via a
  `create_artifact` MCP tool, because the MCP methodology tools named in the stage
  prose are not present in this execution environment — the same interface reality the
  nfr-requirements and functional-design stages of this unit already recorded, and the
  same on-disk pattern the dependency unit `unit-request-workflow` uses. The runtime
  commits the working tree.
- 2026-09-10T14:03:40Z — Did not render an approval gate / completion question; a human
  reviews out-of-band per the execution environment. Skipped state-file/audit
  bookkeeping (runtime-owned).

## Tradeoffs

- 2026-09-10T14:03:40Z — **No read cache / materialized projection at MVP** (PERF-D-4,
  SCALE-D-12). Alternative: add a short-TTL cache-aside layer up front. Rejected — at
  projected volume the synchronous on-demand projection meets budget, and a cache adds
  staleness/invalidation risk against a strongly-consistent append-only store; the
  repository port lets it be added later behind the surface (design-for-change). When
  added, specified as cache-aside with short TTL + event-driven invalidation, never
  cached across principals.
- 2026-09-10T14:03:40Z — **No circuit breaker at MVP** (REL-D-8). Alternative: wrap the
  store read in a breaker now. Rejected — auth/authz are in-process (nothing to trip)
  and the single store hop is adequately guarded by timeout + bounded idempotent retry;
  a breaker is the deferred escalation behind the port if sustained store failure ever
  appears under load.
- 2026-09-10T14:03:40Z — Specified a `(department, status)` secondary index for the
  scoped-queue read (SCALE-D-7) as the design intent, but flagged build-now-vs-defer as
  an infrastructure-design decision against the concrete concurrency figure, rather than
  mandating provisioning at this stage.
- 2026-09-10T14:03:40Z — Kept the **99.9% availability placeholder** (REL-D-1) mirroring
  the workflow unit rather than inventing a distinct read SLO, since the read path shares
  infrastructure and dependencies with the command path; a divergent SLO would be
  arbitrary until `req-nfr-availability-tbd` is quantified.

## Open questions

- 2026-09-10T14:03:40Z — Confirm the concrete `req-nfr-concurrency` figure and its
  reads-vs-writes split so the placeholder read concurrency/throughput budgets and the
  SCALE-D-9 autoscaling thresholds / instance floor can be finalised.
- 2026-09-10T14:03:40Z — Confirm the `req-nfr-availability-tbd` target so the 99.9%
  read-path placeholder (REL-D-1) can be replaced.
- 2026-09-10T14:03:40Z — Decide with infrastructure-design whether to build the
  `(department, status)` GSI now (SCALE-D-7) or defer until the queue read is measured
  hot, and whether read replicas are warranted at the confirmed volume.
- 2026-09-10T14:03:40Z — Confirm the store-read timeout (~800 ms, REL-D-3) and retry
  budget (≤ 2, REL-D-4) against the production store's measured latency distribution,
  and the cold-read impact of long-term retention/archival of aged timelines with the
  `audit-trail` unit.
