/**
 * Express router for unit-status-query — the read/query surface.
 *
 * Composes the shipped `requireSession` (unit-platform-auth) → handler pipeline,
 * the same authentication boundary the unit-request-workflow router uses. The
 * router is the trust boundary: it parses/validates the request shape and query
 * params, delegates the AUTHORIZED read to `StatusQueryService`, and maps the
 * `Result<_, StatusQueryError>` to a status code with the shared PII-free error
 * envelope used across the monolith.
 *
 * Endpoints (frontend-components "API Integration Points"; REST design guide):
 *   GET /status/requests                              -> listOwnRequests      (request:view-own)
 *   GET /status/departments/:department/requests      -> listScopedRequests   (view-team | view-department)
 *   GET /status/requests/:id/timeline                 -> getRequestTimeline   (resolved per relationship)
 *
 * AUTHORIZATION LIVES IN THE SERVICE. Unlike the mutating workflow routes (which
 * bind a single static permission at the `requirePermission` middleware), the
 * status reads resolve the least-privilege permission from the caller's role /
 * relationship to the resource (business-logic-model Query B/C, BR-SQ-2/3). The
 * router therefore guards only `requireSession` and lets `StatusQueryService`
 * call `AuthzService.decide` with the right permission + `{ department }` ABAC
 * resource — a single fail-closed decision, no client-trusted scoping.
 *
 * All reads are GETs (safe, idempotent). No mutation exists on any branch
 * (BR-SQ-15) — every state-changing verb belongs to unit-request-workflow.
 */

import { Router, type Request, type Response } from 'express';
import type { AuthService } from '../../services/auth-service.js';
import type { CookieOptions } from '../../config/session-policy.js';
import { requireSession, type AuthenticatedRequest } from '../../http/session-middleware.js';
import type { AuthorizedRequest } from '../../authz/index.js';
import type { AuthenticatedPrincipal } from '../../domain/entities.js';
import type { StatusQueryService } from '../services/status-query-service.js';
import type { StatusQueryError } from '../domain/status-query-error.js';
import type { StatusQueryFilter } from '../domain/projections.js';

export interface StatusQueryRouterDeps {
  readonly service: StatusQueryService;
  readonly authService: AuthService;
  readonly cookieOptions: CookieOptions;
}

/** Map a `StatusQueryError.code` to an HTTP status (frontend-components mapping). */
function statusFor(error: StatusQueryError): number {
  switch (error.code) {
    case 'INVALID_INPUT':
      return 422; // valid syntax, bad field value (BR-SQ-12..14)
    case 'FORBIDDEN':
      return 403;
    case 'NOT_FOUND':
      return 404;
    default:
      return 400;
  }
}

/** Serialize a StatusQueryError into the shared PII-free error envelope. */
function sendError(res: Response, error: StatusQueryError): void {
  const body: { error: { code: string; message: string; field?: string } } = {
    error: { code: error.code, message: error.message },
  };
  if (error.field !== undefined) body.error.field = error.field;
  res.status(statusFor(error)).json(body);
}

/** The unauthenticated envelope (mirrors the workflow router). */
function unauth(): { error: { code: string; message: string } } {
  return { error: { code: 'UNAUTHENTICATED', message: 'Sign-in required.' } };
}

/**
 * Derive the `AuthenticatedPrincipal` from the guarded request. `requireSession`
 * attaches `req.session` (the principal reference); the pipeline attaches the
 * claims bag as `req.principalClaims` when available (identical to the workflow
 * router's `principalFrom`).
 */
function principalFrom(req: AuthorizedRequest): AuthenticatedPrincipal | undefined {
  if (!req.session) return undefined;
  const claims = (req as { principalClaims?: AuthenticatedPrincipal['rawClaims'] }).principalClaims;
  return { principalId: req.session.principalRef, rawClaims: claims ?? {} };
}

/**
 * Read + validate the optional `status` query param into a `StatusQueryFilter`.
 * An absent param yields an empty filter ("all visible"); a present param is
 * carried through verbatim and re-validated in the service against the closed
 * `RequestStatus` set (BR-SQ-12) — the boundary does not silently drop it.
 */
function readFilter(req: Request): StatusQueryFilter {
  const raw = req.query.status;
  if (typeof raw === 'string' && raw.length > 0) {
    return { status: raw as StatusQueryFilter['status'] };
  }
  return {};
}

export function buildStatusQueryRouter(deps: StatusQueryRouterDeps): Router {
  const router = Router();
  const session = requireSession(deps.authService, deps.cookieOptions);

  // --- List my requests (story-status-tracking) ---
  router.get('/status/requests', session, async (req: Request, res: Response) => {
    const principal = principalFrom(req as AuthorizedRequest);
    if (!principal) return void res.status(401).json(unauth());
    const result = await deps.service.listOwnRequests(principal, readFilter(req));
    if (!result.ok) return void sendError(res, result.error);
    res.status(200).json({ items: result.value });
  });

  // --- Scoped queue: team-lead team / HR department view (req-status-tracking) ---
  router.get(
    '/status/departments/:department/requests',
    session,
    async (req: Request, res: Response) => {
      const principal = principalFrom(req as AuthorizedRequest);
      if (!principal) return void res.status(401).json(unauth());
      // The role intent is derived from the caller's own role claim; the PDP is
      // the arbiter of whether that role grants the chosen view permission.
      const role = readRoleIntent(principal);
      if (role === undefined) {
        // No lead/HR role → the PDP would deny; short-circuit as forbidden.
        return void res
          .status(403)
          .json({ error: { code: 'FORBIDDEN', message: 'You are not permitted to view this.' } });
      }
      const result = await deps.service.listScopedRequests(
        principal,
        role,
        String(req.params.department ?? ''),
        readFilter(req),
      );
      if (!result.ok) return void sendError(res, result.error);
      res.status(200).json({ items: result.value });
    },
  );

  // --- One request status + timeline (req-status-tracking; "across roles") ---
  router.get('/status/requests/:id/timeline', session, async (req: Request, res: Response) => {
    const principal = principalFrom(req as AuthorizedRequest);
    if (!principal) return void res.status(401).json(unauth());
    const result = await deps.service.getRequestTimeline(principal, String(req.params.id ?? ''));
    if (!result.ok) return void sendError(res, result.error);
    res.status(200).json(result.value);
  });

  return router;
}

/**
 * Read the caller's queue intent from the role claim. `team-lead` → team queue;
 * `hr` → department view. Any other role (employee) has no scoped-queue intent.
 * This is a UX routing hint only — the server-side PDP decision in the service
 * remains authoritative (BR-SQ-1/3); the client never scopes itself.
 */
function readRoleIntent(principal: AuthenticatedPrincipal): 'team-lead' | 'hr' | undefined {
  const raw = (principal.rawClaims as Record<string, unknown>).role;
  const role = typeof raw === 'string' ? raw : Array.isArray(raw) && typeof raw[0] === 'string' ? raw[0] : undefined;
  if (role === 'team-lead' || role === 'hr') return role;
  return undefined;
}

export type { AuthenticatedRequest };
