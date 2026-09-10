/**
 * Optional guarded debug route for unit-sla-escalation (`logical-components` C9;
 * `security-design` SEC-DES-4). The unit is headless and timer-driven — it has
 * no primary HTTP surface (functional-design `frontend-components`). This router
 * exposes ONE read-only, PII-free status read: the SLA evaluation for a single
 * request, for operability/debugging.
 *
 * It composes on the shipped platform seam: `requireSession` (unit-platform-auth)
 * then `requirePermission('request:view-department')` (unit-platform-authz) — the
 * same department-scoped read permission HR/leads already hold. Unauthenticated
 * access fails closed with 401; unauthorized with 403 (fail-closed, the shared
 * PII-free error envelope). This unit adds NO auth logic of its own.
 *
 * PII (`req-nfr-security-pii`, `BR-PII-1`): the response is the `SlaEvaluation`
 * (request id, stage, elapsed ms, tier, thresholds) — pseudonymous ids and
 * timings only, never contact data.
 */

import { Router, type Request, type Response } from 'express';
import type { AuthService } from '../../services/auth-service.js';
import type { CookieOptions } from '../../config/session-policy.js';
import { requireSession } from '../../http/session-middleware.js';
import { requirePermission } from '../../authz/http/require-permission.js';
import type { AuthzService } from '../../authz/services/authz-service.js';
import type { SlaScanService } from '../services/sla-scan-service.js';

export interface SlaRouterDeps {
  readonly service: SlaScanService;
  readonly authService: AuthService;
  readonly authz: AuthzService;
  readonly cookieOptions: CookieOptions;
}

/**
 * Build the guarded debug router. Mount under the app root; the single route is:
 *   GET /sla/requests/:requestId/evaluate  -> PII-free SlaEvaluation | 404
 */
export function buildSlaRouter(deps: SlaRouterDeps): Router {
  const router = Router();
  const session = requireSession(deps.authService, deps.cookieOptions);
  const permission = requirePermission(deps.authz, 'request:view-department');

  router.get(
    '/sla/requests/:requestId/evaluate',
    session,
    permission,
    async (req: Request, res: Response) => {
      const evaluation = await deps.service.evaluateById(req.params.requestId);
      if (!evaluation) {
        res.status(404).json({
          error: { code: 'NOT_FOUND', message: 'No pending request for that id.' },
        });
        return;
      }
      res.status(200).json({ evaluation });
    },
  );

  return router;
}
