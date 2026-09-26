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
import { chunk, isNotFound, mapWithConcurrency, PAGE_FETCH_CONCURRENCY } from '../http.js';
import { paginate } from '../paging.js';
import { PtvV12Client } from './client.js';
import {
  type CodeListKind,
  CodeNameCache,
  MISSING_CODE_NAME_TTL_MS,
  sharedCodeNameCache,
} from './codeNameCache.js';
import { referenceCodeToDomain, V12_REFERENCE_CODE_LIST_PATHS } from './mappers/codeList.js';
import { isUri, organizationIdOf } from './mappers/common.js';
import { mapV12Connection } from './mappers/connection.js';
import { mapV12GeneralDescription } from './mappers/generalDescription.js';
import { mapV12Organization } from './mappers/organization.js';
import { mapV12Service } from './mappers/service.js';
import { mapV12ServiceChannel } from './mappers/serviceChannel.js';
import { mapV12ServiceCollection } from './mappers/serviceCollection.js';
import { extractItems, extractPageCount, extractTotalCount } from './pagination.js';
import type {
  V12GeneralDescriptionWire,
  V12OrganizationWire,
  V12ServiceChannelWire,
  V12ServiceCollectionWire,
  V12ServiceWire,
} from './wireModel.js';

type V12Query = Record<string, string | number | readonly string[] | undefined>;

/** The largest `pageSize` v12's paginated endpoints take. */
const V12_MAX_PAGE_SIZE = 100;

