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
import type { Database } from '../db/client.js';
import { resolveMembershipRole } from '../auth/rbac.js';
import { NotAuthorizedError } from './authorization.js';
import type { ProposalService } from '../proposals/proposalService.js';
import * as searchTools from './searchTools.js';
import { ServiceNotFoundError } from './proposeChanges.js';
import { validateChanges } from './validateChanges.js';
import { applyChanges, exportForManualPublish, ValidationFailedError } from './applyOrExport.js';
import type { ReadToolContext, ToolContext } from './toolContext.js';
import {
  getProposal,
  isProposalQueueError,
  listProposals,
  queueProposal,
  resolveProposal,
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
  const server = new McpServer({ name: 'ptv-mcp', version: '0.1.0' });

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
      },
    }),
    async (args, extra) => {
      try {
        return textResult(
          await queueProposal(
            resolveRole,
            registry,
            auditService,
            proposalService,
            toolContext(extra),
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
    'ptv_propose_new_service',
    withOAuthSecurity({
      description:
        'Queue a proposal to create a new PTV service. Needs the Contributor role (Ehdottaja). Nothing is written until an Approver+ resolves it with approve_and_apply (which also needs Publisher-level write access); PTV then assigns the id, recorded on the proposal. `service` is a Service without id: organizationId, serviceType (default Service), publishingStatus (Draft by default, or Published), names, summaries, descriptions (each keyed by language, e.g. {"fi": "..."}), languages, serviceClasses (at least one subclass, e.g. P25.6), ontologyTerms (KOKO URIs), targetGroups, optionally lifeEvents, industrialClasses (needs target groups KR2 + KR2.x), generalDescriptionId, serviceChannelIds. Classification entries need a `uri` (or `code` for industrial classes). The service area is copied from the organisation. Returns the validation result right away.',
      inputSchema: {
        service: z
          .record(z.string(), z.unknown())
          .describe('The new service: a Service without id (see the tool description).'),
        correlationId: z.string().optional(),
      },
    }),
    async (args, extra) => {
      try {
        return textResult(
          await queueNewServiceProposal(
            resolveRole,
            auditService,
            proposalService,
            validator,
            toolContext(extra),
            args.service as Partial<Service>,
            args.correlationId,
          ),
        );
      } catch (err) {
        return errorResult(describeError(err), deps.publicUrl);
      }
    },
  );

  server.registerTool(
    'ptv_propose_channel_changes',
    withOAuthSecurity({
      description:
        'Diff a proposed change against a service channel (any type: EChannel, Phone, PrintableForm, ServiceLocation, WebPage) and queue it as a proposal. Needs the Contributor role (Ehdottaja). Never writes anything; an Approver+ resolves it with ptv_resolve_proposal (approve_and_apply needs Publisher-level write access). Writable fields: names, descriptions (the Description texts; summaries are kept), languages, publishingStatus (Published, Draft for a never-published channel, or Archived). A localized field present in `changes` replaces all its languages.',
      inputSchema: {
        channelId: z.string(),
        changes: z
          .record(z.string(), z.unknown())
          .describe(
            'Partial<ServiceChannel>: only names, descriptions, languages, publishingStatus.',
          ),
        correlationId: z.string().optional(),
      },
    }),
    async (args, extra) => {
      try {
        return textResult(
          await queueChannelProposal(
            resolveRole,
            registry,
            auditService,
            proposalService,
            toolContext(extra),
            args.channelId,
            args.changes as Partial<ServiceChannel>,
            args.correlationId,
          ),
        );
      } catch (err) {
        return errorResult(describeError(err), deps.publicUrl);
      }
    },
  );

  server.registerTool(
    'ptv_list_proposals',
    withOAuthSecurity({
      description:
        'List queued proposals for a tenant (kind: service_update, service_create or channel_update). Requires the Contributor role (Ehdottaja) or above.',
      inputSchema: {
        status: z.enum(['pending', 'approved', 'rejected', 'applied', 'failed']).optional(),
      },
    }),
    async (args, extra) => {
      try {
        return textResult(
          await listProposals(resolveRole, proposalService, toolContext(extra), args.status),
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
    'ptv_resolve_proposal',
    withOAuthSecurity({
      description:
        'Resolve one proposal as approve_and_export, approve_and_apply, or reject. Requires the Approver role (Hyväksyjä) or above; apply also requires the Publisher role (Julkaisija).',
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
        "Render an approved proposal into a per-language preview for manual copy into PTV's own admin UI, and record it as ReadyForManualPublish.",
      inputSchema: {
        serviceId: z.string(),
        changes: changesSchema,
        correlationId: z.string().optional(),
      },
    }),
    async (args, extra) => {
      try {
        return textResult(
          await exportForManualPublish(
            resolveRole,
            registry,
            auditService,
            toolContext(extra),
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
        'Validate and write a proposed change directly to PTV via a write-capable adapter for this tenant/environment. Requires Publisher role and an active PTV connection.',
      inputSchema: {
        serviceId: z.string(),
        changes: changesSchema,
        correlationId: z.string().optional(),
      },
    }),
    async (args, extra) => {
      try {
        return textResult(
          await applyChanges(
            resolveRole,
            registry,
            auditService,
            validator,
            toolContext(extra),
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
