import type {
  ApplyServiceChangeResult, PtvAdapter, PtvAdapterCapabilities, PtvEnvironment, ServiceChangeProposal,
} from '../adapter.js';
import type {
  CodeListEntry, Connection, GeneralDescription, Organization, PaginatedResult,
  PtvContentId, SearchParams, Service, ServiceChannel, ServiceCollection,
} from '../domain.js';
import { PtvV12Client } from './client.js';

interface V12ServiceChannelWire {
  contentId?: string;
  id?: string;
  sourceId?: string;
  organizationId?: string;
  organization?: { contentId?: string; id?: string; organizationId?: string };
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
  modifiedAt?: string;
  modified?: string;
  lastModified?: string;
}

interface V12OrganizationWire {
  contentId?: string;
  id?: string;
  sourceId?: string;
  parentOrganizationId?: string;
  parentOrganization?: { contentId?: string; id?: string };
  businessCode?: string;
  publishingStatus?: string;
  name?: unknown;
  names?: unknown;
  languageVersions?: Record<string, unknown>;
  modifiedAt?: string;
  modified?: string;
  lastModified?: string;
}
interface V12ServiceWire {
  contentId?: string;
  id?: string;
  sourceId?: string;
  organizationId?: string;
  organization?: { contentId?: string; id?: string; organizationId?: string };
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
  modifiedAt?: string;
  modified?: string;
  lastModified?: string;
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

  getCapabilities(): PtvAdapterCapabilities { return this.capabilities; }

  async searchServices(params: SearchParams): Promise<PaginatedResult<Service>> {
    const page = params.page ?? 1;
    const pageSize = params.pageSize ?? 100;
    const all = await this.fetchAll('/api/v12/service/search', (item) =>
      mapV12Service(item as V12ServiceWire),
    );
    const query = params.query?.trim();
    const hydrated = query || params.organizationId
      ? await this.hydrateServices(all)
      : all;

    const filtered = hydrated.filter((service) =>
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
      if (err instanceof Error && 'status' in err && (err as { status?: number }).status === 404) return null;
      throw err;
    }
  }

  async searchChannels(params: SearchParams): Promise<PaginatedResult<ServiceChannel>> {
    const page = params.page ?? 1;
    const pageSize = params.pageSize ?? 100;
    const all = await this.fetchAll('/api/v12/service-channel/search', (item) =>
      mapV12ServiceChannel(item as V12ServiceChannelWire),
    );
    const query = params.query?.trim();
    const hydrated = query || params.organizationId
      ? await this.hydrateChannels(all)
      : all;
    const filtered = hydrated.filter((channel) =>
      (!params.organizationId || channel.organizationId === params.organizationId) &&
      (!query || matchesChannel(channel, query)),
    );
    return paginate(filtered, page, pageSize);
  }

  async searchOrganisations(params: SearchParams): Promise<PaginatedResult<Organization>> {
    const page = params.page ?? 1;
    const pageSize = params.pageSize ?? 100;
    const all = await this.fetchAll('/api/v12/organization/search', (item) =>
      mapV12Organization(item as V12OrganizationWire),
    );
    const query = params.query?.trim();
    const hydrated = query ? await this.hydrateOrganisations(all) : all;
    const filtered = query
      ? hydrated.filter((org) => matchesOrganisation(org, query))
      : hydrated;
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
  async searchServiceCollections(_params: SearchParams): Promise<PaginatedResult<ServiceCollection>> { return unsupported('service-collection search'); }
  async searchGeneralDescriptions(_params: SearchParams): Promise<PaginatedResult<GeneralDescription>> { return unsupported('general-description search'); }
  async getConnectionsFor(entityId: PtvContentId): Promise<Connection[]> {
    const raw = await this.client.get<unknown>('/api/v12/connection/search');
    return extractItems(raw)
      .map(mapV12Connection)
      .filter((connection) => connection.serviceId === entityId || connection.channelId === entityId);
  }
  async listCodes(_codeListName: string): Promise<CodeListEntry[]> { return unsupported('code lists'); }
  private async fetchAll<T>(path: string, map: (item: unknown) => T, pageSize = 100): Promise<T[]> {
    const result: T[] = [];
    for (let page = 1; ; page++) {
      const raw = await this.client.get<unknown>(path, { page, pageSize });
      const items = extractItems(raw);
      result.push(...items.map(map));
      const total = extractTotalCount(raw, result.length);
      if (items.length === 0 || result.length >= total) return result;
    }
  }

  private async hydrateServices(items: Service[]): Promise<Service[]> {
    return Promise.all(items.map(async (service) => {
      if (service.organizationId && service.modifiedAt !== new Date(0).toISOString() && Object.keys(service.names).length > 0) {
        return service;
      }
      return (await this.getService(service.id)) ?? service;
    }));
  }

  private async hydrateChannels(items: ServiceChannel[]): Promise<ServiceChannel[]> {
    return Promise.all(items.map(async (channel) => {
      if (channel.organizationId && channel.modifiedAt !== new Date(0).toISOString() && Object.keys(channel.names).length > 0) {
        return channel;
      }
      return (await this.getChannel(channel.id)) ?? channel;
    }));
  }

  private async hydrateOrganisations(items: Organization[]): Promise<Organization[]> {
    return Promise.all(items.map(async (organization) => {
      if (organization.modifiedAt !== new Date(0).toISOString() && Object.keys(organization.names).length > 0) {
        return organization;
      }
      return (await this.getOrganisation(organization.id)) ?? organization;
    }));
  }

  async applyServiceChange(_proposal: ServiceChangeProposal): Promise<ApplyServiceChangeResult> {
    throw new Error('PTV v12 write operations are not enabled yet');
  }
}

function extractItems(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (!raw || typeof raw !== 'object') return [];
  const object = raw as { items?: unknown[]; content?: unknown[]; data?: unknown[]; results?: unknown[] };
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
  return [...Object.values(service.names), ...Object.values(service.summaries), ...Object.values(service.descriptions)]
    .some((value) => normalizeSearchText(value).includes(needle));
}

function matchesOrganisation(org: Organization, query: string): boolean {
  const needle = normalizeSearchText(query);
  return Object.values(org.names).some((value) => normalizeSearchText(value).includes(needle));
}

function matchesChannel(channel: ServiceChannel, query: string): boolean {
  const needle = normalizeSearchText(query);
  return [...Object.values(channel.names), ...Object.values(channel.descriptions)]
    .some((value) => normalizeSearchText(value).includes(needle));
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
    organizationId: wire.organizationId ?? wire.organization?.contentId ?? wire.organization?.id ?? wire.organization?.organizationId ?? '',
    channelType: normalizeChannelType(wire.serviceChannelType ?? wire.channelType ?? wire.type),
    publishingStatus: normalizePublishingStatus(wire.publishingStatus),
    names: localized(wire.names ?? wire.name ?? wire.languageVersions, 'name'),
    descriptions: localized(wire.descriptions ?? wire.description ?? wire.languageVersions, 'description'),
    languages: wire.languages ?? (wire.languageVersions ? Object.keys(wire.languageVersions) : []),
    modifiedAt: wire.modifiedAt ?? wire.modified ?? wire.lastModified ?? new Date(0).toISOString(),
  };
}

