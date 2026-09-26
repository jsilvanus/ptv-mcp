import { ResourceTemplate, type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Variables } from '@modelcontextprotocol/sdk/shared/uriTemplate.js';
import type { PtvAdapterRegistry } from '../ptv/registry.js';
import * as searchTools from './searchTools.js';
import type { ToolContext } from './toolContext.js';
import { resourceToolContext } from './tools/shared.js';

/**
 * Registers a `ptv://{tenantId}/{environment}/...` resource whose
 * contents are `read`'s value as JSON, at the URI the template expands to.
 * Unlike tools, reads throw on failure: `ReadResourceResult` has no
 * `isError`, so errors become JSON-RPC errors (see CLAUDE.md).
 */
function jsonResource(
  server: McpServer,
  name: string,
  uriTemplate: string,
  title: string,
  description: string,
  read: (ctx: ToolContext, variables: Variables) => Promise<unknown>,
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
            uri: expand(uriTemplate, variables),
            mimeType: 'application/json',
            text: JSON.stringify(value, null, 2),
          },
        ],
      };
    },
  );
}

/** The canonical URI: the template with each `{name}` replaced by its (unencoded) value. */
function expand(uriTemplate: string, variables: Variables): string {
  return uriTemplate.replace(
    /\{(\w+)\}/g,
    (_match, name: string) => `${variables[name] as string}`,
  );
}

/** Read-only resources for one PTV item or code list, addressed by tenant and environment. */
export function registerResources(server: McpServer, registry: PtvAdapterRegistry): void {
  jsonResource(
    server,
    'ptv_resource_service',
    'ptv://{tenantId}/{environment}/services/{serviceId}',
    'PTV service',
    'Get one PTV service by id.',
    (ctx, variables) => searchTools.getService(registry, ctx, variables.serviceId as string),
  );

  jsonResource(
    server,
    'ptv_resource_channel',
    'ptv://{tenantId}/{environment}/channels/{channelId}',
    'PTV service channel',
    'Get one PTV service channel by id.',
    (ctx, variables) => searchTools.getChannel(registry, ctx, variables.channelId as string),
  );

  jsonResource(
    server,
    'ptv_resource_organisation',
    'ptv://{tenantId}/{environment}/organisations/{organisationId}',
    'PTV organisation',
    'Get one PTV organisation by id.',
    (ctx, variables) =>
      searchTools.getOrganisation(registry, ctx, variables.organisationId as string),
  );

  jsonResource(
    server,
    'ptv_resource_organisation_hierarchy',
    'ptv://{tenantId}/{environment}/organisations/{organisationId}/hierarchy',
    'PTV organisation hierarchy',
    'Get one PTV organisation hierarchy by id.',
    (ctx, variables) =>
      searchTools.getOrganisationHierarchy(registry, ctx, variables.organisationId as string),
  );

  jsonResource(
    server,
    'ptv_resource_code_list',
    'ptv://{tenantId}/{environment}/code-lists/{codeListName}',
    'PTV code list',
    'List entries in one PTV code list by name.',
    (ctx, variables) => searchTools.listCodes(registry, ctx, variables.codeListName as string),
  );
}
