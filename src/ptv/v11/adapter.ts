import type { PtvOrganizationCacheService } from '../../db/ptvOrganizationCacheService.js';
import type {
  ApplyServiceChangeResult,
  PtvAdapter,
  PtvAdapterCapabilities,
  PtvEnvironment,
  ServiceChangeProposal,
} from '../adapter.js';
import { OntologySearchUnsupportedError } from '../adapter.js';
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
} from '../domain.js';
import { PtvV11Client } from './client.js';
import {
  fetchAllIdNamePairs,
  fetchIdWindow,
  fetchListByIds,
  fetchOrganizationGeneralDescriptionWindow,
  fetchOrganizationServiceChannelWindow,
  fetchOrganizationServiceCollectionWindow,
  fetchOrganizationServiceWindow,
} from './pagination.js';
import { serviceWireToDomain } from './mappers/service.js';
import { serviceChannelWireToDomain } from './mappers/serviceChannel.js';
import { organizationWireToDomain } from './mappers/organization.js';
import { generalDescriptionWireToDomain } from './mappers/generalDescription.js';
import { serviceCollectionWireToDomain } from './mappers/serviceCollection.js';
import { connectionsFromChannel, connectionsFromService } from './mappers/connection.js';
import { referenceCodeWireToDomain, V11_REFERENCE_CODE_LIST_PATHS } from './mappers/codeList.js';
import { serviceChangesToV11Body } from './writeMapping.js';
import {
  sharedV11ApiTokenCache,
  type V11ApiTokenCache,
  type V11ApiUserCredentials,
} from './auth/apiLogin.js';
import type {
  V11GeneralDescriptionWire,
  V11IdNamePair,
  V11OrganizationWire,
  V11ReferenceCodeItem,
  V11ServiceChannelWire,
  V11ServiceCollectionWire,
  V11ServiceWire,
} from './wireModel.js';

export interface PtvV11AdapterOptions {
  environment: PtvEnvironment;
  /** The acting user's PTV access token, already resolved by PtvAdapterRegistry. Omit for unauthenticated public reads. */
  accessToken?: string;
  /**
   * Whether this instance may write. PtvAdapterRegistry decides this
   * per-call from PtvAdapterConfig — the adapter itself never guesses.
   * Defaults to false: an adapter constructed without an explicit
   * decision should never silently be able to write.
   */
  canWrite?: boolean;
  /**
   * Organisation API user (tenant-scoped credential) for IN-API writes;
   * exchanged for a bearer token via auth/apiLogin.ts.
   */
  apiUser?: V11ApiUserCredentials;
  /** Defaults to the process-wide cache; tests pass their own. */
  apiTokenCache?: V11ApiTokenCache;
  /** Tenant-scoped persistent organization catalogue cache. Omit for public reads. */
  organizationCache?: PtvOrganizationCacheService;
  tenantId?: string;
  fetchImpl?: typeof fetch;
}

export class PtvV11Adapter implements PtvAdapter {
  private readonly client: PtvV11Client;
  private readonly capabilities: PtvAdapterCapabilities;
  private readonly organizationCache?: PtvOrganizationCacheService | undefined;
  private readonly tenantId?: string | undefined;

  constructor(options: PtvV11AdapterOptions) {
    this.organizationCache = options.organizationCache;
    this.tenantId = options.tenantId;
    const { apiUser, environment } = options;
    const tokenCache = options.apiTokenCache ?? sharedV11ApiTokenCache;
    this.client = new PtvV11Client({
      environment,
      ...(options.accessToken ? { accessToken: options.accessToken } : {}),
      ...(apiUser
        ? {
            writeTokenProvider: {
              getToken: () => tokenCache.getToken(environment, apiUser),
              invalidate: () => tokenCache.invalidate(environment, apiUser),
            },
          }
        : {}),
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    });
    this.capabilities = {
      apiVersion: 'v11',
      environment: options.environment,
      credentialScope: apiUser ? 'tenant' : 'user',
      supportsRead: true,
      supportsWrite: options.canWrite ?? false,
      // v11's Service/active and ServiceChannel/active endpoints expose
      // draft/modified content, but only to an authenticated caller —
      // see docs/ptv-v11-notes.md. Not yet wired up (tracked separately);
      // reads in this adapter are currently published-content only.
      supportsDraftRead: false,
    };
  }

  getCapabilities(): PtvAdapterCapabilities {
    return this.capabilities;
  }

  async searchServices(params: SearchParams): Promise<PaginatedResult<Service>> {
    const page = params.page ?? 1;
    const pageSize = params.pageSize ?? 100;
    const start = (page - 1) * pageSize;

    if (params.organizationId) {
      const { items: organizationWires } = await fetchOrganizationServiceWindow(
        this.client,
        params.organizationId,
      );
      const services = organizationWires
        .map(serviceWireToDomain)
        .filter((service) => service.organizationId === params.organizationId);

      return {
        items: services.slice(start, start + pageSize),
        page,
        pageSize,
        totalCount: services.length,
      };
    }

    const { ids, totalCountEstimate } = await fetchIdWindow(
      this.client,
      '/api/v11/Service',
      start,
      pageSize,
    );
    const wires =
      ids.length > 0
        ? await this.client.get<V11ServiceWire[]>('/api/v11/Service/list', {
            guids: ids.join(','),
          })
        : [];

    return {
      items: wires.map(serviceWireToDomain),
      page,
      pageSize,
      totalCount: totalCountEstimate,
    };
  }

