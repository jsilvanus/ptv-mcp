import type { ApplyServiceChangeResult, PtvAdapter, PtvAdapterCapabilities, PtvEnvironment, ServiceChangeProposal } from '../adapter.js';
import type { CodeListEntry, Connection, GeneralDescription, Organization, PaginatedResult, PtvContentId, SearchParams, Service, ServiceChannel, ServiceCollection } from '../domain.js';
import { PtvV11Client } from './client.js';
import { chunkGuids, fetchIdWindow } from './pagination.js';
import { serviceWireToDomain } from './mappers/service.js';
import { serviceChannelWireToDomain } from './mappers/serviceChannel.js';
import { organizationWireToDomain } from './mappers/organization.js';
import { generalDescriptionWireToDomain } from './mappers/generalDescription.js';
import { serviceCollectionWireToDomain } from './mappers/serviceCollection.js';
import { connectionsFromChannel, connectionsFromService } from './mappers/connection.js';
import { referenceCodeWireToDomain, V11_REFERENCE_CODE_LIST_PATHS } from './mappers/codeList.js';
import { serviceChangesToV11Body } from './writeMapping.js';
import type { V11GeneralDescriptionWire, V11IdNamePair, V11OrganizationWire, V11ReferenceCodeItem, V11ServiceChannelWire, V11ServiceCollectionWire, V11ServiceWire } from './wireModel.js';

export interface PtvV11AdapterOptions {
  environment: PtvEnvironment;
  accessToken?: string;
  canWrite?: boolean;
}

const DEFAULT_PAGE_SIZE = 20;

export class PtvV11Adapter implements PtvAdapter {
  private readonly client: PtvV11Client;
  private readonly capabilities: PtvAdapterCapabilities;

  constructor(options: PtvV11AdapterOptions) {
    this.client = new PtvV11Client({ environment: options.environment, ...(options.accessToken ? { accessToken: options.accessToken } : {}) });
    this.capabilities = {
      apiVersion: 'v11', environment: options.environment, credentialScope: 'user',
      supportsRead: true, supportsWrite: options.canWrite ?? false, supportsDraftRead: false,
    };
  }

  getCapabilities(): PtvAdapterCapabilities { return this.capabilities; }

  async searchServices(params: SearchParams): Promise<PaginatedResult<Service>> {
    const page = params.page ?? 1; const pageSize = params.pageSize ?? DEFAULT_PAGE_SIZE;
    const { ids, pageCount } = await fetchIdWindow(this.client, '/api/v11/Service', (page - 1) * pageSize, pageSize);
    const wires = await this.fetchByGuids<V11ServiceWire>('/api/v11/Service/list', ids);
    const byId = new Map(wires.map((wire) => [wire.id, wire]));
    return { items: ids.flatMap((id) => { const wire = byId.get(id); return wire ? [serviceWireToDomain(wire)] : []; }), page, pageSize, pageCount };
  }

  async getService(id: PtvContentId): Promise<Service | null> {
    const wire = await this.getOrNull<V11ServiceWire>(`/api/v11/Service/${id}`); return wire ? serviceWireToDomain(wire) : null;
  }

  async searchChannels(params: SearchParams): Promise<PaginatedResult<ServiceChannel>> {
    const page = params.page ?? 1; const pageSize = params.pageSize ?? DEFAULT_PAGE_SIZE;
    const { ids, pageCount } = await fetchIdWindow(this.client, '/api/v11/ServiceChannel', (page - 1) * pageSize, pageSize);
    const wires = await this.fetchByGuids<V11ServiceChannelWire>('/api/v11/ServiceChannel/list', ids);
    const byId = new Map(wires.map((wire) => [wire.id, wire]));
    return { items: ids.flatMap((id) => { const wire = byId.get(id); return wire ? [serviceChannelWireToDomain(wire)] : []; }), page, pageSize, pageCount };
  }

  async getChannel(id: PtvContentId): Promise<ServiceChannel | null> {
    const wire = await this.getOrNull<V11ServiceChannelWire>(`/api/v11/ServiceChannel/${id}`); return wire ? serviceChannelWireToDomain(wire) : null;
  }

  async getOrganisation(id: PtvContentId): Promise<Organization | null> {
    const wire = await this.getOrNull<V11OrganizationWire>(`/api/v11/Organization/${id}`); return wire ? organizationWireToDomain(wire) : null;
  }

