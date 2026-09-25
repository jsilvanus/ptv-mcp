import { queueChannelProposal } from './channelProposal.js';
import { queueConnectionProposal } from './connectionProposal.js';
import { queueNewOrganizationProposal, queueOrganizationProposal } from './organizationProposal.js';
import { queueNewServiceProposal } from './newServiceProposal.js';
import { McpServer, type ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { Variables } from '@modelcontextprotocol/sdk/shared/uriTemplate.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type {
  ShapeOutput,
  ZodRawShapeCompat,
} from '@modelcontextprotocol/sdk/server/zod-compat.js';
import { z } from 'zod';
import type { PtvAdapterRegistry, PtvAdapterResolutionRequest } from '../ptv/registry.js';
import { PtvAdapterResolutionError } from '../ptv/registry.js';
import type { AuditService } from '../audit/auditService.js';
import type { ChangeValidator } from '../validation/changeValidator.js';
import type {
  ConnectionDetails,
  Organization,
  SearchParams,
  Service,
  ServiceChannel,
} from '../ptv/domain.js';
import type { NewChannel, NewOrganization } from '../ptv/adapter.js';
import type { Database } from '../db/client.js';
import { resolveMembershipRole } from '../auth/rbac.js';
import { requireNoFourEyes } from './authorization.js';
import type { ProposalService } from '../proposals/proposalService.js';
import { TenantService, tenantRequiresFourEyes } from '../tenants/tenantService.js';
import * as searchTools from './searchTools.js';
import { validateChanges } from './validateChanges.js';
import { applyChanges, exportForManualPublish } from './applyOrExport.js';
import type { ReadToolContext, ToolContext } from './toolContext.js';
import { registerGuides, SERVER_INSTRUCTIONS } from './guides.js';
import { useToolMetadata } from './toolAnnotations.js';
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
  listProposals,
  queueProposal,
  confirmManualPublish,
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

/** Thrown when a call has no verified access token; tools answer it with the OAuth challenge. */
export class AuthenticationRequiredError extends Error {
  constructor() {
    super('No authenticated user for this MCP session');
    this.name = 'AuthenticationRequiredError';
  }
}

/**
 * Every business error this layer throws maps to a *tool* error
 * (`isError: true` in the result), not a protocol-level failure — an
 * agent calling e.g. `ptv_apply_changes` with an invalid proposal should
 * get back a readable reason, not a transport exception.
 */
function errorResult(err: unknown, publicUrl?: string): CallToolResult {
  if (err instanceof AuthenticationRequiredError && publicUrl) {
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
  return { content: [{ type: 'text', text: describeError(err) }], isError: true };
}

function describeError(err: unknown): string {
  if (err instanceof PtvAdapterResolutionError) {
    return `${err.reason}: ${err.message}`;
  }
  return err instanceof Error ? err.message : String(err);
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
    throw new AuthenticationRequiredError();
  }
  return userId;
}

/**
 * Caches an async lookup for the lifetime of one `createMcpServer()` call,
 * i.e. one HTTP request. A failed lookup is dropped rather than reused.
 */
