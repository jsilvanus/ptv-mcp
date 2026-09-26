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
import { isNotFound, mapWithConcurrency, PAGE_FETCH_CONCURRENCY } from '../http.js';
import { paginate } from '../paging.js';
import { PtvV12Client } from './client.js';
import {
  type CodeListKind,
  CodeNameCache,
  MISSING_CODE_NAME_TTL_MS,
  sharedCodeNameCache,
} from './codeNameCache.js';

interface V12ServiceChannelWire {
  contentId?: string;
  id?: string;
  sourceId?: string;
  organizationId?: string;
  organizationContentId?: string;
  organization?: {
    contentId?: string;
    id?: string;
    organizationId?: string;
    organizationContentId?: string;
  };
  serviceChannelType?: string;
  serviceLanguages?: string[];
  channelType?: string;
  type?: string;
  publishingStatus?: string;
  name?: unknown;
  names?: unknown;
  languageVersions?: Record<string, unknown>;
  description?: unknown;
  descriptions?: unknown;
  languages?: string[];
  modifiedAt?: string | number;
  modified?: string | number;
  lastModified?: string | number;
  lastModifiedAt?: string | number;
  updatedAt?: string | number;
  publishedAt?: string;
  migratedAt?: string;
}

interface V12OrganizationWire {
  contentId?: string;
  id?: string;
  sourceId?: string;
  parentOrganizationContentId?: string | null;
  parentOrganizationId?: string;
  parentOrganization?: { contentId?: string; id?: string };
  businessCode?: string;
  businessId?: string;
  publishingStatus?: string;
  name?: unknown;
  names?: unknown;
  languageVersions?: Record<string, unknown>;
  modifiedAt?: string | number;
  modified?: string | number;
  lastModified?: string | number;
  lastModifiedAt?: string | number;
  updatedAt?: string | number;
}
interface V12ServiceWire {
  contentId?: string;
  id?: string;
  sourceId?: string;
  organizationId?: string;
  organizationContentId?: string;
  organization?: {
    contentId?: string;
    id?: string;
    organizationId?: string;
    organizationContentId?: string;
  };
  serviceType?: string;
  type?: string;
  publishingStatus?: string;
  name?: unknown;
  names?: unknown;
  languageVersions?: Record<string, unknown>;
  description?: unknown;
  descriptions?: unknown;
  summary?: unknown;
  summaries?: unknown;
  serviceClasses?: unknown[];
  ontologyTerms?: unknown[];
  targetGroups?: unknown[];
  lifeEvents?: unknown[];
  industrialClasses?: unknown[];
  languages?: string[];
  generalDescriptionContentId?: string | null;
  generalDescriptionId?: string;
  serviceLanguages?: string[];
  serviceChannelIds?: Array<string | { contentId?: string; id?: string }>;
  serviceChannels?: Array<string | { contentId?: string; id?: string }>;
  modifiedAt?: string | number;
  modified?: string | number;
  lastModified?: string | number;
  lastModifiedAt?: string | number;
  updatedAt?: string | number;
}

interface V12ServiceCollectionWire {
  contentId?: string;
  id?: string;
  publishingStatus?: string;
  languageVersions?: Record<string, unknown>;
  names?: unknown;
  name?: unknown;
  descriptions?: unknown;
  description?: unknown;
  organizationContentId?: string;
  organizationId?: string;
  services?: Array<string | { contentId?: string; id?: string }>;
  serviceIds?: Array<string | { contentId?: string; id?: string }>;
  /** v12: collection members, each tagged Service or Channel. */
  items?: Array<{ itemType?: string; contentId?: string }>;
  serviceChannels?: Array<string | { contentId?: string; id?: string }>;
  modifiedAt?: string | number;
  modified?: string | number;
  lastModified?: string | number;
  lastModifiedAt?: string | number;
  updatedAt?: string | number;
}

interface V12GeneralDescriptionWire {
  contentId?: string;
  id?: string;
  serviceType?: string;
  type?: string;
  publishingStatus?: string;
  languageVersions?: Record<string, unknown>;
  names?: unknown;
  name?: unknown;
  descriptions?: unknown;
  description?: unknown;
  organizationContentId?: string;
  organizationId?: string;
  serviceClasses?: unknown[];
  ontologyTerms?: unknown[];
  targetGroups?: unknown[];
  lifeEvents?: unknown[];
  industrialClasses?: unknown[];
  modifiedAt?: string | number;
  modified?: string | number;
  lastModified?: string | number;
  lastModifiedAt?: string | number;
  updatedAt?: string | number;
}

export class PtvV12Adapter implements PtvAdapter {
  private readonly client: PtvV12Client;
  private readonly capabilities: PtvAdapterCapabilities;
  private readonly codeNames: CodeNameCache;
  private readonly organizationCache?: PtvOrganizationCacheService | undefined;
  private readonly tenantId?: string | undefined;
  /**
   * Organisation-scoped search results, keyed by search path + organisation
   * id. Each MCP page of an organisation search needs the organisation's
   * whole list; adapters are created per request, so this reuses one
   * download (and hydration) across the pages read within a request.
   */
  private readonly organizationLists = new Map<string, Promise<unknown[]>>();

