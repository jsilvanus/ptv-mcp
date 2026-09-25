import { randomUUID } from 'node:crypto';
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
import { paginate } from '../paging.js';

/**
 * A fake PtvAdapter backed by plain in-memory arrays, used to validate
 * the contract test suite itself (Phase 1's sync point) before any real
 * adapter exists, and reusable later for unit-testing the MCP tool layer
 * (Phase 4) without needing a real PTV connection.
 */
export class InMemoryPtvAdapter implements PtvAdapter {
  private readonly services: Service[];
  private readonly channels: ServiceChannel[];
  private readonly organizations: Organization[];
  private readonly generalDescriptions: GeneralDescription[];
  private readonly serviceCollections: ServiceCollection[];
  private readonly connections: Connection[];
  private readonly codeLists: Record<string, CodeListEntry[]>;
  private readonly capabilities: PtvAdapterCapabilities;

  constructor(seed: {
    services?: Service[];
    channels?: ServiceChannel[];
    organizations?: Organization[];
    generalDescriptions?: GeneralDescription[];
    serviceCollections?: ServiceCollection[];
    connections?: Connection[];
    codeLists?: Record<string, CodeListEntry[]>;
    capabilities: PtvAdapterCapabilities;
  }) {
    this.services = seed.services ?? [];
    this.channels = seed.channels ?? [];
    this.organizations = seed.organizations ?? [];
    this.generalDescriptions = seed.generalDescriptions ?? [];
    this.serviceCollections = seed.serviceCollections ?? [];
    this.connections = seed.connections ?? [];
    this.codeLists = seed.codeLists ?? {};
    this.capabilities = seed.capabilities;
  }

  getCapabilities(): PtvAdapterCapabilities {
    return this.capabilities;
  }

  async searchServices(params: SearchParams): Promise<PaginatedResult<Service>> {
    return paginate(this.services, params);
  }

  async getService(id: PtvContentId): Promise<Service | null> {
    return this.services.find((s) => s.id === id) ?? null;
  }

  async searchChannels(params: SearchParams): Promise<PaginatedResult<ServiceChannel>> {
    return paginate(this.channels, params);
  }

  async getChannel(id: PtvContentId): Promise<ServiceChannel | null> {
    return this.channels.find((c) => c.id === id) ?? null;
  }

  async searchOrganisations(params: SearchParams): Promise<PaginatedResult<Organization>> {
    return paginate(this.organizations, params);
  }

  async getOrganisation(id: PtvContentId): Promise<Organization | null> {
    return this.organizations.find((o) => o.id === id) ?? null;
  }

  async getOrganisationHierarchy(id: PtvContentId): Promise<Organization[]> {
    return walkOrganisationHierarchy((orgId) => this.getOrganisation(orgId), id);
  }

  async searchServiceCollections(
    params: SearchParams,
  ): Promise<PaginatedResult<ServiceCollection>> {
    return paginate(this.serviceCollections, params);
  }

  async searchGeneralDescriptions(
    params: SearchParams,
  ): Promise<PaginatedResult<GeneralDescription>> {
    return paginate(this.generalDescriptions, params);
  }

  async getGeneralDescription(id: PtvContentId): Promise<GeneralDescription | null> {
    return this.generalDescriptions.find((gd) => gd.id === id) ?? null;
  }

  async getConnectionsFor(entityId: PtvContentId): Promise<Connection[]> {
    return this.connections.filter((c) => c.serviceId === entityId || c.channelId === entityId);
  }

  async listCodes(codeListName: string): Promise<CodeListEntry[]> {
    return this.codeLists[codeListName] ?? [];
  }

  async searchOntologyTerms(params: SearchParams): Promise<PaginatedResult<CodeListEntry>> {
    const needle = params.query?.trim().toLocaleLowerCase('fi-FI') ?? '';
    const terms = (this.codeLists.ontologyTerms ?? []).filter((term) =>
      Object.values(term.names).some((name) => name?.toLocaleLowerCase('fi-FI').includes(needle)),
    );
    return paginate(terms, params);
  }

