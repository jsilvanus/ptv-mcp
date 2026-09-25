import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Database } from '../db/client.js';
import type { PtvAdapterRegistry } from '../ptv/registry.js';
import type { AuditService } from '../audit/auditService.js';
import { createAuthenticate, createRequireRole, requestRoleResolver } from '../auth/rbac.js';
import { TenantService, tenantRequiresFourEyes } from '../tenants/tenantService.js';
import { listMyTasks } from '../mcp/myTasks.js';
import { ProposalService } from '../proposals/proposalService.js';
import {
  ReviewService,
  type ReviewItemStatus,
  type ReviewTargetKind,
} from '../reviews/reviewService.js';
import {
  assignReviewItems,
  attachProposalToReviewItem,
  closeReviewCampaign,
  completeReviewItem,
  getReviewCampaign,
  getReviewItem,
  listMyReviewItems,
  listReviewCampaigns,
  reopenReviewItem,
  startReviewCampaign,
  type ReviewDeps,
} from '../reviews/reviewCampaigns.js';
import { toolContextFromRequest, type ContextQuery } from './context.js';

export interface ReviewRoutesOptions {
  db: Database;
  jwtSecret: string;
  registry: PtvAdapterRegistry;
  auditService: AuditService;
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
 * them; the preHandler only requires a Contributor+ membership. Their
 * errors become HTTP statuses in the app's error handler
 * (routes/errorHandler.ts).
 */
export async function reviewRoutes(
  app: FastifyInstance,
  options: ReviewRoutesOptions,
): Promise<void> {
  const authenticate = createAuthenticate(options.jwtSecret);
  const requireContributor = createRequireRole(options.db, 'contributor');
  const tenantService = new TenantService(options.db, options.auditService);
  const proposalService = new ProposalService(options.db);
  const reviewService = new ReviewService(options.db);
  const depsFor = (request: FastifyRequest): ReviewDeps => ({
    proposalService,
    resolveRole: requestRoleResolver(options.db, request),
    registry: options.registry,
    auditService: options.auditService,
    reviewService,
    listMembers: (tenantId) => tenantService.listMembers(tenantId),
  });
  const preHandler = [authenticate, requireContributor];

  app.get<{ Querystring: ContextQuery }>(
    '/tenants/:tenantId/review-campaigns',
    { preHandler },
    async (request) =>
      listReviewCampaigns(depsFor(request), toolContextFromRequest(request, request.query)),
  );

  app.post<{ Body: StartCampaignBody }>(
    '/tenants/:tenantId/review-campaigns',
    { preHandler },
    async (request, reply) => {
      const body = request.body ?? {};
      if (!body.name || !body.organizationId) {
        return reply.badRequest('name and organizationId are required');
      }
      const campaign = await startReviewCampaign(
        depsFor(request),
        toolContextFromRequest(request, body),
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
    },
  );

  app.get<{ Querystring: CampaignQuery }>(
    '/tenants/:tenantId/review-campaigns/:campaignId',
    { preHandler },
    async (request) => {
      const { campaignId } = request.params as { campaignId: string };
      return getReviewCampaign(
        depsFor(request),
        toolContextFromRequest(request, request.query),
        campaignId,
        {
          ...(request.query.assignedToMe === 'true' ? { assignedToMe: true } : {}),
          ...(request.query.status ? { status: request.query.status } : {}),
        },
      );
    },
  );

  app.post<{ Body: AssignBody }>(
    '/tenants/:tenantId/review-campaigns/:campaignId/assign',
    { preHandler },
    async (request, reply) => {
      const { campaignId } = request.params as { campaignId: string };
      const body = request.body ?? {};
      if (!body.reviewer) return reply.badRequest('reviewer is required');
      if (body.itemIds !== undefined && !Array.isArray(body.itemIds)) {
        return reply.badRequest('itemIds must be an array');
      }
      return assignReviewItems(depsFor(request), toolContextFromRequest(request), {
        campaignId,
        reviewer: body.reviewer,
        ...(body.itemIds ? { itemIds: body.itemIds } : {}),
        ...(body.targetKind ? { targetKind: body.targetKind } : {}),
        ...(body.organizationId ? { organizationId: body.organizationId } : {}),
        ...(body.reassign ? { reassign: true } : {}),
      });
    },
  );

  app.post(
    '/tenants/:tenantId/review-campaigns/:campaignId/close',
    { preHandler },
    async (request) => {
      const { campaignId } = request.params as { campaignId: string };
      return closeReviewCampaign(depsFor(request), toolContextFromRequest(request), campaignId);
    },
  );

  app.get<{ Querystring: ContextQuery }>(
    '/tenants/:tenantId/my-tasks',
    { preHandler },
    async (request) =>
      listMyTasks(
        depsFor(request),
        proposalService,
        (id) => tenantRequiresFourEyes(options.db, id),
        toolContextFromRequest(request, request.query),
      ),
  );

  app.get('/tenants/:tenantId/review-items/mine', { preHandler }, async (request) =>
    listMyReviewItems(depsFor(request), toolContextFromRequest(request)),
  );

  app.get<{ Querystring: ContextQuery }>(
    '/tenants/:tenantId/review-items/:itemId',
    { preHandler },
    async (request) => {
      const { itemId } = request.params as { itemId: string };
      return getReviewItem(
        depsFor(request),
        toolContextFromRequest(request, request.query),
        itemId,
      );
    },
  );

  app.post<{ Body: CompleteBody }>(
    '/tenants/:tenantId/review-items/:itemId/complete',
    { preHandler },
    async (request, reply) => {
      const { itemId } = request.params as { itemId: string };
      const { decision, note } = request.body ?? {};
      if (decision !== 'confirmed' && decision !== 'changes_proposed') {
        return reply.badRequest('decision must be confirmed or changes_proposed');
      }
      if (note !== undefined && typeof note !== 'string') {
        return reply.badRequest('note must be a string');
      }
      return completeReviewItem(
        depsFor(request),
        toolContextFromRequest(request),
        itemId,
        decision,
        note,
      );
    },
  );

  app.post<{ Body: { proposalId?: string } }>(
    '/tenants/:tenantId/review-items/:itemId/attach',
    { preHandler },
    async (request, reply) => {
      const { itemId } = request.params as { itemId: string };
      const proposalId = request.body?.proposalId;
      if (!proposalId) return reply.badRequest('proposalId is required');
      return attachProposalToReviewItem(
        depsFor(request),
        toolContextFromRequest(request),
        itemId,
        proposalId,
      );
    },
  );

  app.post<{ Body: { note?: string } }>(
    '/tenants/:tenantId/review-items/:itemId/reopen',
    { preHandler },
    async (request, reply) => {
      const { itemId } = request.params as { itemId: string };
      const note = request.body?.note;
      if (note !== undefined && typeof note !== 'string') {
        return reply.badRequest('note must be a string');
      }
      return reopenReviewItem(depsFor(request), toolContextFromRequest(request), itemId, note);
    },
  );
}