  constructor(options: {
    environment: PtvEnvironment;
    apiKey: string;
    fetchImpl?: typeof fetch;
    /**
     * Defaults to a process-wide memory-only cache; the app passes a
     * Postgres-backed one (via the registry), tests their own.
     */
    codeNameCache?: CodeNameCache;
    /** Tenant-scoped persistent organisation catalogue cache, shared with v11. */
    organizationCache?: PtvOrganizationCacheService;
    tenantId?: string;
  }) {
    this.client = new PtvV12Client(options);
    this.codeNames = options.codeNameCache ?? sharedCodeNameCache;
    this.organizationCache = options.organizationCache;
    this.tenantId = options.tenantId;
    this.capabilities = {
      apiVersion: 'v12',
      environment: options.environment,
      credentialScope: 'tenant',
      supportsRead: true,
      supportsWrite: false,
      supportsDraftRead: false,
    };
  }

  getCapabilities(): PtvAdapterCapabilities {
    return this.capabilities;
  }

  async searchServices(params: SearchParams): Promise<PaginatedResult<Service>> {
    const path = '/api/v12/service/search';
    const hydrated = await this.organizationList(path, params.organizationId, async () =>
      this.hydrate(
        await this.fetchAll(
          path,
          (item) => mapV12Service(item as V12ServiceWire),
          100,
          organizationQuery(params.organizationId),
        ),
        (service) => !!service.organizationId && hasNames(service),
        '/api/v12/service',
        mapV12Service,
      ),
    );
    const query = params.query?.trim();
    const filtered = hydrated.filter(
      (service) =>
        (!params.organizationId || service.organizationId === params.organizationId) &&
        (!query ||
          matchesText(
            query,
            ...Object.values(service.names),
            ...Object.values(service.summaries),
            ...Object.values(service.descriptions),
          )),
    );
    const result = paginate(filtered, params);
    return {
      ...result,
      items: await this.withCodeNames(await this.withChannelIds(result.items)),
    };
  }

