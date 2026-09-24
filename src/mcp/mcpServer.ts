import { queueChannelProposal } from './channelProposal.js';
import { queueNewServiceProposal } from './newServiceProposal.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { PtvAdapterRegistry } from '../ptv/registry.js';
import { PtvAdapterResolutionError } from '../ptv/registry.js';
import type { AuditService } from '../audit/auditService.js';
import type { ChangeValidator } from '../validation/changeValidator.js';
import type { SearchParams, Service, ServiceChannel } from '../ptv/domain.js';
import type { NewChannel } from '../ptv/adapter.js';
import type { Database } from '../db/client.js';
import { resolveMembershipRole } from '../auth/rbac.js';
import { FourEyesError, NotAuthorizedError, requireNoFourEyes } from './authorization.js';
import type { ProposalService } from '../proposals/proposalService.js';
import { TenantService, tenantRequiresFourEyes } from '../tenants/tenantService.js';
import * as searchTools from './searchTools.js';
import { ServiceNotFoundError } from './proposeChanges.js';
import { validateChanges } from './validateChanges.js';
import { applyChanges, exportForManualPublish, ValidationFailedError } from './applyOrExport.js';
import type { ReadToolContext, ToolContext } from './toolContext.js';
import { registerGuides, SERVER_INSTRUCTIONS } from './guides.js';
import { checkQuality } from './qualityTools.js';
import { listMyTasks } from './myTasks.js';
import { ReviewService, type ReviewItemView } from '../reviews/reviewService.js';
import { queueNewChannelProposal } from './newChannelProposal.js';
import {
  assignReviewItems,
  closeReviewCampaign,
  completeReviewItem,
  getReviewCampaign,
  getReviewItem,
  listMyReviewItems,
  listReviewCampaigns,
  attachProposalToReviewItem,
  linkProposalToReviewItem,
  reopenReviewItem,
  requireLinkableReviewItem,
  startReviewCampaign,
  type ReviewDeps,
} from '../reviews/reviewCampaigns.js';
import {
  getProposal,
  isProposalQueueError,
  listProposals,
  queueProposal,
  resolveProposal,
  commentOnProposal,
  MAX_COMMENT_LENGTH,
  listReviewCandidates,
  requestReview,
  signOffProposal,
} from './proposalQueue.js';

export interface McpServerDeps {
  db: Database;
  registry: PtvAdapterRegistry;
  auditService: AuditService;
  validator: ChangeValidator;
  proposalService: ProposalService;
  publicUrl?: string;
}

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

