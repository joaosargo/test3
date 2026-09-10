import type { Express } from 'express';
import type { AuthService } from '../services/auth-service.js';
import type { CookieOptions } from '../config/session-policy.js';
import { BalanceService } from './services/balance-service.js';
import type { HrisClientPort } from './ports/hris-client.js';
import type { BalanceCache } from './ports/balance-cache.js';
import { InMemoryBalanceCache } from './adapters/in-memory-balance-cache.js';
import { type BalancePolicy, DEFAULT_BALANCE_POLICY } from './config/balance-policy.js';
import { buildBalanceRouter } from './http/balance-router.js';

/**
 * Composition helpers for unit-hris-balance.
 *
 * Per deployment-architecture (Compute Model), this unit ships IN-PROCESS
 * within the modular-monolith app tier — it is not a separate service. These
 * helpers let the application composition root construct the service from its
 * ports and mount the guarded route onto the shared Express app, reusing the
 * unit-platform-auth AuthService for session validation.
 */

export function createBalanceService(deps: {
  hris: HrisClientPort;
  cache?: BalanceCache;
  policy?: BalancePolicy;
  clock?: () => number;
}): BalanceService {
  const policy = deps.policy ?? DEFAULT_BALANCE_POLICY;
  const cache =
    deps.cache ?? new InMemoryBalanceCache({ ttlSeconds: policy.cacheTtlSeconds, clock: deps.clock });
  return new BalanceService({ hris: deps.hris, cache, policy, clock: deps.clock });
}

export function mountBalanceRoutes(
  app: Express,
  deps: {
    balanceService: BalanceService;
    authService: AuthService;
    cookieOptions: CookieOptions;
  },
): void {
  app.use(buildBalanceRouter(deps));
}
