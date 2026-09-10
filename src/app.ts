import express, { type Express } from 'express';
import type { AuthService } from './services/auth-service.js';
import type { CookieOptions } from './config/session-policy.js';
import { buildAuthRouter } from './http/auth-router.js';

/**
 * Composition root for the unit-platform-auth HTTP surface. Wires the
 * AuthService (constructed from its ports) into an Express app. The concrete
 * OIDC client, session store, and token signer are injected by the caller
 * (server.ts in production; test doubles in tests) so this module never
 * touches secrets or external infra directly.
 */
export function createApp(deps: {
  service: AuthService;
  cookieOptions: CookieOptions;
}): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '32kb' }));
  app.use(buildAuthRouter({ service: deps.service, cookieOptions: deps.cookieOptions }));
  return app;
}
