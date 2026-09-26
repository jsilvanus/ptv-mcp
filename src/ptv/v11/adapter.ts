import type { PtvOrganizationCacheService } from '../../db/ptvOrganizationCacheService.js';
import type {
  ApplyChannelChangeResult,
  ApplyConnectionChangeResult,
  ApplyOrganizationChangeResult,
  NewOrganization,
  OrganizationChangeProposal,
  ConnectionChangeProposal,
  ApplyServiceChangeResult,
  ChannelChangeProposal,
  ConnectionEndpoint,
  NewChannel,
  NewService,
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
import { walkOrganisationHierarchy } from '../hierarchy.js';
import { isNotFound } from '../http.js';
import { paginate } from '../paging.js';
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
import { toPublishingStatus, V11ModifiedVersionLockedError } from './mappers/common.js';
import { serviceChannelWireToDomain } from './mappers/serviceChannel.js';
import { organizationWireToDomain } from './mappers/organization.js';
import { generalDescriptionWireToDomain } from './mappers/generalDescription.js';
import { serviceCollectionWireToDomain } from './mappers/serviceCollection.js';
import { connectionsFromChannel, connectionsFromService } from './mappers/connection.js';
import { referenceCodeWireToDomain, V11_REFERENCE_CODE_LIST_PATHS } from './mappers/codeList.js';
import {
  newServiceToV11Body,
  organizationAreaToV11,
  serviceChangesToV11Body,
} from './writeMapping.js';
import {
  channelChangesToV11Body,
  newChannelToV11Body,
  V11_CHANNEL_WRITE_TYPES,
} from './channelWriteMapping.js';
import { planConnectionDetails, planServiceConnections } from './connectionWrite.js';
import { newOrganizationToV11Body, organizationChangesToV11Body } from './organizationWrite.js';
import {
  sharedV11ApiTokenCache,
  type V11ApiTokenCache,
  type V11ApiUserCredentials,
} from './auth/apiLogin.js';
import type {
  V11GeneralDescriptionWire,
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
  /**
   * Organisation-scoped lists, keyed by list + organisation id. Each MCP
   * page of an organisation search needs the organisation's whole list;
   * adapters are created per request, so this reuses one download across
   * the pages read within a request and never goes stale beyond it.
   */
  private readonly organizationLists = new Map<string, Promise<unknown[]>>();

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
      // Service/active and ServiceChannel/active return the latest version
      // (draft or modified included), but only with the API-user token.
      supportsDraftRead: apiUser !== undefined,
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
      const organizationId = params.organizationId;
      const organizationWires = await this.organizationList('services', organizationId, () =>
        fetchOrganizationServiceWindow(this.client, organizationId),
      );
      const services = organizationWires
        .map(serviceWireToDomain)
        .filter((service) => service.organizationId === organizationId);
      return paginate(services, params);
    }

    const { ids, totalCountEstimate } = await fetchIdWindow(
      this.client,
      '/api/v11/Service',
      start,
      pageSize,
    );
    const wires = await fetchListByIds<V11ServiceWire>(this.client, '/api/v11/Service/list', ids);

    return {
      items: wires.map(serviceWireToDomain),
      page,
      pageSize,
      totalCount: totalCountEstimate,
    };
  }

  async getService(id: PtvContentId): Promise<Service | null> {
    const wire = await this.getLatestOrNull<V11ServiceWire>('Service', id);
    return wire ? serviceWireToDomain(wire) : null;
  }

  async searchChannels(params: SearchParams): Promise<PaginatedResult<ServiceChannel>> {
    const page = params.page ?? 1;
    const pageSize = params.pageSize ?? 100;
    const start = (page - 1) * pageSize;

    if (params.organizationId) {
      const organizationId = params.organizationId;
      const organizationWires = await this.organizationList('channels', organizationId, () =>
        fetchOrganizationServiceChannelWindow(this.client, organizationId),
      );
      const channels = organizationWires
        .map(serviceChannelWireToDomain)
        .filter((channel) => channel.organizationId === organizationId);
      return paginate(channels, params);
    }

    const { ids, totalCountEstimate } = await fetchIdWindow(
      this.client,
      '/api/v11/ServiceChannel',
      start,
      pageSize,
    );
    const wires = await fetchListByIds<V11ServiceChannelWire>(
      this.client,
      '/api/v11/ServiceChannel/list',
      ids,
    );

    return {
      items: wires.map(serviceChannelWireToDomain),
      page,
      pageSize,
      totalCount: totalCountEstimate,
    };
  }

  async getChannel(id: PtvContentId): Promise<ServiceChannel | null> {
    const wire = await this.getLatestOrNull<V11ServiceChannelWire>('ServiceChannel', id);
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

      return paginate(await this.organizationCache.search(cacheKey, query), params);
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
      return paginate(wires.map(organizationWireToDomain), params);
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
    // fetchListByIds keeps the catalogue's order.
    const wires = await fetchListByIds<V11OrganizationWire>(
      this.client,
      '/api/v11/Organization/list',
      catalog.map((item) => item.id),
    );
    await this.organizationCache!.replaceCatalogue(key, wires.map(organizationWireToDomain));
  }

  async getOrganisation(id: PtvContentId): Promise<Organization | null> {
    const wire = await this.getOrNull<V11OrganizationWire>(`/api/v11/Organization/${id}`);
    return wire ? organizationWireToDomain(wire) : null;
  }

  async getOrganisationHierarchy(id: PtvContentId): Promise<Organization[]> {
    return walkOrganisationHierarchy((orgId) => this.getOrganisation(orgId), id);
  }

  async searchServiceCollections(
    params: SearchParams,
  ): Promise<PaginatedResult<ServiceCollection>> {
    const page = params.page ?? 1;
    const pageSize = params.pageSize ?? 100;
    const start = (page - 1) * pageSize;

    if (params.organizationId) {
      const organizationId = params.organizationId;
      const organizationWires = await this.organizationList('collections', organizationId, () =>
        fetchOrganizationServiceCollectionWindow(this.client, organizationId),
      );
      return paginate(organizationWires.map(serviceCollectionWireToDomain), params);
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
      const organizationId = params.organizationId;
      const organizationWires = await this.organizationList(
        'generalDescriptions',
        organizationId,
        () => fetchOrganizationGeneralDescriptionWindow(this.client, organizationId),
      );
      return paginate(organizationWires.map(generalDescriptionWireToDomain), params);
    }

    const { ids, totalCountEstimate } = await fetchIdWindow(
      this.client,
      '/api/v11/GeneralDescription',
      start,
      pageSize,
    );
    const wires = await fetchListByIds<V11GeneralDescriptionWire>(
      this.client,
      '/api/v11/GeneralDescription/list',
      ids,
    );

    return {
      items: wires.map(generalDescriptionWireToDomain),
      page,
      pageSize,
      totalCount: totalCountEstimate,
    };
  }

  async getGeneralDescription(id: PtvContentId): Promise<GeneralDescription | null> {
    const wire = await this.getOrNull<V11GeneralDescriptionWire>(
      `/api/v11/GeneralDescription/${id}`,
    );
    return wire ? generalDescriptionWireToDomain(wire) : null;
  }

  async getConnectionsFor(
    entityId: PtvContentId,
    kind?: ConnectionEndpoint,
  ): Promise<Connection[]> {
    if (kind !== 'channel') {
      const serviceWire = await this.getOrNull<V11ServiceWire>(`/api/v11/Service/${entityId}`);
      if (serviceWire) return connectionsFromService(serviceWire);
      if (kind === 'service') return [];
    }

    const channelWire = await this.getOrNull<V11ServiceChannelWire>(
      `/api/v11/ServiceChannel/${entityId}`,
    );
    if (channelWire) return connectionsFromChannel(channelWire);

    return [];
  }

  /**
   * Services this instance already read through an organisation search
   * carry their connections; the rest come from `Service/list?guids=`, 100
   * per request. Both are the published version, like `Service/{id}`.
   */
  async getConnectionsForServices(serviceIds: PtvContentId[]): Promise<Connection[]> {
    const wires = await this.organizationServiceWires();
    const missing = [...new Set(serviceIds)].filter((id) => !wires.has(id));
    const fetched = await fetchListByIds<V11ServiceWire>(
      this.client,
      '/api/v11/Service/list',
      missing,
      { notFoundAsEmpty: true },
    );
    for (const wire of fetched) wires.set(wire.id, wire);
    return serviceIds.flatMap((id) => {
      const wire = wires.get(id);
      return wire ? connectionsFromService(wire) : [];
    });
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
    this.requireWrite();
    // The PUT has to resend required fields the change doesn't touch (see
    // writeMapping.ts), so it's built on top of PTV's current record.
    // Built on the latest version, so a PUT never reverts a newer draft.
    const current = await this.getLatestOrNull<V11ServiceWire>('Service', proposal.serviceId);
    if (!current) throw new Error(`PTV service ${proposal.serviceId} not found`);
    if (current.publishingStatus === 'Modified') {
      throw new V11ModifiedVersionLockedError(proposal.serviceId);
    }
    const body = serviceChangesToV11Body(
      proposal.changes,
      current,
      await this.generalDescriptionUris(current.generalDescriptionId),
    );
    const updated = await this.client.put<V11ServiceWire>(
      `/api/v11/Service/${proposal.serviceId}`,
      body,
    );
    if (proposal.changes.serviceChannelIds !== undefined) {
      await this.applyServiceConnections(current, proposal.changes.serviceChannelIds);
    }
    return {
      serviceId: updated.id,
      publishingStatus: serviceWireToDomain(updated).publishingStatus,
      appliedAt: new Date().toISOString(),
    };
  }

  async createService(service: NewService): Promise<ApplyServiceChangeResult> {
    this.requireWrite();
    const organization = await this.getOrNull<V11OrganizationWire>(
      `/api/v11/Organization/${service.organizationId}`,
    );
    const created = await this.client.post<V11ServiceWire>(
      '/api/v11/Service',
      newServiceToV11Body(service, organizationAreaToV11(organization)),
    );
    return {
      serviceId: created.id,
      publishingStatus: toPublishingStatus(created.publishingStatus),
      appliedAt: new Date().toISOString(),
    };
  }

  async applyChannelChange(proposal: ChannelChangeProposal): Promise<ApplyChannelChangeResult> {
    this.requireWrite();
    const current = await this.getLatestOrNull<V11ServiceChannelWire>(
      'ServiceChannel',
      proposal.channelId,
    );
    if (!current) throw new Error(`PTV service channel ${proposal.channelId} not found`);
    if (current.publishingStatus === 'Modified') {
      throw new V11ModifiedVersionLockedError(proposal.channelId);
    }
    const type = channelWriteType(current.serviceChannelType);
    const updated = await this.client.put<V11ServiceChannelWire>(
      `/api/v11/ServiceChannel/${type}/${proposal.channelId}`,
      channelChangesToV11Body(proposal.changes, current),
    );
    return {
      channelId: updated.id,
      publishingStatus: toPublishingStatus(updated.publishingStatus),
      appliedAt: new Date().toISOString(),
    };
  }

  async createChannel(channel: NewChannel): Promise<ApplyChannelChangeResult> {
    this.requireWrite();
    const type = channelWriteType(channel.channelType);
    const created = await this.client.post<V11ServiceChannelWire>(
      `/api/v11/ServiceChannel/${type}`,
      newChannelToV11Body(channel),
    );
    return {
      channelId: created.id,
      publishingStatus: toPublishingStatus(created.publishingStatus),
      appliedAt: new Date().toISOString(),
    };
  }

  async applyConnectionChange(
    proposal: ConnectionChangeProposal,
  ): Promise<ApplyConnectionChangeResult> {
    this.requireWrite();
    const current = await this.getLatestOrNull<V11ServiceWire>('Service', proposal.serviceId);
    if (!current) throw new Error(`PTV service ${proposal.serviceId} not found`);
    await this.client.put(
      `/api/v11/Connection/serviceId/${proposal.serviceId}`,
      planConnectionDetails(current, proposal.channelId, proposal.changes),
    );
    return {
      serviceId: proposal.serviceId,
      channelId: proposal.channelId,
      appliedAt: new Date().toISOString(),
    };
  }

  async applyOrganizationChange(
    proposal: OrganizationChangeProposal,
  ): Promise<ApplyOrganizationChangeResult> {
    this.requireWrite();
    const current = await this.getOrNull<V11OrganizationWire>(
      `/api/v11/Organization/${proposal.organizationId}`,
    );
    if (!current) throw new Error(`PTV organisation ${proposal.organizationId} not found`);
    if (current.publishingStatus === 'Modified') {
      throw new V11ModifiedVersionLockedError(proposal.organizationId);
    }
    const updated = await this.client.put<V11OrganizationWire>(
      `/api/v11/Organization/${proposal.organizationId}`,
      organizationChangesToV11Body(proposal.changes, current),
    );
    return {
      organizationId: updated.id,
      publishingStatus: toPublishingStatus(updated.publishingStatus),
      appliedAt: new Date().toISOString(),
    };
  }

  async createOrganization(organization: NewOrganization): Promise<ApplyOrganizationChangeResult> {
    this.requireWrite();
    const created = await this.client.post<V11OrganizationWire>(
      '/api/v11/Organization',
      newOrganizationToV11Body(organization),
    );
    return {
      organizationId: created.id,
      publishingStatus: toPublishingStatus(created.publishingStatus),
      appliedAt: new Date().toISOString(),
    };
  }

  /** Classification URIs a linked general description brings (see serviceChangesToV11Body). */
  private async generalDescriptionUris(id: string | null | undefined): Promise<Set<string>> {
    if (!id) return new Set();
    const wire = await this.getOrNull<V11GeneralDescriptionWire>(
      `/api/v11/GeneralDescription/${id}`,
    );
    const lists = [
      wire?.serviceClasses,
      wire?.ontologyTerms,
      wire?.targetGroups,
      wire?.lifeEvents,
      wire?.industrialClasses,
    ];
    return new Set(
      lists.flatMap((items) =>
        (items ?? []).map((item) => item.uri).filter((uri): uri is string => !!uri),
      ),
    );
  }

  private requireWrite(): void {
    if (!this.capabilities.supportsWrite) {
      throw new Error('PtvV11Adapter: write is not enabled for this instance');
    }
  }

  /** One download per (list, organisation) for this adapter instance; a failed one is retried. */
  private organizationList<T>(
    list: string,
    organizationId: string,
    load: () => Promise<T[]>,
  ): Promise<T[]> {
    const key = `${list}:${organizationId}`;
    let pending = this.organizationLists.get(key) as Promise<T[]> | undefined;
    if (!pending) {
      pending = load();
      this.organizationLists.set(key, pending);
      pending.catch(() => this.organizationLists.delete(key));
    }
    return pending;
  }

  /** Service wires from the organisation service lists this instance has downloaded, by id. */
  private async organizationServiceWires(): Promise<Map<string, V11ServiceWire>> {
    const lists = await Promise.all(
      [...this.organizationLists]
        .filter(([key]) => key.startsWith('services:'))
        .map(([, list]) => list.catch(() => [])),
    );
    return new Map((lists.flat() as V11ServiceWire[]).map((wire) => [wire.id, wire] as const));
  }

  /** Connections are written through their own endpoint, after the service PUT. */
  private async applyServiceConnections(
    current: V11ServiceWire,
    desiredChannelIds: PtvContentId[],
  ): Promise<void> {
    const body = planServiceConnections(current, desiredChannelIds);
    if (body) await this.client.put(`/api/v11/Connection/serviceId/${current.id}`, body);
  }

  /**
   * The latest version of a service or channel: `{type}/active/{id}` (drafts
   * and modified versions included) when an API user is configured, else
   * the public, published-only `{type}/{id}`. If the restricted read fails
   * for any reason (including a 404, in case it only covers the API user's
   * own organisation), the public read decides, so a broken API-user login
   * never breaks published reads.
   */
  private async getLatestOrNull<T>(
    type: 'Service' | 'ServiceChannel',
    id: PtvContentId,
  ): Promise<T | null> {
    if (this.client.canAuthenticate) {
      try {
        return await this.client.getRestricted<T>(`/api/v11/${type}/active/${id}`);
      } catch {
        // Fall through to the public read.
      }
    }
    return this.getOrNull<T>(`/api/v11/${type}/${id}`);
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

/** v11 writes a channel through its type's own path (`ServiceChannel/{type}/...`). */
function channelWriteType(type: string): (typeof V11_CHANNEL_WRITE_TYPES)[number] {
  const writeType = V11_CHANNEL_WRITE_TYPES.find((t) => t === type);
  if (!writeType) throw new Error(`Unknown v11 service channel type: ${type}`);
  return writeType;
}
