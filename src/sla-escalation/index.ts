/**
 * Public API for unit-sla-escalation — the timer-driven SLA Reminder and
 * Escalation unit.
 *
 * The composition root (app.ts / server.ts) imports this unit exclusively
 * through this surface, keeping the unit's internals encapsulated — mirroring
 * `src/workflow/index.ts` and `src/notifications/index.ts`. The unit is driven
 * by a `SchedulerPort` (timer), reads `unit-request-workflow` read-only through
 * `WorkflowPendingQueryPort`, and dispatches through the reused
 * `unit-notifications` send seam — it never calls the workflow back and owns no
 * business state beyond its append-only reminder ledger.
 *
 * Grounded in `unit-of-work` (`unit-sla-escalation — SLA Reminder and
 * Escalation`) and the unit's functional-design (business-logic-model,
 * domain-entities, business-rules), nfr-design (logical-components), and
 * tech-stack-decisions.
 */

export { SlaScanService } from './services/sla-scan-service.js';
export type {
  SlaScanServiceDeps,
  ScanSummary,
  TierOutcome,
} from './services/sla-scan-service.js';

export { buildSlaRouter } from './http/sla-router.js';
export type { SlaRouterDeps } from './http/sla-router.js';

export { SlaError } from './domain/errors.js';
export type { SlaErrorCode } from './domain/errors.js';

export {
  SLA_EVALUATION_TIERS,
  SLA_FIRED_TIERS,
  SLA_OUTCOME_CODES,
  DEFAULT_ESCALATION_POLICY,
} from './domain/value-objects.js';
export type {
  SlaStage,
  SlaTier,
  SlaEvaluationTier,
  SlaOutcomeCode,
  SlaThresholds,
  EscalationPolicy,
  PendingRequestView,
  SlaEvaluation,
} from './domain/value-objects.js';

export type { ReminderRecord } from './domain/reminder-record.js';
export { reminderKey } from './domain/reminder-record.js';

export {
  evaluate,
  classify,
  pendingStageOf,
  elapsedMs,
  tiersUpTo,
  validatePolicy,
} from './domain/sla-policy.js';

export { renderSlaInApp, renderSlaEmail } from './domain/templates.js';
export type { RenderedSlaInApp, RenderedSlaEmail } from './domain/templates.js';

export type { SchedulerPort, ScanTickHandler } from './ports/scheduler-port.js';
export type { WorkflowPendingQueryPort } from './ports/workflow-pending-query-port.js';
export type { ReminderLedgerRepository } from './ports/reminder-ledger-repository.js';

export { InMemoryReminderLedger } from './adapters/in-memory-reminder-ledger.js';
export {
  WorkflowPendingQueryAdapter,
  type WorkflowPendingQueryAdapterDeps,
} from './adapters/workflow-pending-query-adapter.js';
export {
  IntervalScheduler,
  type IntervalSchedulerDeps,
} from './adapters/interval-scheduler.js';

export { registerSlaScheduler } from './subscribe.js';
