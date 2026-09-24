import type { FastifyInstance } from 'fastify';
import type { Database } from '../db/client.js';
import {
  MembershipNotFoundError,
  SlugAlreadyTakenError,
  type TenantService,
  UserNotFoundError,
} from '../tenants/tenantService.js';
import {
  createAuthenticate,
  createRequireRole,
  ROLE_RANK,
  type MembershipRole,
} from '../auth/rbac.js';

export interface TenantRoutesOptions {
  tenantService: TenantService;
  jwtSecret: string;
  db: Database;
}

interface CreateTenantBody {
  name: string;
  slug: string;
}

interface AddMemberBody {
  email: string;
  role: MembershipRole;
}

interface UpdateMemberRoleBody {
  role: MembershipRole;
}

export async function tenantRoutes(
  app: FastifyInstance,
  options: TenantRoutesOptions,
): Promise<void> {
  const { tenantService, db } = options;
  const authenticate = createAuthenticate(options.jwtSecret);
  const requireTenantAdmin = createRequireRole(db, 'tenant_admin');

  app.post<{ Body: CreateTenantBody }>(
    '/tenants',
    { preHandler: authenticate },
    async (request, reply) => {
      const { name, slug } = request.body;
      if (!name || !slug) {
        return reply.badRequest('name and slug are required');
      }
      try {
        const { tenantId } = await tenantService.createTenant(name, slug, request.userId!);
        return reply.code(201).send({ tenantId, name, slug });
      } catch (err) {
        if (err instanceof SlugAlreadyTakenError) {
          return reply.conflict(err.message);
        }
        throw err;
      }
    },
  );

  app.get('/tenants', { preHandler: authenticate }, async (request) => {
    return tenantService.listTenantsForUser(request.userId!);
  });

  app.get(
    '/tenants/:tenantId/members',
    { preHandler: [authenticate, requireTenantAdmin] },
    async (request) => {
      const { tenantId } = request.params as { tenantId: string };
      return tenantService.listMembers(tenantId);
    },
  );

  app.post<{ Body: AddMemberBody }>(
    '/tenants/:tenantId/members',
    { preHandler: [authenticate, requireTenantAdmin] },
    async (request, reply) => {
      const { tenantId } = request.params as { tenantId: string };
      const { email, role } = request.body;
      if (!email || !role) {
        return reply.badRequest('email and role are required');
      }
      if (!isMembershipRole(role)) return reply.badRequest(INVALID_ROLE_MESSAGE);
      try {
        await tenantService.addMember(tenantId, email, role, request.userId!);
        return reply.code(204).send();
      } catch (err) {
        if (err instanceof UserNotFoundError) {
          return reply.notFound(err.message);
        }
        throw err;
      }
    },
  );

  app.patch<{ Body: UpdateMemberRoleBody }>(
    '/tenants/:tenantId/members/:userId',
    { preHandler: [authenticate, requireTenantAdmin] },
    async (request, reply) => {
      const { tenantId, userId } = request.params as { tenantId: string; userId: string };
      const { role } = request.body;
      if (!role) {
        return reply.badRequest('role is required');
      }
      if (!isMembershipRole(role)) return reply.badRequest(INVALID_ROLE_MESSAGE);
      try {
        await tenantService.updateMemberRole(tenantId, userId, role, request.userId!);
        return reply.code(204).send();
      } catch (err) {
        if (err instanceof MembershipNotFoundError) {
          return reply.notFound(err.message);
        }
        throw err;
      }
    },
  );

  app.delete(
    '/tenants/:tenantId/members/:userId',
    { preHandler: [authenticate, requireTenantAdmin] },
    async (request, reply) => {
      const { tenantId, userId } = request.params as { tenantId: string; userId: string };
      await tenantService.removeMember(tenantId, userId, request.userId!);
      return reply.code(204).send();
    },
  );
}

const INVALID_ROLE_MESSAGE = `role must be one of: ${Object.keys(ROLE_RANK).join(', ')}`;

function isMembershipRole(value: unknown): value is MembershipRole {
  return typeof value === 'string' && Object.hasOwn(ROLE_RANK, value);
}
