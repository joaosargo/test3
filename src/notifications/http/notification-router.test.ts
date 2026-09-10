import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { buildNotificationRouter } from './notification-router.js';
import { NotificationService } from '../services/notification-service.js';
import { InMemoryRecipientDirectory } from '../adapters/in-memory-recipient-directory.js';
import { InMemoryEmailSender } from '../adapters/in-memory-email-sender.js';
import { InMemoryInAppInbox } from '../adapters/in-memory-in-app-inbox.js';
import { InMemoryNotificationDeliveryRepository } from '../adapters/in-memory-notification-delivery-repository.js';
import type { AuthService } from '../../services/auth-service.js';
import type { Session } from '../../domain/entities.js';
import type { CookieOptions } from '../../config/session-policy.js';
import { ok } from '../../domain/result.js';
import type { RequestApproved } from '../../workflow/domain/events.js';

/**
 * Integration test for the notification HTTP boundary
 * (notification-router + requireSession). Drives an ephemeral http.Server with
 * Node's built-in fetch (no new dependency), covering the status contract:
 * 200 list, 204 mark-read, 401 unauthenticated, 403 cross-scope, 404 unknown.
 *
 * A stub AuthService validates a fake session token encoding the principal id;
 * this isolates the notification router from the full OIDC flow. Self-scope
 * (`BR-NOTIF-12`) is enforced by the service, verified here end-to-end.
 */

const COOKIE_NAME = 'vra_session';
const cookieOptions: CookieOptions = {
  name: COOKIE_NAME,
  secure: false,
  httpOnly: true,
  sameSite: 'Lax',
};

function stubAuthService(): AuthService {
  const svc = {
    async validateSession(t: string) {
      const [id] = t.split('|');
      const session: Session = {
        sessionId: `sess-${id}`,
        principalRef: id,
        createdAt: 0,
        lastSeenAt: 0,
        absoluteExpiryAt: Number.MAX_SAFE_INTEGER,
      };
      return ok(session);
    },
  };
  return svc as unknown as AuthService;
}

const approved: RequestApproved = {
  type: 'RequestApproved',
  requestId: 'req-1',
  ownerId: 'emp-1',
  department: 'engineering',
  actorId: 'hr-1',
  status: 'Approved',
  atMs: 1000,
};

describe('notification HTTP integration', () => {
  let server: Server;
  let baseUrl: string;
  let inbox: InMemoryInAppInbox;
  let service: NotificationService;
  let seededId = '';

  beforeAll(async () => {
    const directory = new InMemoryRecipientDirectory().addContact({
      principalId: 'emp-1',
      email: 'emp1@corp.example',
    });
    inbox = new InMemoryInAppInbox();
    let ids = 0;
    service = new NotificationService({
      directory,
      email: new InMemoryEmailSender(),
      inbox,
      deliveries: new InMemoryNotificationDeliveryRepository(),
      now: () => 1000,
      newId: () => `notif-${++ids}`,
    });
    await service.handleEvent(approved); // seed one notification for emp-1
    seededId = (await inbox.list('emp-1'))[0]!.id;

    const app = express();
    app.use(express.json());
    app.use(
      buildNotificationRouter({ service, authService: stubAuthService(), cookieOptions }),
    );

    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function authedHeaders(principalId: string): Record<string, string> {
    return { cookie: `${COOKIE_NAME}=${encodeURIComponent(`${principalId}|`)}` };
  }

  it('401 when unauthenticated', async () => {
    const res = await fetch(`${baseUrl}/notifications`);
    expect(res.status).toBe(401);
  });

  it('200 lists the viewer’s own inbox', async () => {
    const res = await fetch(`${baseUrl}/notifications`, { headers: authedHeaders('emp-1') });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { notifications: unknown[] };
    expect(body.notifications).toHaveLength(1);
  });

  it('204 marks the viewer’s own notification read', async () => {
    const res = await fetch(`${baseUrl}/notifications/${seededId}/read`, {
      method: 'POST',
      headers: authedHeaders('emp-1'),
    });
    expect(res.status).toBe(204);
    expect(await inbox.list('emp-1', true)).toHaveLength(0);
  });

  it('403 when a different principal tries to mark-read (self-scope BR-NOTIF-12)', async () => {
    const res = await fetch(`${baseUrl}/notifications/${seededId}/read`, {
      method: 'POST',
      headers: authedHeaders('attacker-1'),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('FORBIDDEN');
  });

  it('404 for an unknown notification id', async () => {
    const res = await fetch(`${baseUrl}/notifications/nope/read`, {
      method: 'POST',
      headers: authedHeaders('emp-1'),
    });
    expect(res.status).toBe(404);
  });
});
