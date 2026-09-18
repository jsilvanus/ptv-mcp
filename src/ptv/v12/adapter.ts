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
  organization?: { contentId?: string };
  serviceType?: string;
  publishingStatus?: string;
  name?: unknown;
  names?: unknown;
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
  serviceChannelIds?: string[];
  serviceChannels?: Array<{ contentId?: string; id?: string }>;
  modifiedAt?: string;
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
    const raw = await this.client.get<unknown>('/api/v12/service/search', { page, pageSize });
    return normalizePage<Service>(raw, page, pageSize, (item) => mapService(item as V12ServiceWire));
  }

  async getService(id: PtvContentId): Promise<Service | null> {
    try {
      const raw = await this.client.get<V12ServiceWire>(`/api/v12/service/${id}`);
      return mapService(raw);
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

function mapService(wire: V12ServiceWire): Service {
  const id = wire.contentId ?? wire.id;
  if (!id) throw new Error('PTV v12 service response has no contentId');
  return {
    id,
    ...(wire.sourceId ? { sourceId: wire.sourceId } : {}),
    organizationId: wire.organizationId ?? wire.organization?.contentId ?? '',
    serviceType: normalizeServiceType(wire.serviceType),
    publishingStatus: normalizePublishingStatus(wire.publishingStatus),
    names: localized(wire.names ?? wire.name),
    summaries: localized(wire.summaries ?? wire.summary),
    descriptions: localized(wire.descriptions ?? wire.description),
    serviceClasses: codeEntries(wire.serviceClasses),
    ontologyTerms: codeEntries(wire.ontologyTerms),
    targetGroups: codeEntries(wire.targetGroups),
    lifeEvents: codeEntries(wire.lifeEvents),
    industrialClasses: codeEntries(wire.industrialClasses),
    languages: wire.languages ?? [],
    ...(wire.generalDescriptionId ? { generalDescriptionId: wire.generalDescriptionId } : {}),
    serviceChannelIds: wire.serviceChannelIds ??
      (wire.serviceChannels ?? []).map((c) => c.contentId ?? c.id).filter((x): x is string => !!x),
    modifiedAt: wire.modifiedAt ?? wire.lastModified ?? new Date(0).toISOString(),
  };
}

function localized(value: unknown): Record<string, string> {
  if (!value) return {};
  if (typeof value === 'string') return { fi: value };
  if (Array.isArray(value)) {
    return Object.fromEntries(value.flatMap((entry) => {
      if (!entry || typeof entry !== 'object') return [];
      const e = entry as Record<string, unknown>;
      const language = String(e.languageCode ?? e.language ?? e.lang ?? '');
      const text = e.value ?? e.text ?? e.description;
      return language && typeof text === 'string' ? [[language, text]] : [];
    }));
  }
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).filter(([, v]) => typeof v === 'string')) as Record<string, string>;
  }
  return {};
}

function codeEntries(values: unknown[] | undefined): CodeListEntry[] {
  if (!values) return [];
  return values.map((value) => {
    if (!value || typeof value !== 'object') return {};
    const v = value as Record<string, unknown>;
    return {
      ...(typeof v.code === 'string' ? { code: v.code } : {}),
      ...(typeof v.uri === 'string' ? { uri: v.uri } : {}),
      names: localized(v.names ?? v.name),
    };
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