  async applyServiceChange(proposal: ServiceChangeProposal): Promise<ApplyServiceChangeResult> {
    this.requireWrite();
    const index = this.services.findIndex((s) => s.id === proposal.serviceId);
    if (index === -1) {
      throw new Error(`Unknown service id: ${proposal.serviceId}`);
    }
    const existing = this.services[index];
    if (!existing) {
      throw new Error(`Unknown service id: ${proposal.serviceId}`);
    }
    const updated: Service = { ...existing, ...proposal.changes };
    this.services[index] = updated;
    return {
      serviceId: updated.id,
      publishingStatus: updated.publishingStatus,
      appliedAt: new Date().toISOString(),
    };
  }

  async applyChannelChange(proposal: ChannelChangeProposal): Promise<ApplyChannelChangeResult> {
    this.requireWrite();
    const index = this.channels.findIndex((c) => c.id === proposal.channelId);
    const existing = this.channels[index];
    if (!existing) throw new Error(`Unknown channel id: ${proposal.channelId}`);
    const updated: ServiceChannel = { ...existing, ...proposal.changes };
    this.channels[index] = updated;
    return {
      channelId: updated.id,
      publishingStatus: updated.publishingStatus,
      appliedAt: new Date().toISOString(),
    };
  }

  async createService(service: NewService): Promise<ApplyServiceChangeResult> {
    this.requireWrite();
    const created: Service = { ...service, id: randomUUID() };
    this.services.push(created);
    return {
      serviceId: created.id,
      publishingStatus: created.publishingStatus,
      appliedAt: new Date().toISOString(),
    };
  }

  async createChannel(channel: NewChannel): Promise<ApplyChannelChangeResult> {
    this.requireWrite();
    const { serviceIds, ...fields } = channel;
    const created: ServiceChannel = { ...fields, id: randomUUID() };
    this.channels.push(created);
    for (const serviceId of serviceIds ?? []) {
      this.connections.push({ serviceId, channelId: created.id });
      const service = this.services.find((s) => s.id === serviceId);
      if (service) service.serviceChannelIds = [...service.serviceChannelIds, created.id];
    }
    return {
      channelId: created.id,
      publishingStatus: created.publishingStatus,
      appliedAt: new Date().toISOString(),
    };
  }

  async applyConnectionChange(
    proposal: ConnectionChangeProposal,
  ): Promise<ApplyConnectionChangeResult> {
    this.requireWrite();
    const index = this.connections.findIndex(
      (c) => c.serviceId === proposal.serviceId && c.channelId === proposal.channelId,
    );
    const existing = this.connections[index];
    if (!existing) {
      throw new Error(`Service ${proposal.serviceId} is not connected to ${proposal.channelId}`);
    }
    this.connections[index] = { ...existing, ...proposal.changes };
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
    const index = this.organizations.findIndex((o) => o.id === proposal.organizationId);
    const existing = this.organizations[index];
    if (!existing) throw new Error(`Unknown organisation id: ${proposal.organizationId}`);
    const updated: Organization = { ...existing, ...proposal.changes };
    this.organizations[index] = updated;
    return {
      organizationId: updated.id,
      publishingStatus: updated.publishingStatus,
      appliedAt: new Date().toISOString(),
    };
  }

  async createOrganization(organization: NewOrganization): Promise<ApplyOrganizationChangeResult> {
    this.requireWrite();
    const created: Organization = { ...organization, id: randomUUID() };
    this.organizations.push(created);
    return {
      organizationId: created.id,
      publishingStatus: created.publishingStatus,
      appliedAt: new Date().toISOString(),
    };
  }

  private requireWrite(): void {
    if (!this.capabilities.supportsWrite) {
      throw new Error(
        `${this.capabilities.apiVersion} adapter does not support write in ${this.capabilities.environment}`,
      );
    }
  }
}
