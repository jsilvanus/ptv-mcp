import type { FastifyReply, FastifyRequest } from 'fastify';
import { and, eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { withContext } from '../db/context.js';
import { memberships } from '../db/schema/index.js';
import { InvalidAccessTokenError, verifyAccessToken } from './jwt.js';

declare module 'fastify' {
  interface FastifyRequest {
    userId?: string;
    tenantId?: string;
    /** Set only once `requireRole` has run and found a membership. */
    role?: MembershipRole;
  }
}

/** Reader < Editor < Publisher < Tenant Admin, per docs/plan.md's role model. */
export const ROLE_RANK = {
  reader: 0,
  editor: 1,
  publisher: 2,
  tenant_admin: 3,
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

    const membership = await withContext(db, { tenantId, userId: request.userId }, async (tx) =>
      tx.query.memberships.findFirst({
        where: and(eq(memberships.tenantId, tenantId), eq(memberships.userId, request.userId!)),
      }),
    );

    if (!membership || ROLE_RANK[membership.role] < ROLE_RANK[minRole]) {
      return reply.forbidden('Insufficient role for this tenant');
    }

    request.tenantId = tenantId;
    request.role = membership.role;
  };
}
