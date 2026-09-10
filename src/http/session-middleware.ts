import type { Request, Response, NextFunction, RequestHandler } from 'express';
import * as cookie from 'cookie';
import type { AuthService } from '../services/auth-service.js';
import type { Session } from '../domain/entities.js';
import type { CookieOptions } from '../config/session-policy.js';

/** Express request augmented with the validated session. */
export interface AuthenticatedRequest extends Request {
  session?: Session;
}

function readSessionCookie(req: Request, cookieName: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  const parsed = cookie.parse(header);
  return parsed[cookieName];
}

/**
 * Per-request session-validation middleware (performance-design hot path).
 * Rejects unauthenticated requests fail-closed with 401 and never falls back
 * to any in-house auth (req-constraint-sso-mandatory). On a due idle-slide it
 * re-issues the session cookie via the throttled policy.
 */
export function requireSession(service: AuthService, cookieOpts: CookieOptions): RequestHandler {
  return async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    const token = readSessionCookie(req, cookieOpts.name);
    if (!token) {
      res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'Sign-in required.' } });
      return;
    }

    const result = await service.validateSession(token);
    if (!result.ok) {
      res
        .status(401)
        .json({ error: { code: 'SESSION_INVALID', message: 'Sign-in required.' } });
      return;
    }

    req.session = result.value;
    next();
  };
}