  async getOrganisationHierarchy(id: PtvContentId): Promise<Organization[]> {
    const root = await this.getOrganisation(id); if (!root) return [];
    const hierarchy: Organization[] = [root]; let current = root;
    while (current.parentOrganizationId) { const parent = await this.getOrganisation(current.parentOrganizationId); if (!parent) break; hierarchy.push(parent); current = parent; }
    return hierarchy;
  }

  async searchServiceCollections(params: SearchParams): Promise<PaginatedResult<ServiceCollection>> {
    const page = params.page ?? 1; const pageSize = params.pageSize ?? DEFAULT_PAGE_SIZE;
    const { ids, pageCount } = await fetchIdWindow(this.client, '/api/v11/ServiceCollection', (page - 1) * pageSize, pageSize);
    const wires = await Promise.all(ids.map((id) => this.client.get<V11ServiceCollectionWire>(`/api/v11/ServiceCollection/${id}`)));
    const byId = new Map(wires.map((wire) => [wire.id, wire]));
    return { items: ids.flatMap((id) => { const wire = byId.get(id); return wire ? [serviceCollectionWireToDomain(wire)] : []; }), page, pageSize, pageCount };
  }

  async searchGeneralDescriptions(params: SearchParams): Promise<PaginatedResult<GeneralDescription>> {
    const page = params.page ?? 1; const pageSize = params.pageSize ?? DEFAULT_PAGE_SIZE;
    const { ids, pageCount } = await fetchIdWindow(this.client, '/api/v11/GeneralDescription', (page - 1) * pageSize, pageSize);
    const wires = await this.fetchByGuids<V11GeneralDescriptionWire>('/api/v11/GeneralDescription/list', ids);
    const byId = new Map(wires.map((wire) => [wire.id, wire]));
    return { items: ids.flatMap((id) => { const wire = byId.get(id); return wire ? [generalDescriptionWireToDomain(wire)] : []; }), page, pageSize, pageCount };
  }

  async getConnectionsFor(entityId: PtvContentId): Promise<Connection[]> {
    const serviceWire = await this.getOrNull<V11ServiceWire>(`/api/v11/Service/${entityId}`); if (serviceWire) return connectionsFromService(serviceWire);
    const channelWire = await this.getOrNull<V11ServiceChannelWire>(`/api/v11/ServiceChannel/${entityId}`); if (channelWire) return connectionsFromChannel(channelWire);
    return [];
  }

  async listCodes(codeListName: string): Promise<CodeListEntry[]> {
    const path = V11_REFERENCE_CODE_LIST_PATHS[codeListName];
    if (!path) throw new Error(`v11 has no standalone code list named "${codeListName}" — classification codes (service classes, ontology terms, target groups, life events, industrial classes) are only available embedded on entities in v11, not as a standalone list. Supported names: ${Object.keys(V11_REFERENCE_CODE_LIST_PATHS).join(', ')}`);
    const items = await this.client.get<V11ReferenceCodeItem[]>(path); return items.map(referenceCodeWireToDomain);
  }

  async applyServiceChange(proposal: ServiceChangeProposal): Promise<ApplyServiceChangeResult> {
    if (!this.capabilities.supportsWrite) throw new Error('PtvV11Adapter: write is not enabled for this instance');
    const updated = await this.client.put<V11ServiceWire>(`/api/v11/Service/${proposal.serviceId}`, serviceChangesToV11Body(proposal.changes));
    return { serviceId: updated.id, publishingStatus: serviceWireToDomain(updated).publishingStatus, appliedAt: new Date().toISOString() };
  }

  private async fetchByGuids<T>(listPath: string, ids: string[]): Promise<T[]> {
    if (ids.length === 0) return [];
    const results = await Promise.all(chunkGuids(ids).map((batch) => this.client.get<T[]>(listPath, { guids: batch.join(',') })));
    return results.flat();
  }

  private async getOrNull<T>(path: string): Promise<T | null> {
    try { return await this.client.get<T>(path); } catch (err) { if (isNotFound(err)) return null; throw err; }
  }
}

function isNotFound(err: unknown): boolean { return err instanceof Error && 'status' in err && (err as { status: unknown }).status === 404; }
export type { V11IdNamePair };
