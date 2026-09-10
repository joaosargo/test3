import { Router, type Request, type Response } from 'express';
import * as cookie from 'cookie';
import type { AuthService } from '../services/auth-service.js';
import type { CookieOptions } from '../config/session-policy.js';
import { securityHeaders } from './security-headers.js';
import {
  requireSession,
  type AuthenticatedRequest,
} from './session-middleware.js';

/**
 * Auth HTTP routes for unit-platform-auth (story-sso-login). These wire the
 * `beginLogin` / `completeLogin` / `endSession` service contract to HTTP.
 * PII rule: state/nonce/tokens are never placed in redirect query logs; the
 * session cookie is Secure/HttpOnly and never appears in a URL (SEC-SES-1).
 */
export function buildAuthRouter(deps: {
  service: AuthService;
  cookieOptions: CookieOptions;
  loginReturnDefault?: string;
}): Router {
  const { service, cookieOptions } = deps;
  const router = Router();
  router.use(securityHeaders);

  const setSessionCookie = (res: Response, token: string, maxAgeSec: number): void => {
    res.setHeader(
      'Set-Cookie',
      cookie.serialize(cookieOptions.name, token, {
        httpOnly: cookieOptions.httpOnly,
        secure: cookieOptions.secure,
        sameSite: cookieOptions.sameSite.toLowerCase() as 'lax' | 'strict',
        path: '/',
        maxAge: maxAgeSec,
      }),
    );
  };

  const clearSessionCookie = (res: Response): void => {
    res.setHeader(
      'Set-Cookie',
      cookie.serialize(cookieOptions.name, '', {
        httpOnly: cookieOptions.httpOnly,
        secure: cookieOptions.secure,
        sameSite: cookieOptions.sameSite.toLowerCase() as 'lax' | 'strict',
        path: '/',
        maxAge: 0,
      }),
    );
  };

  // GET /auth/login — start the SSO handshake, redirect the browser to the IdP.
  router.get('/auth/login', async (req: Request, res: Response) => {
    const returnUrl = typeof req.query.returnUrl === 'string'
      ? req.query.returnUrl
      : (deps.loginReturnDefault ?? '/');
    const result = await service.beginLogin(returnUrl);
    if (!result.ok) {
      res
        .status(500)
        .json({ error: { code: result.error.code, message: result.error.message } });
      return;
    }
    res.redirect(302, result.value.authorizationUrl);
  });

  // GET /auth/callback — IdP redirect target; validate assertion, mint session.
  router.get(
    '/auth/callback',
    async (req: Request, res: Response) => {
      const code = typeof req.query.code === 'string' ? req.query.code : '';
      const state = typeof req.query.state === 'string' ? req.query.state : '';
      const overTls = req.secure || req.headers['x-forwarded-proto'] === 'https';

      const login = await service.completeLogin({ code, state, overTls });
      if (!login.ok) {
        // Fail closed: access denied, no session, no credential prompt.
        res
          .status(401)
          .json({ error: { code: login.error.code, message: 'Sign-in failed.' } });
        return;
      }

      const { session, token } = await service.establishSession(login.value);
      const maxAgeSec = Math.floor((session.absoluteExpiryAt - session.createdAt) / 1000);
      setSessionCookie(res, token, maxAgeSec);
      res.status(200).json({ authenticated: true });
    },
  );

  // POST /auth/logout — terminate the session server-side (idempotent).
  router.post(
    '/auth/logout',
    requireSession(service, cookieOptions),
    async (req: AuthenticatedRequest, res: Response) => {
      if (req.session) {
        await service.endSession(req.session.sessionId);
      }
      clearSessionCookie(res);
      res.status(204).end();
    },
  );

  // GET /auth/me — return the authenticated principal reference (guarded).
  router.get(
    '/auth/me',
    requireSession(service, cookieOptions),
    (req: AuthenticatedRequest, res: Response) => {
      res.status(200).json({ principalId: req.session?.principalRef });
    },
  );

  return router;
}
