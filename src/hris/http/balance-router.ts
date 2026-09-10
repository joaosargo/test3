import { Router, type Response } from 'express';
import type { AuthService } from '../../services/auth-service.js';
import type { CookieOptions } from '../../config/session-policy.js';
import {
  requireSession,
  type AuthenticatedRequest,
} from '../../http/session-middleware.js';
import type { BalanceService } from '../services/balance-service.js';
import type { BalanceOutcome } from '../domain/balance.js';

/**
 * HTTP route for the display-only leave balance (story-display-balance).
 *
 * Authentication is INHERITED from unit-platform-auth via the shared
 * `requireSession` middleware (security-design "Authentication & Authorization
 * Model": this unit adds no auth path and defers authorization). The read is
 * scoped to the authenticated principal's own balance — the client cannot ask
 * for another employee's balance.
 *
 * The response is a stable envelope that surfaces the non-blocking degraded
 * state directly (`status: "unavailable"`) so the UI can render an advisory
 * placeholder without treating it as an error. `Cache-Control: no-store`
 * because the payload is PII (req-nfr-security-pii).
 */
export function buildBalanceRouter(deps: {
  balanceService: BalanceService;
  authService: AuthService;
  cookieOptions: CookieOptions;
}): Router {
  const { balanceService, authService, cookieOptions } = deps;
  const router = Router();

  router.get(
    '/me/leave-balance',
    requireSession(authService, cookieOptions),
    async (req: AuthenticatedRequest, res: Response): Promise<void> => {
      const principalRef = req.session?.principalRef;
      if (!principalRef) {
        // Defensive: requireSession guarantees a session, but fail closed.
        res
          .status(401)
          .json({ error: { code: 'UNAUTHENTICATED', message: 'Sign-in required.' } });
        return;
      }

      // Own-principal scoping: the employee reference IS the session subject.
      const result = await balanceService.getBalance(principalRef);
      res.setHeader('Cache-Control', 'no-store');

      if (!result.ok) {
        res
          .status(400)
          .json({ error: { code: result.error.code, message: result.error.message } });
        return;
      }

      res.status(200).json(toEnvelope(result.value));
    },
  );

  return router;
}

/** Map a BalanceOutcome to the stable display envelope (PII-safe by shape). */
function toEnvelope(outcome: BalanceOutcome): Record<string, unknown> {
  if (outcome.status === 'unavailable') {
    return { status: 'unavailable', reason: outcome.reason };
  }
  const { balance } = outcome;
  return {
    status: 'available',
    balance: {
      accruedDays: balance.accruedDays,
      usedDays: balance.usedDays,
      remainingDays: balance.remainingDays,
      asOf: balance.asOf,
      stale: balance.stale,
    },
  };
}
