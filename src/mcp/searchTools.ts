import type { PtvAdapterRegistry } from '../ptv/registry.js';
import type {
  CodeListEntry,
  Connection,
  GeneralDescription,
  Organization,
  PaginatedResult,
  PtvContentId,
  SearchParams,
  Service,
  ServiceChannel,
  ServiceCollection,
} from '../ptv/domain.js';
import type { ToolContext } from './toolContext.js';

/**
 * Search/read tools are thin pass-throughs to a registry-resolved
 * PtvAdapter. The tenant comes from the OAuth-selected MCP connection;
 * search criteria are carried separately in SearchParams and never inferred
 * from the tenant or its organisation membership.
 */
async function resolveReadAdapter(registry: PtvAdapterRegistry, ctx: ToolContext) {
  return registry.resolve({
    tenantId: ctx.tenantId,
    environment: ctx.environment,
    apiVersion: ctx.readApiVersion ?? ctx.apiVersion ?? 'v11',
    operation: 'read',
    actingUserId: ctx.actingUserId,
  });
}

export async function searchServices(
  registry: PtvAdapterRegistry,
  ctx: ToolContext,
  params: SearchParams,
): Promise<PaginatedResult<Service>> {
  const adapter = await resolveReadAdapter(registry, ctx);
  return adapter.searchServices(params);
}

export async function getService(
  registry: PtvAdapterRegistry,
  ctx: ToolContext,
  id: PtvContentId,
): Promise<Service | null> {
  const adapter = await resolveReadAdapter(registry, ctx);
  return adapter.getService(id);
}

export async function searchChannels(
  registry: PtvAdapterRegistry,
  ctx: ToolContext,
  params: SearchParams,
): Promise<PaginatedResult<ServiceChannel>> {
  const adapter = await resolveReadAdapter(registry, ctx);
  return adapter.searchChannels(params);
}

export async function getChannel(
  registry: PtvAdapterRegistry,
  ctx: ToolContext,
  id: PtvContentId,
): Promise<ServiceChannel | null> {
  const adapter = await resolveReadAdapter(registry, ctx);
  return adapter.getChannel(id);
}

export async function searchOrganisations(
  registry: PtvAdapterRegistry,
  ctx: ToolContext,
  params: SearchParams,
): Promise<PaginatedResult<Organization>> {
  const adapter = await resolveReadAdapter(registry, ctx);
  return adapter.searchOrganisations(params);
}

export async function findOrganisationAndChildren(
  registry: PtvAdapterRegistry,
  ctx: ToolContext,
  query: string,
): Promise<{
  organisation: Organization;
  services: PaginatedResult<Service>;
  channels: PaginatedResult<ServiceChannel>;
}> {
  const adapter = await resolveReadAdapter(registry, ctx);
  const organisations = await adapter.searchOrganisations({
    query,
    page: 1,
    pageSize: 10,
  });
  const organisation = organisations.items[0];
  if (!organisation) {
    throw new Error(`No PTV organisation found for query "${query}"`);
  }
  return {
    organisation,
    services: await adapter.searchServices({
      organizationId: organisation.id,
      page: 1,
      pageSize: 1000,
    }),
    channels: await adapter.searchChannels({
      organizationId: organisation.id,
      page: 1,
      pageSize: 1000,
    }),
  };
}

export async function getOrganisation(
  registry: PtvAdapterRegistry,
  ctx: ToolContext,
  id: PtvContentId,
): Promise<Organization | null> {
  const adapter = await resolveReadAdapter(registry, ctx);
  return adapter.getOrganisation(id);
}

export async function getOrganisationHierarchy(
  registry: PtvAdapterRegistry,
  ctx: ToolContext,
  id: PtvContentId,
): Promise<Organization[]> {
  const adapter = await resolveReadAdapter(registry, ctx);
  return adapter.getOrganisationHierarchy(id);
}

export async function searchServiceCollections(
  registry: PtvAdapterRegistry,
  ctx: ToolContext,
  params: SearchParams,
): Promise<PaginatedResult<ServiceCollection>> {
  const adapter = await resolveReadAdapter(registry, ctx);
  return adapter.searchServiceCollections(params);
}

export async function searchGeneralDescriptions(
  registry: PtvAdapterRegistry,
  ctx: ToolContext,
  params: SearchParams,
): Promise<PaginatedResult<GeneralDescription>> {
  const adapter = await resolveReadAdapter(registry, ctx);
  return adapter.searchGeneralDescriptions(params);
}

/** "ptv_search_connections" in the phase plan — PtvAdapter exposes this as getConnectionsFor. */
export async function searchConnections(
  registry: PtvAdapterRegistry,
  ctx: ToolContext,
  entityId: PtvContentId,
): Promise<Connection[]> {
  const adapter = await resolveReadAdapter(registry, ctx);
  return adapter.getConnectionsFor(entityId);
}

export async function searchOntologyTerms(
  registry: PtvAdapterRegistry,
  ctx: ToolContext,
  params: SearchParams,
): Promise<PaginatedResult<CodeListEntry>> {
  const adapter = await resolveReadAdapter(registry, ctx);
  return adapter.searchOntologyTerms(params);
}

export async function listCodes(
  registry: PtvAdapterRegistry,
  ctx: ToolContext,
  codeListName: string,
): Promise<CodeListEntry[]> {
  const adapter = await resolveReadAdapter(registry, ctx);
  return adapter.listCodes(codeListName);
}
