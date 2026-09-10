/**
 * Public API + composition helpers for unit-overlap-indicator — the Overlap
 * Indicator read-side unit.
 *
 * The composition root (app.ts / server.ts) imports this unit exclusively
 * through this surface, mirroring `src/workflow/index.ts`, `src/authz/index.ts`,
 * and `src/hris/hris-balance.ts`. Per deployment-architecture
 * (`unit-overlap-indicator` Compute Model), this unit ships IN-PROCESS within
 * the modular-monolith app tier — it is not a separate service and adds no new
 * compute, network, or datastore resources.
 *
 * Grounded in `unit-of-work` (unit-overlap-indicator — Overlap Indicator) and
 * the functional-design artifacts (business-logic-model, business-rules,
 * domain-entities, frontend-components).
 */

import type { Express } from 'express';
import type { AuthService } from '../services/auth-service.js';
import type { CookieOptions } from '../config/session-policy.js';
import type { AuthzService } from '../authz/index.js';
import type { VacationRequestRepository } from '../workflow/index.js';
import { OverlapService } from './services/overlap-service.js';
import { buildOverlapRouter } from './http/overlap-router.js';

export { OverlapService } from './services/overlap-service.js';
export type { OverlapServiceDeps } from './services/overlap-service.js';

export { buildOverlapRouter } from './http/overlap-router.js';
export type { OverlapRouterDeps } from './http/overlap-router.js';

export { OverlapError } from './domain/overlap-error.js';
export type { OverlapErrorCode } from './domain/overlap-error.js';

export { COMPETING_STATUSES } from './domain/value-objects.js';
export type { OverlapSummary, OverlapQuery } from './domain/value-objects.js';

export type { OverlapReader } from './ports/overlap-reader.js';

/**
 * Construct the read-side overlap service from the workflow's read seam
 * (consumed read-only). The unit owns no repository of its own — it reuses the
 * shipped `VacationRequestRepository` (INV-OV-1, BR-ADV-1).
 */
export function createOverlapService(deps: {
  repository: VacationRequestRepository;
}): OverlapService {
  return new OverlapService({ repository: deps.repository });
}

/**
 * Mount the guarded overlap read route onto the shared Express app, reusing the
 * unit-platform-auth AuthService and unit-platform-authz PDP for the same
 * `requireSession -> requirePermission('request:validate')` pipeline that guards
 * the lead review action (BR-SCOPE-1).
 */
export function mountOverlapRoutes(
  app: Express,
  deps: {
    overlapService: OverlapService;
    authService: AuthService;
    authz: AuthzService;
    cookieOptions: CookieOptions;
  },
): void {
  app.use(
    buildOverlapRouter({
      reader: deps.overlapService,
      authService: deps.authService,
      authz: deps.authz,
      cookieOptions: deps.cookieOptions,
    }),
  );
}
