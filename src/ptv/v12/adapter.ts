import type {
  ApplyServiceChangeResult, PtvAdapter, PtvAdapterCapabilities, PtvEnvironment, ServiceChangeProposal,
} from '../adapter.js';
import type {
  CodeListEntry, Connection, GeneralDescription, Organization, PaginatedResult,
  PtvContentId, SearchParams, Service, ServiceChannel, ServiceCollection,
} from '../domain.js';
import { PtvV12Client } from './client.js';

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

  constructor(options: { environment: PtvEnvironment; apiKey: string }) {
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
    const raw = await this.client.get<unknown>('/api/v12/service/search', {
      ...(params.query ? { searchText: params.query } : {}),
      ...(params.organizationId ? { organizationId: params.organizationId } : {}),
      page,
      pageSize,
    });
    return normalizePage<Service>(raw, page, pageSize, (item) => mapV12Service(item as V12ServiceWire));
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

  async searchChannels(_params: SearchParams): Promise<PaginatedResult<ServiceChannel>> { return unsupported('service-channel search'); }
  async getChannel(_id: PtvContentId): Promise<ServiceChannel | null> { return unsupported('service-channel get'); }
  async getOrganisation(_id: PtvContentId): Promise<Organization | null> { return unsupported('organization get'); }
  async getOrganisationHierarchy(_id: PtvContentId): Promise<Organization[]> { return unsupported('organization hierarchy'); }
  async searchServiceCollections(_params: SearchParams): Promise<PaginatedResult<ServiceCollection>> { return unsupported('service-collection search'); }
  async searchGeneralDescriptions(_params: SearchParams): Promise<PaginatedResult<GeneralDescription>> { return unsupported('general-description search'); }
  async getConnectionsFor(_entityId: PtvContentId): Promise<Connection[]> { return unsupported('connection get'); }
  async listCodes(_codeListName: string): Promise<CodeListEntry[]> { return unsupported('code lists'); }
  async applyServiceChange(_proposal: ServiceChangeProposal): Promise<ApplyServiceChangeResult> {
    throw new Error('PTV v12 write operations are not enabled yet');
  }
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
