import type {
  ApplyChannelChangeResult,
  ApplyConnectionChangeResult,
  ApplyOrganizationChangeResult,
  NewOrganization,
  OrganizationChangeProposal,
  ConnectionChangeProposal,
  ApplyServiceChangeResult,
  ChannelChangeProposal,
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

  constructor(options: {
    environment: PtvEnvironment;
    apiKey: string;
    fetchImpl?: typeof fetch;
    /**
     * Defaults to a process-wide memory-only cache; the app passes a
     * Postgres-backed one (via the registry), tests their own.
     */
    codeNameCache?: CodeNameCache;
  }) {
    this.client = new PtvV12Client(options);
    this.codeNames = options.codeNameCache ?? sharedCodeNameCache;
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
    const page = params.page ?? 1;
    const pageSize = params.pageSize ?? 100;
    const all = await this.fetchAll(
      '/api/v12/service/search',
      (item) => mapV12Service(item as V12ServiceWire),
      100,
      params.organizationId ? { organizationContentIds: [params.organizationId] } : undefined,
    );
    const query = params.query?.trim();
    const hydrated = await this.hydrateServices(all);

    const filtered = hydrated.filter(
      (service) =>
        (!params.organizationId || service.organizationId === params.organizationId) &&
        (!query || matchesService(service, query)),
    );
    const result = paginate(filtered, page, pageSize);
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
      if (err instanceof Error && 'status' in err && (err as { status?: number }).status === 404)
        return null;
      throw err;
    }
  }

  async searchChannels(params: SearchParams): Promise<PaginatedResult<ServiceChannel>> {
    const page = params.page ?? 1;
    const pageSize = params.pageSize ?? 100;
    const all = await this.fetchAll(
      '/api/v12/service-channel/search',
      (item) => mapV12ServiceChannel(item as V12ServiceChannelWire),
      100,
      params.organizationId ? { organizationContentIds: [params.organizationId] } : undefined,
    );
    const query = params.query?.trim();
    const hydrated = await this.hydrateChannels(all);
    const filtered = hydrated.filter(
      (channel) =>
        (!params.organizationId || channel.organizationId === params.organizationId) &&
        (!query || matchesChannel(channel, query)),
    );
    return paginate(filtered, page, pageSize);
  }

  async searchOrganisations(params: SearchParams): Promise<PaginatedResult<Organization>> {
    const page = params.page ?? 1;
    const pageSize = params.pageSize ?? 100;
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
    const query = params.query?.trim();
    // v12 search is a catalogue feed; search results can omit fields present
    // on the individual resource. Hydrate every organization before applying
    // the MCP query so the public interface does not depend on search DTO shape.
    const hydrated = await this.hydrateOrganisations(all);
    const filtered = query ? hydrated.filter((org) => matchesOrganisation(org, query)) : hydrated;
    return paginate(filtered, page, pageSize);
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
    const query = params.query?.trim();
    const rawItems = await this.fetchAllRaw<V12ServiceCollectionWire>(
      '/api/v12/service-collection/search',
      100,
      params.organizationId ? { organizationContentIds: [params.organizationId] } : undefined,
    );
    const filtered = rawItems.filter((item) =>
      !params.organizationId && !query
        ? true
        : (!params.organizationId || organizationIdOf(item) === params.organizationId) &&
          (!query || matchesCollection(mapV12ServiceCollection(item), query)),
    );
    const result = paginate(filtered, page, pageSize);
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
    const page = params.page ?? 1;
    const pageSize = params.pageSize ?? 100;
    const query = params.query?.trim();
    const rawItems = await this.fetchAllRaw<V12GeneralDescriptionWire>(
      '/api/v12/general-description/search',
      100,
      params.organizationId ? { organizationContentIds: [params.organizationId] } : undefined,
    );
    const filtered = rawItems
      .filter((item) =>
        !params.organizationId && !query
          ? true
          : (!params.organizationId || organizationIdOf(item) === params.organizationId) &&
            (!query || matchesGeneralDescription(mapV12GeneralDescription(item), query)),
      )
      .map(mapV12GeneralDescription);
    const result = paginate(filtered, page, pageSize);
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

  async getConnectionsFor(entityId: PtvContentId): Promise<Connection[]> {
    // The id may be a service or a channel; v12 filters by either server-side.
    const [asService, asChannel] = await Promise.all([
      this.fetchAllRaw<unknown>('/api/v12/connection/search', 100, {
        serviceContentIds: [entityId],
      }),
      this.fetchAllRaw<unknown>('/api/v12/connection/search', 100, {
        channelContentIds: [entityId],
      }),
    ]);
    return [...asService, ...asChannel]
      .map(mapV12Connection)
      .filter(
        (connection) => connection.serviceId === entityId || connection.channelId === entityId,
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
        const keys = missing;
        const batches: Array<{ param: 'codes' | 'uris'; values: string[] }> = [];
        for (const param of ['uris', 'codes'] as const) {
          const values = keys.filter((key) => isUri(key) === (param === 'uris'));
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
    const rest: T[][] = new Array(Math.max(0, pageCount - 1));
    let next = 2;
    const worker = async (): Promise<void> => {
      while (next <= pageCount) {
        const page = next++;
        const raw = await this.client.get<unknown>(path, { ...query, page, pageSize });
        rest[page - 2] = extractItems(raw) as T[];
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(PAGE_FETCH_CONCURRENCY, pageCount - 1) }, worker),
    );
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

  private async hydrateServices(items: Service[]): Promise<Service[]> {
    return Promise.all(
      items.map(async (service) => {
        if (
          service.organizationId &&
          service.modifiedAt !== new Date(0).toISOString() &&
          Object.keys(service.names).length > 0
        ) {
          return service;
        }
        return (await this.getService(service.id)) ?? service;
      }),
    );
  }

  private async hydrateChannels(items: ServiceChannel[]): Promise<ServiceChannel[]> {
    return Promise.all(
      items.map(async (channel) => {
        if (
          channel.organizationId &&
          channel.modifiedAt !== new Date(0).toISOString() &&
          Object.keys(channel.names).length > 0
        ) {
          return channel;
        }
        return (await this.getChannel(channel.id)) ?? channel;
      }),
    );
  }

  private async hydrateOrganisations(items: Organization[]): Promise<Organization[]> {
    return Promise.all(
      items.map(async (organization) => {
        if (
          organization.modifiedAt !== new Date(0).toISOString() &&
          Object.keys(organization.names).length > 0
        ) {
          return organization;
        }
        return (await this.getOrganisation(organization.id)) ?? organization;
      }),
    );
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

const PAGE_FETCH_CONCURRENCY = 6;
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

function paginate<T>(items: T[], page: number, pageSize: number): PaginatedResult<T> {
  const start = (page - 1) * pageSize;
  return { items: items.slice(start, start + pageSize), page, pageSize, totalCount: items.length };
}

function normalizeSearchText(value: string): string {
  return value.normalize('NFKC').trim().toLocaleLowerCase('fi-FI');
}

function matchesService(service: Service, query: string): boolean {
  const needle = normalizeSearchText(query);
  return [
    ...Object.values(service.names),
    ...Object.values(service.summaries),
    ...Object.values(service.descriptions),
  ].some((value) => value !== undefined && normalizeSearchText(value).includes(needle));
}

function matchesOrganisation(org: Organization, query: string): boolean {
  const needle = normalizeSearchText(query);
  return Object.values(org.names).some(
    (value) => value !== undefined && normalizeSearchText(value).includes(needle),
  );
}

function matchesChannel(channel: ServiceChannel, query: string): boolean {
  const needle = normalizeSearchText(query);
  return [...Object.values(channel.names), ...Object.values(channel.descriptions)].some(
    (value) => value !== undefined && normalizeSearchText(value).includes(needle),
  );
}

function isNotFound(err: unknown): boolean {
  return err instanceof Error && 'status' in err && (err as { status?: number }).status === 404;
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

function matchesCollection(collection: ServiceCollection, query: string): boolean {
  const needle = normalizeSearchText(query);
  return [...Object.values(collection.names), ...Object.values(collection.descriptions)].some(
    (value) => value !== undefined && normalizeSearchText(value).includes(needle),
  );
}

function matchesGeneralDescription(description: GeneralDescription, query: string): boolean {
  const needle = normalizeSearchText(query);
  return [...Object.values(description.names), ...Object.values(description.descriptions)].some(
    (value) => value !== undefined && normalizeSearchText(value).includes(needle),
  );
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
