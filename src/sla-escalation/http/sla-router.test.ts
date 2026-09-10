import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { buildSlaRouter } from './sla-router.js';
import { SlaScanService } from '../services/sla-scan-service.js';
import { InMemoryReminderLedger } from '../adapters/in-memory-reminder-ledger.js';
import { InMemoryRecipientDirectory } from '../../notifications/adapters/in-memory-recipient-directory.js';
import { InMemoryEmailSender } from '../../notifications/adapters/in-memory-email-sender.js';
import { InMemoryInAppInbox } from '../../notifications/adapters/in-memory-in-app-inbox.js';
import { AuthzService } from '../../authz/services/authz-service.js';
import { InMemoryRoleDirectory } from '../../authz/adapters/in-memory-role-directory.js';
import type { WorkflowPendingQueryPort } from '../ports/workflow-pending-query-port.js';
import type { PendingRequestView } from '../domain/value-objects.js';
import type { RequestId } from '../../workflow/domain/value-objects.js';
import type { AuthService } from '../../services/auth-service.js';
import type { Session } from '../../domain/entities.js';
import type { CookieOptions } from '../../config/session-policy.js';
import { ok } from '../../domain/result.js';

/**
 * Integration test for the guarded SLA debug route (`logical-components` C9;
 * `security-design` SEC-DES-4). Drives an ephemeral http.Server with Node's
 * built-in fetch (no new dependency), covering the status contract:
 * 401 unauthenticated, 403 unauthorized role, 200 evaluation, 404 unknown.
 *
 * A stub AuthService validates a fake token encoding the principal id; a real
 * AuthzService with an in-memory role directory enforces the RBAC decision.
 */

const HOUR = 60 * 60 * 1000;
const COOKIE_NAME = 'vra_session';
const cookieOptions: CookieOptions = { name: COOKIE_NAME, secure: false, httpOnly: true, sameSite: 'Lax' };

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

class StubPendingQuery implements WorkflowPendingQueryPort {
  constructor(private readonly views: PendingRequestView[]) {}
  async listPending(): Promise<readonly PendingRequestView[]> {
    return this.views;
  }
  async findById(requestId: RequestId): Promise<PendingRequestView | null> {
    return this.views.find((v) => v.requestId === requestId) ?? null;
  }
}

describe('SLA debug route HTTP integration', () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    const pending = new StubPendingQuery([
      { requestId: 'req-1', ownerId: 'emp-1', department: 'engineering', status: 'Submitted', enteredCurrentStatusAtMs: 0 },
    ]);
    const service = new SlaScanService({
      pending,
      ledger: new InMemoryReminderLedger(),
      directory: new InMemoryRecipientDirectory(),
      email: new InMemoryEmailSender(),
      inbox: new InMemoryInAppInbox(),
      policy: { thresholds: { TeamLead: { reminderAfterMs: 24 * HOUR, escalateAfterMs: 48 * HOUR } } },
      now: () => 25 * HOUR,
    });

    // hr-1 resolves to the HR role via the directory fallback (no role claim on
    // the stub session); hr holds `request:view-department`. emp-1 resolves to
    // employee, which does not.
    const roleDirectory = new InMemoryRoleDirectory({
      'hr-1': { role: 'hr', departments: ['engineering'] },
      'emp-1': { role: 'employee', departments: [] },
    });
    const authz = new AuthzService({ directory: roleDirectory });

    const app = express();
    app.use(express.json());
    app.use(buildSlaRouter({ service, authService: stubAuthService(), authz, cookieOptions }));

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
    const res = await fetch(`${baseUrl}/sla/requests/req-1/evaluate`);
    expect(res.status).toBe(401);
  });

  it('403 for an authenticated employee without the view-department permission', async () => {
    const res = await fetch(`${baseUrl}/sla/requests/req-1/evaluate`, { headers: authedHeaders('emp-1') });
    expect(res.status).toBe(403);
  });

  it('200 returns a PII-free evaluation for an authorized HR principal', async () => {
    const res = await fetch(`${baseUrl}/sla/requests/req-1/evaluate`, { headers: authedHeaders('hr-1') });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { evaluation: { tier: string; stage: string } };
    expect(body.evaluation.stage).toBe('TeamLead');
    expect(body.evaluation.tier).toBe('ReminderDue');
  });

  it('404 for an unknown / non-pending request id', async () => {
    const res = await fetch(`${baseUrl}/sla/requests/nope/evaluate`, { headers: authedHeaders('hr-1') });
    expect(res.status).toBe(404);
  });
});