const WRITES_NOT_ENABLED = 'PTV v12 write operations are not enabled yet';

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
    const hydrated = await this.hydratedSearch(
      '/api/v12/service',
      params.organizationId,
      mapV12Service,
      (service) => !!service.organizationId && hasNames(service),
    );
    const query = params.query?.trim();
    const filtered = hydrated.filter(
      (service) =>
        (!params.organizationId || service.organizationId === params.organizationId) &&
        matchesQuery(query, service.names, service.summaries, service.descriptions),
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
    const hydrated = await this.hydratedSearch(
      '/api/v12/service-channel',
      params.organizationId,
      mapV12ServiceChannel,
      (channel) => !!channel.organizationId && hasNames(channel),
    );
    const query = params.query?.trim();
    const filtered = hydrated.filter(
      (channel) =>
        (!params.organizationId || channel.organizationId === params.organizationId) &&
        matchesQuery(query, channel.names, channel.descriptions),
    );
    return paginate(filtered, params);
  }

  async searchOrganisations(params: SearchParams): Promise<PaginatedResult<Organization>> {
    const query = params.query?.trim();
    const organizations = await this.organizationCatalogue();
    const filtered = query
      ? organizations.filter((org) => matchesQuery(query, org.names))
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
    const all = (
      await this.fetchAllRaw<V12OrganizationWire>(
        '/api/v12/organization/search',
        // The live v12 organization search catalogue otherwise returns rows
        // without localized names in some environments. Request Finnish
        // language versions explicitly; text matching remains client-side
        // because v12 exposes no organization-name query parameter.
        { languageVersions: ['fi'] },
      )
    ).map(mapV12Organization);
    // v12 search is a catalogue feed; search results can omit fields present
    // on the individual resource. Hydrate every organization before applying
    // the MCP query so the public interface does not depend on search DTO shape.
    return this.hydrate(all, hasNames, '/api/v12/organization', mapV12Organization);
  }

  async getChannel(id: PtvContentId): Promise<ServiceChannel | null> {
    const raw = await this.getOrNull<V12ServiceChannelWire>(`/api/v12/service-channel/${id}`);
    return raw === null ? null : mapV12ServiceChannel(raw);
  }

  async getOrganisation(id: PtvContentId): Promise<Organization | null> {
    const raw = await this.getOrNull<V12OrganizationWire>(`/api/v12/organization/${id}`);
    return raw === null ? null : mapV12Organization(raw);
  }

  async getOrganisationHierarchy(id: PtvContentId): Promise<Organization[]> {
    return walkOrganisationHierarchy((orgId) => this.getOrganisation(orgId), id);
  }

  async searchServiceCollections(
    params: SearchParams,
  ): Promise<PaginatedResult<ServiceCollection>> {
    const query = params.query?.trim();
    const rawItems = await this.organizationSearch<V12ServiceCollectionWire>(
      '/api/v12/service-collection/search',
      params.organizationId,
    );
    const filtered = rawItems.filter((item) => {
      if (params.organizationId && organizationIdOf(item) !== params.organizationId) return false;
      if (!query) return true;
      const collection = mapV12ServiceCollection(item);
      return matchesQuery(query, collection.names, collection.descriptions);
    });
    const result = paginate(filtered, params);
    // The search listing omits collection members (`items`); only the
    // detail endpoint carries them, so hydrate just the returned page.
    const hydrated = await Promise.all(
      result.items.map(async (item) => {
        if (item.items ?? item.serviceIds ?? item.services) return item;
        const id = item.contentId ?? item.id;
        if (!id) return item;
        const detail = await this.getOrNull<V12ServiceCollectionWire>(
          `/api/v12/service-collection/${id}`,
        );
        return detail === null ? item : detail;
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
    const rawItems = await this.organizationSearch<V12GeneralDescriptionWire>(
      '/api/v12/general-description/search',
      params.organizationId,
    );
    const filtered = rawItems
      .filter((item) => !params.organizationId || organizationIdOf(item) === params.organizationId)
      .map(mapV12GeneralDescription)
      .filter((description) => matchesQuery(query, description.names, description.descriptions));
    const result = paginate(filtered, params);
    return { ...result, items: await this.withCodeNames(result.items) };
  }

  /**
   * v12 services carry no channel list; connections are their own
   * resource. Fill `serviceChannelIds` from /connection/search so v12
   * matches v11's shape.
   */
  private async withChannelIds(services: Service[]): Promise<Service[]> {
    const needingIds = services.filter((service) => service.serviceChannelIds.length === 0);
    if (needingIds.length === 0) return services;
    const connections = await this.connectionsOfServices(needingIds.map((service) => service.id));
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
      this.fetchAllRaw<unknown>('/api/v12/connection/search', { [filter]: [entityId] });
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

  async getConnectionsForServices(serviceIds: PtvContentId[]): Promise<Connection[]> {
    const connections = await this.connectionsOfServices([...new Set(serviceIds)]);
    return serviceIds.flatMap((id) =>
      connections.filter((connection) => connection.serviceId === id),
    );
  }

  /** `/connection/search` by service, CONNECTION_SEARCH_MAX_IDS services per request. */
  private async connectionsOfServices(serviceIds: PtvContentId[]): Promise<Connection[]> {
    const pages = await Promise.all(
      chunk(serviceIds, CONNECTION_SEARCH_MAX_IDS).map((serviceContentIds) =>
        this.fetchAllRaw<unknown>('/api/v12/connection/search', { serviceContentIds }),
      ),
    );
    return pages.flat().map(mapV12Connection);
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
    const items = (await this.fetchAllRaw<unknown>(path)).map(referenceCodeToDomain);
    if (isCodeListKind(codeListName)) await this.cacheCodeEntries(codeListName, items);
    return items;
  }

  async searchOntologyTerms(params: SearchParams): Promise<PaginatedResult<CodeListEntry>> {
    const page = params.page ?? 1;
    // v12 pages server-side.
    const pageSize = Math.min(params.pageSize ?? 20, V12_MAX_PAGE_SIZE);
    const query = params.query?.trim();
    const raw = await this.client.get<unknown>('/api/v12/ontology-terms', {
      page,
      pageSize,
      isValid: 'true',
      ...(query ? { name: query } : {}),
    });
    const items = extractItems(raw).map(referenceCodeToDomain);
    await this.cacheCodeEntries('ontologyTerms', items);
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
        const batches = (['uris', 'codes'] as const).flatMap((param) =>
          chunk(
            missing.filter((key) => isUri(key) === (param === 'uris')),
            CODE_FILTER_MAX_ITEMS,
          ).map((values) => ({ param, values })),
        );
        await Promise.all(
          batches.map(async ({ param, values }) => {
            try {
              const found = (
                await this.fetchAllRaw<unknown>(V12_REFERENCE_CODE_LIST_PATHS[kind]!, {
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

  private async cacheCodeEntries(kind: CodeListKind, entries: CodeListEntry[]): Promise<void> {
    for (const entry of entries) this.cacheCodeEntry(kind, entry);
    await this.codeNames.flush();
  }

  /** A GET that reads PTV's 404 as `null`. */
  private async getOrNull<W>(path: string): Promise<W | null> {
    try {
      return await this.client.get<W>(path);
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  /**
   * Fetch every page of a v12 paginated endpoint. Page 1 tells us
   * totalPages/totalItems; the remaining pages are fetched with bounded
   * concurrency so a full catalogue scan (e.g. organisation name search,
   * which v12 cannot do server-side) stays fast.
   */
  private async fetchAllRaw<T>(path: string, query?: V12Query): Promise<T[]> {
    const pageSize = V12_MAX_PAGE_SIZE;
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

  /** Every search row, filtered to one organisation server-side when given. */
  private searchRows<W>(path: string, organizationId: string | undefined): Promise<W[]> {
    return this.fetchAllRaw<W>(
      path,
      organizationId ? { organizationContentIds: [organizationId] } : undefined,
    );
  }

  /** `searchRows`, downloaded once per organisation (see `organizationList`). */
  private organizationSearch<W>(path: string, organizationId: string | undefined): Promise<W[]> {
    return this.organizationList(path, organizationId, () =>
      this.searchRows<W>(path, organizationId),
    );
  }

  /**
   * `${detailPath}/search` mapped to the domain, with incomplete rows
   * re-read from `${detailPath}/{id}` (see `hydrate`); downloaded once per
   * organisation.
   */
  private hydratedSearch<W, T extends { id: string }>(
    detailPath: string,
    organizationId: string | undefined,
    map: (wire: W) => T,
    isComplete: (item: T) => boolean,
  ): Promise<T[]> {
    const path = `${detailPath}/search`;
    return this.organizationList(path, organizationId, async () =>
      this.hydrate(
        (await this.searchRows<W>(path, organizationId)).map(map),
        isComplete,
        detailPath,
        map,
      ),
    );
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
      const wire = await this.getOrNull<W>(`${detailPath}/${item.id}`);
      return wire === null ? item : map(wire);
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
    throw new Error(WRITES_NOT_ENABLED);
  }

  async createService(_service: NewService): Promise<ApplyServiceChangeResult> {
    throw new Error(WRITES_NOT_ENABLED);
  }

  async applyChannelChange(_proposal: ChannelChangeProposal): Promise<ApplyChannelChangeResult> {
    throw new Error(WRITES_NOT_ENABLED);
  }

  async createChannel(_channel: NewChannel): Promise<ApplyChannelChangeResult> {
    throw new Error(WRITES_NOT_ENABLED);
  }

  async applyConnectionChange(
    _proposal: ConnectionChangeProposal,
  ): Promise<ApplyConnectionChangeResult> {
    throw new Error(WRITES_NOT_ENABLED);
  }

  async applyOrganizationChange(
    _proposal: OrganizationChangeProposal,
  ): Promise<ApplyOrganizationChangeResult> {
    throw new Error(WRITES_NOT_ENABLED);
  }

  async createOrganization(_organization: NewOrganization): Promise<ApplyOrganizationChangeResult> {
    throw new Error(WRITES_NOT_ENABLED);
  }
}

/** `serviceContentIds` / `channelContentIds` maxItems in the v12 spec. */
const CONNECTION_SEARCH_MAX_IDS = 20;

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

function hasNames(item: { names: Record<string, string | undefined> }): boolean {
  return Object.keys(item.names).length > 0;
}

function normalizeSearchText(value: string): string {
  return value.normalize('NFKC').trim().toLocaleLowerCase('fi-FI');
}

/**
 * Whether any text in `fields` (localized texts) contains `query`, compared
 * case- and width-insensitively. No query matches everything.
 */
function matchesQuery(
  query: string | undefined,
  ...fields: Array<Record<string, string | undefined>>
): boolean {
  if (!query) return true;
  const needle = normalizeSearchText(query);
  return fields.some((field) =>
    Object.values(field).some(
      (value) => value !== undefined && normalizeSearchText(value).includes(needle),
    ),
  );
}
