/**
 * Express router for unit-notifications — the in-app inbox surface.
 *
 * Realizes the reader half of `req-notifications-email-inapp` / `story-notifications`
 * at the HTTP boundary (frontend-components Interaction Flows). The email
 * channel is headless (an outbound adapter) and has no route here.
 *
 * The router composes the shipped `requireSession` (unit-platform-auth) so
 * unauthenticated access fails closed with 401. It does NOT compose
 * `requirePermission`: the in-app inbox is keyed on the viewing principal, not
 * their role (frontend-components — "the inbox is the same for every role
 * because it is keyed on the viewing principal"). Self-scope (`BR-NOTIF-12`) is
 * enforced server-side by `NotificationService`, which maps a cross-principal
 * mark-read to `403`. Interactive UI elements carry `data-testid` in the
 * client (frontend-components); the JSON API mirrors the shared PII-free error
 * envelope used across the monolith.
 *
 * Endpoints (REST design guide):
 *   GET  /notifications                 -> list the viewer's own inbox
 *   POST /notifications/:id/read        -> mark one of the viewer's own read
 */

import { Router, type Request, type Response } from 'express';
import type { AuthService } from '../../services/auth-service.js';
import type { CookieOptions } from '../../config/session-policy.js';
import { requireSession, type AuthenticatedRequest } from '../../http/session-middleware.js';
import type { AuthenticatedPrincipal } from '../../domain/entities.js';
import type { NotificationService } from '../services/notification-service.js';
import type { NotificationError } from '../domain/errors.js';
import type { InAppNotification } from '../domain/entities.js';

export interface NotificationRouterDeps {
  readonly service: NotificationService;
  readonly authService: AuthService;
  readonly cookieOptions: CookieOptions;
}

/** Map a `NotificationError.code` to an HTTP status (REST design guide). */
function statusFor(error: NotificationError): number {
  switch (error.code) {
    case 'FORBIDDEN':
      return 403;
    case 'NOT_FOUND':
      return 404;
    case 'RECIPIENT_UNRESOLVED':
    case 'CHANNEL_ERROR':
      return 400;
    default:
      return 400;
  }
}

/** Serialize a NotificationError into the shared PII-free error envelope. */
function sendError(res: Response, error: NotificationError): void {
  res.status(statusFor(error)).json({ error: { code: error.code, message: error.message } });
}

/** Public projection of an in-app notification (already PII-minimal). */
function toDto(notification: InAppNotification): Record<string, unknown> {
  return {
    id: notification.id,
    requestId: notification.requestId,
    eventType: notification.eventType,
    title: notification.title,
    body: notification.body,
    read: notification.read,
    createdAtMs: notification.createdAtMs,
  };
}

function unauth(): { error: { code: string; message: string } } {
  return { error: { code: 'UNAUTHENTICATED', message: 'Sign-in required.' } };
}

/**
 * Derive the `AuthenticatedPrincipal` from the validated session. The session
 * carries the principal reference; claims are attached by the session pipeline
 * when present (mirrors the workflow router's `principalFrom`).
 */
function principalFrom(req: AuthenticatedRequest): AuthenticatedPrincipal | undefined {
  if (!req.session) return undefined;
  const claims = (req as { principalClaims?: AuthenticatedPrincipal['rawClaims'] }).principalClaims;
  return { principalId: req.session.principalRef, rawClaims: claims ?? {} };
}

export function buildNotificationRouter(deps: NotificationRouterDeps): Router {
  const router = Router();
  const session = requireSession(deps.authService, deps.cookieOptions);

  // --- List the viewer's own inbox (story-notifications, self-scoped) ---
  router.get('/notifications', session, async (req: Request, res: Response) => {
    const principal = principalFrom(req as AuthenticatedRequest);
    if (!principal) return void res.status(401).json(unauth());
    const unreadOnly = String((req.query.unreadOnly ?? '')).toLowerCase() === 'true';
    const result = await deps.service.listForRecipient(principal, unreadOnly);
    if (!result.ok) return void sendError(res, result.error);
    res.status(200).json({ notifications: result.value.map(toDto) });
  });

  // --- Mark one of the viewer's own notifications read (idempotent) ---
  router.post('/notifications/:id/read', session, async (req: Request, res: Response) => {
    const principal = principalFrom(req as AuthenticatedRequest);
    if (!principal) return void res.status(401).json(unauth());
    const result = await deps.service.markRead(principal, req.params.id);
    if (!result.ok) return void sendError(res, result.error);
    res.status(204).end();
  });

  return router;
}
