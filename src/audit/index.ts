/**
 * Public API for unit-audit-trail — the Immutable Audit Trail.
 *
 * The composition root (app.ts / server.ts) imports this unit exclusively
 * through this surface, keeping the sink's internals encapsulated — mirroring
 * `src/authz/index.ts`, `src/hris/hris-balance.ts`, and
 * `src/workflow/index.ts`.
 *
 * Grounded in `unit-of-work` (unit-audit-trail — Immutable Audit Trail),
 * `deployment-architecture` (embedded in-process module of the modular
 * monolith), and the functional-design artifacts (`business-logic-model`,
 * `domain-entities`, `business-rules`). The unit is a choreography side-effect
 * consumer: it subscribes to the workflow's `EventPublisher` and never calls
 * the workflow unit back.
 */

import type { Express } from 'express';
import type { AuthService } from '../services/auth-service.js';
import type { CookieOptions } from '../config/session-policy.js';
import type { AuthzService } from '../authz/index.js';
import type { InMemoryEventPublisher } from '../workflow/index.js';
import { AuditService, type AuditServiceDeps } from './services/audit-service.js';
import { InMemoryAuditStore } from './adapters/in-memory-audit-store.js';
import type { AuditStore } from './ports/audit-store.js';
import { buildAuditRouter } from './http/audit-router.js';

export { AuditService } from './services/audit-service.js';
export type { AuditServiceDeps } from './services/audit-service.js';

export { buildAuditRouter } from './http/audit-router.js';
export type { AuditRouterDeps, AuditRecordView } from './http/audit-router.js';

export type { AuditStore } from './ports/audit-store.js';
export { InMemoryAuditStore } from './adapters/in-memory-audit-store.js';

export {
  type AuditRecord,
  type AuditableEvent,
  type AuditId,
  type EventType,
  type RecordHash,
  type TrailQuery,
  AuditError,
  EVENT_TYPES,
  GENESIS,
  HASH_VERSION,
  SEVEN_YEARS_MS,
  createAuditRecord,
  isEventType,
  recomputeHash,
} from './domain/audit-record.js';

export { canonicalSerialize, sha256Hex, newAuditId } from './domain/canonical.js';
export { type AuditPolicy, DEFAULT_AUDIT_POLICY } from './config/audit-policy.js';

/** Construct the AuditService, defaulting to the in-memory dev/test store. */
export function createAuditService(
  deps: Omit<AuditServiceDeps, 'store'> & { store?: AuditStore } = {},
): AuditService {
  const store = deps.store ?? new InMemoryAuditStore();
  return new AuditService({ ...deps, store });
}

/**
 * Wire the audit ingest handler to the workflow's in-process event publisher
 * (choreography seam; business-logic-model Data Flow). Each published
 * `WorkflowEvent` is recorded as exactly one immutable AuditRecord.
 *
 * Production swaps the in-process publisher for a durable bus subscription
 * behind the same `EventPublisher` port (infrastructure-design).
 */
export function subscribeAuditTrail(
  publisher: InMemoryEventPublisher,
  service: AuditService,
): void {
  publisher.subscribe(async (event) => {
    await service.recordEvent(event);
  });
}

/** Mount the guarded read-only audit routes onto the shared Express app. */
export function mountAuditRoutes(
  app: Express,
  deps: {
    auditService: AuditService;
    authService: AuthService;
    authz: AuthzService;
    cookieOptions: CookieOptions;
  },
): void {
  app.use(
    buildAuditRouter({
      service: deps.auditService,
      authService: deps.authService,
      authz: deps.authz,
      cookieOptions: deps.cookieOptions,
    }),
  );
}