function memoize<A extends unknown[], R>(
  key: (...args: A) => string,
  fn: (...args: A) => Promise<R>,
): (...args: A) => Promise<R> {
  const cache = new Map<string, Promise<R>>();
  return (...args) => {
    const k = key(...args);
    let result = cache.get(k);
    if (!result) {
      result = fn(...args);
      cache.set(k, result);
      result.catch(() => cache.delete(k));
    }
    return result;
  };
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
  const { db, auditService, validator, proposalService } = deps;
  // One server per request (see httpTransport.ts), so these memos only
  // span one request. Keys hold every argument, so nothing is shared
  // between tenants or users.
  const resolveRole = memoize(
    (tenantId: string, userId: string) => `${tenantId}:${userId}`,
    (tenantId: string, userId: string) => resolveMembershipRole(db, tenantId, userId),
  );
  const registry: PtvAdapterRegistry = {
    resolve: memoize(
      (request: PtvAdapterResolutionRequest) => JSON.stringify(Object.entries(request).sort()),
      (request: PtvAdapterResolutionRequest) => deps.registry.resolve(request),
    ),
  };
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
  useToolMetadata(server);
  registerGuides(server);

  /**
   * Registers an OAuth-protected tool whose result is `run`'s value as
   * JSON; anything it throws becomes a tool error (see `errorResult`).
   */
  function tool<Shape extends ZodRawShapeCompat>(
    name: string,
    config: { description: string; inputSchema: Shape },
    run: (args: ShapeOutput<Shape>, extra: Extra) => Promise<unknown>,
  ): void {
    const callback = async (args: ShapeOutput<Shape>, extra: Extra): Promise<CallToolResult> => {
      try {
        return textResult(await run(args, extra));
      } catch (err) {
        return errorResult(err, deps.publicUrl);
      }
    };
    // `securitySchemes` isn't in the SDK's config type yet; clients read it
    // from the tool listing, so it goes through as an extra property.
    const withSecurity = { ...config, securitySchemes: oauthSecuritySchemes };
    server.registerTool(name, withSecurity, callback as ToolCallback<Shape>);
  }

  tool(
    'ptv_search_services',
    {
      description:
        'Search published PTV services. The OAuth-selected PTV connection determines tenant, environment, read API version and write API version; `query` and `organizationId` determine what PTV data is searched.',
      inputSchema: publicReadSearchParamsSchema,
    },
    (args, extra) =>
      searchTools.searchServices(registry, readToolContext(extra), searchParams(args)),
  );

  tool(
    'ptv_get_service',
    {
      description:
        'Fetch one published PTV service by id. The PTV tenant, environment, read API version and write API version are selected during OAuth authorization.',
      inputSchema: publicReadGetByIdSchema,
    },
    (args, extra) => searchTools.getService(registry, readToolContext(extra), args.id),
  );

  tool(
    'ptv_search_channels',
    {
      description:
        'Search published PTV service channels. The OAuth-selected tenant determines which PTV integration/API key is used; `query` and `organizationId` determine what PTV data is searched.',
      inputSchema: publicReadSearchParamsSchema,
    },
    (args, extra) =>
      searchTools.searchChannels(registry, readToolContext(extra), searchParams(args)),
  );

  tool(
    'ptv_get_channel',
    {
      description:
        'Fetch one published PTV service channel by id. The organisation context is selected during OAuth authorization.',
      inputSchema: publicReadGetByIdSchema,
    },
    (args, extra) => searchTools.getChannel(registry, readToolContext(extra), args.id),
  );

  tool(
    'ptv_search_organisations',
    {
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
    },
    (args, extra) =>
      searchTools.searchOrganisations(registry, readToolContext(extra), {
        ...(args.query !== undefined ? { query: args.query } : {}),
        ...(args.page !== undefined ? { page: args.page } : {}),
        ...(args.pageSize !== undefined ? { pageSize: args.pageSize } : {}),
      }),
  );

  tool(
    'ptv_find_organisation_and_children',
    {
      description:
        'Find a PTV organisation by name/text and return that organisation together with its published services and service channels. This is a compound convenience operation; use the individual search tools when you need independent searches.',
      inputSchema: {
        query: z
          .string()
          .min(1)
          .describe('Organisation name or text, for example "Riihimäen seurakunta".'),
      },
    },
    (args, extra) =>
      searchTools.findOrganisationAndChildren(registry, readToolContext(extra), args.query),
  );

  tool(
    'ptv_get_organisation',
    {
      description:
        'Fetch one published PTV organisation by id. The PTV tenant, environment, read API version and write API version are selected during OAuth authorization. The tenant does not limit which PTV organisation may be queried.',
      inputSchema: publicReadGetByIdSchema,
    },
    (args, extra) => searchTools.getOrganisation(registry, readToolContext(extra), args.id),
  );

  tool(
    'ptv_get_organisation_hierarchy',
    {
      description:
        'Fetch a published PTV organisation and every ancestor up to its root. The organisation context is selected during OAuth authorization.',
      inputSchema: publicReadGetByIdSchema,
    },
    (args, extra) =>
      searchTools.getOrganisationHierarchy(registry, readToolContext(extra), args.id),
  );

  tool(
    'ptv_search_service_collections',
    {
      description:
        'Search published PTV service collections. The OAuth-selected tenant determines which PTV integration/API key is used; `query` and `organizationId` determine what PTV data is searched.',
      inputSchema: publicReadSearchParamsSchema,
    },
    (args, extra) =>
      searchTools.searchServiceCollections(registry, readToolContext(extra), searchParams(args)),
  );

  tool(
    'ptv_search_general_descriptions',
    {
      description:
        'Search published PTV general descriptions. The OAuth-selected tenant determines which PTV integration/API key is used; `query` and `organizationId` determine what PTV data is searched.',
      inputSchema: publicReadSearchParamsSchema,
    },
    (args, extra) =>
      searchTools.searchGeneralDescriptions(registry, readToolContext(extra), searchParams(args)),
  );

  tool(
    'ptv_search_connections',
    {
      description:
        "List a service's or channel's connections (give the service or channel id), with each connection's extra info (charge type, descriptions, service hours, contact details). Published data.",
      inputSchema: publicReadGetByIdSchema,
    },
    (args, extra) => searchTools.searchConnections(registry, readToolContext(extra), args.id),
  );

  tool(
    'ptv_search_ontology_terms',
    {
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
    },
    (args, extra) =>
      searchTools.searchOntologyTerms(registry, readToolContext(extra), searchParams(args)),
  );

  tool(
    'ptv_list_codes',
    {
      description: 'List entries in a PTV code list (e.g. "languages", "service-classes").',
      inputSchema: {
        codeListName: z.string(),
      },
    },
    (args, extra) => searchTools.listCodes(registry, readToolContext(extra), args.codeListName),
  );

  const changesSchema = z
    .record(z.string(), z.unknown())
    .describe(
      'Partial<Service> — only the fields being changed. A key present but empty clears that field.',
    );

  tool(
    'ptv_propose_changes',
    {
      description:
        'Diff a proposed change against the current service. Never writes anything. Returns {serviceId, current, proposed, diff, correlationId} — pass correlationId to ptv_validate_changes/ptv_export_for_manual_publish/ptv_apply_changes to keep them in one audit trail.',
      inputSchema: {
        serviceId: z.string(),
        changes: changesSchema,
        correlationId: z.string().optional(),
        reviewItemId: reviewItemIdSchema,
      },
    },
    async (args, extra) => {
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
      return result;
    },
  );

  tool(
    'ptv_propose_new_service',
    {
      description:
        'Queue a proposal to create a new PTV service. Needs the Contributor role (Ehdottaja). Nothing is written until an Approver+ resolves it with approve_and_apply (which also needs Publisher-level write access); PTV then assigns the id, recorded on the proposal. `service` is a Service without id: organizationId, serviceType (default Service), publishingStatus (Draft by default, or Published), names, summaries, descriptions (each keyed by language, e.g. {"fi": "..."}), languages, serviceClasses (at least one subclass, e.g. P25.6), ontologyTerms (KOKO URIs), targetGroups, optionally lifeEvents, industrialClasses (needs target groups KR2 + KR2.x), generalDescriptionId, serviceChannelIds. Classification entries need a `uri` (or `code` for industrial classes). The service area is copied from the organisation. Returns the validation result right away.',
      inputSchema: {
        service: z
          .record(z.string(), z.unknown())
          .describe('The new service: a Service without id (see the tool description).'),
        correlationId: z.string().optional(),
        reviewItemId: reviewItemIdSchema,
      },
    },
    async (args, extra) => {
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
      return result;
    },
  );

  tool(
    'ptv_propose_channel_changes',
    {
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
    },
    async (args, extra) => {
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
      return result;
    },
  );

  tool(
    'ptv_propose_connection_changes',
    {
      description:
        "Diff a change to a service–channel connection's extra info (liitoksen lisätiedot) and queue it as a proposal. Needs the Contributor role (Ehdottaja). Never writes anything; an Approver+ resolves it with ptv_resolve_proposal (approve_and_apply needs Publisher-level write access). The service and channel must already be connected (connect them with ptv_propose_changes' serviceChannelIds). Use extra info only for what is specific to this service in this channel, e.g. the service's own hours or phone number at a shared service location. Writable fields: chargeType (Chargeable, FreeOfCharge, Other), descriptions and chargeDescriptions (keyed by language, max 500 characters each), serviceHours, emails, phoneNumbers (type Fax for fax numbers), webPages, addresses (postal only: Street, PostOfficeBox or Foreign). A field present in `changes` replaces all its values; an empty one clears it. Read the connection first (ptv_search_connections) and send the full list. Returns validation and automated quality checks right away.",
      inputSchema: {
        serviceId: z.string(),
        channelId: z.string(),
        changes: z
          .record(z.string(), z.unknown())
          .describe('Partial connection extra info: only the fields being changed.'),
        correlationId: z.string().optional(),
        reviewItemId: reviewItemIdSchema,
      },
    },
    async (args, extra) => {
      const ctx = toolContext(extra);
      const item = args.reviewItemId
        ? await requireLinkableReviewItem(reviewDeps, ctx, args.reviewItemId, {
            kind: 'connection_update',
            targetId: args.serviceId,
            changes: { channelId: args.channelId },
          })
        : null;
      const result = await queueConnectionProposal(
        resolveRole,
        registry,
        auditService,
        proposalService,
        ctx,
        args.serviceId,
        args.channelId,
        args.changes as Partial<ConnectionDetails>,
        args.correlationId,
        args.reviewItemId,
      );
      if (item) await linkQueued(ctx, item, result.proposalId);
      return result;
    },
  );

  tool(
    'ptv_propose_organisation_changes',
    {
      description:
        'Diff a change to an organisation or sub-organisation and queue it as a proposal. Needs the Contributor role (Ehdottaja). Never writes anything; an Approver+ resolves it with ptv_resolve_proposal (approve_and_apply needs Publisher-level write access). Writable fields: names, alternativeNames (an unofficial name customers use) and alternativeNameShownIn (languages that show it instead of the official name), summaries (max 150, not a copy of the name), descriptions (max 2500, what the organisation is and does for its customers, no contact details), businessCode (Y-tunnus 1234567-8), publishingStatus (Published, or Archived to archive a sub-organisation that no longer exists), emails, phoneNumbers, webPages, addresses (one Visiting address for the main office, others Postal; Street, PostOfficeBox, Foreign or Other). Texts are keyed by language, e.g. {"fi": "..."}, and every language version needs a name, a summary and a description. A field present in `changes` replaces all its values; read the organisation first (ptv_get_organisation). The type, area and parent are changed in PTV\'s UI.',
      inputSchema: {
        organizationId: z.string(),
        changes: z
          .record(z.string(), z.unknown())
          .describe('Partial<Organization>: only the fields being changed (see the description).'),
        correlationId: z.string().optional(),
      },
    },
    (args, extra) =>
      queueOrganizationProposal(
        resolveRole,
        registry,
        auditService,
        proposalService,
        toolContext(extra),
        args.organizationId,
        args.changes as Partial<Organization>,
        args.correlationId,
      ),
  );

  tool(
    'ptv_propose_new_organisation',
    {
      description:
        "Queue a proposal to create a sub-organisation (alaorganisaatio) under an existing organisation. Needs the Contributor role (Ehdottaja); nothing is written until an Approver+ resolves it with approve_and_apply (Publisher-level write access), and PTV then assigns the id. Create one only when customers benefit from seeing it as the responsible organisation, or reporting needs it; at most five levels below the main organisation. `organization` needs parentOrganizationId, names, summaries and descriptions for every language the sub-organisation's services will use (keyed by language), and businessCode (its own Y-tunnus, or the parent's if it shares it; check which). organizationType, area and municipality are copied from the parent unless given. Optional: alternativeNames, alternativeNameShownIn, emails, phoneNumbers, webPages, addresses (see ptv_propose_organisation_changes). Starts as Draft unless publishingStatus is Published. Returns validation and quality checks right away.",
      inputSchema: {
        organization: z
          .record(z.string(), z.unknown())
          .describe('The new sub-organisation (see the description).'),
        correlationId: z.string().optional(),
      },
    },
    (args, extra) =>
      queueNewOrganizationProposal(
        resolveRole,
        registry,
        auditService,
        proposalService,
        toolContext(extra),
        args.organization as Partial<NewOrganization>,
        args.correlationId,
      ),
  );

  tool(
    'ptv_propose_new_channel',
    {
      description:
        'Queue a proposal to create a new service channel. Needs the Contributor role (Ehdottaja). Nothing is written until an Approver+ resolves it with approve_and_apply (Publisher-level write access); PTV then assigns the id, recorded on the proposal. `channel` needs channelType (EChannel, WebPage, Phone, PrintableForm, ServiceLocation) and organizationId, then names, summaries and descriptions (keyed by language, e.g. {"fi": "..."}) for every language version, languages (the languages it serves customers in), and the type\'s fields (see ptv_propose_channel_changes): EChannel and WebPage need urls for every language version; Phone needs phoneNumbers; ServiceLocation needs a street address in addresses; PrintableForm needs formFiles. Optional serviceIds connects it to existing services. Starts as Draft and shared (isVisibleForAll) unless set. Returns validation and automated quality checks right away. Do not describe another organisation\'s channel: connect their shared channel instead.',
      inputSchema: {
        channel: z
          .record(z.string(), z.unknown())
          .describe('The new channel: a ServiceChannel without id, plus optional serviceIds.'),
        correlationId: z.string().optional(),
        reviewItemId: reviewItemIdSchema,
      },
    },
    async (args, extra) => {
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
      return result;
    },
  );

  tool(
    'ptv_list_proposals',
    {
      description:
        'List queued proposals for a tenant (kind: service_update, service_create or channel_update). waitingForMe: true lists only pending proposals waiting for your sign-off as a required reviewer. Requires the Contributor role (Ehdottaja) or above.',
      inputSchema: {
        status: z.enum(['pending', 'approved', 'rejected', 'applied', 'failed']).optional(),
        waitingForMe: z.boolean().optional(),
      },
    },
    (args, extra) =>
      listProposals(
        resolveRole,
        proposalService,
        toolContext(extra),
        args.status,
        args.waitingForMe ?? false,
      ),
  );

  tool(
    'ptv_get_proposal',
    {
      description:
        'Read one proposal and re-diff it against the current service state for review. Requires the Contributor role (Ehdottaja) or above.',
      inputSchema: {
        proposalId: z.string(),
      },
    },
    (args, extra) =>
      getProposal(
        resolveRole,
        registry,
        proposalService,
        auditService,
        toolContext(extra),
        args.proposalId,
      ),
  );

  tool(
    'ptv_comment_proposal',
    {
      description:
        'Add a comment to a proposal, e.g. a review note or the reason for a change. Requires the Contributor role (Ehdottaja) or above. Comments show up in ptv_get_proposal and the web review page.',
      inputSchema: {
        proposalId: z.string(),
        comment: z.string().min(1).max(MAX_COMMENT_LENGTH),
      },
    },
    (args, extra) =>
      commentOnProposal(
        resolveRole,
        proposalService,
        auditService,
        toolContext(extra),
        args.proposalId,
        args.comment,
      ),
  );

  tool(
    'ptv_request_review',
    {
      description:
        'Name required reviewers (emails or user ids of Contributor+ members) for a pending proposal. Approving then waits until every reviewer has signed off with ptv_sign_off_proposal. The proposer or an Approver (Hyväksyjä) may ask. Without reviewers, lists the possible ones.',
      inputSchema: {
        proposalId: z.string(),
        reviewers: z.array(z.string().min(1)).max(20).optional(),
      },
    },
    async (args, extra) => {
      const ctx = toolContext(extra);
      if (!args.reviewers || args.reviewers.length === 0) {
        return {
          possibleReviewers: await listReviewCandidates(resolveRole, listMembers, ctx),
        };
      }
      return await requestReview(
        resolveRole,
        listMembers,
        proposalService,
        auditService,
        ctx,
        args.proposalId,
        args.reviewers,
      );
    },
  );

  tool(
    'ptv_sign_off_proposal',
    {
      description:
        'Sign off a pending proposal you were asked to review: approved (Hyväksyn) or changes_requested (Pyydän muutoksia), with an optional comment. You can change your sign-off until the proposal is resolved.',
      inputSchema: {
        proposalId: z.string(),
        decision: z.enum(['approved', 'changes_requested']),
        comment: z.string().max(MAX_COMMENT_LENGTH).optional(),
      },
    },
    (args, extra) =>
      signOffProposal(
        resolveRole,
        proposalService,
        auditService,
        toolContext(extra),
        args.proposalId,
        args.decision,
        args.comment,
      ),
  );

  tool(
    'ptv_resolve_proposal',
    {
      description:
        "Resolve one proposal as approve_and_export, approve_and_apply, or reject. Requires the Approver role (Hyväksyjä) or above; apply also requires the Publisher role (Julkaisija). With four-eyes on (the default), you cannot approve a proposal you created, only reject it. Approving also waits for every required reviewer to sign off. approve_and_export writes nothing: the result's manualPublish sheet lists every field to enter in PTV's own UI (Finnish labels, PTV formats) and the steps; after entering it, close it with ptv_confirm_manual_publish.",
      inputSchema: {
        proposalId: z.string(),
        action: z.enum(['approve_and_export', 'approve_and_apply', 'reject']),
      },
    },
    (args, extra) =>
      resolveProposal(
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

  tool(
    'ptv_confirm_manual_publish',
    {
      description:
        "Close an approved (approve_and_export) proposal after a person has entered it in PTV's own UI. The MCP checks PTV first: an update must have nothing left to differ; a new service or channel needs ptvId (the id PTV gave it) and must belong to the organisation and carry the proposed names. Then the proposal becomes applied (the id is recorded for new items). If PTV still differs, the error lists the fields; ptv_get_proposal shows what is left in its manualPublish sheet. Approver role (Hyväksyjä) or above.",
      inputSchema: {
        proposalId: z.string(),
        ptvId: z
          .string()
          .optional()
          .describe('New services and channels only: the id PTV gave the created item.'),
      },
    },
    (args, extra) =>
      confirmManualPublish(
        resolveRole,
        registry,
        proposalService,
        auditService,
        toolContext(extra),
        args.proposalId,
        args.ptvId,
      ),
  );

  tool(
    'ptv_validate_changes',
    {
      description:
        'Validate an already-merged proposed service (the "proposed" object ptv_propose_changes returned) against PTV write rules.',
      inputSchema: {
        proposed: z.record(z.string(), z.unknown()),
        correlationId: z.string().optional(),
      },
    },
    (args, extra) =>
      validateChanges(
        auditService,
        validator,
        toolContext(extra),
        args.proposed as unknown as Service,
        args.correlationId,
      ),
  );

  tool(
    'ptv_export_for_manual_publish',
    {
      description:
        "Render an approved proposal into a per-language preview for manual copy into PTV's own admin UI, and record it as ReadyForManualPublish. Refused when the organisation requires four-eyes review (the default): use ptv_propose_changes instead.",
      inputSchema: {
        serviceId: z.string(),
        changes: changesSchema,
        correlationId: z.string().optional(),
      },
    },
    async (args, extra) => {
      const ctx = toolContext(extra);
      await requireNoFourEyes(requireFourEyes, ctx.tenantId);
      return await exportForManualPublish(
        resolveRole,
        registry,
        auditService,
        ctx,
        args.serviceId,
        args.changes as Partial<Service>,
        args.correlationId,
      );
    },
  );

  tool(
    'ptv_apply_changes',
    {
      description:
        'Validate and write a proposed change directly to PTV via a write-capable adapter for this tenant/environment. Requires Publisher role and an active PTV connection. Refused when the organisation requires four-eyes review (the default): use ptv_propose_changes instead.',
      inputSchema: {
        serviceId: z.string(),
        changes: changesSchema,
        correlationId: z.string().optional(),
      },
    },
    async (args, extra) => {
      const ctx = toolContext(extra);
      await requireNoFourEyes(requireFourEyes, ctx.tenantId);
      return await applyChanges(
        resolveRole,
        registry,
        auditService,
        validator,
        ctx,
        args.serviceId,
        args.changes as Partial<Service>,
        args.correlationId,
      );
    },
  );

  tool(
    'ptv_my_tasks',
    {
      description:
        "Everything waiting for you in this organisation and environment: review items assigned to you, proposals waiting for your sign-off, and for Approvers and above every suggested change that still needs review, resolving or (Publisher+) publishing in PTV, each with its readiness; Publishers also get open review campaigns' progress. Call it at the start of a session and tell the user the `summary` lines. Contributor role (Ehdottaja) or above.",
      inputSchema: {},
    },
    (_args, extra) => listMyTasks(reviewDeps, proposalService, requireFourEyes, toolContext(extra)),
  );

  tool(
    'ptv_check_quality',
    {
      description:
        "Run the deterministic content checks (guides/content-quality.md's Q-* checks that can be decided from the data: contact details or opening hours in free text, missing or too long texts, summary repeating the name, classification limits, missing channels or languages, and Finnish style heuristics such as passive voice) on a published service or channel. Returns findings with severity error (breaks a DVV rule) or warning (heuristic, for a human to judge). The same checks run on every proposal and review item.",
      inputSchema: {
        kind: z.enum(['service', 'channel']),
        id: z.string(),
      },
    },
    (args, extra) => checkQuality(registry, readToolContext(extra), args.kind, args.id),
  );

  tool(
    'ptv_review_start_campaign',
    {
      description:
        "Start a review campaign: a full check of an organisation's published PTV content in this environment. Every service, channel and organisation (sub-organisations included unless includeSubOrganisations is false) becomes a review item with its automated check findings. Needs the Publisher role (Julkaisija) or above. One open campaign per organisation. Next: assign items with ptv_review_assign.",
      inputSchema: {
        name: z.string().describe('e.g. "Syyskuun 2026 tarkistus"'),
        organizationId: z.string().uuid().describe('PTV organisation id'),
        dueDate: z.string().optional().describe('Target date, YYYY-MM-DD'),
        includeSubOrganisations: z.boolean().optional(),
      },
    },
    (args, extra) =>
      startReviewCampaign(reviewDeps, toolContext(extra), {
        name: args.name,
        organizationId: args.organizationId,
        ...(args.dueDate ? { dueDate: args.dueDate } : {}),
        ...(args.includeSubOrganisations !== undefined
          ? { includeSubOrganisations: args.includeSubOrganisations }
          : {}),
      }),
  );

  tool(
    'ptv_review_list_campaigns',
    {
      description:
        'List review campaigns with progress (items open, confirmed, changes proposed, unassigned). Contributor role (Ehdottaja) or above.',
      inputSchema: {},
    },
    (_args, extra) => listReviewCampaigns(reviewDeps, toolContext(extra)),
  );

  tool(
    'ptv_review_get_campaign',
    {
      description:
        'One review campaign with its items (reviewer, status, automated findings, linked proposals). assignedToMe: only your items. Contributor role (Ehdottaja) or above.',
      inputSchema: {
        campaignId: z.string().uuid(),
        assignedToMe: z.boolean().optional(),
        status: z.enum(['open', 'confirmed', 'changes_proposed']).optional(),
      },
    },
    (args, extra) =>
      getReviewCampaign(reviewDeps, toolContext(extra), args.campaignId, {
        ...(args.assignedToMe ? { assignedToMe: true } : {}),
        ...(args.status ? { status: args.status } : {}),
      }),
  );

  tool(
    'ptv_review_assign',
    {
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
    },
    (args, extra) =>
      assignReviewItems(reviewDeps, toolContext(extra), {
        campaignId: args.campaignId,
        reviewer: args.reviewer,
        ...(args.itemIds ? { itemIds: args.itemIds } : {}),
        ...(args.targetKind ? { targetKind: args.targetKind } : {}),
        ...(args.organizationId ? { organizationId: args.organizationId } : {}),
        ...(args.reassign ? { reassign: true } : {}),
      }),
  );

  tool(
    'ptv_review_my_items',
    {
      description:
        'Your open review items in open campaigns, with automated findings and linked proposals. For each: read it with ptv_review_get_item, check that the content is up to date and the proper channels are linked, then either confirm it or propose changes (reviewItemId) and send it on with ptv_review_complete_item.',
      inputSchema: {},
    },
    (_args, extra) => listMyReviewItems(reviewDeps, toolContext(extra)),
  );

  tool(
    'ptv_review_get_item',
    {
      description:
        "One review item with the target's current PTV data, fresh automated checks and linked proposals. Contributor role (Ehdottaja) or above.",
      inputSchema: { itemId: z.string().uuid() },
    },
    (args, extra) => getReviewItem(reviewDeps, toolContext(extra), args.itemId),
  );

  tool(
    'ptv_review_complete_item',
    {
      description:
        "Record the reviewer's decision on a review item. confirmed: the content is up to date and the proper channels are linked, nothing to change (not allowed while linked proposals are pending). changes_proposed: sends the item to Publishers; needs at least one proposal made with this reviewItemId. Only the item's reviewer or a Publisher+. Call it only when the user has decided.",
      inputSchema: {
        itemId: z.string().uuid(),
        decision: z.enum(['confirmed', 'changes_proposed']),
        note: z.string().optional(),
      },
    },
    (args, extra) =>
      completeReviewItem(reviewDeps, toolContext(extra), args.itemId, args.decision, args.note),
  );

  tool(
    'ptv_review_reopen_item',
    {
      description:
        'Send a review item back to its reviewer (status open), e.g. when its proposals were rejected. Needs the Publisher role (Julkaisija) or above.',
      inputSchema: { itemId: z.string().uuid(), note: z.string().optional() },
    },
    (args, extra) => reopenReviewItem(reviewDeps, toolContext(extra), args.itemId, args.note),
  );

  tool(
    'ptv_review_attach_proposal',
    {
      description:
        "Attach an existing pending proposal to a review campaign item, e.g. a draft a Publisher made for a reviewer to check. The proposal must fit the item (its own service or channel; a service change that edits connections fits a channel's item; a new service or channel fits any item). A finished item is reopened, and the item's reviewer becomes a required reviewer of the proposal, so it can't be approved before they sign off. Your own proposal, or any as a Publisher (Julkaisija) or above. Proposing with reviewItemId does the same in one step.",
      inputSchema: { itemId: z.string().uuid(), proposalId: z.string().uuid() },
    },
    (args, extra) =>
      attachProposalToReviewItem(reviewDeps, toolContext(extra), args.itemId, args.proposalId),
  );

  tool(
    'ptv_review_close_campaign',
    {
      description:
        'Close a review campaign; its items stay as the record. Needs the Publisher role (Julkaisija) or above.',
      inputSchema: { campaignId: z.string().uuid() },
    },
    (args, extra) => closeReviewCampaign(reviewDeps, toolContext(extra), args.campaignId),
  );

  /**
   * Registers a `ptv://{tenantId}/{environment}/...` resource whose
   * contents are `read`'s value as JSON. `uri` rebuilds the canonical URI
   * from the resolved context and the template variables.
   */
  function jsonResource(
    name: string,
    uriTemplate: string,
    title: string,
    description: string,
    read: (ctx: ToolContext, variables: Variables) => Promise<unknown>,
    uri: (ctx: ToolContext, variables: Variables) => string,
  ): void {
    const template = new ResourceTemplate(uriTemplate, {
      list: async () => ({
        resources: [{ uri: uriTemplate, name: title, description, mimeType: 'application/json' }],
      }),
    });
    server.registerResource(
      name,
      template,
      { description, mimeType: 'application/json' },
      async (_uri, variables, extra) => {
        const ctx = resourceToolContext(
          extra,
          variables.tenantId as string,
          variables.environment as string,
        );
        const value = await read(ctx, variables);
        return {
          contents: [
            {
              uri: uri(ctx, variables),
              mimeType: 'application/json',
              text: JSON.stringify(value, null, 2),
            },
          ],
        };
      },
    );
  }

  jsonResource(
    'ptv_resource_service',
    'ptv://{tenantId}/{environment}/services/{serviceId}',
    'PTV service',
    'Get one PTV service by id.',
    (ctx, variables) => searchTools.getService(registry, ctx, variables.serviceId as string),
    (ctx, variables) =>
      `ptv://${ctx.tenantId}/${ctx.environment}/services/${variables.serviceId as string}`,
  );

  jsonResource(
    'ptv_resource_channel',
    'ptv://{tenantId}/{environment}/channels/{channelId}',
    'PTV service channel',
    'Get one PTV service channel by id.',
    (ctx, variables) => searchTools.getChannel(registry, ctx, variables.channelId as string),
    (ctx, variables) =>
      `ptv://${ctx.tenantId}/${ctx.environment}/channels/${variables.channelId as string}`,
  );

  jsonResource(
    'ptv_resource_organisation',
    'ptv://{tenantId}/{environment}/organisations/{organisationId}',
    'PTV organisation',
    'Get one PTV organisation by id.',
    (ctx, variables) =>
      searchTools.getOrganisation(registry, ctx, variables.organisationId as string),
    (ctx, variables) =>
      `ptv://${ctx.tenantId}/${ctx.environment}/organisations/${variables.organisationId as string}`,
  );

  jsonResource(
    'ptv_resource_organisation_hierarchy',
    'ptv://{tenantId}/{environment}/organisations/{organisationId}/hierarchy',
    'PTV organisation hierarchy',
    'Get one PTV organisation hierarchy by id.',
    (ctx, variables) =>
      searchTools.getOrganisationHierarchy(registry, ctx, variables.organisationId as string),
    (ctx, variables) =>
      `ptv://${ctx.tenantId}/${ctx.environment}/organisations/${variables.organisationId as string}/hierarchy`,
  );

  jsonResource(
    'ptv_resource_code_list',
    'ptv://{tenantId}/{environment}/code-lists/{codeListName}',
    'PTV code list',
    'List entries in one PTV code list by name.',
    (ctx, variables) => searchTools.listCodes(registry, ctx, variables.codeListName as string),
    (ctx, variables) =>
      `ptv://${ctx.tenantId}/${ctx.environment}/code-lists/${variables.codeListName as string}`,
  );

  return server;
}
