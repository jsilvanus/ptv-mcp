import type { FastifyInstance } from 'fastify';
import type { Database } from '../db/client.js';
import type { PtvAdapterRegistry } from '../ptv/registry.js';
import type { AuditService } from '../audit/auditService.js';
import type { ChangeValidator } from '../validation/changeValidator.js';
import { createAuthenticate, createRequireRole, requestRoleResolver } from '../auth/rbac.js';
import {
  commentOnProposal,
  getProposal,
  confirmManualPublish,
  listProposals,
  listReviewCandidates,
  requestReview,
  resolveProposal,
  signOffProposal,
  type SignOffDecision,
  type ResolveProposalAction,
} from '../mcp/proposalQueue.js';
import type { ProposalService, ProposalStatus } from '../proposals/proposalService.js';
import { TenantService, tenantRequiresFourEyes } from '../tenants/tenantService.js';
import { toolContextFromRequest, type ContextQuery } from './context.js';

export interface ProposalRoutesOptions {
  db: Database;
  jwtSecret: string;
  proposalService: ProposalService;
  registry: PtvAdapterRegistry;
  auditService: AuditService;
  validator: ChangeValidator;
}

interface ListProposalQuery extends ContextQuery {
  status?: ProposalStatus;
  /** `true` lists only pending proposals waiting for the caller's sign-off. */
  waitingForMe?: string;
}

interface ResolveProposalBody {
  action: ResolveProposalAction;
}

/**
 * The proposal queue for the web UI; the same functions back the MCP
 * tools. Their domain errors (not found, already resolved, four-eyes, ...)
 * become HTTP statuses in the app's error handler (routes/errorHandler.ts).
 */
export async function proposalRoutes(
  app: FastifyInstance,
  options: ProposalRoutesOptions,
): Promise<void> {
  const authenticate = createAuthenticate(options.jwtSecret);
  const requireContributor = createRequireRole(options.db, 'contributor');
  const requireApprover = createRequireRole(options.db, 'approver');
  const tenantService = new TenantService(options.db, options.auditService);
  const listMembers = (tenantId: string) => tenantService.listMembers(tenantId);

  app.get<{ Querystring: ListProposalQuery }>(
    '/tenants/:tenantId/proposals',
    { preHandler: [authenticate, requireContributor] },
    async (request) =>
      listProposals(
        requestRoleResolver(options.db, request),
        options.proposalService,
        toolContextFromRequest(request, request.query),
        request.query.status,
        request.query.waitingForMe === 'true',
      ),
  );

  app.get<{ Querystring: ContextQuery }>(
    '/tenants/:tenantId/proposals/:proposalId',
    { preHandler: [authenticate, requireContributor] },
    async (request) => {
      const { proposalId } = request.params as { proposalId: string };
      return getProposal(
        requestRoleResolver(options.db, request),
        options.registry,
        options.proposalService,
        options.auditService,
        toolContextFromRequest(request, request.query),
        proposalId,
      );
    },
  );

  app.post<{ Body: ResolveProposalBody; Querystring: ContextQuery }>(
    '/tenants/:tenantId/proposals/:proposalId/resolve',
    { preHandler: [authenticate, requireApprover] },
    async (request) => {
      const { proposalId } = request.params as { proposalId: string };
      return resolveProposal(
        requestRoleResolver(options.db, request),
        options.registry,
        options.proposalService,
        options.auditService,
        options.validator,
        toolContextFromRequest(request, request.query),
        proposalId,
        request.body.action,
        (id) => tenantRequiresFourEyes(options.db, id),
      );
    },
  );

  app.post<{ Body: { ptvId?: string } | undefined; Querystring: ContextQuery }>(
    '/tenants/:tenantId/proposals/:proposalId/confirm-published',
    { preHandler: [authenticate, requireApprover] },
    async (request, reply) => {
      const { proposalId } = request.params as { proposalId: string };
      const ptvId = request.body?.ptvId;
      if (ptvId !== undefined && typeof ptvId !== 'string') {
        return reply.badRequest('ptvId must be a string');
      }
      return confirmManualPublish(
        requestRoleResolver(options.db, request),
        options.registry,
        options.proposalService,
        options.auditService,
        toolContextFromRequest(request, request.query),
        proposalId,
        ptvId,
      );
    },
  );

  app.post<{ Body: { comment?: string }; Querystring: ContextQuery }>(
    '/tenants/:tenantId/proposals/:proposalId/comments',
    { preHandler: [authenticate, requireContributor] },
    async (request, reply) => {
      const { proposalId } = request.params as { proposalId: string };
      const comment = await commentOnProposal(
        requestRoleResolver(options.db, request),
        options.proposalService,
        options.auditService,
        toolContextFromRequest(request, request.query),
        proposalId,
        request.body?.comment ?? '',
      );
      return reply.code(201).send(comment);
    },
  );

  app.get<{ Querystring: ContextQuery }>(
    '/tenants/:tenantId/review-candidates',
    { preHandler: [authenticate, requireContributor] },
    async (request) =>
      listReviewCandidates(
        requestRoleResolver(options.db, request),
        listMembers,
        toolContextFromRequest(request, request.query),
      ),
  );

  app.post<{ Body: { reviewers?: unknown }; Querystring: ContextQuery }>(
    '/tenants/:tenantId/proposals/:proposalId/reviewers',
    { preHandler: [authenticate, requireContributor] },
    async (request, reply) => {
      const { proposalId } = request.params as { proposalId: string };
      const reviewers = request.body?.reviewers;
      if (!Array.isArray(reviewers) || !reviewers.every((entry) => typeof entry === 'string')) {
        return reply.badRequest('reviewers must be an array of emails or user ids');
      }
      const result = await requestReview(
        requestRoleResolver(options.db, request),
        listMembers,
        options.proposalService,
        options.auditService,
        toolContextFromRequest(request, request.query),
        proposalId,
        reviewers,
      );
      return reply.code(201).send(result);
    },
  );

  app.post<{
    Body: { decision?: unknown; comment?: unknown };
    Querystring: ContextQuery;
  }>(
    '/tenants/:tenantId/proposals/:proposalId/sign-off',
    { preHandler: [authenticate, requireContributor] },
    async (request, reply) => {
      const { proposalId } = request.params as { proposalId: string };
      const { decision, comment } = request.body ?? {};
      if (decision !== 'approved' && decision !== 'changes_requested') {
        return reply.badRequest('decision must be approved or changes_requested');
      }
      if (comment !== undefined && typeof comment !== 'string') {
        return reply.badRequest('comment must be a string');
      }
      return signOffProposal(
        requestRoleResolver(options.db, request),
        options.proposalService,
        options.auditService,
        toolContextFromRequest(request, request.query),
        proposalId,
        decision satisfies SignOffDecision,
        comment,
      );
    },
  );
}
