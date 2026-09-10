/**
 * Express router for unit-request-workflow.
 *
 * Composes the shipped `requireSession` (unit-platform-auth) →
 * `requirePermission` (unit-platform-authz) → handler pipeline, exactly as the
 * authz `code-summary` integration note prescribes. The router is the trust
 * boundary: it parses/validates the request shape, delegates the decision to
 * `WorkflowService`, and maps the `Result<_, WorkflowError>` to a status code
 * with the shared PII-free error envelope used across the monolith.
 *
 * Endpoints (frontend-components Interaction Flows; REST guide):
 *   POST /requests                     -> submit           (request:submit)
 *   POST /requests/:id/validate        -> lead validate    (request:validate)
 *   POST /requests/:id/reject-lead     -> lead reject       (request:validate)
 *   POST /requests/:id/approve         -> HR approve        (request:approve)
 *   POST /requests/:id/reject-hr       -> HR reject         (request:approve)
 *   POST /requests/:id/withdraw        -> owner withdraw    (request:submit)
 *   GET  /requests/:id                 -> read one          (request:view-own | scoped)
 *
 * No override control exists on any branch (`req-hr-approve-reject-no-override`,
 * `req-team-lead-approve-reject`): the only mutating verbs are forward
 * (validate/approve) or terminate (reject/withdraw).
 */

import { Router, type Request, type Response, type RequestHandler } from 'express';
import type { AuthService } from '../../services/auth-service.js';
import type { CookieOptions } from '../../config/session-policy.js';
import { requireSession, type AuthenticatedRequest } from '../../http/session-middleware.js';
import {
  requirePermission,
  type AuthzService,
  type AuthorizedRequest,
} from '../../authz/index.js';
import type { WorkflowService } from '../services/workflow-service.js';
import { VacationRequest } from '../domain/vacation-request.js';
import type { WorkflowError } from '../domain/errors.js';
import { ok, type Result } from '../../domain/result.js';

export interface WorkflowRouterDeps {
  readonly service: WorkflowService;
  readonly authService: AuthService;
  readonly authz: AuthzService;
  readonly cookieOptions: CookieOptions;
}

/** Map a `WorkflowError.code` to an HTTP status (REST design guide). */
function statusFor(error: WorkflowError): number {
  switch (error.code) {
    case 'INVALID_INPUT':
      return 422; // valid syntax, business-rule (field) violation
    case 'FORBIDDEN':
      return 403;
    case 'NOT_FOUND':
      return 404;
    case 'STALE_STATE':
      return 409; // optimistic-concurrency conflict
    case 'ILLEGAL_TRANSITION':
      return 409; // state conflict
    default:
      return 400;
  }
}

/** Serialize a WorkflowError into the shared PII-free error envelope. */
function sendError(res: Response, error: WorkflowError): void {
  const body: { error: { code: string; message: string; field?: string } } = {
    error: { code: error.code, message: error.message },
  };
  if (error.field !== undefined) body.error.field = error.field;
  res.status(statusFor(error)).json(body);
}

/** Public projection of a request aggregate (PII-free-safe for the owner/approver). */
function toDto(request: VacationRequest): Record<string, unknown> {
  const state = request.toState();
  return {
    id: state.id,
    ownerId: state.ownerId,
    department: state.department,
    dates: state.dates,
    reason: state.reason,
    status: state.status,
    rejectedStage: state.rejectedStage,
    version: state.version,
    history: state.history,
  };
}

/** Parse and coerce the `expectedVersion` field from a decision body. */
function readExpectedVersion(body: unknown): Result<number, string> {
  const raw = (body as { expectedVersion?: unknown } | null)?.expectedVersion;
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 1) return ok(raw);
  return { ok: false, error: 'expectedVersion' };
}

