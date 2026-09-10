/**
 * Express router for unit-overlap-indicator.
 *
 * Exposes the single guarded read endpoint backing
 * `OverlapReader.computeOverlap`:
 *
 *   GET /requests/:id/overlap   -> advisory overlap summary   (request:validate)
 *
 * It composes the SAME `requireSession` (unit-platform-auth) ->
 * `requirePermission` (unit-platform-authz) pipeline that guards the lead
 * review action (BR-SCOPE-1): a non-lead viewer is stopped with 403 before any
 * overlap read runs; the unit performs no independent authorization.
 *
 * Advisory posture (business-rules): the endpoint never mutates a request and
 * never gates a decision. On an expected read failure it returns 404 (unknown
 * reviewed request) or a fail-open 200-shape is NOT used — instead the client
 * hook treats any non-200 as "overlap unavailable" (frontend-components
 * `useOverlapSummary`). We surface a PII-free error envelope consistent with the
 * rest of the monolith (BR-PII-3).
 */

import { Router, type Request, type Response } from 'express';
import type { AuthService } from '../../services/auth-service.js';
import type { CookieOptions } from '../../config/session-policy.js';
import { requireSession } from '../../http/session-middleware.js';
import { requirePermission, type AuthzService } from '../../authz/index.js';
import type { OverlapReader } from '../ports/overlap-reader.js';
import type { OverlapError } from '../domain/overlap-error.js';

export interface OverlapRouterDeps {
  readonly reader: OverlapReader;
  readonly authService: AuthService;
  readonly authz: AuthzService;
  readonly cookieOptions: CookieOptions;
}

/** Map an `OverlapError.code` to an HTTP status (REST design guide). */
function statusFor(error: OverlapError): number {
  switch (error.code) {
    case 'NOT_FOUND':
      return 404;
    case 'READ_FAILED':
      return 503; // advisory read seam unavailable; client degrades fail-open
    default:
      return 400;
  }
}

/** Serialize an OverlapError into the shared PII-free error envelope. */
function sendError(res: Response, error: OverlapError): void {
  res.status(statusFor(error)).json({
    error: { code: error.code, message: error.message },
  });
}

export function buildOverlapRouter(deps: OverlapRouterDeps): Router {
  const router = Router();
  const session = requireSession(deps.authService, deps.cookieOptions);
  const guard = requirePermission(deps.authz, 'request:validate');

  // --- Read the advisory overlap summary (story-overlap-indicator) ---
  router.get('/requests/:id/overlap', session, guard, async (req: Request, res: Response) => {
    const result = await deps.reader.computeOverlap(req.params.id);
    if (!result.ok) return void sendError(res, result.error);
    const { hasOverlap, overlapCount, overlappingIds, window } = result.value;
    res.status(200).json({ hasOverlap, overlapCount, overlappingIds, window });
  });

  return router;
}
