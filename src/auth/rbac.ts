import type { FastifyReply, FastifyRequest } from 'fastify';
import { and, eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { withContext } from '../db/context.js';
import { memberships } from '../db/schema/index.js';
import type { MembershipRoleResolver } from '../mcp/authorization.js';
import { InvalidAccessTokenError, verifyAccessToken } from './jwt.js';

declare module 'fastify' {
  interface FastifyRequest {
    userId?: string;
    tenantId?: string;
    /** Set only once `requireRole` has run and found a membership. */
    role?: MembershipRole;
  }
}

/**
 * Viewer < Contributor < Approver < Publisher < Tenant Admin
 * (docs/roles-and-review-plan.md):
 * - viewer: read the tenant's PTV data, drafts included
 * - contributor: + view, comment on and create proposals
 * - approver: + resolve proposals (approve + export, reject)
 * - publisher: + approve + apply (write to PTV)
 * - tenant_admin: + members, PTV credentials, tenant settings
 */
export const ROLE_RANK = {
  viewer: 0,
  contributor: 1,
  approver: 2,
  publisher: 3,
  tenant_admin: 4,
} as const;

export type MembershipRole = keyof typeof ROLE_RANK;

/** Verifies the bearer JWT and sets `request.userId`. Every other guard in this module depends on this having run first. */
export function createAuthenticate(jwtSecret: string) {
  return async function authenticate(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const header = request.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      return reply.unauthorized('Missing bearer token');
    }
    const token = header.slice('Bearer '.length);
    try {
      const payload = await verifyAccessToken(token, jwtSecret);
      request.userId = payload.sub;
    } catch (err) {
      if (err instanceof InvalidAccessTokenError) {
        return reply.unauthorized(err.message);
      }
      throw err;
    }
  };
}

/**
 * The one place that looks up "what role does this user have in this
 * tenant" — used both by the Fastify `requireRole` guard below and by
 * non-HTTP callers (e.g. the MCP tool layer, src/mcp/authorization.ts)
 * that need the same check without a Fastify request/reply in scope.
 * Returns `null` for no membership at all, never throws for that case.
 */
export async function resolveMembershipRole(
  db: Database,
  tenantId: string,
  userId: string,
): Promise<MembershipRole | null> {
  const membership = await withContext(db, { tenantId, userId }, async (tx) =>
    tx.query.memberships.findFirst({
      where: and(eq(memberships.tenantId, tenantId), eq(memberships.userId, userId)),
    }),
  );
  return membership?.role ?? null;
}

/**
 * Resolves the acting user's role for `request.params.tenantId` and rejects
 * if it's below `minRole`. Must run after `authenticate`. On success, sets
 * `request.tenantId`/`request.role` — this is the one place a route learns
 * "is this user allowed to act on this tenant, and as what."
 */
export function createRequireRole(db: Database, minRole: MembershipRole) {
  return async function requireRole(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (!request.userId) {
      return reply.unauthorized('Authentication required before role can be checked');
    }
    const { tenantId } = request.params as { tenantId?: string };
    if (!tenantId) {
      return reply.badRequest('Missing tenantId route parameter');
    }

    const role = await resolveMembershipRole(db, tenantId, request.userId);
    if (!role || ROLE_RANK[role] < ROLE_RANK[minRole]) {
      return reply.forbidden('Insufficient role for this tenant');
    }

    request.tenantId = tenantId;
    request.role = role;
  };
}

/**
 * A `MembershipRoleResolver` for the domain functions a route calls after
 * `requireRole`: it answers the acting user's role for the guarded tenant
 * from `request.role` instead of looking it up again, and falls back to
 * `resolveMembershipRole` for any other (tenant, user) pair — e.g. the
 * role of a reviewer being assigned.
 */
export function requestRoleResolver(db: Database, request: FastifyRequest): MembershipRoleResolver {
  return async (tenantId, userId) =>
    request.role !== undefined && tenantId === request.tenantId && userId === request.userId
      ? request.role
      : resolveMembershipRole(db, tenantId, userId);
}
