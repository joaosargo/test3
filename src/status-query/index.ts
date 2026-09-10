/**
 * Public API for unit-status-query — the Status Tracking & Query read model.
 *
 * The composition root (app.ts / server.ts) imports this unit exclusively
 * through this surface, keeping the read model's internals encapsulated —
 * mirroring `src/workflow/index.ts` and `src/authz/index.ts`.
 *
 * This unit owns NO state and NO persistence port: it reads through the shipped
 * `VacationRequestRepository` (unit-request-workflow) and authorizes through the
 * shipped `AuthzService` (unit-platform-authz), both consumed read-only.
 *
 * Grounded in `unit-of-work` (unit-status-query — Status Tracking and Query) and
 * the functional-design artifacts (business-logic-model, domain-entities,
 * business-rules, frontend-components).
 */

export { StatusQueryService } from './services/status-query-service.js';
export type { StatusQueryServiceDeps } from './services/status-query-service.js';

export { buildStatusQueryRouter } from './http/status-query-router.js';
export type { StatusQueryRouterDeps } from './http/status-query-router.js';

export { StatusQueryError } from './domain/status-query-error.js';
export type { StatusQueryErrorCode } from './domain/status-query-error.js';

export type {
  RequestSummaryView,
  RequestStatusView,
  RequestTimelineView,
  TimelineEntry,
  StatusQueryFilter,
} from './domain/projections.js';
