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
  InvalidReviewRequestError,
  confirmManualPublish,
  listProposals,
  ManualPublishCheckError,
  listReviewCandidates,
  requestReview,
  resolveProposal,
  ReviewsPendingError,
  signOffProposal,
  type SignOffDecision,
  type ResolveProposalAction,
} from '../mcp/proposalQueue.js';
import {
  NotARequestedReviewerError,
  ProposalAlreadyResolvedError,
  ProposalNotFoundError,
  ProposalService,
  type ProposalStatus,
} from '../proposals/proposalService.js';
import { FourEyesError, NotAuthorizedError } from '../mcp/authorization.js';
import { TenantService, tenantRequiresFourEyes } from '../tenants/tenantService.js';

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
  /** `true` lists only pending proposals waiting for the caller's sign-off. */
  waitingForMe?: string;
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
  const tenantService = new TenantService(options.db, options.auditService);
  const listMembers = (tenantId: string) => tenantService.listMembers(tenantId);
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
        request.query.waitingForMe === 'true',
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
        if (err instanceof ReviewsPendingError) {
          return reply.conflict(err.message);
        }
        throw err;
      }
    },
  );

  app.post<{ Body: { ptvId?: string } | undefined; Querystring: ProposalRequestQuery }>(
    '/tenants/:tenantId/proposals/:proposalId/confirm-published',
    { preHandler: [authenticate, requireApprover] },
    async (request, reply) => {
      const { tenantId, proposalId } = request.params as { tenantId: string; proposalId: string };
      const ptvId = request.body?.ptvId;
      if (ptvId !== undefined && typeof ptvId !== 'string') {
        return reply.badRequest('ptvId must be a string');
      }
      try {
        return await confirmManualPublish(
          resolveRole,
          options.registry,
          options.proposalService,
          options.auditService,
          contextFrom(tenantId, request.userId!, request.query),
          proposalId,
          ptvId,
        );
      } catch (err) {
        if (err instanceof ProposalNotFoundError) return reply.notFound(err.message);
        if (err instanceof ProposalAlreadyResolvedError || err instanceof ManualPublishCheckError) {
          return reply.conflict(err.message);
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

  app.get<{ Querystring: ProposalRequestQuery }>(
    '/tenants/:tenantId/review-candidates',
    { preHandler: [authenticate, requireContributor] },
    async (request) => {
      const { tenantId } = request.params as { tenantId: string };
      return listReviewCandidates(
        resolveRole,
        listMembers,
        contextFrom(tenantId, request.userId!, request.query),
      );
    },
  );

  app.post<{ Body: { reviewers?: unknown }; Querystring: ProposalRequestQuery }>(
    '/tenants/:tenantId/proposals/:proposalId/reviewers',
    { preHandler: [authenticate, requireContributor] },
    async (request, reply) => {
      const { tenantId, proposalId } = request.params as { tenantId: string; proposalId: string };
      const reviewers = request.body?.reviewers;
      if (!Array.isArray(reviewers) || !reviewers.every((entry) => typeof entry === 'string')) {
        return reply.badRequest('reviewers must be an array of emails or user ids');
      }
      try {
        const result = await requestReview(
          resolveRole,
          listMembers,
          options.proposalService,
          options.auditService,
          contextFrom(tenantId, request.userId!, request.query),
          proposalId,
          reviewers,
        );
        return reply.code(201).send(result);
      } catch (err) {
        if (err instanceof ProposalNotFoundError) return reply.notFound(err.message);
        if (err instanceof ProposalAlreadyResolvedError) return reply.conflict(err.message);
        if (err instanceof InvalidReviewRequestError) return reply.badRequest(err.message);
        if (err instanceof NotAuthorizedError) return reply.forbidden(err.message);
        throw err;
      }
    },
  );

  app.post<{
    Body: { decision?: unknown; comment?: unknown };
    Querystring: ProposalRequestQuery;
  }>(
    '/tenants/:tenantId/proposals/:proposalId/sign-off',
    { preHandler: [authenticate, requireContributor] },
    async (request, reply) => {
      const { tenantId, proposalId } = request.params as { tenantId: string; proposalId: string };
      const { decision, comment } = request.body ?? {};
      if (decision !== 'approved' && decision !== 'changes_requested') {
        return reply.badRequest('decision must be approved or changes_requested');
      }
      if (comment !== undefined && typeof comment !== 'string') {
        return reply.badRequest('comment must be a string');
      }
      try {
        return await signOffProposal(
          resolveRole,
          options.proposalService,
          options.auditService,
          contextFrom(tenantId, request.userId!, request.query),
          proposalId,
          decision satisfies SignOffDecision,
          comment,
        );
      } catch (err) {
        if (err instanceof ProposalNotFoundError) return reply.notFound(err.message);
        if (err instanceof ProposalAlreadyResolvedError) return reply.conflict(err.message);
        if (err instanceof NotARequestedReviewerError) return reply.forbidden(err.message);
        if (err instanceof InvalidCommentError) return reply.badRequest(err.message);
        throw err;
      }
    },
  );
}
