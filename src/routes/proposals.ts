import type { FastifyInstance } from 'fastify';
import type { Database } from '../db/client.js';
import type { PtvAdapterRegistry } from '../ptv/registry.js';
import type { AuditService } from '../audit/auditService.js';
import type { ChangeValidator } from '../validation/changeValidator.js';
import { createAuthenticate, createRequireRole, resolveMembershipRole } from '../auth/rbac.js';
import {
  commentOnProposal,
  getProposal,
  InvalidCommentError,
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
import { FourEyesError } from '../mcp/authorization.js';
import { tenantRequiresFourEyes } from '../tenants/tenantService.js';

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
  environment?: 'test' | 'production';
}

interface ResolveProposalBody {
  action: ResolveProposalAction;
}

interface ProposalRequestQuery {
  environment?: 'test' | 'production';
}

export async function proposalRoutes(
  app: FastifyInstance,
  options: ProposalRoutesOptions,
): Promise<void> {
  const authenticate = createAuthenticate(options.jwtSecret);
  const requireContributor = createRequireRole(options.db, 'contributor');
  const requireApprover = createRequireRole(options.db, 'approver');
  const resolveRole = (tenantId: string, userId: string) =>
    resolveMembershipRole(options.db, tenantId, userId);
  const contextFrom = (
    tenantId: string,
    userId: string,
    query: ProposalRequestQuery,
  ): { tenantId: string; environment: 'test' | 'production'; actingUserId: string } => ({
    tenantId,
    environment: query.environment ?? 'test',
    actingUserId: userId,
  });

  app.get<{ Querystring: ListProposalQuery }>(
    '/tenants/:tenantId/proposals',
    { preHandler: [authenticate, requireContributor] },
    async (request) => {
      const { tenantId } = request.params as { tenantId: string };
      return listProposals(
        resolveRole,
        options.proposalService,
        contextFrom(tenantId, request.userId!, request.query),
        request.query.status,
      );
    },
  );

  app.get<{ Querystring: ProposalRequestQuery }>(
    '/tenants/:tenantId/proposals/:proposalId',
    { preHandler: [authenticate, requireContributor] },
    async (request, reply) => {
      const { tenantId, proposalId } = request.params as { tenantId: string; proposalId: string };
      try {
        return await getProposal(
          resolveRole,
          options.registry,
          options.proposalService,
          options.auditService,
          contextFrom(tenantId, request.userId!, request.query),
          proposalId,
        );
      } catch (err) {
        if (err instanceof ProposalNotFoundError) {
          return reply.notFound(err.message);
        }
        throw err;
      }
    },
  );

  app.post<{ Body: ResolveProposalBody; Querystring: ProposalRequestQuery }>(
    '/tenants/:tenantId/proposals/:proposalId/resolve',
    { preHandler: [authenticate, requireApprover] },
    async (request, reply) => {
      const { tenantId, proposalId } = request.params as { tenantId: string; proposalId: string };
      try {
        return await resolveProposal(
          resolveRole,
          options.registry,
          options.proposalService,
          options.auditService,
          options.validator,
          contextFrom(tenantId, request.userId!, request.query),
          proposalId,
          request.body.action,
          (id) => tenantRequiresFourEyes(options.db, id),
        );
      } catch (err) {
        if (err instanceof ProposalNotFoundError) {
          return reply.notFound(err.message);
        }
        if (err instanceof ProposalAlreadyResolvedError) {
          return reply.conflict(err.message);
        }
        if (err instanceof FourEyesError) {
          return reply.forbidden(err.message);
        }
        throw err;
      }
    },
  );

  app.post<{ Body: { comment?: string }; Querystring: ProposalRequestQuery }>(
    '/tenants/:tenantId/proposals/:proposalId/comments',
    { preHandler: [authenticate, requireContributor] },
    async (request, reply) => {
      const { tenantId, proposalId } = request.params as { tenantId: string; proposalId: string };
      try {
        const comment = await commentOnProposal(
          resolveRole,
          options.proposalService,
          options.auditService,
          contextFrom(tenantId, request.userId!, request.query),
          proposalId,
          request.body?.comment ?? '',
        );
        return reply.code(201).send(comment);
      } catch (err) {
        if (err instanceof ProposalNotFoundError) return reply.notFound(err.message);
        if (err instanceof InvalidCommentError) return reply.badRequest(err.message);
        throw err;
      }
    },
  );
}