  async getService(id: PtvContentId): Promise<Service | null> {
    const wire = await this.getOrNull<V11ServiceWire>(`/api/v11/Service/${id}`);
    return wire ? serviceWireToDomain(wire) : null;
  }

  async searchChannels(params: SearchParams): Promise<PaginatedResult<ServiceChannel>> {
    const page = params.page ?? 1;
    const pageSize = params.pageSize ?? 100;
    const start = (page - 1) * pageSize;

    if (params.organizationId) {
      const { items: organizationWires } = await fetchOrganizationServiceChannelWindow(
        this.client,
        params.organizationId,
      );
      const channels = organizationWires
        .map(serviceChannelWireToDomain)
        .filter((channel) => channel.organizationId === params.organizationId);

      return {
        items: channels.slice(start, start + pageSize),
        page,
        pageSize,
        totalCount: channels.length,
      };
    }

    const { ids, totalCountEstimate } = await fetchIdWindow(
      this.client,
      '/api/v11/ServiceChannel',
      start,
      pageSize,
    );
    const wires =
      ids.length > 0
        ? await this.client.get<V11ServiceChannelWire[]>('/api/v11/ServiceChannel/list', {
            guids: ids.join(','),
          })
        : [];

    return {
      items: wires.map(serviceChannelWireToDomain),
      page,
      pageSize,
      totalCount: totalCountEstimate,
    };
  }

  async getChannel(id: PtvContentId): Promise<ServiceChannel | null> {
    const wire = await this.getOrNull<V11ServiceChannelWire>(`/api/v11/ServiceChannel/${id}`);
    return wire ? serviceChannelWireToDomain(wire) : null;
  }

  async searchOrganisations(params: SearchParams): Promise<PaginatedResult<Organization>> {
    const page = params.page ?? 1;
    const pageSize = params.pageSize ?? 100;
    const start = (page - 1) * pageSize;
    const query = params.query?.trim().toLocaleLowerCase('fi-FI');

    if (this.organizationCache && this.tenantId) {
      const cacheKey = {
        tenantId: this.tenantId,
        environment: this.capabilities.environment,
        apiVersion: 'v11',
      } as const;

      if (!(await this.organizationCache.hasFreshCatalogue(cacheKey))) {
        await this.refreshOrganizationCache(cacheKey);
      }

      const wires = await this.organizationCache.search(cacheKey, query);
      const items = wires.map(organizationWireToDomain);
      return {
        items: items.slice(start, start + pageSize),
        page,
        pageSize,
        totalCount: items.length,
      };
    }

    if (query) {
      // Public v11 reads have no tenant context, so they cannot use the
      // tenant-scoped persistent cache. Keep the catalogue scan as fallback.
      const catalog = await fetchAllIdNamePairs(this.client, '/api/v11/Organization');
      const matchingIds = catalog
        .filter(
          (item) => item.name !== undefined && item.name.toLocaleLowerCase('fi-FI').includes(query),
        )
        .map((item) => item.id);
      const wires = await fetchListByIds<V11OrganizationWire>(
        this.client,
        '/api/v11/Organization/list',
        matchingIds,
      );
      const items = wires.map(organizationWireToDomain);
      return {
        items: items.slice(start, start + pageSize),
        page,
        pageSize,
        totalCount: items.length,
      };
    }

    const { ids, totalCountEstimate } = await fetchIdWindow(
      this.client,
      '/api/v11/Organization',
      start,
      pageSize,
    );
    const wires = await fetchListByIds<V11OrganizationWire>(
      this.client,
      '/api/v11/Organization/list',
      ids,
    );
    return {
      items: wires.map(organizationWireToDomain),
      page,
      pageSize,
      totalCount: totalCountEstimate,
    };
  }

  private async refreshOrganizationCache(key: {
    tenantId: string;
    environment: PtvEnvironment;
    apiVersion: string;
  }): Promise<void> {
    const catalog = await fetchAllIdNamePairs(this.client, '/api/v11/Organization');
    const wires = await fetchListByIds<V11OrganizationWire>(
      this.client,
      '/api/v11/Organization/list',
      catalog.map((item) => item.id),
    );
    const byId = new Map(wires.map((wire) => [wire.id, wire]));
    const ordered = catalog
      .map((item) => byId.get(item.id))
      .filter((wire): wire is V11OrganizationWire => wire !== undefined);

    await this.organizationCache!.replaceCatalogue(key, ordered);
  }

  async getOrganisation(id: PtvContentId): Promise<Organization | null> {
    const wire = await this.getOrNull<V11OrganizationWire>(`/api/v11/Organization/${id}`);
    return wire ? organizationWireToDomain(wire) : null;
  }

