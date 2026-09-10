import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { buildOverlapRouter } from './overlap-router.js';
import { OverlapService } from '../services/overlap-service.js';
import {
  VacationRequest,
  type RequestStatus,
  type VacationRequestState,
  type VacationRequestRepository,
} from '../../workflow/index.js';
import { AuthzService, InMemoryRoleDirectory } from '../../authz/index.js';
import type { AuthService } from '../../services/auth-service.js';
import type { Session } from '../../domain/entities.js';
import { ok } from '../../domain/result.js';

/**
 * Integration test for the overlap HTTP boundary (overlap-router +
 * requireSession + requirePermission('request:validate')). Drives an ephemeral
 * http.Server with Node's built-in fetch (no new dependency), covering the
 * status-code contract: 200 with a PII-free summary, 401 unauthenticated,
 * 403 for a non-lead viewer (BR-SCOPE-1), 404 for an unknown reviewed request.
 *
 * Mirrors the workflow-router integration test: a stub AuthService validates a
 * `id|role|department` token and a small middleware attaches the claims bag the
 * authz PDP reads.
 */

const COOKIE_NAME = 'vra_session';
const DEPT = 'engineering';

function token(id: string, role: string, department: string): string {
  return `${id}|${role}|${department}`;
}

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

function attachClaims(): express.RequestHandler {
  return (req, _res, next) => {
    const header = req.headers.cookie ?? '';
    const match = header.match(new RegExp(`${COOKIE_NAME}=([^;]+)`));
    if (match) {
      const [, role, department] = decodeURIComponent(match[1]).split('|');
      (req as { principalClaims?: Record<string, unknown> }).principalClaims = { role, department };
    }
    next();
  };
}

function state(id: string, startDate: string, endDate: string, status: RequestStatus): VacationRequestState {
  return {
    id,
    ownerId: `owner-${id}`,
    department: DEPT,
    dates: { startDate, endDate },
    status,
    history: [{ from: null, to: 'Submitted', actorId: `owner-${id}`, atMs: 0 }],
    version: 1,
  };
}

/** Read-only repository seeded from fixed states. */
class SeededRepository implements VacationRequestRepository {
  private readonly byId = new Map<string, VacationRequestState>();
  constructor(states: VacationRequestState[]) {
    for (const s of states) this.byId.set(s.id, s);
  }
  async save(): Promise<never> {
    throw new Error('read-only test double');
  }
  async findById(id: string): Promise<VacationRequest | null> {
    const s = this.byId.get(id);
    return s ? VacationRequest.fromState(s) : null;
  }
  async findByOwner(): Promise<readonly VacationRequest[]> {
    return [];
  }
  async findByDepartmentAndStatus(
    department: string,
    status: RequestStatus,
  ): Promise<readonly VacationRequest[]> {
    return [...this.byId.values()]
      .filter((s) => s.department === department && s.status === status)
      .map((s) => VacationRequest.fromState(s));
  }
}

describe('overlap HTTP integration', () => {
  let server: Server;
  let baseUrl: string;

  const repository = new SeededRepository([
    state('R', '2999-06-10', '2999-06-14', 'Submitted'),
    state('a', '2999-06-12', '2999-06-18', 'Approved'),
  ]);
  const reader = new OverlapService({ repository });

  beforeAll(async () => {
    const app = express();
    app.disable('x-powered-by');
    app.use(express.json());
    app.use(attachClaims());
    app.use(
      buildOverlapRouter({
        reader,
        authService: stubAuthService(),
        authz: new AuthzService({ directory: new InMemoryRoleDirectory() }),
        cookieOptions: { secure: false, httpOnly: true, sameSite: 'Lax', name: COOKIE_NAME },
      }),
    );
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  });

  function authed(id: string, role: string, department: string): Record<string, string> {
    return { cookie: `${COOKIE_NAME}=${encodeURIComponent(token(id, role, department))}` };
  }

  it('401 when unauthenticated (no session cookie)', async () => {
    const res = await fetch(`${baseUrl}/requests/R/overlap`);
    expect(res.status).toBe(401);
  });

  it('403 when a non-lead viewer requests the overlap summary (BR-SCOPE-1)', async () => {
    const res = await fetch(`${baseUrl}/requests/R/overlap`, {
      headers: authed('emp-1', 'employee', DEPT),
    });
    expect(res.status).toBe(403);
  });

  it('200 with a PII-free overlap summary for a team lead (story-overlap-indicator)', async () => {
    const res = await fetch(`${baseUrl}/requests/R/overlap`, {
      headers: authed('lead-1', 'team-lead', DEPT),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      hasOverlap: boolean;
      overlapCount: number;
      overlappingIds: string[];
      window: { startDate: string; endDate: string };
    };
    expect(body.hasOverlap).toBe(true);
    expect(body.overlapCount).toBe(1);
    expect(body.overlappingIds).toEqual(['a']);
    expect(Object.keys(body).sort()).toEqual(['hasOverlap', 'overlapCount', 'overlappingIds', 'window']);
  });

  it('404 for an unknown reviewed request (BR-ADV-3)', async () => {
    const res = await fetch(`${baseUrl}/requests/nope/overlap`, {
      headers: authed('lead-1', 'team-lead', DEPT),
    });
    expect(res.status).toBe(404);
  });
});