function textResult(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

function errorResult(message: string, publicUrl?: string): CallToolResult {
  const requiresAuthentication = message === 'No authenticated user for this MCP session';
  if (requiresAuthentication && publicUrl) {
    return {
      content: [{ type: 'text', text: 'Authentication required: no access token provided.' }],
      _meta: {
        'mcp/www_authenticate': [
          `Bearer resource_metadata="${publicUrl}/.well-known/oauth-protected-resource", error="insufficient_scope", error_description="You need to login to continue"`,
        ],
      },
      isError: true,
    };
  }
  return { content: [{ type: 'text', text: message }], isError: true };
}

/**
 * Every business error this layer throws maps to a *tool* error
 * (`isError: true` in the result), not a protocol-level failure — an
 * agent calling e.g. `ptv_apply_changes` with an invalid proposal should
 * get back a readable reason, not a transport exception.
 */
function describeError(err: unknown): string {
  if (err instanceof PtvAdapterResolutionError) {
    return `${err.reason}: ${err.message}`;
  }
  if (
    err instanceof ServiceNotFoundError ||
    err instanceof ValidationFailedError ||
    err instanceof NotAuthorizedError ||
    err instanceof FourEyesError ||
    isProposalQueueError(err)
  ) {
    return err.message;
  }
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

/**
 * Resolves the acting user from the bearer token our own HTTP transport
 * layer (mcp/httpTransport.ts) already verified and stashed on `authInfo.extra`
 * — never trust a `userId` supplied as a tool argument, since that would let
 * one authenticated caller act as anyone.
 */
function actingUserId(extra: Extra): string {
  const userId = extra.authInfo?.extra?.userId;
  if (typeof userId !== 'string' || userId === '') {
    throw new Error('No authenticated user for this MCP session');
  }
  return userId;
}

const publicReadSearchParamsSchema = {
  query: z
    .string()
    .optional()
    .describe('Optional PTV text search. Omit it to browse using the other filters.'),
  organizationId: z
    .string()
    .uuid()
    .optional()
    .describe('Optional PTV organisation filter. This is not the OAuth tenant.'),
  page: z.number().int().min(1).optional(),
  pageSize: z.number().int().min(1).max(1000).optional(),
};
const publicReadGetByIdSchema = {
  id: z.string(),
};

const oauthSecuritySchemes = [{ type: 'oauth2' as const, scopes: ['mcp'] }];

function withOAuthSecurity<T extends object>(
  config: T,
): T & { securitySchemes: typeof oauthSecuritySchemes } {
  return { ...config, securitySchemes: oauthSecuritySchemes };
}

function toolContext(extra: Extra): ToolContext {
  const { tenantId, ...rest } = readToolContext(extra);
  if (!tenantId) {
    throw new Error(
      'This MCP connection has no organisation (public PTV data only). Proposals and writes need an organisation: reconnect and choose one.',
    );
  }
  return { tenantId, ...rest };
}

/**
 * Read tools also work on a public connection without an organisation:
 * then the tenant is absent and only PTV v11's published data is read.
 */
function readToolContext(extra: Extra): ReadToolContext {
  const userId = actingUserId(extra);
  const activeTenantId = extra.authInfo?.extra?.tenantId;
  const environment = extra.authInfo?.extra?.environment;
  const readApiVersion = extra.authInfo?.extra?.readApiVersion;
  const writeApiVersion = extra.authInfo?.extra?.writeApiVersion;
  if (environment !== 'test' && environment !== 'production') {
    throw new Error(
      'No active PTV environment for this MCP connection; reconnect and select a connection',
    );
  }
  if (typeof readApiVersion !== 'string' || readApiVersion === '') {
    throw new Error(
      'No active PTV read API version for this MCP connection; reconnect and select a connection',
    );
  }
  return {
    ...(typeof activeTenantId === 'string' && activeTenantId !== ''
      ? { tenantId: activeTenantId }
      : {}),
    environment,
    readApiVersion,
    ...(typeof writeApiVersion === 'string' ? { writeApiVersion } : {}),
    actingUserId: userId,
  };
}

/**
 * Resource reads carry tenant/environment in the URI itself (the
 * `ptv://{tenantId}/{environment}/...` templates below), unlike tools,
 * which have no per-call channel for either and take both from the OAuth
 * token (see `toolContext()` above). Read/write API version and the
 * acting user still come from the token. Accepting whatever tenantId the
 * URI names doesn't bypass anything: `PtvAdapterRegistry.resolve()`
 * re-checks that `actingUserId` actually belongs to that tenant before
 * ever touching a credential, exactly as it does for a tool call.
 */
function resourceToolContext(
  extra: Extra,
  uriTenantId: string,
  uriEnvironment: string,
): ToolContext {
  const userId = actingUserId(extra);
  const readApiVersion = extra.authInfo?.extra?.readApiVersion;
  const writeApiVersion = extra.authInfo?.extra?.writeApiVersion;
  if (uriEnvironment !== 'test' && uriEnvironment !== 'production') {
    throw new Error(`Invalid PTV environment in resource URI: ${uriEnvironment}`);
  }
  if (typeof readApiVersion !== 'string' || readApiVersion === '') {
    throw new Error(
      'No active PTV read API version for this MCP connection; reconnect and select a connection',
    );
  }
  return {
    tenantId: uriTenantId,
    environment: uriEnvironment,
    readApiVersion,
    ...(typeof writeApiVersion === 'string' ? { writeApiVersion } : {}),
    actingUserId: userId,
  };
}

/** `exactOptionalPropertyTypes` means an explicit `page: undefined` doesn't satisfy `page?: number` — omit the key entirely instead. */
function searchParams(args: {
  query?: string | undefined;
  organizationId?: string | undefined;
  page?: number | undefined;
  pageSize?: number | undefined;
}): SearchParams {
  return {
    ...(args.query !== undefined ? { query: args.query } : {}),
    ...(args.organizationId !== undefined ? { organizationId: args.organizationId } : {}),
    ...(args.page !== undefined ? { page: args.page } : {}),
    ...(args.pageSize !== undefined ? { pageSize: args.pageSize } : {}),
  };
}

/**
 * Builds the MCP tool surface (Phase 4) over the given dependencies. A
 * fresh server is expected per-request in the stateless HTTP transport
 * (mcp/httpTransport.ts) — construction here is cheap (just closures),
 * the real state (DB connections, adapters) lives in `deps`.
 */
export function createMcpServer(deps: McpServerDeps): McpServer {
  const { db, registry, auditService, validator, proposalService } = deps;
  const resolveRole = (tenantId: string, userId: string) =>
    resolveMembershipRole(db, tenantId, userId);
  const requireFourEyes = (tenantId: string) => tenantRequiresFourEyes(db, tenantId);
  const tenantService = new TenantService(db, auditService);
  const listMembers = (tenantId: string) => tenantService.listMembers(tenantId);
  const reviewDeps: ReviewDeps = {
    proposalService,
    resolveRole,
    registry,
    auditService,
    reviewService: new ReviewService(db),
    listMembers,
  };
  const reviewItemIdSchema = z
    .string()
    .uuid()
    .optional()
    .describe(
      'Review item this proposal answers (from ptv_review_my_items). Links the proposal to the review campaign; the item must be open and assigned to you.',
    );
  const linkQueued = async (ctx: ToolContext, item: ReviewItemView, proposalId: string) =>
    linkProposalToReviewItem(
      reviewDeps,
      ctx,
      item,
      await proposalService.getById(ctx.tenantId, proposalId),
    );
  const server = new McpServer(
    { name: 'ptv-mcp', version: '0.1.0' },
    { instructions: SERVER_INSTRUCTIONS },
  );
  registerGuides(server);

  server.registerTool(
    'ptv_search_services',
    withOAuthSecurity({
      description:
        'Search published PTV services. The OAuth-selected PTV connection determines tenant, environment, read API version and write API version; `query` and `organizationId` determine what PTV data is searched.',
      inputSchema: publicReadSearchParamsSchema,
    }),
    async (args, extra) => {
      try {
        return textResult(
          await searchTools.searchServices(registry, readToolContext(extra), searchParams(args)),
        );
      } catch (err) {
        return errorResult(describeError(err), deps.publicUrl);
      }
    },
  );

  server.registerTool(
    'ptv_get_service',
    withOAuthSecurity({
      description:
        'Fetch one published PTV service by id. The PTV tenant, environment, read API version and write API version are selected during OAuth authorization.',
      inputSchema: publicReadGetByIdSchema,
    }),
    async (args, extra) => {
      try {
        return textResult(await searchTools.getService(registry, readToolContext(extra), args.id));
      } catch (err) {
        return errorResult(describeError(err), deps.publicUrl);
      }
    },
  );

  server.registerTool(
    'ptv_search_channels',
    withOAuthSecurity({
      description:
        'Search published PTV service channels. The OAuth-selected tenant determines which PTV integration/API key is used; `query` and `organizationId` determine what PTV data is searched.',
      inputSchema: publicReadSearchParamsSchema,
    }),
    async (args, extra) => {
      try {
        return textResult(
          await searchTools.searchChannels(registry, readToolContext(extra), searchParams(args)),
        );
      } catch (err) {
        return errorResult(describeError(err), deps.publicUrl);
      }
    },
  );

  server.registerTool(
    'ptv_get_channel',
    withOAuthSecurity({
      description:
        'Fetch one published PTV service channel by id. The organisation context is selected during OAuth authorization.',
      inputSchema: publicReadGetByIdSchema,
    }),
    async (args, extra) => {
      try {
        return textResult(await searchTools.getChannel(registry, readToolContext(extra), args.id));
      } catch (err) {
        return errorResult(describeError(err), deps.publicUrl);
      }
    },
  );

  server.registerTool(
    'ptv_search_organisations',
    withOAuthSecurity({
      description: 'Search published PTV organisations. Query searches organisation names.',
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe(
            'Optional text search in PTV organisation names. Omit it to browse organisations.',
          ),
        page: z.number().int().min(1).optional(),
        pageSize: z.number().int().min(1).max(1000).optional(),
      },
    }),
    async (args, extra) => {
      try {
        return textResult(
          await searchTools.searchOrganisations(registry, readToolContext(extra), {
            ...(args.query !== undefined ? { query: args.query } : {}),
            ...(args.page !== undefined ? { page: args.page } : {}),
            ...(args.pageSize !== undefined ? { pageSize: args.pageSize } : {}),
          }),
        );
      } catch (err) {
        return errorResult(describeError(err), deps.publicUrl);
      }
    },
  );

  server.registerTool(
    'ptv_find_organisation_and_children',
    withOAuthSecurity({
      description:
        'Find a PTV organisation by name/text and return that organisation together with its published services and service channels. This is a compound convenience operation; use the individual search tools when you need independent searches.',
      inputSchema: {
        query: z
          .string()
          .min(1)
          .describe('Organisation name or text, for example "Riihimäen seurakunta".'),
      },
    }),
    async (args, extra) => {
      try {
        return textResult(
          await searchTools.findOrganisationAndChildren(
            registry,
            readToolContext(extra),
            args.query,
          ),
        );
      } catch (err) {
        return errorResult(describeError(err), deps.publicUrl);
      }
    },
  );

  server.registerTool(
    'ptv_get_organisation',
    withOAuthSecurity({
      description:
        'Fetch one published PTV organisation by id. The PTV tenant, environment, read API version and write API version are selected during OAuth authorization. The tenant does not limit which PTV organisation may be queried.',
      inputSchema: publicReadGetByIdSchema,
    }),
    async (args, extra) => {
      try {
        return textResult(
          await searchTools.getOrganisation(registry, readToolContext(extra), args.id),
        );
      } catch (err) {
        return errorResult(describeError(err), deps.publicUrl);
      }
    },
  );

  server.registerTool(
    'ptv_get_organisation_hierarchy',
    withOAuthSecurity({
      description:
        'Fetch a published PTV organisation and every ancestor up to its root. The organisation context is selected during OAuth authorization.',
      inputSchema: publicReadGetByIdSchema,
    }),
    async (args, extra) => {
      try {
        return textResult(
          await searchTools.getOrganisationHierarchy(registry, readToolContext(extra), args.id),
        );
      } catch (err) {
        return errorResult(describeError(err), deps.publicUrl);
      }
    },
  );

  server.registerTool(
    'ptv_search_service_collections',
    withOAuthSecurity({
      description:
        'Search published PTV service collections. The OAuth-selected tenant determines which PTV integration/API key is used; `query` and `organizationId` determine what PTV data is searched.',
      inputSchema: publicReadSearchParamsSchema,
    }),
    async (args, extra) => {
      try {
        return textResult(
          await searchTools.searchServiceCollections(
            registry,
            readToolContext(extra),
            searchParams(args),
          ),
        );
      } catch (err) {
        return errorResult(describeError(err), deps.publicUrl);
      }
    },
  );

  server.registerTool(
    'ptv_search_general_descriptions',
    withOAuthSecurity({
      description:
        'Search published PTV general descriptions. The OAuth-selected tenant determines which PTV integration/API key is used; `query` and `organizationId` determine what PTV data is searched.',
      inputSchema: publicReadSearchParamsSchema,
    }),
    async (args, extra) => {
      try {
        return textResult(
          await searchTools.searchGeneralDescriptions(
            registry,
            readToolContext(extra),
            searchParams(args),
          ),
        );
      } catch (err) {
        return errorResult(describeError(err), deps.publicUrl);
      }
    },
  );

  server.registerTool(
    'ptv_search_connections',
    withOAuthSecurity({
      description:
        'List published PTV service/channel connections. The organisation context is selected during OAuth authorization.',
      inputSchema: publicReadGetByIdSchema,
    }),
    async (args, extra) => {
      try {
        return textResult(
          await searchTools.searchConnections(registry, readToolContext(extra), args.id),
        );
      } catch (err) {
        return errorResult(describeError(err), deps.publicUrl);
      }
    },
  );

  server.registerTool(
    'ptv_search_ontology_terms',
    withOAuthSecurity({
      description:
        'Search PTV ontology terms (asiasanat) by name, e.g. "kaste" or "rippikoulu". ' +
        'Terms are KOKO concepts, which cover YSO, MAO and other Finto ontologies; each ' +
        "result's `uri` (http://www.yso.fi/onto/koko/p…) is the value a service's " +
        '`ontologyTerms` must use. KOKO numbers differ from YSO numbers, so use these URIs ' +
        'rather than YSO ones. Only valid terms are returned. Requires the v12 read API.',
      inputSchema: {
        query: z.string().min(1).describe('Term name or part of it, e.g. "siunaus".'),
        page: z.number().int().min(1).optional(),
        pageSize: z.number().int().min(1).max(100).optional(),
      },
    }),
    async (args, extra) => {
      try {
        return textResult(
          await searchTools.searchOntologyTerms(
            registry,
            readToolContext(extra),
            searchParams(args),
          ),
        );
      } catch (err) {
        return errorResult(describeError(err), deps.publicUrl);
      }
    },
  );

  server.registerTool(
    'ptv_list_codes',
    withOAuthSecurity({
      description: 'List entries in a PTV code list (e.g. "languages", "service-classes").',
      inputSchema: {
        codeListName: z.string(),
      },
    }),
    async (args, extra) => {
      try {
        return textResult(
          await searchTools.listCodes(registry, readToolContext(extra), args.codeListName),
        );
      } catch (err) {
        return errorResult(describeError(err), deps.publicUrl);
      }
    },
  );

  const changesSchema = z
    .record(z.string(), z.unknown())
    .describe(
      'Partial<Service> — only the fields being changed. A key present but empty clears that field.',
    );

  server.registerTool(
    'ptv_propose_changes',
    withOAuthSecurity({
      description:
        'Diff a proposed change against the current service. Never writes anything. Returns {serviceId, current, proposed, diff, correlationId} — pass correlationId to ptv_validate_changes/ptv_export_for_manual_publish/ptv_apply_changes to keep them in one audit trail.',
      inputSchema: {
        serviceId: z.string(),
        changes: changesSchema,
        correlationId: z.string().optional(),
        reviewItemId: reviewItemIdSchema,
      },
    }),
    async (args, extra) => {
      try {
        const ctx = toolContext(extra);
        const item = args.reviewItemId
          ? await requireLinkableReviewItem(reviewDeps, ctx, args.reviewItemId, {
              kind: 'service_update',
              targetId: args.serviceId,
              changes: args.changes as Record<string, unknown>,
            })
          : null;
        const result = await queueProposal(
          resolveRole,
          registry,
          auditService,
          proposalService,
          ctx,
          args.serviceId,
          args.changes as Partial<Service>,
          args.correlationId,
          args.reviewItemId,
        );
        if (item) await linkQueued(ctx, item, result.proposalId);
        return textResult(result);
      } catch (err) {
        return errorResult(describeError(err), deps.publicUrl);
      }
    },
  );

  server.registerTool(
    'ptv_propose_new_service',
    withOAuthSecurity({
      description:
        'Queue a proposal to create a new PTV service. Needs the Contributor role (Ehdottaja). Nothing is written until an Approver+ resolves it with approve_and_apply (which also needs Publisher-level write access); PTV then assigns the id, recorded on the proposal. `service` is a Service without id: organizationId, serviceType (default Service), publishingStatus (Draft by default, or Published), names, summaries, descriptions (each keyed by language, e.g. {"fi": "..."}), languages, serviceClasses (at least one subclass, e.g. P25.6), ontologyTerms (KOKO URIs), targetGroups, optionally lifeEvents, industrialClasses (needs target groups KR2 + KR2.x), generalDescriptionId, serviceChannelIds. Classification entries need a `uri` (or `code` for industrial classes). The service area is copied from the organisation. Returns the validation result right away.',
      inputSchema: {
        service: z
          .record(z.string(), z.unknown())
          .describe('The new service: a Service without id (see the tool description).'),
        correlationId: z.string().optional(),
        reviewItemId: reviewItemIdSchema,
      },
    }),
    async (args, extra) => {
      try {
        const ctx = toolContext(extra);
        const item = args.reviewItemId
          ? await requireLinkableReviewItem(reviewDeps, ctx, args.reviewItemId, {
              kind: 'service_create',
            })
          : null;
        const result = await queueNewServiceProposal(
          resolveRole,
          auditService,
          proposalService,
          validator,
          ctx,
          args.service as Partial<Service>,
          args.correlationId,
          args.reviewItemId,
        );
        if (item) await linkQueued(ctx, item, result.proposalId);
        return textResult(result);
      } catch (err) {
        return errorResult(describeError(err), deps.publicUrl);
      }
    },
  );

  server.registerTool(
    'ptv_propose_channel_changes',
    withOAuthSecurity({
      description:
        'Diff a proposed change against a service channel and queue it as a proposal. Needs the Contributor role (Ehdottaja). Never writes anything; an Approver+ resolves it with ptv_resolve_proposal (approve_and_apply needs Publisher-level write access). Writable fields by type (see ServiceChannel in the guides): all types names, summaries (max 150), descriptions, languages (languages it serves in), publishingStatus (Published, Draft for a never-published channel, or Archived), isVisibleForAll, serviceHours; EChannel urls, requiresAuthentication, requiresSignature, signatureQuantity, accessibility, supportPhones, supportEmails; WebPage urls, accessibility, supportPhones, supportEmails; Phone phoneNumbers (type Phone/Sms/Fax), urls, supportPhones, supportEmails; PrintableForm formFiles, formIdentifiers, deliveryAddresses, webPages, supportPhones, supportEmails; ServiceLocation addresses, phoneNumbers (Fax as type), emails, webPages. A field present in `changes` replaces all its values (every language, every list entry): read the channel first and send the full list. Phone numbers: number without the leading 0 plus prefixNumber +358, or isFinnishServiceNumber; times HH:mm; dates YYYY-MM-DD.',
      inputSchema: {
        channelId: z.string(),
        changes: z
          .record(z.string(), z.unknown())
          .describe(
            "Partial<ServiceChannel>: only the channel type's writable fields (see the description).",
          ),
        correlationId: z.string().optional(),
        reviewItemId: reviewItemIdSchema,
      },
    }),
    async (args, extra) => {
      try {
        const ctx = toolContext(extra);
        const item = args.reviewItemId
          ? await requireLinkableReviewItem(reviewDeps, ctx, args.reviewItemId, {
              kind: 'channel_update',
              targetId: args.channelId,
            })
          : null;
        const result = await queueChannelProposal(
          resolveRole,
          registry,
          auditService,
          proposalService,
          ctx,
          args.channelId,
          args.changes as Partial<ServiceChannel>,
          args.correlationId,
          args.reviewItemId,
        );
        if (item) await linkQueued(ctx, item, result.proposalId);
        return textResult(result);
      } catch (err) {
        return errorResult(describeError(err), deps.publicUrl);
      }
    },
  );

  server.registerTool(
    'ptv_propose_new_channel',
    withOAuthSecurity({
      description:
        'Queue a proposal to create a new service channel. Needs the Contributor role (Ehdottaja). Nothing is written until an Approver+ resolves it with approve_and_apply (Publisher-level write access); PTV then assigns the id, recorded on the proposal. `channel` needs channelType (EChannel, WebPage, Phone, PrintableForm, ServiceLocation) and organizationId, then names, summaries and descriptions (keyed by language, e.g. {"fi": "..."}) for every language version, languages (the languages it serves customers in), and the type\'s fields (see ptv_propose_channel_changes): EChannel and WebPage need urls for every language version; Phone needs phoneNumbers; ServiceLocation needs a street address in addresses; PrintableForm needs formFiles. Optional serviceIds connects it to existing services. Starts as Draft and shared (isVisibleForAll) unless set. Returns validation and automated quality checks right away. Do not describe another organisation\'s channel: connect their shared channel instead.',
      inputSchema: {
        channel: z
          .record(z.string(), z.unknown())
          .describe('The new channel: a ServiceChannel without id, plus optional serviceIds.'),
        correlationId: z.string().optional(),
        reviewItemId: reviewItemIdSchema,
      },
    }),
    async (args, extra) => {
      try {
        const ctx = toolContext(extra);
        const item = args.reviewItemId
          ? await requireLinkableReviewItem(reviewDeps, ctx, args.reviewItemId, {
              kind: 'channel_create',
            })
          : null;
        const result = await queueNewChannelProposal(
          resolveRole,
          auditService,
          proposalService,
          ctx,
          args.channel as Partial<NewChannel>,
          args.correlationId,
          args.reviewItemId,
        );
        if (item) await linkQueued(ctx, item, result.proposalId);
        return textResult(result);
      } catch (err) {
        return errorResult(describeError(err), deps.publicUrl);
      }
    },
  );

  server.registerTool(
    'ptv_list_proposals',
    withOAuthSecurity({
      description:
        'List queued proposals for a tenant (kind: service_update, service_create or channel_update). waitingForMe: true lists only pending proposals waiting for your sign-off as a required reviewer. Requires the Contributor role (Ehdottaja) or above.',
      inputSchema: {
        status: z.enum(['pending', 'approved', 'rejected', 'applied', 'failed']).optional(),
        waitingForMe: z.boolean().optional(),
      },
    }),
    async (args, extra) => {
      try {
        return textResult(
          await listProposals(
            resolveRole,
            proposalService,
            toolContext(extra),
            args.status,
            args.waitingForMe ?? false,
          ),
        );
      } catch (err) {
        return errorResult(describeError(err), deps.publicUrl);
      }
    },
  );

  server.registerTool(
    'ptv_get_proposal',
    withOAuthSecurity({
      description:
        'Read one proposal and re-diff it against the current service state for review. Requires the Contributor role (Ehdottaja) or above.',
      inputSchema: {
        proposalId: z.string(),
      },
    }),
    async (args, extra) => {
      try {
        return textResult(
          await getProposal(
            resolveRole,
            registry,
            proposalService,
            auditService,
            toolContext(extra),
            args.proposalId,
          ),
        );
      } catch (err) {
        return errorResult(describeError(err), deps.publicUrl);
      }
    },
  );

  server.registerTool(
    'ptv_comment_proposal',
    withOAuthSecurity({
      description:
        'Add a comment to a proposal, e.g. a review note or the reason for a change. Requires the Contributor role (Ehdottaja) or above. Comments show up in ptv_get_proposal and the web review page.',
      inputSchema: {
        proposalId: z.string(),
        comment: z.string().min(1).max(MAX_COMMENT_LENGTH),
      },
    }),
    async (args, extra) => {
      try {
        return textResult(
          await commentOnProposal(
            resolveRole,
            proposalService,
            auditService,
            toolContext(extra),
            args.proposalId,
            args.comment,
          ),
        );
      } catch (err) {
        return errorResult(describeError(err), deps.publicUrl);
      }
    },
  );

  server.registerTool(
    'ptv_request_review',
    withOAuthSecurity({
      description:
        'Name required reviewers (emails or user ids of Contributor+ members) for a pending proposal. Approving then waits until every reviewer has signed off with ptv_sign_off_proposal. The proposer or an Approver (Hyväksyjä) may ask. Without reviewers, lists the possible ones.',
      inputSchema: {
        proposalId: z.string(),
        reviewers: z.array(z.string().min(1)).max(20).optional(),
      },
    }),
    async (args, extra) => {
      try {
        const ctx = toolContext(extra);
        if (!args.reviewers || args.reviewers.length === 0) {
          return textResult({
            possibleReviewers: await listReviewCandidates(resolveRole, listMembers, ctx),
          });
        }
        return textResult(
          await requestReview(
            resolveRole,
            listMembers,
            proposalService,
            auditService,
            ctx,
            args.proposalId,
            args.reviewers,
          ),
        );
      } catch (err) {
        return errorResult(describeError(err), deps.publicUrl);
      }
    },
  );

  server.registerTool(
    'ptv_sign_off_proposal',
    withOAuthSecurity({
      description:
        'Sign off a pending proposal you were asked to review: approved (Hyväksyn) or changes_requested (Pyydän muutoksia), with an optional comment. You can change your sign-off until the proposal is resolved.',
      inputSchema: {
        proposalId: z.string(),
        decision: z.enum(['approved', 'changes_requested']),
        comment: z.string().max(MAX_COMMENT_LENGTH).optional(),
      },
    }),
    async (args, extra) => {
      try {
        return textResult(
          await signOffProposal(
            resolveRole,
            proposalService,
            auditService,
            toolContext(extra),
            args.proposalId,
            args.decision,
            args.comment,
          ),
        );
      } catch (err) {
        return errorResult(describeError(err), deps.publicUrl);
      }
    },
  );

  server.registerTool(
    'ptv_resolve_proposal',
    withOAuthSecurity({
      description:
        'Resolve one proposal as approve_and_export, approve_and_apply, or reject. Requires the Approver role (Hyväksyjä) or above; apply also requires the Publisher role (Julkaisija). With four-eyes on (the default), you cannot approve a proposal you created, only reject it. Approving also waits for every required reviewer to sign off.',
      inputSchema: {
        proposalId: z.string(),
        action: z.enum(['approve_and_export', 'approve_and_apply', 'reject']),
      },
    }),
    async (args, extra) => {
      try {
        return textResult(
          await resolveProposal(
            resolveRole,
            registry,
            proposalService,
            auditService,
            validator,
            toolContext(extra),
            args.proposalId,
            args.action,
            requireFourEyes,
          ),
        );
      } catch (err) {
        return errorResult(describeError(err), deps.publicUrl);
      }
    },
  );

  server.registerTool(
    'ptv_validate_changes',
    withOAuthSecurity({
      description:
        'Validate an already-merged proposed service (the "proposed" object ptv_propose_changes returned) against PTV write rules.',
      inputSchema: {
        proposed: z.record(z.string(), z.unknown()),
        correlationId: z.string().optional(),
      },
    }),
    async (args, extra) => {
      try {
        return textResult(
          await validateChanges(
            auditService,
            validator,
            toolContext(extra),
            args.proposed as unknown as Service,
            args.correlationId,
          ),
        );
      } catch (err) {
        return errorResult(describeError(err), deps.publicUrl);
      }
    },
  );

  server.registerTool(
    'ptv_export_for_manual_publish',
    withOAuthSecurity({
      description:
        "Render an approved proposal into a per-language preview for manual copy into PTV's own admin UI, and record it as ReadyForManualPublish. Refused when the organisation requires four-eyes review (the default): use ptv_propose_changes instead.",
      inputSchema: {
        serviceId: z.string(),
        changes: changesSchema,
        correlationId: z.string().optional(),
      },
    }),
    async (args, extra) => {
      try {
        const ctx = toolContext(extra);
        await requireNoFourEyes(requireFourEyes, ctx.tenantId);
        return textResult(
          await exportForManualPublish(
            resolveRole,
            registry,
            auditService,
            ctx,
            args.serviceId,
            args.changes as Partial<Service>,
            args.correlationId,
          ),
        );
      } catch (err) {
        return errorResult(describeError(err), deps.publicUrl);
      }
    },
  );

  server.registerTool(
    'ptv_apply_changes',
    withOAuthSecurity({
      description:
        'Validate and write a proposed change directly to PTV via a write-capable adapter for this tenant/environment. Requires Publisher role and an active PTV connection. Refused when the organisation requires four-eyes review (the default): use ptv_propose_changes instead.',
      inputSchema: {
        serviceId: z.string(),
        changes: changesSchema,
        correlationId: z.string().optional(),
      },
    }),
    async (args, extra) => {
      try {
        const ctx = toolContext(extra);
        await requireNoFourEyes(requireFourEyes, ctx.tenantId);
        return textResult(
          await applyChanges(
            resolveRole,
            registry,
            auditService,
            validator,
            ctx,
            args.serviceId,
            args.changes as Partial<Service>,
            args.correlationId,
          ),
        );
      } catch (err) {
        return errorResult(describeError(err), deps.publicUrl);
      }
    },
  );

  server.registerTool(
    'ptv_my_tasks',
    withOAuthSecurity({
      description:
        "Everything waiting for you in this organisation and environment: review items assigned to you, proposals waiting for your sign-off, and for Approvers and above every suggested change that still needs review, resolving or (Publisher+) publishing in PTV, each with its readiness; Publishers also get open review campaigns' progress. Call it at the start of a session and tell the user the `summary` lines. Contributor role (Ehdottaja) or above.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    }),
    async (_args, extra) => {
      try {
        return textResult(
          await listMyTasks(reviewDeps, proposalService, requireFourEyes, toolContext(extra)),
        );
      } catch (err) {
        return errorResult(describeError(err), deps.publicUrl);
      }
    },
  );

  server.registerTool(
    'ptv_check_quality',
    withOAuthSecurity({
      description:
        "Run the deterministic content checks (guides/content-quality.md's Q-* checks that can be decided from the data: contact details or opening hours in free text, missing or too long texts, summary repeating the name, classification limits, missing channels or languages, and Finnish style heuristics such as passive voice) on a published service or channel. Returns findings with severity error (breaks a DVV rule) or warning (heuristic, for a human to judge). The same checks run on every proposal and review item.",
      inputSchema: {
        kind: z.enum(['service', 'channel']),
        id: z.string(),
      },
      annotations: { readOnlyHint: true },
    }),
    async (args, extra) => {
      try {
        return textResult(await checkQuality(registry, readToolContext(extra), args.kind, args.id));
      } catch (err) {
        return errorResult(describeError(err), deps.publicUrl);
      }
    },
  );

  server.registerTool(
    'ptv_review_start_campaign',
    withOAuthSecurity({
      description:
        "Start a review campaign: a full check of an organisation's published PTV content in this environment. Every service, channel and organisation (sub-organisations included unless includeSubOrganisations is false) becomes a review item with its automated check findings. Needs the Publisher role (Julkaisija) or above. One open campaign per organisation. Next: assign items with ptv_review_assign.",
      inputSchema: {
        name: z.string().describe('e.g. "Syyskuun 2026 tarkistus"'),
        organizationId: z.string().uuid().describe('PTV organisation id'),
        dueDate: z.string().optional().describe('Target date, YYYY-MM-DD'),
        includeSubOrganisations: z.boolean().optional(),
      },
    }),
    async (args, extra) => {
      try {
        return textResult(
          await startReviewCampaign(reviewDeps, toolContext(extra), {
            name: args.name,
            organizationId: args.organizationId,
            ...(args.dueDate ? { dueDate: args.dueDate } : {}),
            ...(args.includeSubOrganisations !== undefined
              ? { includeSubOrganisations: args.includeSubOrganisations }
              : {}),
          }),
        );
      } catch (err) {
        return errorResult(describeError(err), deps.publicUrl);
      }
    },
  );

  server.registerTool(
    'ptv_review_list_campaigns',
    withOAuthSecurity({
      description:
        'List review campaigns with progress (items open, confirmed, changes proposed, unassigned). Contributor role (Ehdottaja) or above.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    }),
    async (_args, extra) => {
      try {
        return textResult(await listReviewCampaigns(reviewDeps, toolContext(extra)));
      } catch (err) {
        return errorResult(describeError(err), deps.publicUrl);
      }
    },
  );

  server.registerTool(
    'ptv_review_get_campaign',
    withOAuthSecurity({
      description:
        'One review campaign with its items (reviewer, status, automated findings, linked proposals). assignedToMe: only your items. Contributor role (Ehdottaja) or above.',
      inputSchema: {
        campaignId: z.string().uuid(),
        assignedToMe: z.boolean().optional(),
        status: z.enum(['open', 'confirmed', 'changes_proposed']).optional(),
      },
      annotations: { readOnlyHint: true },
    }),
    async (args, extra) => {
      try {
        return textResult(
          await getReviewCampaign(reviewDeps, toolContext(extra), args.campaignId, {
            ...(args.assignedToMe ? { assignedToMe: true } : {}),
            ...(args.status ? { status: args.status } : {}),
          }),
        );
      } catch (err) {
        return errorResult(describeError(err), deps.publicUrl);
      }
    },
  );

  server.registerTool(
    'ptv_review_assign',
    withOAuthSecurity({
      description:
        'Assign review items to a reviewer (email or user id; must be Contributor/Ehdottaja or above so they can propose changes). Give itemIds, or select by targetKind (organisation, service, channel) and/or organizationId; a selection only takes unassigned items unless reassign is true. Needs the Publisher role (Julkaisija) or above.',
      inputSchema: {
        campaignId: z.string().uuid(),
        reviewer: z.string(),
        itemIds: z.array(z.string().uuid()).optional(),
        targetKind: z.enum(['organisation', 'service', 'channel']).optional(),
        organizationId: z.string().uuid().optional(),
        reassign: z.boolean().optional(),
      },
    }),
    async (args, extra) => {
      try {
        return textResult(
          await assignReviewItems(reviewDeps, toolContext(extra), {
            campaignId: args.campaignId,
            reviewer: args.reviewer,
            ...(args.itemIds ? { itemIds: args.itemIds } : {}),
            ...(args.targetKind ? { targetKind: args.targetKind } : {}),
            ...(args.organizationId ? { organizationId: args.organizationId } : {}),
            ...(args.reassign ? { reassign: true } : {}),
          }),
        );
      } catch (err) {
        return errorResult(describeError(err), deps.publicUrl);
      }
    },
  );

  server.registerTool(
    'ptv_review_my_items',
    withOAuthSecurity({
      description:
        'Your open review items in open campaigns, with automated findings and linked proposals. For each: read it with ptv_review_get_item, check that the content is up to date and the proper channels are linked, then either confirm it or propose changes (reviewItemId) and send it on with ptv_review_complete_item.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    }),
    async (_args, extra) => {
      try {
        return textResult(await listMyReviewItems(reviewDeps, toolContext(extra)));
      } catch (err) {
        return errorResult(describeError(err), deps.publicUrl);
      }
    },
  );

  server.registerTool(
    'ptv_review_get_item',
    withOAuthSecurity({
      description:
        "One review item with the target's current PTV data, fresh automated checks and linked proposals. Contributor role (Ehdottaja) or above.",
      inputSchema: { itemId: z.string().uuid() },
      annotations: { readOnlyHint: true },
    }),
    async (args, extra) => {
      try {
        return textResult(await getReviewItem(reviewDeps, toolContext(extra), args.itemId));
      } catch (err) {
        return errorResult(describeError(err), deps.publicUrl);
      }
    },
  );

  server.registerTool(
    'ptv_review_complete_item',
    withOAuthSecurity({
      description:
        "Record the reviewer's decision on a review item. confirmed: the content is up to date and the proper channels are linked, nothing to change (not allowed while linked proposals are pending). changes_proposed: sends the item to Publishers; needs at least one proposal made with this reviewItemId. Only the item's reviewer or a Publisher+. Call it only when the user has decided.",
      inputSchema: {
        itemId: z.string().uuid(),
        decision: z.enum(['confirmed', 'changes_proposed']),
        note: z.string().optional(),
      },
    }),
    async (args, extra) => {
      try {
        return textResult(
          await completeReviewItem(
            reviewDeps,
            toolContext(extra),
            args.itemId,
            args.decision,
            args.note,
          ),
        );
      } catch (err) {
        return errorResult(describeError(err), deps.publicUrl);
      }
    },
  );

  server.registerTool(
    'ptv_review_reopen_item',
    withOAuthSecurity({
      description:
        'Send a review item back to its reviewer (status open), e.g. when its proposals were rejected. Needs the Publisher role (Julkaisija) or above.',
      inputSchema: { itemId: z.string().uuid(), note: z.string().optional() },
    }),
    async (args, extra) => {
      try {
        return textResult(
          await reopenReviewItem(reviewDeps, toolContext(extra), args.itemId, args.note),
        );
      } catch (err) {
        return errorResult(describeError(err), deps.publicUrl);
      }
    },
  );

  server.registerTool(
    'ptv_review_attach_proposal',
    withOAuthSecurity({
      description:
        "Attach an existing pending proposal to a review campaign item, e.g. a draft a Publisher made for a reviewer to check. The proposal must fit the item (its own service or channel; a service change that edits connections fits a channel's item; a new service or channel fits any item). A finished item is reopened, and the item's reviewer becomes a required reviewer of the proposal, so it can't be approved before they sign off. Your own proposal, or any as a Publisher (Julkaisija) or above. Proposing with reviewItemId does the same in one step.",
      inputSchema: { itemId: z.string().uuid(), proposalId: z.string().uuid() },
    }),
    async (args, extra) => {
      try {
        return textResult(
          await attachProposalToReviewItem(
            reviewDeps,
            toolContext(extra),
            args.itemId,
            args.proposalId,
          ),
        );
      } catch (err) {
        return errorResult(describeError(err), deps.publicUrl);
      }
    },
  );

  server.registerTool(
    'ptv_review_close_campaign',
    withOAuthSecurity({
      description:
        'Close a review campaign; its items stay as the record. Needs the Publisher role (Julkaisija) or above.',
      inputSchema: { campaignId: z.string().uuid() },
    }),
    async (args, extra) => {
      try {
        return textResult(
          await closeReviewCampaign(reviewDeps, toolContext(extra), args.campaignId),
        );
      } catch (err) {
        return errorResult(describeError(err), deps.publicUrl);
      }
    },
  );

  function templatedResource(
    uriTemplate: string,
    name: string,
    description: string,
  ): ResourceTemplate {
    return new ResourceTemplate(uriTemplate, {
      list: async () => ({
        resources: [{ uri: uriTemplate, name, description, mimeType: 'application/json' }],
      }),
    });
  }

  const serviceTemplate = templatedResource(
    'ptv://{tenantId}/{environment}/services/{serviceId}',
    'PTV service',
    'Get one PTV service by id.',
  );
  server.registerResource(
    'ptv_resource_service',
    serviceTemplate,
    { description: 'Get one PTV service by id.', mimeType: 'application/json' },
    async (_uri, variables, extra) => {
      const ctx = resourceToolContext(
        extra,
        variables.tenantId as string,
        variables.environment as string,
      );
      const service = await searchTools.getService(registry, ctx, variables.serviceId as string);
      return {
        contents: [
          {
            uri: `ptv://${ctx.tenantId}/${ctx.environment}/services/${variables.serviceId as string}`,
            mimeType: 'application/json',
            text: JSON.stringify(service, null, 2),
          },
        ],
      };
    },
  );

  const channelTemplate = templatedResource(
    'ptv://{tenantId}/{environment}/channels/{channelId}',
    'PTV service channel',
    'Get one PTV service channel by id.',
  );
  server.registerResource(
    'ptv_resource_channel',
    channelTemplate,
    { description: 'Get one PTV service channel by id.', mimeType: 'application/json' },
    async (_uri, variables, extra) => {
      const ctx = resourceToolContext(
        extra,
        variables.tenantId as string,
        variables.environment as string,
      );
      const channel = await searchTools.getChannel(registry, ctx, variables.channelId as string);
      return {
        contents: [
          {
            uri: `ptv://${ctx.tenantId}/${ctx.environment}/channels/${variables.channelId as string}`,
            mimeType: 'application/json',
            text: JSON.stringify(channel, null, 2),
          },
        ],
      };
    },
  );

  const organisationTemplate = templatedResource(
    'ptv://{tenantId}/{environment}/organisations/{organisationId}',
    'PTV organisation',
    'Get one PTV organisation by id.',
  );
  server.registerResource(
    'ptv_resource_organisation',
    organisationTemplate,
    { description: 'Get one PTV organisation by id.', mimeType: 'application/json' },
    async (_uri, variables, extra) => {
      const ctx = resourceToolContext(
        extra,
        variables.tenantId as string,
        variables.environment as string,
      );
      const organisation = await searchTools.getOrganisation(
        registry,
        ctx,
        variables.organisationId as string,
      );
      return {
        contents: [
          {
            uri: `ptv://${ctx.tenantId}/${ctx.environment}/organisations/${variables.organisationId as string}`,
            mimeType: 'application/json',
            text: JSON.stringify(organisation, null, 2),
          },
        ],
      };
    },
  );

  const hierarchyTemplate = templatedResource(
    'ptv://{tenantId}/{environment}/organisations/{organisationId}/hierarchy',
    'PTV organisation hierarchy',
    'Get one PTV organisation hierarchy by id.',
  );
  server.registerResource(
    'ptv_resource_organisation_hierarchy',
    hierarchyTemplate,
    { description: 'Get one PTV organisation hierarchy by id.', mimeType: 'application/json' },
    async (_uri, variables, extra) => {
      const ctx = resourceToolContext(
        extra,
        variables.tenantId as string,
        variables.environment as string,
      );
      const hierarchy = await searchTools.getOrganisationHierarchy(
        registry,
        ctx,
        variables.organisationId as string,
      );
      return {
        contents: [
          {
            uri: `ptv://${ctx.tenantId}/${ctx.environment}/organisations/${variables.organisationId as string}/hierarchy`,
            mimeType: 'application/json',
            text: JSON.stringify(hierarchy, null, 2),
          },
        ],
      };
    },
  );

  const codeListTemplate = templatedResource(
    'ptv://{tenantId}/{environment}/code-lists/{codeListName}',
    'PTV code list',
    'List entries in one PTV code list by name.',
  );
  server.registerResource(
    'ptv_resource_code_list',
    codeListTemplate,
    { description: 'List entries in one PTV code list by name.', mimeType: 'application/json' },
    async (_uri, variables, extra) => {
      const ctx = resourceToolContext(
        extra,
        variables.tenantId as string,
        variables.environment as string,
      );
      const codes = await searchTools.listCodes(registry, ctx, variables.codeListName as string);
      return {
        contents: [
          {
            uri: `ptv://${ctx.tenantId}/${ctx.environment}/code-lists/${variables.codeListName as string}`,
            mimeType: 'application/json',
            text: JSON.stringify(codes, null, 2),
          },
        ],
      };
    },
  );

  return server;
}
