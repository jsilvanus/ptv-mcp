import type { FastifyInstance } from 'fastify';
import type { Database } from '../db/client.js';
import type { PtvAdapterRegistry } from '../ptv/registry.js';
import type { AuditService } from '../audit/auditService.js';
import type { ChangeValidator } from '../validation/changeValidator.js';
import { resolveMembershipRole } from '../auth/rbac.js';
import { createAuthenticate, createRequireRole } from '../auth/rbac.js';
import {
  getProposal,
  listProposals,
  resolveProposal,
  type ResolveProposalAction,
} from '../mcp/proposalQueue.js';
import {
  ProposalAlreadyResolvedError,
  ProposalNotFoundError,
  ProposalService,
  type ProposalStatus,
} from '../proposals/proposalService.js';

export interface ProposalRoutesOptions {
  db: Database;
  jwtSecret: string;
  proposalService: ProposalService;
  registry: PtvAdapterRegistry;
  auditService: AuditService;
  validator: ChangeValidator;
}

interface ListProposalQuery {
  status?: ProposalStatus;
}

interface ResolveProposalBody {
  action: ResolveProposalAction;
}

export async function proposalRoutes(
  app: FastifyInstance,
  options: ProposalRoutesOptions,
): Promise<void> {
  const authenticate = createAuthenticate(options.jwtSecret);
  const requireEditor = createRequireRole(options.db, 'editor');
  const resolveRole = (tenantId: string, userId: string) =>
    resolveMembershipRole(options.db, tenantId, userId);

  app.get<{ Querystring: ListProposalQuery }>(
    '/tenants/:tenantId/proposals',
    { preHandler: [authenticate, requireEditor] },
    async (request) => {
      const { tenantId } = request.params as { tenantId: string };
      return listProposals(
        resolveRole,
        options.proposalService,
        { tenantId, environment: 'test', actingUserId: request.userId! },
        request.query.status,
      );
    },
  );

  app.get('/tenants/:tenantId/proposals/:proposalId', { preHandler: [authenticate, requireEditor] }, async (request, reply) => {
    const { tenantId, proposalId } = request.params as { tenantId: string; proposalId: string };
    try {
      return await getProposal(
        resolveRole,
        options.registry,
        options.proposalService,
        options.auditService,
        { tenantId, environment: 'test', actingUserId: request.userId! },
        proposalId,
      );
    } catch (err) {
      if (err instanceof ProposalNotFoundError) {
        return reply.notFound(err.message);
      }
      throw err;
    }
  });

  app.post<{ Body: ResolveProposalBody }>(
    '/tenants/:tenantId/proposals/:proposalId/resolve',
    { preHandler: [authenticate, requireEditor] },
    async (request, reply) => {
      const { tenantId, proposalId } = request.params as { tenantId: string; proposalId: string };
      try {
        return await resolveProposal(
          resolveRole,
          options.registry,
          options.proposalService,
          options.auditService,
          options.validator,
          { tenantId, environment: 'test', actingUserId: request.userId! },
          proposalId,
          request.body.action,
        );
      } catch (err) {
        if (err instanceof ProposalNotFoundError) {
          return reply.notFound(err.message);
        }
        if (err instanceof ProposalAlreadyResolvedError) {
          return reply.conflict(err.message);
        }
        throw err;
      }
    },
  );
}
