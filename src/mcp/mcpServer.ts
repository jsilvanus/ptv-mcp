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
import type { SearchParams, Service } from '../ptv/domain.js';
import type { Database } from '../db/client.js';
import { resolveMembershipRole } from '../auth/rbac.js';
import { NotAuthorizedError } from './authorization.js';
import type { ProposalService } from '../proposals/proposalService.js';
import * as searchTools from './searchTools.js';
import { ServiceNotFoundError } from './proposeChanges.js';
import { validateChanges } from './validateChanges.js';
import { applyChanges, exportForManualPublish, ValidationFailedError } from './applyOrExport.js';
import type { ToolContext } from './toolContext.js';
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
}

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

function textResult(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

function errorResult(message: string): CallToolResult {
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

const environmentSchema = z.enum(['test', 'production']);
const searchParamsSchema = {
  tenantId: z.string(),
  environment: environmentSchema,
  page: z.number().int().min(1).optional(),
  pageSize: z.number().int().min(1).max(1000).optional(),
};
const getByIdSchema = { tenantId: z.string(), environment: environmentSchema, id: z.string() };

const oauthSecuritySchemes = [{ type: 'oauth2' as const, scopes: ['mcp'] }];

function withOAuthSecurity<T extends object>(config: T): T & { securitySchemes: typeof oauthSecuritySchemes } {
  return { ...config, securitySchemes: oauthSecuritySchemes };
}

function toolContext(
  args: { tenantId: string; environment: 'test' | 'production' },
  extra: Extra,
): ToolContext {
  return {
    tenantId: args.tenantId,
    environment: args.environment,
    actingUserId: actingUserId(extra),
  };
}

/** `exactOptionalPropertyTypes` means an explicit `page: undefined` doesn't satisfy `page?: number` — omit the key entirely instead. */
function searchParams(args: {
  page?: number | undefined;
  pageSize?: number | undefined;
}): SearchParams {
  return {
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
    'ptv_search_services', withOAuthSecurity({
      description: 'Search PTV services for a tenant/environment.',
      inputSchema: searchParamsSchema,
    )},
    async (args, extra) => {
      try {
        return textResult(
          await searchTools.searchServices(registry, toolContext(args, extra), searchParams(args)),
        );
      } catch (err) {
        return errorResult(describeError(err));
      }
    },
  );

  server.registerTool(
    'ptv_get_service', withOAuthSecurity({ description: 'Fetch one PTV service by id.', inputSchema: getByIdSchema )},
    async (args, extra) => {
      try {
        return textResult(
          await searchTools.getService(registry, toolContext(args, extra), args.id),
        );
      } catch (err) {
        return errorResult(describeError(err));
      }
    },
  );

  server.registerTool(
    'ptv_search_channels', withOAuthSecurity({
      description: 'Search PTV service channels for a tenant/environment.',
      inputSchema: searchParamsSchema,
    )},
    async (args, extra) => {
      try {
        return textResult(
          await searchTools.searchChannels(registry, toolContext(args, extra), searchParams(args)),
        );
      } catch (err) {
        return errorResult(describeError(err));
      }
    },
  );

  server.registerTool(
    'ptv_get_channel', withOAuthSecurity({ description: 'Fetch one PTV service channel by id.', inputSchema: getByIdSchema )},
    async (args, extra) => {
      try {
        return textResult(
          await searchTools.getChannel(registry, toolContext(args, extra), args.id),
        );
      } catch (err) {
        return errorResult(describeError(err));
      }
    },
  );

  server.registerTool(
    'ptv_get_organisation', withOAuthSecurity({ description: 'Fetch one PTV organisation by id.', inputSchema: getByIdSchema )},
    async (args, extra) => {
      try {
        return textResult(
          await searchTools.getOrganisation(registry, toolContext(args, extra), args.id),
        );
      } catch (err) {
        return errorResult(describeError(err));
      }
    },
  );

  server.registerTool(
    'ptv_get_organisation_hierarchy', withOAuthSecurity({
      description: 'Fetch a PTV organisation and every ancestor up to its root.',
      inputSchema: getByIdSchema,
    )},
    async (args, extra) => {
      try {
        return textResult(
          await searchTools.getOrganisationHierarchy(registry, toolContext(args, extra), args.id),
        );
      } catch (err) {
        return errorResult(describeError(err));
      }
    },
  );

  server.registerTool(
    'ptv_search_service_collections', withOAuthSecurity({
      description: 'Search PTV service collections for a tenant/environment.',
      inputSchema: searchParamsSchema,
    )},
    async (args, extra) => {
      try {
        return textResult(
          await searchTools.searchServiceCollections(
            registry,
            toolContext(args, extra),
            searchParams(args),
          ),
        );
      } catch (err) {
        return errorResult(describeError(err));
      }
    },
  );

  server.registerTool(
    'ptv_search_general_descriptions', withOAuthSecurity({
      description: 'Search PTV general descriptions for a tenant/environment.',
      inputSchema: searchParamsSchema,
    )},
    async (args, extra) => {
      try {
        return textResult(
          await searchTools.searchGeneralDescriptions(
            registry,
            toolContext(args, extra),
            searchParams(args),
          ),
        );
      } catch (err) {
        return errorResult(describeError(err));
      }
    },
  );

  server.registerTool(
    'ptv_search_connections', withOAuthSecurity({
      description: 'List service<->channel connections for a service or channel id.',
      inputSchema: getByIdSchema,
    )},
    async (args, extra) => {
      try {
        return textResult(
          await searchTools.searchConnections(registry, toolContext(args, extra), args.id),
        );
      } catch (err) {
        return errorResult(describeError(err));
      }
    },
  );

  server.registerTool(
    'ptv_list_codes', withOAuthSecurity({
      description: 'List entries in a PTV code list (e.g. "languages", "service-classes").',
      inputSchema: {
        tenantId: z.string(),
        environment: environmentSchema,
        codeListName: z.string(),
      },
    )},
    async (args, extra) => {
      try {
        return textResult(
          await searchTools.listCodes(registry, toolContext(args, extra), args.codeListName),
        );
      } catch (err) {
        return errorResult(describeError(err));
      }
    },
  );

  const changesSchema = z
    .record(z.string(), z.unknown())
    .describe(
      'Partial<Service> — only the fields being changed. A key present but empty clears that field.',
    );

  server.registerTool(
    'ptv_propose_changes', withOAuthSecurity({
      description:
        'Diff a proposed change against the current service. Never writes anything. Returns {serviceId, current, proposed, diff, correlationId} — pass correlationId to ptv_validate_changes/ptv_export_for_manual_publish/ptv_apply_changes to keep them in one audit trail.',
      inputSchema: {
        tenantId: z.string(),
        environment: environmentSchema,
        serviceId: z.string(),
        changes: changesSchema,
        correlationId: z.string().optional(),
      },
    )},
    async (args, extra) => {
      try {
        return textResult(
          await queueProposal(
            resolveRole,
            registry,
            auditService,
            proposalService,
            toolContext(args, extra),
            args.serviceId,
            args.changes as Partial<Service>,
            args.correlationId,
          ),
        );
      } catch (err) {
        return errorResult(describeError(err));
      }
    },
  );

  server.registerTool(
    'ptv_list_proposals', withOAuthSecurity({
      description: 'List queued service proposals for a tenant. Requires Editor+ role.',
      inputSchema: {
        tenantId: z.string(),
        environment: environmentSchema,
        status: z.enum(['pending', 'approved', 'rejected', 'applied', 'failed']).optional(),
      },
    )},
    async (args, extra) => {
      try {
        return textResult(
          await listProposals(resolveRole, proposalService, toolContext(args, extra), args.status),
        );
      } catch (err) {
        return errorResult(describeError(err));
      }
    },
  );

  server.registerTool(
    'ptv_get_proposal', withOAuthSecurity({
      description:
        'Read one proposal and re-diff it against the current service state for review. Requires Editor+ role.',
      inputSchema: {
        tenantId: z.string(),
        environment: environmentSchema,
        proposalId: z.string(),
      },
    )},
    async (args, extra) => {
      try {
        return textResult(
          await getProposal(
            resolveRole,
            registry,
            proposalService,
            auditService,
            toolContext(args, extra),
            args.proposalId,
          ),
        );
      } catch (err) {
        return errorResult(describeError(err));
      }
    },
  );

  server.registerTool(
    'ptv_resolve_proposal', withOAuthSecurity({
      description:
        'Resolve one proposal as approve_and_export, approve_and_apply, or reject. Requires Editor+; apply still requires Publisher-level write access.',
      inputSchema: {
        tenantId: z.string(),
        environment: environmentSchema,
        proposalId: z.string(),
        action: z.enum(['approve_and_export', 'approve_and_apply', 'reject']),
      },
    )},
    async (args, extra) => {
      try {
        return textResult(
          await resolveProposal(
            resolveRole,
            registry,
            proposalService,
            auditService,
            validator,
            toolContext(args, extra),
            args.proposalId,
            args.action,
          ),
        );
      } catch (err) {
        return errorResult(describeError(err));
      }
    },
  );

  server.registerTool(
    'ptv_validate_changes', withOAuthSecurity({
      description:
        'Validate an already-merged proposed service (the "proposed" object ptv_propose_changes returned) against PTV write rules.',
      inputSchema: {
        tenantId: z.string(),
        environment: environmentSchema,
        proposed: z.record(z.string(), z.unknown()),
        correlationId: z.string().optional(),
      },
    )},
    async (args, extra) => {
      try {
        return textResult(
          await validateChanges(
            auditService,
            validator,
            toolContext(args, extra),
            args.proposed as unknown as Service,
            args.correlationId,
          ),
        );
      } catch (err) {
        return errorResult(describeError(err));
      }
    },
  );

  server.registerTool(
    'ptv_export_for_manual_publish', withOAuthSecurity({
      description:
        "Render an approved proposal into a per-language preview for manual copy into PTV's own admin UI, and record it as ReadyForManualPublish.",
      inputSchema: {
        tenantId: z.string(),
        environment: environmentSchema,
        serviceId: z.string(),
        changes: changesSchema,
        correlationId: z.string().optional(),
      },
    )},
    async (args, extra) => {
      try {
        return textResult(
          await exportForManualPublish(
            resolveRole,
            registry,
            auditService,
            toolContext(args, extra),
            args.serviceId,
            args.changes as Partial<Service>,
            args.correlationId,
          ),
        );
      } catch (err) {
        return errorResult(describeError(err));
      }
    },
  );

  server.registerTool(
    'ptv_apply_changes', withOAuthSecurity({
      description:
        'Validate and write a proposed change directly to PTV via a write-capable adapter for this tenant/environment. Requires Publisher role and an active PTV connection.',
      inputSchema: {
        tenantId: z.string(),
        environment: environmentSchema,
        serviceId: z.string(),
        changes: changesSchema,
        correlationId: z.string().optional(),
      },
    )},
    async (args, extra) => {
      try {
        return textResult(
          await applyChanges(
            resolveRole,
            registry,
            auditService,
            validator,
            toolContext(args, extra),
            args.serviceId,
            args.changes as Partial<Service>,
            args.correlationId,
          ),
        );
      } catch (err) {
        return errorResult(describeError(err));
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
      const ctx = toolContext(
        {
          tenantId: variables.tenantId as string,
          environment: variables.environment as 'test' | 'production',
        },
        extra,
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
      const ctx = toolContext(
        {
          tenantId: variables.tenantId as string,
          environment: variables.environment as 'test' | 'production',
        },
        extra,
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
      const ctx = toolContext(
        {
          tenantId: variables.tenantId as string,
          environment: variables.environment as 'test' | 'production',
        },
        extra,
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
      const ctx = toolContext(
        {
          tenantId: variables.tenantId as string,
          environment: variables.environment as 'test' | 'production',
        },
        extra,
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
      const ctx = toolContext(
        {
          tenantId: variables.tenantId as string,
          environment: variables.environment as 'test' | 'production',
        },
        extra,
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
