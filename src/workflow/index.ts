/**
 * Public API for unit-request-workflow — the Vacation Request Workflow core.
 *
 * The composition root (app.ts / server.ts) and downstream units
 * (status-tracking, overlap-indicator, notification, audit-trail) import this
 * unit exclusively through this surface, keeping the aggregate's internals
 * encapsulated — mirroring `src/authz/index.ts`.
 *
 * Grounded in `unit-of-work` (unit-request-workflow — Vacation Request Workflow
 * Core) and the functional-design artifacts (business-logic-model,
 * domain-entities, business-rules).
 */

export { WorkflowService } from './services/workflow-service.js';
export type {
  WorkflowServiceDeps,
  DecisionCommand,
  LeadDecision,
  HrDecision,
} from './services/workflow-service.js';

export { buildWorkflowRouter } from './http/workflow-router.js';
export type { WorkflowRouterDeps } from './http/workflow-router.js';

export { VacationRequest } from './domain/vacation-request.js';
export type { VacationRequestState } from './domain/vacation-request.js';

export { WorkflowError } from './domain/errors.js';
export type { WorkflowErrorCode } from './domain/errors.js';

export {
  REQUEST_STATUSES,
  TERMINAL_STATUSES,
  WORKFLOW_STAGES,
  MAX_REASON_LENGTH,
  isTerminal,
  isValidCalendarDate,
  rangesOverlap,
} from './domain/value-objects.js';
export type {
  RequestId,
  DepartmentCode,
  RequestStatus,
  WorkflowStage,
  DateRange,
  Transition,
  SubmitRequestInput,
} from './domain/value-objects.js';

export type {
  WorkflowEvent,
  WorkflowEventType,
  RequestSubmitted,
  RequestValidated,
  RequestApproved,
  RequestRejected,
  RequestWithdrawn,
} from './domain/events.js';

export type { VacationRequestRepository } from './ports/vacation-request-repository.js';
export type { EventPublisher } from './ports/event-publisher.js';

export { InMemoryVacationRequestRepository } from './adapters/in-memory-vacation-request-repository.js';
export {
  InMemoryEventPublisher,
  type WorkflowEventHandler,
} from './adapters/in-memory-event-publisher.js';
