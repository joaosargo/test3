/**
 * Express router for unit-audit-trail — the auditor's read-only inspection
 * surface (frontend-components; story-immutable-audit).
 *
 * This unit is a backend event sink; its ONLY HTTP surface is read-only. There
 * is deliberately no create/update/delete route — the append-only contract
 * (`req-constraint-append-only-store`, `BR-AUD-5`) is enforced all the way to
 * the HTTP boundary.
 *
 * Auth pipeline reuses the shipped `requireSession` (unit-platform-auth) →
 * `requirePermission` (unit-platform-authz), exactly as `workflow-router.ts`.
 * The compliance-auditor reads across departments per the org-wide audit
 * mandate (functional-design memory open question, assumed org-wide); the
 * closest shipped permission for a cross-request compliance read is
 * `request:view-department`. A dedicated `audit:read` permission would require
 * changing the authz unit, which is out of this unit's lane — recorded in the
 * code-summary as a deviation to revisit.
 *
 * Fail-closed: unauthenticated → 401, unauthorized → 403 (owned by the guards).
 * Responses use the shared PII-free error envelope and `Cache-Control:
 * no-store` (`BR-AUD-8`).
 *
 * Endpoints (frontend-components Interaction Flows):
 *   GET  /audit/requests/:requestId          -> ordered trail for one request
 *   POST /audit/requests/:requestId/verify   -> integrity check (verifyChain)
 *   GET  /audit                              -> filtered query (TrailQuery)
 */

import { Router, type Request, type Response } from 'express';
import type { AuthService } from '../../services/auth-service.js';
import type { CookieOptions } from '../../config/session-policy.js';
import { requireSession } from '../../http/session-middleware.js';
import { requirePermission, type AuthzService } from '../../authz/index.js';
import type { AuditService } from '../services/audit-service.js';
import {
  type AuditRecord,
  type EventType,
  type TrailQuery,
  isEventType,
} from '../domain/audit-record.js';

export interface AuditRouterDeps {
  readonly service: AuditService;
  readonly authService: AuthService;
  readonly authz: AuthzService;
  readonly cookieOptions: CookieOptions;
}

/** PII-free read-only projection of an AuditRecord for the auditor UI (`BR-AUD-8`). */
export interface AuditRecordView {
  readonly auditId: string;
  readonly eventType: string;
  readonly requestId: string;
  readonly department: string;
  readonly actorId: string;
  readonly resultingState: string;
  readonly rejectedStage?: string;
  readonly occurredAtMs: number;
  readonly recordedAtMs: number;
  readonly hash: string;
}

function toView(record: AuditRecord): AuditRecordView {
  return {
    auditId: record.auditId,
    eventType: record.eventType,
    requestId: record.requestId,
    department: record.department,
    actorId: record.actorId,
    resultingState: record.resultingState,
    ...(record.rejectedStage !== undefined ? { rejectedStage: record.rejectedStage } : {}),
    occurredAtMs: record.occurredAtMs,
    recordedAtMs: record.recordedAtMs,
    hash: record.hash,
  };
}

/** Parse the optional `TrailQuery` from validated query-string params. */
function parseFilter(query: Request['query']): TrailQuery {
  const filter: {
    department?: string;
    eventType?: EventType;
    actorId?: string;
    fromMs?: number;
    toMs?: number;
  } = {};
  if (typeof query.department === 'string') filter.department = query.department;
  if (typeof query.eventType === 'string' && isEventType(query.eventType)) {
    filter.eventType = query.eventType;
  }
  if (typeof query.actorId === 'string') filter.actorId = query.actorId;
  const from = Number(query.from);
  const to = Number(query.to);
  if (query.from !== undefined && Number.isFinite(from)) filter.fromMs = from;
  if (query.to !== undefined && Number.isFinite(to)) filter.toMs = to;
  return filter;
}

export function buildAuditRouter(deps: AuditRouterDeps): Router {
  const { service, authService, authz, cookieOptions } = deps;
  const router = Router();
  const session = requireSession(authService, cookieOptions);
  // Compliance read guard — closest shipped permission (see module TSDoc).
  const guard = requirePermission(authz, 'request:view-department');

  // --- Ordered trail for one request ---
  router.get(
    '/audit/requests/:requestId',
    session,
    guard,
    async (req: Request, res: Response): Promise<void> => {
      res.setHeader('Cache-Control', 'no-store');
      const result = await service.getRequestTrail(req.params.requestId);
      if (!result.ok) {
        res.status(422).json({ error: { code: result.error.code, message: result.error.message } });
        return;
      }
      res.status(200).json({ records: result.value.map(toView) });
    },
  );

  // --- Integrity verification (verifyChain) ---
  router.post(
    '/audit/requests/:requestId/verify',
    session,
    guard,
    async (req: Request, res: Response): Promise<void> => {
      res.setHeader('Cache-Control', 'no-store');
      const result = await service.verifyChain(req.params.requestId);
      if (!result.ok) {
        // Integrity violation is a 200 verdict, not a server error: the auditor
        // MUST see that the chain is broken (and where), not a generic failure.
        if (result.error.code === 'INTEGRITY_VIOLATION') {
          res.status(200).json({
            integrity: 'violated',
            auditId: result.error.auditId,
            kind: result.error.kind,
          });
          return;
        }
        res.status(422).json({ error: { code: result.error.code, message: result.error.message } });
        return;
      }
      res.status(200).json({ integrity: 'intact' });
    },
  );

  // --- Filtered query ---
  router.get(
    '/audit',
    session,
    guard,
    async (req: Request, res: Response): Promise<void> => {
      res.setHeader('Cache-Control', 'no-store');
      const result = await service.queryTrail(parseFilter(req.query));
      if (!result.ok) {
        res.status(422).json({ error: { code: result.error.code, message: result.error.message } });
        return;
      }
      res.status(200).json({ records: result.value.map(toView) });
    },
  );

  return router;
}
