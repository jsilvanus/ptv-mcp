import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Database } from '../db/client.js';
import type { PtvAdapterRegistry } from '../ptv/registry.js';
import { PtvAdapterResolutionError } from '../ptv/registry.js';
import type { AuditService } from '../audit/auditService.js';
import { createAuthenticate, createRequireRole, resolveMembershipRole } from '../auth/rbac.js';
import { NotAuthorizedError } from '../mcp/authorization.js';
import type { ToolContext } from '../mcp/toolContext.js';
import { TenantService, tenantRequiresFourEyes } from '../tenants/tenantService.js';
import { listMyTasks } from '../mcp/myTasks.js';
import { ProposalService } from '../proposals/proposalService.js';
import {
  ReviewCampaignNotFoundError,
  ReviewItemNotFoundError,
  ReviewService,
  type ReviewItemStatus,
  type ReviewTargetKind,
} from '../reviews/reviewService.js';
import {
  assignReviewItems,
  closeReviewCampaign,
  completeReviewItem,
  getReviewCampaign,
  getReviewItem,
  listMyReviewItems,
  listReviewCampaigns,
  reopenReviewItem,
  ReviewCampaignError,
  startReviewCampaign,
  type ReviewDeps,
} from '../reviews/reviewCampaigns.js';

export interface ReviewRoutesOptions {
  db: Database;
  jwtSecret: string;
  registry: PtvAdapterRegistry;
  auditService: AuditService;
}

type Environment = 'test' | 'production';

interface ContextQuery {
  environment?: Environment;
  readApiVersion?: string;
}

interface StartCampaignBody extends ContextQuery {
  name?: string;
  organizationId?: string;
  dueDate?: string;
  includeSubOrganisations?: boolean;
}

interface AssignBody {
  reviewer?: string;
  itemIds?: string[];
  targetKind?: ReviewTargetKind;
  organizationId?: string;
  reassign?: boolean;
}

interface CompleteBody {
  decision?: 'confirmed' | 'changes_proposed';
  note?: string;
}

interface CampaignQuery extends ContextQuery {
  assignedToMe?: string;
  status?: ReviewItemStatus;
}

/**
 * Review campaigns for the web UI (docs/review-campaigns-plan.md); the same
 * functions back the `ptv_review_*` MCP tools. Role checks happen inside
 * them; the preHandler only requires a Contributor+ membership.
 */