  async getService(id: PtvContentId): Promise<Service | null> {
    try {
      const raw = await this.client.get<V12ServiceWire>(`/api/v12/service/${id}`);
      const [service] = await this.withCodeNames(await this.withChannelIds([mapV12Service(raw)]));
      return service ?? null;
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async searchChannels(params: SearchParams): Promise<PaginatedResult<ServiceChannel>> {
    const path = '/api/v12/service-channel/search';
    const hydrated = await this.organizationList(path, params.organizationId, async () =>
      this.hydrate(
        await this.fetchAll(
          path,
          (item) => mapV12ServiceChannel(item as V12ServiceChannelWire),
          100,
          organizationQuery(params.organizationId),
        ),
        (channel) => !!channel.organizationId && hasNames(channel),
        '/api/v12/service-channel',
        mapV12ServiceChannel,
      ),
    );
    const query = params.query?.trim();
    const filtered = hydrated.filter(
      (channel) =>
        (!params.organizationId || channel.organizationId === params.organizationId) &&
        (!query ||
          matchesText(
            query,
            ...Object.values(channel.names),
            ...Object.values(channel.descriptions),
          )),
    );
    return paginate(filtered, params);
  }

  async searchOrganisations(params: SearchParams): Promise<PaginatedResult<Organization>> {
    const query = params.query?.trim();
    const organizations = await this.organizationCatalogue();
    const filtered = query
      ? organizations.filter((org) => matchesText(query, ...Object.values(org.names)))
      : organizations;
    return paginate(filtered, params);
  }

  /**
   * The whole organisation catalogue: from the tenant's persistent cache
   * (shared with v11, up to its TTL stale) when there is one, refreshed
   * from PTV when it has gone stale.
   */
  private async organizationCatalogue(): Promise<Organization[]> {
    if (!this.organizationCache || !this.tenantId) return this.fetchOrganizationCatalogue();
    const cacheKey = {
      tenantId: this.tenantId,
      environment: this.capabilities.environment,
      apiVersion: 'v12',
    } as const;
    if (!(await this.organizationCache.hasFreshCatalogue(cacheKey))) {
      await this.organizationCache.replaceCatalogue(
        cacheKey,
        await this.fetchOrganizationCatalogue(),
      );
    }
    return this.organizationCache.search(cacheKey);
  }

  private async fetchOrganizationCatalogue(): Promise<Organization[]> {
    const all = await this.fetchAll(
      '/api/v12/organization/search',
      (item) => mapV12Organization(item as V12OrganizationWire),
      100,
      // The live v12 organization search catalogue otherwise returns rows
      // without localized names in some environments. Request Finnish
      // language versions explicitly; text matching remains client-side
      // because v12 exposes no organization-name query parameter.
      { languageVersions: ['fi'] },
    );
    // v12 search is a catalogue feed; search results can omit fields present
    // on the individual resource. Hydrate every organization before applying
    // the MCP query so the public interface does not depend on search DTO shape.
    return this.hydrate(all, hasNames, '/api/v12/organization', mapV12Organization);
  }

  async getChannel(id: PtvContentId): Promise<ServiceChannel | null> {
    try {
      const raw = await this.client.get<V12ServiceChannelWire>(`/api/v12/service-channel/${id}`);
      return mapV12ServiceChannel(raw);
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async getOrganisation(id: PtvContentId): Promise<Organization | null> {
    try {
      const raw = await this.client.get<V12OrganizationWire>(`/api/v12/organization/${id}`);
      return mapV12Organization(raw);
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async getOrganisationHierarchy(id: PtvContentId): Promise<Organization[]> {
    return walkOrganisationHierarchy((orgId) => this.getOrganisation(orgId), id);
  }
  async searchServiceCollections(
    params: SearchParams,
  ): Promise<PaginatedResult<ServiceCollection>> {
    const query = params.query?.trim();
    const path = '/api/v12/service-collection/search';
    const rawItems = await this.organizationList(path, params.organizationId, () =>
      this.fetchAllRaw<V12ServiceCollectionWire>(
        path,
        100,
        organizationQuery(params.organizationId),
      ),
    );
    const filtered = rawItems.filter((item) => {
      if (params.organizationId && organizationIdOf(item) !== params.organizationId) return false;
      if (!query) return true;
      const collection = mapV12ServiceCollection(item);
      return matchesText(
        query,
        ...Object.values(collection.names),
        ...Object.values(collection.descriptions),
      );
    });
    const result = paginate(filtered, params);
    // The search listing omits collection members (`items`); only the
    // detail endpoint carries them, so hydrate just the returned page.
    const hydrated = await Promise.all(
      result.items.map(async (item) => {
        if (item.items ?? item.serviceIds ?? item.services) return item;
        const id = item.contentId ?? item.id;
        if (!id) return item;
        try {
          return await this.client.get<V12ServiceCollectionWire>(
            `/api/v12/service-collection/${id}`,
          );
        } catch (err) {
          if (isNotFound(err)) return item;
          throw err;
        }
      }),
    );
    return { ...result, items: hydrated.map(mapV12ServiceCollection) };
  }

  /** v12 general descriptions are not read yet (see searchGeneralDescriptions). */
  async getGeneralDescription(_id: PtvContentId): Promise<GeneralDescription | null> {
    return null;
  }

  async searchGeneralDescriptions(
    params: SearchParams,
  ): Promise<PaginatedResult<GeneralDescription>> {
    const query = params.query?.trim();
    const path = '/api/v12/general-description/search';
    const rawItems = await this.organizationList(path, params.organizationId, () =>
      this.fetchAllRaw<V12GeneralDescriptionWire>(
        path,
        100,
        organizationQuery(params.organizationId),
      ),
    );
    const filtered = rawItems
      .filter((item) => !params.organizationId || organizationIdOf(item) === params.organizationId)
      .map(mapV12GeneralDescription)
      .filter(
        (description) =>
          !query ||
          matchesText(
            query,
            ...Object.values(description.names),
            ...Object.values(description.descriptions),
          ),
      );
    const result = paginate(filtered, params);
    return { ...result, items: await this.withCodeNames(result.items) };
  }
  /**
   * v12 services carry no channel list; connections are their own
   * resource. Fill `serviceChannelIds` from /connection/search (which takes
   * at most 20 service ids per request) so v12 matches v11's shape.
   */
  private async withChannelIds(services: Service[]): Promise<Service[]> {
    const needingIds = services.filter((service) => service.serviceChannelIds.length === 0);
    if (needingIds.length === 0) return services;
    const batches: string[][] = [];
    for (let i = 0; i < needingIds.length; i += CONNECTION_SEARCH_MAX_IDS) {
      batches.push(needingIds.slice(i, i + CONNECTION_SEARCH_MAX_IDS).map((service) => service.id));
    }
    const connections = (
      await Promise.all(
        batches.map((serviceContentIds) =>
          this.fetchAllRaw<unknown>('/api/v12/connection/search', 100, { serviceContentIds }),
        ),
      )
    )
      .flat()
      .map(mapV12Connection);
    const channelIdsByService = new Map<string, string[]>();
    for (const connection of connections) {
      const channelIds = channelIdsByService.get(connection.serviceId) ?? [];
      if (!channelIds.includes(connection.channelId)) channelIds.push(connection.channelId);
      channelIdsByService.set(connection.serviceId, channelIds);
    }
    return services.map((service) =>
      service.serviceChannelIds.length === 0
        ? { ...service, serviceChannelIds: channelIdsByService.get(service.id) ?? [] }
        : service,
    );
  }

  async getConnectionsFor(
    entityId: PtvContentId,
    kind?: ConnectionEndpoint,
  ): Promise<Connection[]> {
    // The id may be a service or a channel; v12 filters by either server-side.
    const search = (filter: 'serviceContentIds' | 'channelContentIds') =>
      this.fetchAllRaw<unknown>('/api/v12/connection/search', 100, { [filter]: [entityId] });
    const [asService, asChannel] = await Promise.all([
      kind === 'channel' ? [] : search('serviceContentIds'),
      kind === 'service' ? [] : search('channelContentIds'),
    ]);
    return [...asService, ...asChannel]
      .map(mapV12Connection)
      .filter(
        (connection) => connection.serviceId === entityId || connection.channelId === entityId,
      );
  }

  /** `/connection/search` by service, CONNECTION_SEARCH_MAX_IDS services per request. */
  async getConnectionsForServices(serviceIds: PtvContentId[]): Promise<Connection[]> {
    const ids = [...new Set(serviceIds)];
    const batches: string[][] = [];
    for (let i = 0; i < ids.length; i += CONNECTION_SEARCH_MAX_IDS) {
      batches.push(ids.slice(i, i + CONNECTION_SEARCH_MAX_IDS));
    }
    const connections = (
      await Promise.all(
        batches.map((serviceContentIds) =>
          this.fetchAllRaw<unknown>('/api/v12/connection/search', 100, { serviceContentIds }),
        ),
      )
    )
      .flat()
      .map(mapV12Connection);
    return serviceIds.flatMap((id) =>
      connections.filter((connection) => connection.serviceId === id),
    );
  }

  async listCodes(codeListName: string): Promise<CodeListEntry[]> {
    const path = V12_REFERENCE_CODE_LIST_PATHS[codeListName];
    if (!path) {
      throw new Error(
        `v12 has no standalone code list named "${codeListName}". Supported names: ${Object.keys(
          V12_REFERENCE_CODE_LIST_PATHS,
        ).join(', ')}`,
      );
    }
    const items = (await this.fetchAllRaw<unknown>(path, 100)).map(referenceCodeToDomain);
    if (isCodeListKind(codeListName)) {
      for (const item of items) this.cacheCodeEntry(codeListName, item);
      await this.codeNames.flush();
    }
    return items;
  }

  async searchOntologyTerms(params: SearchParams): Promise<PaginatedResult<CodeListEntry>> {
    const page = params.page ?? 1;
    // v12 pages server-side with pageSize ≤ 100.
    const pageSize = Math.min(params.pageSize ?? 20, 100);
    const query = params.query?.trim();
    const raw = await this.client.get<unknown>('/api/v12/ontology-terms', {
      page,
      pageSize,
      isValid: 'true',
      ...(query ? { name: query } : {}),
    });
    const items = extractItems(raw).map(referenceCodeToDomain);
    for (const item of items) this.cacheCodeEntry('ontologyTerms', item);
    await this.codeNames.flush();
    return { items, page, pageSize, totalCount: extractTotalCount(raw, items.length) };
  }

  /**
   * Complete classification entries, which v12 returns as a bare code or
   * URI: fill `names`, and whichever of `code`/`uri` is missing, from the
   * reference-data endpoints, so entries match v11's `{code, uri, names}`.
   * The v11 write path sends `uri` (and `code` for industrial classes),
   * so this also makes v12-read entries writable through v11.
   *
   * Only entries not already cached are fetched, via the endpoints'
   * `codes`/`uris` filters (max 20 per request). A failed lookup leaves
   * the entry as-is rather than failing the read.
   */
  private async withCodeNames<T extends CodeCarrier>(items: T[]): Promise<T[]> {
    const environment = this.capabilities.environment;
    await Promise.all(
      CODE_LIST_KINDS.map(async (kind) => {
        const incomplete = new Set<string>();
        for (const item of items) {
          for (const entry of item[kind]) {
            const key = lookupKey(entry);
            if (key && isIncomplete(kind, entry)) incomplete.add(key);
          }
        }
        await this.codeNames.prime(environment, kind, [...incomplete]);
        const missing = [...incomplete].filter(
          (key) => !this.codeNames.get(environment, kind, key),
        );
        const batches: Array<{ param: 'codes' | 'uris'; values: string[] }> = [];
        for (const param of ['uris', 'codes'] as const) {
          const values = missing.filter((key) => isUri(key) === (param === 'uris'));
          for (let i = 0; i < values.length; i += CODE_FILTER_MAX_ITEMS) {
            batches.push({ param, values: values.slice(i, i + CODE_FILTER_MAX_ITEMS) });
          }
        }
        await Promise.all(
          batches.map(async ({ param, values }) => {
            try {
              const found = (
                await this.fetchAllRaw<unknown>(V12_REFERENCE_CODE_LIST_PATHS[kind]!, 100, {
                  [param]: values,
                })
              ).map(referenceCodeToDomain);
              for (const entry of found) this.cacheCodeEntry(kind, entry);
              // Cache misses too, so an unknown code isn't re-requested on every read.
              for (const value of values) {
                if (!this.codeNames.get(environment, kind, value)) {
                  this.codeNames.set(
                    environment,
                    kind,
                    value,
                    { names: {} },
                    MISSING_CODE_NAME_TTL_MS,
                  );
                }
              }
            } catch {
              // Leave these entries as they are; the next read retries.
            }
          }),
        );
      }),
    );
    await this.codeNames.flush();
    return items.map((item) => {
      const completed = { ...item };
      for (const kind of CODE_LIST_KINDS) {
        completed[kind] = item[kind].map((entry) => {
          const key = lookupKey(entry);
          const cached = key ? this.codeNames.get(environment, kind, key) : undefined;
          if (!cached) return entry;
          const code = entry.code ?? cached.code;
          const uri = entry.uri ?? cached.uri;
          return {
            ...(code ? { code } : {}),
            ...(uri ? { uri } : {}),
            names: Object.keys(entry.names).length > 0 ? entry.names : cached.names,
          };
        });
      }
      return completed;
    });
  }

  private cacheCodeEntry(kind: CodeListKind, entry: CodeListEntry): void {
    const environment = this.capabilities.environment;
    for (const key of [entry.code, entry.uri]) {
      if (key) this.codeNames.set(environment, kind, key, entry);
    }
  }
  /**
   * Fetch every page of a v12 paginated endpoint. Page 1 tells us
   * totalPages/totalItems; the remaining pages are fetched with bounded
   * concurrency so a full catalogue scan (e.g. organisation name search,
   * which v12 cannot do server-side) stays fast.
   */
  private async fetchAllRaw<T>(
    path: string,
    pageSize = 100,
    query?: Record<string, string | number | readonly string[] | undefined>,
  ): Promise<T[]> {
    const first = await this.client.get<unknown>(path, { ...query, page: 1, pageSize });
    const firstItems = extractItems(first) as T[];
    const pageCount = extractPageCount(first, firstItems.length, pageSize);
    const laterPages = Array.from({ length: Math.max(0, pageCount - 1) }, (_, index) => index + 2);
    const rest = await mapWithConcurrency(laterPages, PAGE_FETCH_CONCURRENCY, async (page) => {
      const raw = await this.client.get<unknown>(path, { ...query, page, pageSize });
      return extractItems(raw) as T[];
    });
    return [...firstItems, ...rest.flat()];
  }

  private async fetchAll<T>(
    path: string,
    map: (item: unknown) => T,
    pageSize = 100,
    query?: Record<string, string | number | readonly string[] | undefined>,
  ): Promise<T[]> {
    return (await this.fetchAllRaw<unknown>(path, pageSize, query)).map(map);
  }

  /**
   * v12 search is a catalogue feed whose rows can omit fields present on
   * the individual resource. Re-read each incomplete row from
   * `${detailPath}/{id}` (raw read + mapper only: enrichment such as
   * withChannelIds/withCodeNames runs on the final page), with bounded
   * concurrency. A row that has since disappeared (404) is kept as is.
   */
  private async hydrate<W, T extends { id: string }>(
    items: T[],
    isComplete: (item: T) => boolean,
    detailPath: string,
    map: (wire: W) => T,
  ): Promise<T[]> {
    return mapWithConcurrency(items, PAGE_FETCH_CONCURRENCY, async (item) => {
      if (isComplete(item)) return item;
      try {
        return map(await this.client.get<W>(`${detailPath}/${item.id}`));
      } catch (err) {
        if (isNotFound(err)) return item;
        throw err;
      }
    });
  }

  /**
   * One download per (search path, organisation) for this adapter
   * instance; searches without an organisation are not memoised. A failed
   * download is retried.
   */
  private organizationList<T>(
    path: string,
    organizationId: string | undefined,
    load: () => Promise<T[]>,
  ): Promise<T[]> {
    if (!organizationId) return load();
    const key = `${path}:${organizationId}`;
    let pending = this.organizationLists.get(key) as Promise<T[]> | undefined;
    if (!pending) {
      pending = load();
      this.organizationLists.set(key, pending);
      pending.catch(() => this.organizationLists.delete(key));
    }
    return pending;
  }

  async applyServiceChange(_proposal: ServiceChangeProposal): Promise<ApplyServiceChangeResult> {
    throw new Error('PTV v12 write operations are not enabled yet');
  }

  async createService(_service: NewService): Promise<ApplyServiceChangeResult> {
    throw new Error('PTV v12 write operations are not enabled yet');
  }

  async applyChannelChange(_proposal: ChannelChangeProposal): Promise<ApplyChannelChangeResult> {
    throw new Error('PTV v12 write operations are not enabled yet');
  }

  async createChannel(_channel: NewChannel): Promise<ApplyChannelChangeResult> {
    throw new Error('PTV v12 write operations are not enabled yet');
  }

  async applyConnectionChange(
    _proposal: ConnectionChangeProposal,
  ): Promise<ApplyConnectionChangeResult> {
    throw new Error('PTV v12 write operations are not enabled yet');
  }

  async applyOrganizationChange(
    _proposal: OrganizationChangeProposal,
  ): Promise<ApplyOrganizationChangeResult> {
    throw new Error('PTV v12 write operations are not enabled yet');
  }

  async createOrganization(_organization: NewOrganization): Promise<ApplyOrganizationChangeResult> {
    throw new Error('PTV v12 write operations are not enabled yet');
  }
}

function extractItems(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (!raw || typeof raw !== 'object') return [];
  const object = raw as {
    items?: unknown[];
    content?: unknown[];
    data?: unknown[];
    results?: unknown[];
  };
  return object.items ?? object.content ?? object.data ?? object.results ?? [];
}

function extractTotalCount(raw: unknown, fallback: number): number {
  if (!raw || typeof raw !== 'object') return fallback;
  // v12's paginated responses carry `totalItems` (see PaginatedType in
  // docs/ptv-api-documentation.json). Missing it made every catalogue scan
  // stop after the first page of 100.
  const object = raw as {
    totalItems?: number;
    totalCount?: number;
    totalElements?: number;
    total?: number;
  };
  return object.totalItems ?? object.totalCount ?? object.totalElements ?? object.total ?? fallback;
}

/** `codes` / `uris` maxItems on the v12 reference-data endpoints. */
const CODE_FILTER_MAX_ITEMS = 20;

const CODE_LIST_KINDS: readonly CodeListKind[] = [
  'serviceClasses',
  'targetGroups',
  'lifeEvents',
  'industrialClasses',
  'ontologyTerms',
];

type CodeCarrier = Record<CodeListKind, CodeListEntry[]>;

function isCodeListKind(name: string): name is CodeListKind {
  return (CODE_LIST_KINDS as readonly string[]).includes(name);
}

/** Look entries up by URI when v12 gave one (ontology terms, industrial classes). */
function lookupKey(entry: CodeListEntry): string | undefined {
  return entry.uri ?? entry.code;
}

/** Ontology terms have no code in PTV; every other kind has both code and uri. */
function isIncomplete(kind: CodeListKind, entry: CodeListEntry): boolean {
  return (
    Object.keys(entry.names).length === 0 || !entry.uri || (kind !== 'ontologyTerms' && !entry.code)
  );
}

function isUri(value: string): boolean {
  return /^https?:\/\//.test(value);
}
/** `serviceContentIds` / `channelContentIds` maxItems in the v12 spec. */
const CONNECTION_SEARCH_MAX_IDS = 20;

function extractPageCount(raw: unknown, firstPageLength: number, pageSize: number): number {
  if (firstPageLength === 0) return 1;
  if (raw && typeof raw === 'object') {
    const totalPages = (raw as { totalPages?: unknown }).totalPages;
    if (typeof totalPages === 'number' && Number.isFinite(totalPages))
      return Math.max(1, totalPages);
  }
  return Math.max(1, Math.ceil(extractTotalCount(raw, firstPageLength) / pageSize));
}

function organizationQuery(
  organizationId: string | undefined,
): { organizationContentIds: string[] } | undefined {
  return organizationId ? { organizationContentIds: [organizationId] } : undefined;
}

function hasNames(item: { names: Record<string, string | undefined> }): boolean {
  return Object.keys(item.names).length > 0;
}

function normalizeSearchText(value: string): string {
  return value.normalize('NFKC').trim().toLocaleLowerCase('fi-FI');
}

/** Whether any of `texts` contains `query`, compared case- and width-insensitively. */
function matchesText(query: string, ...texts: Array<string | undefined>): boolean {
  const needle = normalizeSearchText(query);
  return texts.some((value) => value !== undefined && normalizeSearchText(value).includes(needle));
}

function mapV12ServiceChannel(wire: V12ServiceChannelWire): ServiceChannel {
  const id = wire.contentId ?? wire.id;
  if (!id) throw new Error('PTV v12 service channel response has no contentId');
  return {
    id,
    ...(wire.sourceId ? { sourceId: wire.sourceId } : {}),
    organizationId: organizationIdOf(wire),
    channelType: normalizeChannelType(wire.serviceChannelType ?? wire.channelType ?? wire.type),
    publishingStatus: normalizePublishingStatus(wire.publishingStatus),
    names: localized(wire.names ?? wire.name ?? wire.languageVersions, 'name'),
    descriptions: localized(
      wire.descriptions ?? wire.description ?? wire.languageVersions,
      'description',
    ),
    languages:
      wire.languages ??
      wire.serviceLanguages ??
      (wire.languageVersions ? Object.keys(wire.languageVersions) : []),
    ...modifiedAtField(wire),
  };
}

function mapV12Organization(wire: V12OrganizationWire): Organization {
  const id = wire.contentId ?? wire.id;
  if (!id) throw new Error('PTV v12 organization response has no contentId');
  const parentOrganizationId =
    wire.parentOrganizationContentId ??
    wire.parentOrganizationId ??
    wire.parentOrganization?.contentId ??
    wire.parentOrganization?.id;
  return {
    id,
    ...(wire.sourceId ? { sourceId: wire.sourceId } : {}),
    ...(parentOrganizationId ? { parentOrganizationId } : {}),
    ...((wire.businessCode ?? wire.businessId)
      ? { businessCode: wire.businessCode ?? wire.businessId }
      : {}),
    publishingStatus: normalizePublishingStatus(wire.publishingStatus),
    names: localized(wire.names ?? wire.name ?? wire.languageVersions, 'name'),
    ...modifiedAtField(wire),
  };
}

function mapV12ServiceCollection(wire: V12ServiceCollectionWire): ServiceCollection {
  const id = wire.contentId ?? wire.id;
  if (!id) throw new Error('PTV v12 service collection response has no contentId');
  return {
    id,
    publishingStatus: normalizePublishingStatus(wire.publishingStatus),
    names: localized(wire.names ?? wire.name ?? wire.languageVersions, 'name'),
    descriptions: localized(
      wire.descriptions ?? wire.description ?? wire.languageVersions,
      'description',
    ),
    serviceIds: wire.items
      ? wire.items.flatMap((item) =>
          item.itemType === 'Service' && item.contentId ? [item.contentId] : [],
        )
      : ids(wire.serviceIds ?? wire.services),
    ...modifiedAtField(wire),
  };
}

function mapV12GeneralDescription(wire: V12GeneralDescriptionWire): GeneralDescription {
  const id = wire.contentId ?? wire.id;
  if (!id) throw new Error('PTV v12 general description response has no contentId');
  return {
    id,
    serviceType: normalizeServiceType(wire.serviceType ?? wire.type),
    publishingStatus: normalizePublishingStatus(wire.publishingStatus),
    names: localized(wire.names ?? wire.name ?? wire.languageVersions, 'name'),
    descriptions: localized(
      wire.descriptions ?? wire.description ?? wire.languageVersions,
      'description',
    ),
    serviceClasses: codeEntries(wire.serviceClasses),
    ontologyTerms: codeEntries(wire.ontologyTerms),
    targetGroups: codeEntries(wire.targetGroups),
    lifeEvents: codeEntries(wire.lifeEvents),
    industrialClasses: codeEntries(wire.industrialClasses),
    ...modifiedAtField(wire),
  };
}

const V12_REFERENCE_CODE_LIST_PATHS: Record<string, string> = {
  countries: '/api/v12/country-codes',
  industrialClasses: '/api/v12/industrial-classes',
  languages: '/api/v12/language-codes',
  lifeEvents: '/api/v12/life-events',
  municipalities: '/api/v12/municipality-codes',
  ontologyTerms: '/api/v12/ontology-terms',
  postalCodes: '/api/v12/postal-codes',
  regions: '/api/v12/region-codes',
  serviceClasses: '/api/v12/service-classes',
  targetGroups: '/api/v12/target-groups',
  wellbeingServicesCounties: '/api/v12/wellbeing-services-county-codes',
};

function referenceCodeToDomain(value: unknown): CodeListEntry {
  if (typeof value === 'string') return { code: value, names: {} };
  if (!value || typeof value !== 'object') return { names: {} };
  const item = value as Record<string, unknown>;
  const code = firstString(item.code, item.contentId, item.id, item.value);
  return {
    ...(code ? { code } : {}),
    ...(typeof item.uri === 'string' ? { uri: item.uri } : {}),
    names: localized(item.names ?? item.name ?? item.languageVersions, 'name'),
  };
}

function organizationIdOf(wire: {
  organizationId?: string;
  organizationContentId?: string;
  organization?: {
    contentId?: string;
    id?: string;
    organizationId?: string;
    organizationContentId?: string;
  };
}): string {
  return (
    wire.organizationContentId ??
    wire.organizationId ??
    wire.organization?.organizationContentId ??
    wire.organization?.contentId ??
    wire.organization?.id ??
    wire.organization?.organizationId ??
    ''
  );
}

function modifiedAtOf(wire: {
  modifiedAt?: string | number;
  modified?: string | number;
  lastModified?: string | number;
  lastModifiedAt?: string | number;
  updatedAt?: string | number;
}): string | undefined {
  const value =
    wire.modifiedAt ?? wire.modified ?? wire.lastModified ?? wire.lastModifiedAt ?? wire.updatedAt;
  if (typeof value === 'string') {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime()) && date.getTime() !== 0) return date.toISOString();
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    const millis = value < 1_000_000_000_000 ? value * 1000 : value;
    const date = new Date(millis);
    if (!Number.isNaN(date.getTime()) && date.getTime() !== 0) return date.toISOString();
  }
  return undefined;
}

function modifiedAtField(wire: Parameters<typeof modifiedAtOf>[0]): { modifiedAt?: string } {
  const modifiedAt = modifiedAtOf(wire);
  return modifiedAt ? { modifiedAt } : {};
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string' && value.length > 0);
}

function mapV12Connection(wire: unknown): Connection {
  const value = (wire && typeof wire === 'object' ? wire : {}) as Record<string, unknown>;
  const service = value.service as Record<string, unknown> | undefined;
  const channel = value.channel as Record<string, unknown> | undefined;
  const serviceId =
    value.serviceContentId ?? value.serviceId ?? service?.contentId ?? service?.id ?? '';
  const channelId =
    value.channelContentId ??
    value.channelId ??
    value.serviceChannelId ??
    channel?.contentId ??
    channel?.id ??
    '';
  if (!serviceId || !channelId)
    throw new Error('PTV v12 connection response has no service/channel id');
  const descriptions = localized(value.languageVersions, 'description');
  const timestamp = value.modifiedAt ?? value.publishedAt;
  const modifiedAt = modifiedAtOf(typeof timestamp === 'string' ? { modifiedAt: timestamp } : {});
  return {
    serviceId: String(serviceId),
    channelId: String(channelId),
    ...(Object.keys(descriptions).length > 0 ? { descriptions } : {}),
    ...(modifiedAt ? { modifiedAt } : {}),
  };
}

function normalizeChannelType(value: string | undefined): ServiceChannel['channelType'] {
  if (
    value === 'Phone' ||
    value === 'PrintableForm' ||
    value === 'ServiceLocation' ||
    value === 'WebPage'
  )
    return value;
  // v12's wire name for the phone channel subtype (see ChannelResponse's discriminator).
  if (value === 'TelephoneService') return 'Phone';
  return 'EChannel';
}
/**
 * Map the v12 wire representation into the stable PTV domain model.
 *
 * v12 deliberately changed localized content from v11's array of
 * {language,value} records to languageVersions, e.g.
 * { fi: { name, summary, description }, sv: { ... } }.
 * The old mapper treated those nested objects as non-string values and
 * consequently discarded every localized field.
 */
export function mapV12Service(wire: V12ServiceWire): Service {
  const id = wire.contentId ?? wire.id;
  if (!id) throw new Error('PTV v12 service response has no contentId');

  const languageVersions = wire.languageVersions;
  const names = localized(wire.names ?? wire.name ?? languageVersions, 'name');
  const summaries = localized(wire.summaries ?? wire.summary ?? languageVersions, 'summary');
  const descriptions = localized(
    wire.descriptions ?? wire.description ?? languageVersions,
    'description',
  );
  const languages =
    wire.languages ??
    wire.serviceLanguages ??
    (languageVersions ? Object.keys(languageVersions) : []);

  return {
    id,
    ...(wire.sourceId ? { sourceId: wire.sourceId } : {}),
    organizationId: organizationIdOf(wire),
    serviceType: normalizeServiceType(wire.serviceType ?? wire.type),
    publishingStatus: normalizePublishingStatus(wire.publishingStatus),
    names,
    summaries,
    descriptions,
    serviceClasses: codeEntries(wire.serviceClasses),
    ontologyTerms: codeEntries(wire.ontologyTerms),
    targetGroups: codeEntries(wire.targetGroups),
    lifeEvents: codeEntries(wire.lifeEvents),
    industrialClasses: codeEntries(wire.industrialClasses),
    languages,
    ...((wire.generalDescriptionContentId ?? wire.generalDescriptionId)
      ? { generalDescriptionId: (wire.generalDescriptionContentId ?? wire.generalDescriptionId)! }
      : {}),
    serviceChannelIds: ids(wire.serviceChannelIds ?? wire.serviceChannels),
    ...modifiedAtField(wire),
  };
}

/** PTV sends `""` for missing translations; treat those as absent. */
function localized(value: unknown, preferredField?: string): Record<string, string> {
  return Object.fromEntries(
    Object.entries(localizedWithEmpty(value, preferredField)).filter(
      ([, text]) => text.trim() !== '',
    ),
  );
}

function localizedWithEmpty(value: unknown, preferredField?: string): Record<string, string> {
  if (!value) return {};

  if (Array.isArray(value)) {
    return Object.fromEntries(
      value.flatMap((entry) => {
        if (!entry || typeof entry !== 'object') return [];
        const e = entry as Record<string, unknown>;
        const language = String(e.languageCode ?? e.language ?? e.lang ?? '');
        const text = preferredField ? e[preferredField] : (e.value ?? e.text ?? e.description);
        return language && typeof text === 'string' ? [[language, text]] : [];
      }),
    );
  }

  if (typeof value === 'object') {
    const object = value as Record<string, unknown>;

    if (preferredField && typeof object[preferredField] === 'string') {
      return { fi: object[preferredField] as string };
    }

    if (preferredField && 'languageVersions' in object) {
      return localized(object.languageVersions, preferredField);
    }

    const entries = Object.entries(object).flatMap(([language, entry]) => {
      if (typeof entry === 'string') return [[language, entry] as [string, string]];
      if (!entry || typeof entry !== 'object') return [];
      const e = entry as Record<string, unknown>;
      const text = preferredField ? e[preferredField] : (e.value ?? e.text ?? e.description);
      return typeof text === 'string' ? [[language, text] as [string, string]] : [];
    });
    return Object.fromEntries(entries);
  }

  if (typeof value === 'string') return { fi: value };
  return {};
}

function codeEntries(values: unknown[] | undefined): CodeListEntry[] {
  if (!values) return [];

  return values.map((value) => {
    // v12 sends bare strings: a URI for ontology terms and industrial
    // classes, a code for the rest. withCodeNames fills in the other half.
    if (typeof value === 'string') {
      return isUri(value) ? { uri: value, names: {} } : { code: value, names: {} };
    }
    if (!value || typeof value !== 'object') return { names: {} };

    const v = value as Record<string, unknown>;
    const code = firstString(v.code, v.contentId, v.id, v.value);
    const names = localized(
      v.names ?? v.name ?? v.languageVersions ?? v.displayName ?? v.label,
      'name',
    );

    return {
      ...(code ? { code } : {}),
      ...(typeof v.uri === 'string' ? { uri: v.uri } : {}),
      names,
    };
  });
}

function ids(values: Array<string | { contentId?: string; id?: string }> | undefined): string[] {
  return (values ?? []).flatMap((value) => {
    if (typeof value === 'string') return [value];
    const id = value.contentId ?? value.id;
    return id ? [id] : [];
  });
}

function normalizeServiceType(value: string | undefined): Service['serviceType'] {
  if (value === 'ProfessionalQualification' || value === 'PermitOrObligation') return value;
  // v12's wire name for the same subtype.
  if (value === 'PermitOrOtherObligation') return 'PermitOrObligation';
  return 'Service';
}

function normalizePublishingStatus(value: string | undefined): Service['publishingStatus'] {
  if (value === 'Draft' || value === 'Modified' || value === 'Archived' || value === 'Withdrawn')
    return value;
  return 'Published';
}
