import type {
  ApplyServiceChangeResult,
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
  generalDescriptionId?: string;
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

  constructor(options: { environment: PtvEnvironment; apiKey: string; fetchImpl?: typeof fetch }) {
    this.client = new PtvV12Client(options);
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
      params.organizationId ? { organizationId: params.organizationId } : undefined,
    );
    const query = params.query?.trim();
    const hydrated = await this.hydrateServices(all);

    const filtered = hydrated.filter(
      (service) =>
        (!params.organizationId || service.organizationId === params.organizationId) &&
        (!query || matchesService(service, query)),
    );
    return paginate(filtered, page, pageSize);
  }

  async getService(id: PtvContentId): Promise<Service | null> {
    try {
      const raw = await this.client.get<V12ServiceWire>(`/api/v12/service/${id}`);
      return mapV12Service(raw);
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
      params.organizationId ? { organizationId: params.organizationId } : undefined,
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
      params.query?.trim() ? { name: params.query.trim() } : undefined,
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
      params.organizationId ? { organizationId: params.organizationId } : undefined,
    );
    const filtered = rawItems
      .filter(
        (item) =>
          !params.organizationId &&
          !query
            ? true
            : (!params.organizationId ||
                organizationIdOf(item) === params.organizationId) &&
              (!query || matchesCollection(mapV12ServiceCollection(item), query)),
      )
      .map(mapV12ServiceCollection);
    return paginate(filtered, page, pageSize);
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
      params.organizationId ? { organizationId: params.organizationId } : undefined,
    );
    const filtered = rawItems
      .filter(
        (item) =>
          !params.organizationId &&
          !query
            ? true
            : (!params.organizationId ||
                organizationIdOf(item) === params.organizationId) &&
              (!query || matchesGeneralDescription(mapV12GeneralDescription(item), query)),
      )
      .map(mapV12GeneralDescription);
    return paginate(filtered, page, pageSize);
  }
  async getConnectionsFor(entityId: PtvContentId): Promise<Connection[]> {
    const raw = await this.client.get<unknown>('/api/v12/connection/search');
    return extractItems(raw)
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
    const raw = await this.client.get<unknown>(path);
    return extractItems(raw).map((item) => referenceCodeToDomain(item));
  }
  private async fetchAllRaw<T>(
    path: string,
    pageSize = 100,
    query?: Record<string, string | number | undefined>,
  ): Promise<T[]> {
    const result: T[] = [];
    for (let page = 1; ; page++) {
      const raw = await this.client.get<unknown>(path, { ...query, page, pageSize });
      const items = extractItems(raw) as T[];
      result.push(...items);
      const total = extractTotalCount(raw, result.length);
      if (items.length === 0 || result.length >= total) return result;
    }
  }

  private async fetchAll<T>(
    path: string,
    map: (item: unknown) => T,
    pageSize = 100,
    query?: Record<string, string | number | undefined>,
  ): Promise<T[]> {
    const result: T[] = [];
    for (let page = 1; ; page++) {
      const raw = await this.client.get<unknown>(path, { ...query, page, pageSize });
      const items = extractItems(raw);
      result.push(...items.map(map));
      const total = extractTotalCount(raw, result.length);
      if (items.length === 0 || result.length >= total) return result;
    }
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
  const object = raw as { totalCount?: number; totalElements?: number; total?: number };
  return object.totalCount ?? object.totalElements ?? object.total ?? fallback;
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
    languages: wire.languages ?? (wire.languageVersions ? Object.keys(wire.languageVersions) : []),
    modifiedAt: modifiedAtOf(wire),
  };
}

function mapV12Organization(wire: V12OrganizationWire): Organization {
  const id = wire.contentId ?? wire.id;
  if (!id) throw new Error('PTV v12 organization response has no contentId');
  const parentOrganizationId =
    wire.parentOrganizationId ?? wire.parentOrganization?.contentId ?? wire.parentOrganization?.id;
  return {
    id,
    ...(wire.sourceId ? { sourceId: wire.sourceId } : {}),
    ...(parentOrganizationId ? { parentOrganizationId } : {}),
    ...(wire.businessCode ?? wire.businessId
      ? { businessCode: wire.businessCode ?? wire.businessId }
      : {}),
    publishingStatus: normalizePublishingStatus(wire.publishingStatus),
    names: localized(wire.names ?? wire.name ?? wire.languageVersions, 'name'),
    modifiedAt: modifiedAtOf(wire),
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
    serviceIds: ids(wire.serviceIds ?? wire.services),
    modifiedAt: modifiedAtOf(wire),
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
    modifiedAt: modifiedAtOf(wire),
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
    wire.modifiedAt ??
    wire.modified ??
    wire.lastModified ??
    wire.lastModifiedAt ??
    wire.updatedAt;
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
  return [
    ...Object.values(description.names),
    ...Object.values(description.descriptions),
  ].some((value) => value !== undefined && normalizeSearchText(value).includes(needle));
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
  return {
    serviceId: String(serviceId),
    channelId: String(channelId),
    modifiedAt: typeof value.modifiedAt === 'string' ? value.modifiedAt : new Date(0).toISOString(),
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
  const languages = wire.languages ?? (languageVersions ? Object.keys(languageVersions) : []);

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
    ...(wire.generalDescriptionId ? { generalDescriptionId: wire.generalDescriptionId } : {}),
    serviceChannelIds: ids(wire.serviceChannelIds ?? wire.serviceChannels),
    modifiedAt: modifiedAtOf(wire),
  };
}

function localized(value: unknown, preferredField?: string): Record<string, string> {
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
    if (typeof value === 'string') return { code: value, names: {} };
    if (!value || typeof value !== 'object') return { names: {} };

    const v = value as Record<string, unknown>;
    return {
      ...(typeof v.code === 'string' ? { code: v.code } : {}),
      ...(typeof v.contentId === 'string' ? { code: v.contentId } : {}),
      ...(typeof v.id === 'string' ? { code: v.id } : {}),
      ...(typeof v.uri === 'string' ? { uri: v.uri } : {}),
      names: localized(v.names ?? v.name ?? v.languageVersions, 'name'),
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
  return 'Service';
}

function normalizePublishingStatus(value: string | undefined): Service['publishingStatus'] {
  if (value === 'Draft' || value === 'Archived' || value === 'Withdrawn') return value;
  return 'Published';
}