export async function reviewRoutes(
  app: FastifyInstance,
  options: ReviewRoutesOptions,
): Promise<void> {
  const authenticate = createAuthenticate(options.jwtSecret);
  const requireContributor = createRequireRole(options.db, 'contributor');
  const tenantService = new TenantService(options.db, options.auditService);
  const deps: ReviewDeps = {
    resolveRole: (tenantId, userId) => resolveMembershipRole(options.db, tenantId, userId),
    registry: options.registry,
    auditService: options.auditService,
    reviewService: new ReviewService(options.db),
    listMembers: (tenantId) => tenantService.listMembers(tenantId),
  };
  const preHandler = [authenticate, requireContributor];

  const contextFrom = (tenantId: string, userId: string, query: ContextQuery): ToolContext => ({
    tenantId,
    environment: query.environment === 'production' ? 'production' : 'test',
    ...(query.readApiVersion ? { readApiVersion: query.readApiVersion } : {}),
    actingUserId: userId,
  });

  const fail = (reply: FastifyReply, err: unknown) => {
    if (err instanceof ReviewCampaignNotFoundError || err instanceof ReviewItemNotFoundError) {
      return reply.notFound(err.message);
    }
    if (err instanceof NotAuthorizedError) return reply.forbidden(err.message);
    if (err instanceof ReviewCampaignError) return reply.badRequest(err.message);
    if (err instanceof PtvAdapterResolutionError) {
      return err.reason === 'not_authorized'
        ? reply.forbidden(err.message)
        : reply.badRequest(`${err.reason}: ${err.message}`);
    }
    throw err;
  };

  app.get<{ Querystring: ContextQuery }>(
    '/tenants/:tenantId/review-campaigns',
    { preHandler },
    async (request, reply) => {
      const { tenantId } = request.params as { tenantId: string };
      try {
        return await listReviewCampaigns(
          deps,
          contextFrom(tenantId, request.userId!, request.query),
        );
      } catch (err) {
        return fail(reply, err);
      }
    },
  );

  app.post<{ Body: StartCampaignBody }>(
    '/tenants/:tenantId/review-campaigns',
    { preHandler },
    async (request, reply) => {
      const { tenantId } = request.params as { tenantId: string };
      const body = request.body ?? {};
      if (!body.name || !body.organizationId) {
        return reply.badRequest('name and organizationId are required');
      }
      try {
        const campaign = await startReviewCampaign(
          deps,
          contextFrom(tenantId, request.userId!, body),
          {
            name: body.name,
            organizationId: body.organizationId,
            ...(body.dueDate ? { dueDate: body.dueDate } : {}),
            ...(body.includeSubOrganisations !== undefined
              ? { includeSubOrganisations: body.includeSubOrganisations }
              : {}),
          },
        );
        return reply.code(201).send(campaign);
      } catch (err) {
        return fail(reply, err);
      }
    },
  );

  app.get<{ Querystring: CampaignQuery }>(
    '/tenants/:tenantId/review-campaigns/:campaignId',
    { preHandler },
    async (request, reply) => {
      const { tenantId, campaignId } = request.params as { tenantId: string; campaignId: string };
      try {
        return await getReviewCampaign(
          deps,
          contextFrom(tenantId, request.userId!, request.query),
          campaignId,
          {
            ...(request.query.assignedToMe === 'true' ? { assignedToMe: true } : {}),
            ...(request.query.status ? { status: request.query.status } : {}),
          },
        );
      } catch (err) {
        return fail(reply, err);
      }
    },
  );

  app.post<{ Body: AssignBody }>(
    '/tenants/:tenantId/review-campaigns/:campaignId/assign',
    { preHandler },
    async (request, reply) => {
      const { tenantId, campaignId } = request.params as { tenantId: string; campaignId: string };
      const body = request.body ?? {};
      if (!body.reviewer) return reply.badRequest('reviewer is required');
      if (body.itemIds !== undefined && !Array.isArray(body.itemIds)) {
        return reply.badRequest('itemIds must be an array');
      }
      try {
        return await assignReviewItems(deps, contextFrom(tenantId, request.userId!, {}), {
          campaignId,
          reviewer: body.reviewer,
          ...(body.itemIds ? { itemIds: body.itemIds } : {}),
          ...(body.targetKind ? { targetKind: body.targetKind } : {}),
          ...(body.organizationId ? { organizationId: body.organizationId } : {}),
          ...(body.reassign ? { reassign: true } : {}),
        });
      } catch (err) {
        return fail(reply, err);
      }
    },
  );

  app.post(
    '/tenants/:tenantId/review-campaigns/:campaignId/close',
    { preHandler },
    async (request, reply) => {
      const { tenantId, campaignId } = request.params as { tenantId: string; campaignId: string };
      try {
        return await closeReviewCampaign(
          deps,
          contextFrom(tenantId, request.userId!, {}),
          campaignId,
        );
      } catch (err) {
        return fail(reply, err);
      }
    },
  );

  const proposalService = new ProposalService(options.db);
  app.get<{ Querystring: ContextQuery }>(
    '/tenants/:tenantId/my-tasks',
    { preHandler },
    async (request, reply) => {
      const { tenantId } = request.params as { tenantId: string };
      try {
        return await listMyTasks(
          deps,
          proposalService,
          (id) => tenantRequiresFourEyes(options.db, id),
          contextFrom(tenantId, request.userId!, request.query),
        );
      } catch (err) {
        return fail(reply, err);
      }
    },
  );

  app.get('/tenants/:tenantId/review-items/mine', { preHandler }, async (request, reply) => {
    const { tenantId } = request.params as { tenantId: string };
    try {
      return await listMyReviewItems(deps, contextFrom(tenantId, request.userId!, {}));
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.get<{ Querystring: ContextQuery }>(
    '/tenants/:tenantId/review-items/:itemId',
    { preHandler },
    async (request, reply) => {
      const { tenantId, itemId } = request.params as { tenantId: string; itemId: string };
      try {
        return await getReviewItem(
          deps,
          contextFrom(tenantId, request.userId!, request.query),
          itemId,
        );
      } catch (err) {
        return fail(reply, err);
      }
    },
  );

  app.post<{ Body: CompleteBody }>(
    '/tenants/:tenantId/review-items/:itemId/complete',
    { preHandler },
    async (request, reply) => {
      const { tenantId, itemId } = request.params as { tenantId: string; itemId: string };
      const { decision, note } = request.body ?? {};
      if (decision !== 'confirmed' && decision !== 'changes_proposed') {
        return reply.badRequest('decision must be confirmed or changes_proposed');
      }
      if (note !== undefined && typeof note !== 'string') {
        return reply.badRequest('note must be a string');
      }
      try {
        return await completeReviewItem(
          deps,
          contextFrom(tenantId, request.userId!, {}),
          itemId,
          decision,
          note,
        );
      } catch (err) {
        return fail(reply, err);
      }
    },
  );

  app.post<{ Body: { note?: string } }>(
    '/tenants/:tenantId/review-items/:itemId/reopen',
    { preHandler },
    async (request, reply) => {
      const { tenantId, itemId } = request.params as { tenantId: string; itemId: string };
      const note = request.body?.note;
      if (note !== undefined && typeof note !== 'string') {
        return reply.badRequest('note must be a string');
      }
      try {
        return await reopenReviewItem(
          deps,
          contextFrom(tenantId, request.userId!, {}),
          itemId,
          note,
        );
      } catch (err) {
        return fail(reply, err);
      }
    },
  );
}