export function buildWorkflowRouter(deps: WorkflowRouterDeps): Router {
  const router = Router();
  const session = requireSession(deps.authService, deps.cookieOptions);

  // The PDP needs the principal's claims to resolve role/department. The auth
  // session middleware attaches `req.session`; when the pipeline also attaches
  // the principal claims bag, the default resolver in requirePermission uses it.
  const guard = (permission: Parameters<typeof requirePermission>[1]): RequestHandler =>
    requirePermission(deps.authz, permission);

  // --- Submit (story-submit-request) ---
  router.post('/requests', session, guard('request:submit'), async (req: Request, res: Response) => {
    const principal = principalFrom(req as AuthorizedRequest);
    if (!principal) return void res.status(401).json(unauth());
    const body = (req.body ?? {}) as { startDate?: string; endDate?: string; reason?: string };
    const result = await deps.service.submitRequest(principal, {
      startDate: String(body.startDate ?? ''),
      endDate: String(body.endDate ?? ''),
      ...(body.reason !== undefined ? { reason: String(body.reason) } : {}),
    });
    if (!result.ok) return void sendError(res, result.error);
    res.status(201).location(`/requests/${result.value.id}`).json(toDto(result.value));
  });

  // --- Team-lead validate / reject (story-lead-validate) ---
  router.post('/requests/:id/validate', session, guard('request:validate'), decisionHandler('lead', 'validate'));
  router.post('/requests/:id/reject-lead', session, guard('request:validate'), decisionHandler('lead', 'reject'));

  // --- HR approve / reject (story-hr-approve) ---
  router.post('/requests/:id/approve', session, guard('request:approve'), decisionHandler('hr', 'approve'));
  router.post('/requests/:id/reject-hr', session, guard('request:approve'), decisionHandler('hr', 'reject'));

  // --- Owner withdraw (BR-WF-9) ---
  router.post('/requests/:id/withdraw', session, guard('request:submit'), async (req: Request, res: Response) => {
    const principal = principalFrom(req as AuthorizedRequest);
    if (!principal) return void res.status(401).json(unauth());
    const version = readExpectedVersion(req.body);
    if (!version.ok) return void res.status(422).json({ error: { code: 'INVALID_INPUT', message: 'expectedVersion is required.', field: 'expectedVersion' } });
    const result = await deps.service.withdrawRequest(principal, {
      requestId: req.params.id,
      expectedVersion: version.value,
      ...(readReason(req.body) !== undefined ? { reason: readReason(req.body) as string } : {}),
    });
    if (!result.ok) return void sendError(res, result.error);
    res.status(200).json(toDto(result.value));
  });

  // --- Read one (req-status-tracking) ---
  router.get('/requests/:id', session, guard('request:view-own'), async (req: Request, res: Response) => {
    const request = await deps.service.getRequest(req.params.id);
    if (!request) return void res.status(404).json({ error: { code: 'NOT_FOUND', message: 'The requested resource was not found.' } });
    res.status(200).json(toDto(request));
  });

  return router;

  /** Build a stage-decision handler for the lead/HR endpoints. */
  function decisionHandler(stage: 'lead' | 'hr', decision: 'validate' | 'reject' | 'approve'): RequestHandler {
    return async (req: Request, res: Response) => {
      const principal = principalFrom(req as AuthorizedRequest);
      if (!principal) return void res.status(401).json(unauth());
      const version = readExpectedVersion(req.body);
      if (!version.ok) {
        return void res.status(422).json({ error: { code: 'INVALID_INPUT', message: 'expectedVersion is required.', field: 'expectedVersion' } });
      }
      const cmd = {
        requestId: req.params.id,
        expectedVersion: version.value,
        ...(readReason(req.body) !== undefined ? { reason: readReason(req.body) as string } : {}),
      };
      const result =
        stage === 'lead'
          ? await deps.service.leadDecision(principal, decision === 'reject' ? 'reject' : 'validate', cmd)
          : await deps.service.hrDecision(principal, decision === 'reject' ? 'reject' : 'approve', cmd);
      if (!result.ok) return void sendError(res, result.error);
      res.status(200).json(toDto(result.value));
    };
  }
}

/** Read the optional reason from a decision body. */
function readReason(body: unknown): string | undefined {
  const raw = (body as { reason?: unknown } | null)?.reason;
  return typeof raw === 'string' ? raw : undefined;
}

/**
 * Derive the AuthenticatedPrincipal from the guarded request. The authz guard
 * populates `req.authzGrant`; the session carries the principal reference and
 * (when the pipeline attaches it) the claims bag.
 */
function principalFrom(req: AuthorizedRequest): { principalId: string; rawClaims: Record<string, unknown> } | undefined {
  if (!req.session) return undefined;
  const claims = (req as { principalClaims?: Record<string, unknown> }).principalClaims;
  return { principalId: req.session.principalRef, rawClaims: claims ?? {} };
}

function unauth(): { error: { code: string; message: string } } {
  return { error: { code: 'UNAUTHENTICATED', message: 'Sign-in required.' } };
}

export type { AuthenticatedRequest };
