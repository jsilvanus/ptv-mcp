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
 * Phase 4 Stream A — search tools. Every one of these is a thin pass-through
 * to a registry-resolved `PtvAdapter`'s own read methods (the Phase 1
 * `PtvAdapter` interface already has a 1:1 method for each tool the phase
 * plan lists), because the actual work — picking the right adapter,
 * checking role authorization, resolving credentials — belongs to
 * `PtvAdapterRegistry`, not duplicated here. Reads never require a
 * write-capable role: `operation: 'read'` only needs Reader.
 */
async function resolveReadAdapter(registry: PtvAdapterRegistry, ctx: ToolContext) {
  return registry.resolve({
    tenantId: ctx.tenantId,
    environment: ctx.environment,
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

/** "ptv_search_connections" in the phase plan — `PtvAdapter` exposes this as `getConnectionsFor` (Phase 1 naming). */
export async function searchConnections(
  registry: PtvAdapterRegistry,
  ctx: ToolContext,
  entityId: PtvContentId,
): Promise<Connection[]> {
  const adapter = await resolveReadAdapter(registry, ctx);
  return adapter.getConnectionsFor(entityId);
}

export async function listCodes(
  registry: PtvAdapterRegistry,
  ctx: ToolContext,
  codeListName: string,
): Promise<CodeListEntry[]> {
  const adapter = await resolveReadAdapter(registry, ctx);
  return adapter.listCodes(codeListName);
}