  async getOrganisationHierarchy(id: PtvContentId): Promise<Organization[]> {
    const root = await this.getOrganisation(id);
    if (!root) return [];

    const hierarchy: Organization[] = [root];
    let current = root;
    while (current.parentOrganizationId) {
      const parent = await this.getOrganisation(current.parentOrganizationId);
      if (!parent) break;
      hierarchy.push(parent);
      current = parent;
    }
    return hierarchy;
  }

  async searchServiceCollections(
    params: SearchParams,
  ): Promise<PaginatedResult<ServiceCollection>> {
    const page = params.page ?? 1;
    const pageSize = params.pageSize ?? 100;
    const start = (page - 1) * pageSize;

    if (params.organizationId) {
      const { items: organizationWires } = await fetchOrganizationServiceCollectionWindow(
        this.client,
        params.organizationId,
      );
      const items = organizationWires.map(serviceCollectionWireToDomain);
      return {
        items: items.slice(start, start + pageSize),
        page,
        pageSize,
        totalCount: items.length,
      };
    }

    // v11 has no bulk /ServiceCollection/list?guids= endpoint (unlike
    // Service/ServiceChannel/Organization/GeneralDescription), so each id
    // in the window is fetched individually.
    const { ids, totalCountEstimate } = await fetchIdWindow(
      this.client,
      '/api/v11/ServiceCollection',
      start,
      pageSize,
    );
    const wires = await Promise.all(
      ids.map((id) =>
        this.client.get<V11ServiceCollectionWire>(`/api/v11/ServiceCollection/${id}`),
      ),
    );

    return {
      items: wires.map(serviceCollectionWireToDomain),
      page,
      pageSize,
      totalCount: totalCountEstimate,
    };
  }

  async searchGeneralDescriptions(
    params: SearchParams,
  ): Promise<PaginatedResult<GeneralDescription>> {
    const page = params.page ?? 1;
    const pageSize = params.pageSize ?? 100;
    const start = (page - 1) * pageSize;

    if (params.organizationId) {
      const { items: organizationWires } = await fetchOrganizationGeneralDescriptionWindow(
        this.client,
        params.organizationId,
      );
      const items = organizationWires.map(generalDescriptionWireToDomain);
      return {
        items: items.slice(start, start + pageSize),
        page,
        pageSize,
        totalCount: items.length,
      };
    }

    const { ids, totalCountEstimate } = await fetchIdWindow(
      this.client,
      '/api/v11/GeneralDescription',
      start,
      pageSize,
    );
    const wires =
      ids.length > 0
        ? await this.client.get<V11GeneralDescriptionWire[]>('/api/v11/GeneralDescription/list', {
            guids: ids.join(','),
          })
        : [];

    return {
      items: wires.map(generalDescriptionWireToDomain),
      page,
      pageSize,
      totalCount: totalCountEstimate,
    };
  }

  async getConnectionsFor(entityId: PtvContentId): Promise<Connection[]> {
    const serviceWire = await this.getOrNull<V11ServiceWire>(`/api/v11/Service/${entityId}`);
    if (serviceWire) return connectionsFromService(serviceWire);

    const channelWire = await this.getOrNull<V11ServiceChannelWire>(
      `/api/v11/ServiceChannel/${entityId}`,
    );
    if (channelWire) return connectionsFromChannel(channelWire);

    return [];
  }

  async listCodes(codeListName: string): Promise<CodeListEntry[]> {
    const path = V11_REFERENCE_CODE_LIST_PATHS[codeListName];
    if (!path) {
      throw new Error(
        `v11 has no standalone code list named "${codeListName}" — classification codes ` +
          `(service classes, ontology terms, target groups, life events, industrial classes) ` +
          `are only available embedded on entities in v11, not as a standalone list. ` +
          `Supported names: ${Object.keys(V11_REFERENCE_CODE_LIST_PATHS).join(', ')}`,
      );
    }
    const items = await this.client.get<V11ReferenceCodeItem[]>(path);
    return items.map(referenceCodeWireToDomain);
  }

  async searchOntologyTerms(_params: SearchParams): Promise<PaginatedResult<CodeListEntry>> {
    throw new OntologySearchUnsupportedError('v11');
  }

  async applyServiceChange(proposal: ServiceChangeProposal): Promise<ApplyServiceChangeResult> {
    if (!this.capabilities.supportsWrite) {
      throw new Error('PtvV11Adapter: write is not enabled for this instance');
    }
    const body = serviceChangesToV11Body(proposal.changes);
    const updated = await this.client.put<V11ServiceWire>(
      `/api/v11/Service/${proposal.serviceId}`,
      body,
    );
    return {
      serviceId: updated.id,
      publishingStatus: serviceWireToDomain(updated).publishingStatus,
      appliedAt: new Date().toISOString(),
    };
  }

  private async getOrNull<T>(path: string): Promise<T | null> {
    try {
      return await this.client.get<T>(path);
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }
}

function isNotFound(err: unknown): boolean {
  return err instanceof Error && 'status' in err && (err as { status: unknown }).status === 404;
}

// Re-exported for callers that need to enumerate id/name pairs directly
// (e.g. future UI autocomplete) without going through a full domain fetch.
export type { V11IdNamePair };
