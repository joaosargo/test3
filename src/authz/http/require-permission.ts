/**
 * requirePermission — Express authorization guard for unit-platform-authz.
 *
 * Realizes `story-rbac-role-access` at the HTTP boundary. It composes ON TOP OF
 * unit-platform-auth's `requireSession` middleware: authentication establishes
 * `req.session` (the principal reference); this guard resolves the principal's
 * role and enforces the RBAC decision via the in-process `AuthzService` PDP.
 *
 * Fail-closed (`security-design-unit-platform-authz`): on any deny it responds
 * 403 with a PII-free error envelope (matching the error shape used across the
 * monolith) and does NOT call `next()`. An absent principal yields 401 to match
 * the auth boundary's unauthenticated contract.
 *
 * PII (`req-nfr-security-pii`): the response carries only the machine-readable
 * reason and a static message — never the principal id, department, or claims.
 */

import type { Response, NextFunction, RequestHandler } from 'express';
import type { AuthenticatedRequest } from '../../http/session-middleware.js';
import type { AuthenticatedPrincipal } from '../../domain/entities.js';
import type { AuthzService, AuthzResource } from '../services/authz-service.js';
import type { AuthzGrant } from '../domain/authz-decision.js';
import type { Permission } from '../domain/roles.js';

/** Request augmented with the resolved authorization grant for handlers. */
export interface AuthorizedRequest extends AuthenticatedRequest {
  authzGrant?: AuthzGrant;
}

/**
 * Derive the `AuthenticatedPrincipal` the PDP needs from the validated session.
 * unit-platform-auth's session carries the stable principal reference; the raw
 * role/department claims are re-hydrated here from the session claims bag when
 * present. Callers that need richer claims can supply a custom resolver.
 */
export type PrincipalResolver = (
  req: AuthorizedRequest,
) => AuthenticatedPrincipal | undefined;

/** Extract the resource department (ABAC overlay) from the request. */
export type ResourceResolver = (req: AuthorizedRequest) => AuthzResource;

const defaultPrincipalResolver: PrincipalResolver = (req) => {
  if (!req.session) return undefined;
  // The session holds the principal reference; claims are attached by the
  // session pipeline when available. Default to an empty claim bag so the PDP
  // falls back to the RoleDirectoryPort.
  const rawClaims = (req as { principalClaims?: AuthenticatedPrincipal['rawClaims'] })
    .principalClaims;
  return {
    principalId: req.session.principalRef,
    rawClaims: rawClaims ?? {},
  };
};

const defaultResourceResolver: ResourceResolver = () => ({});

/**
 * Build a guard that authorizes `permission`. Compose after `requireSession`:
 *   router.post('/requests', requireSession(...), requirePermission(authz, 'request:submit'), handler)
 */
export function requirePermission(
  authz: AuthzService,
  permission: Permission,
  opts: {
    principalResolver?: PrincipalResolver;
    resourceResolver?: ResourceResolver;
  } = {},
): RequestHandler {
  const resolvePrincipal = opts.principalResolver ?? defaultPrincipalResolver;
  const resolveResource = opts.resourceResolver ?? defaultResourceResolver;

  return async (req: AuthorizedRequest, res: Response, next: NextFunction): Promise<void> => {
    const principal = resolvePrincipal(req);
    const resource = resolveResource(req);

    const decision = await authz.decide(principal, permission, resource);
    if (!decision.ok) {
      const status = decision.error.reason === 'UNAUTHENTICATED' ? 401 : 403;
      res.status(status).json({
        error: { code: decision.error.reason, message: decision.error.message },
      });
      return;
    }

    req.authzGrant = decision.value;
    next();
  };
}