function mapV12Organization(wire: V12OrganizationWire): Organization {
  const id = wire.contentId ?? wire.id;
  if (!id) throw new Error('PTV v12 organization response has no contentId');
  const parentOrganizationId = wire.parentOrganizationId ?? wire.parentOrganization?.contentId ?? wire.parentOrganization?.id;
  return {
    id,
    ...(wire.sourceId ? { sourceId: wire.sourceId } : {}),
    ...(parentOrganizationId ? { parentOrganizationId } : {}),
    ...(wire.businessCode ? { businessCode: wire.businessCode } : {}),
    publishingStatus: normalizePublishingStatus(wire.publishingStatus),
    names: localized(wire.names ?? wire.name ?? wire.languageVersions, 'name'),
    modifiedAt: wire.modifiedAt ?? wire.modified ?? wire.lastModified ?? new Date(0).toISOString(),
  };
}

function mapV12Connection(wire: unknown): Connection {
  const value = (wire && typeof wire === 'object' ? wire : {}) as Record<string, any>;
  const service = value.service as Record<string, any> | undefined;
  const channel = value.channel as Record<string, any> | undefined;
  const serviceId = value.serviceContentId ?? value.serviceId ?? service?.contentId ?? service?.id ?? '';
  const channelId = value.channelContentId ?? value.channelId ?? value.serviceChannelId ?? channel?.contentId ?? channel?.id ?? '';
  if (!serviceId || !channelId) throw new Error('PTV v12 connection response has no service/channel id');
  return {
    serviceId: String(serviceId),
    channelId: String(channelId),
    modifiedAt: typeof value.modifiedAt === 'string' ? value.modifiedAt : new Date(0).toISOString(),
  };
}

function normalizeChannelType(value: string | undefined): ServiceChannel['channelType'] {
  if (value === 'Phone' || value === 'PrintableForm' || value === 'ServiceLocation' || value === 'WebPage') return value;
  return 'EChannel';
}
function normalizePage<T>(
  raw: unknown,
  page: number,
  pageSize: number,
  map: (item: unknown) => T,
): PaginatedResult<T> {
  if (Array.isArray(raw)) return { items: raw.map(map), page, pageSize, totalCount: raw.length };
  const object = raw as { items?: unknown[]; content?: unknown[]; totalCount?: number; totalElements?: number };
  const values = object.items ?? object.content ?? [];
  return {
    items: values.map(map),
    page,
    pageSize,
    totalCount: object.totalCount ?? object.totalElements ?? values.length,
  };
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
  const descriptions = localized(wire.descriptions ?? wire.description ?? languageVersions, 'description');
  const languages = wire.languages ?? (languageVersions ? Object.keys(languageVersions) : []);

  return {
    id,
    ...(wire.sourceId ? { sourceId: wire.sourceId } : {}),
    organizationId:
      wire.organizationId ??
      wire.organization?.contentId ??
      wire.organization?.id ??
      wire.organization?.organizationId ??
      '',
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
    modifiedAt: wire.modifiedAt ?? wire.modified ?? wire.lastModified ?? new Date(0).toISOString(),
  };
}

function localized(value: unknown, preferredField?: string): Record<string, string> {
  if (!value) return {};

  if (Array.isArray(value)) {
    return Object.fromEntries(value.flatMap((entry) => {
      if (!entry || typeof entry !== 'object') return [];
      const e = entry as Record<string, unknown>;
      const language = String(e.languageCode ?? e.language ?? e.lang ?? '');
      const text = preferredField ? e[preferredField] : e.value ?? e.text ?? e.description;
      return language && typeof text === 'string' ? [[language, text]] : [];
    }));
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
      const text = preferredField ? e[preferredField] : e.value ?? e.text ?? e.description;
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

function unsupported(name: string): never {
  throw new Error(`PTV v12 adapter operation not implemented yet: ${name}`);
}
