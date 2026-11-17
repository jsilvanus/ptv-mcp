import type { FastifyInstance } from 'fastify';
import type { Database } from '../db/client.js';
import {
  EmailNotVerifiedForMembershipError,
  UserNotFoundError,
  type TenantService,
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
  /** `ALLOW_TENANT_CREATION`; defaults to true. When false `POST /tenants` answers 403. */
  allowTenantCreation?: boolean;
}

/**
 * The answer to `POST /tenants/:tenantId/members` whatever the outcome for the
 * email: added, unknown, or not verified. Identical wording and status, so the
 * response does not reveal which addresses have accounts.
 */
export const ADD_MEMBER_NEUTRAL_MESSAGE =
  'If an account with that email exists and is eligible, it has been added.';

interface CreateTenantBody {
  name: string;
  slug: string;
}

interface AddMemberBody {
  email: string;
  role: MembershipRole;
}

interface UpdateSettingsBody {
  requireFourEyes?: unknown;
}

interface UpdateMemberRoleBody {
  role: MembershipRole;
}

export async function tenantRoutes(
  app: FastifyInstance,
  options: TenantRoutesOptions,
): Promise<void> {
  const { tenantService, db } = options;
  const allowTenantCreation = options.allowTenantCreation ?? true;
  const authenticate = createAuthenticate(options.jwtSecret);
  const requireTenantAdmin = createRequireRole(db, 'tenant_admin');
  const requireViewer = createRequireRole(db, 'viewer');

  app.post<{ Body: CreateTenantBody }>(
    '/tenants',
    { preHandler: authenticate },
    async (request, reply) => {
      if (!allowTenantCreation) {
        return reply.forbidden(
          'Tenant creation is disabled on this server. Ask an operator to create the tenant.',
        );
      }
      const { name, slug } = request.body;
      if (!name || !slug) {
        return reply.badRequest('name and slug are required');
      }
      const { tenantId } = await tenantService.createTenant(name, slug, request.userId!);
      return reply.code(201).send({ tenantId, name, slug });
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
      } catch (error) {
        // Swallowed on purpose: unknown and unverified accounts get the same answer as a
        // successful add. The service has already audited the refusal as NotApplied.
        if (
          !(error instanceof UserNotFoundError) &&
          !(error instanceof EmailNotVerifiedForMembershipError)
        ) {
          throw error;
        }
      }
      return reply.code(200).send({ message: ADD_MEMBER_NEUTRAL_MESSAGE });
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
      await tenantService.updateMemberRole(tenantId, userId, role, request.userId!);
      return reply.code(204).send();
    },
  );

  // Every member may read the settings (the proposal page shows whether
  // four-eyes applies); only a Tenant Admin (Pääkäyttäjä) changes them.
  app.get(
    '/tenants/:tenantId/settings',
    { preHandler: [authenticate, requireViewer] },
    async (request) => {
      const { tenantId } = request.params as { tenantId: string };
      return tenantService.getSettings(tenantId);
    },
  );

  app.put<{ Body: UpdateSettingsBody }>(
    '/tenants/:tenantId/settings',
    { preHandler: [authenticate, requireTenantAdmin] },
    async (request, reply) => {
      const { tenantId } = request.params as { tenantId: string };
      const requireFourEyes = request.body?.requireFourEyes;
      if (typeof requireFourEyes !== 'boolean') {
        return reply.badRequest('requireFourEyes must be a boolean');
      }
      return tenantService.updateSettings(tenantId, { requireFourEyes }, request.userId!);
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
