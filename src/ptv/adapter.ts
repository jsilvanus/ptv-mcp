import type {
  Connection,
  ConnectionDetails,
  GeneralDescription,
  Organization,
  OrganizationType,
  PaginatedResult,
  PtvContentId,
  SearchParams,
  Service,
  ServiceChannel,
  ServiceCollection,
  CodeListEntry,
} from './domain.js';

export type PtvEnvironment = 'test' | 'production';

/**
 * Which table a PtvAdapter's credential is resolved from. 'tenant' for a
 * shared organisational secret (TenantEnvironment — e.g. v12's API key,
 * entered once by a tenant admin); 'user' for a personal one
 * (UserPtvConnection — e.g. v11's OAuth token, confirmed personal-by-design
 * in docs/ptv-v11-notes.md). PtvAdapterRegistry (Phase 3) uses this to
 * know which table to resolve credentials from before constructing an
 * adapter instance — it is never both, and never guessed at call time.
 */
export type CredentialScope = 'tenant' | 'user';

export interface PtvAdapterCapabilities {
  apiVersion: string;
  environment: PtvEnvironment;
  credentialScope: CredentialScope;
  supportsRead: boolean;
  supportsWrite: boolean;
  /** Can this adapter see PTV drafts, not just published/archived content? */
  supportsDraftRead: boolean;
}

/** A proposed change to an existing service, produced by the diff engine (Phase 4). */
export interface ServiceChangeProposal {
  serviceId: PtvContentId;
  /** Partial — only the fields the proposal actually changes. */
  changes: Partial<Service>;
}

/**
 * A service to create. PTV assigns `id` and `modifiedAt`;
 * `publishingStatus` is Draft or Published.
 */
export type NewService = Omit<Service, 'id' | 'modifiedAt'>;

/**
 * A channel to create. PTV assigns `id` and `modifiedAt`; `serviceIds`
 * connects it to existing services in the same request.
 */
export type NewChannel = Omit<ServiceChannel, 'id' | 'modifiedAt'> & {
  serviceIds?: PtvContentId[];
};

/** A proposed change to an existing service channel. */
export interface ChannelChangeProposal {
  channelId: PtvContentId;
  /** Partial: names, descriptions, languages, publishingStatus. */
  changes: Partial<ServiceChannel>;
}

/** A proposed change to one service–channel connection's extra info. */
export interface ConnectionChangeProposal {
  serviceId: PtvContentId;
  channelId: PtvContentId;
  /** Only the fields that change; a present field replaces the current value. */
  changes: Partial<ConnectionDetails>;
}

export interface ApplyConnectionChangeResult {
  serviceId: PtvContentId;
  channelId: PtvContentId;
  appliedAt: string;
}

/** A proposed change to an existing organisation. */
export interface OrganizationChangeProposal {
  organizationId: PtvContentId;
  /** Only the fields that change; a present field replaces the current value. */
  changes: Partial<Organization>;
}

/**
 * A sub-organisation to create under `parentOrganizationId`. PTV assigns
 * `id` and `modifiedAt`; `publishingStatus` is Draft or Published.
 */
export type NewOrganization = Omit<
  Organization,
  'id' | 'modifiedAt' | 'parentOrganizationId' | 'organizationType'
> & {
  parentOrganizationId: PtvContentId;
  organizationType: OrganizationType;
};

export interface ApplyOrganizationChangeResult {
  organizationId: PtvContentId;
  publishingStatus: Organization['publishingStatus'];
  appliedAt: string;
}

export interface ApplyChannelChangeResult {
  channelId: PtvContentId;
  publishingStatus: ServiceChannel['publishingStatus'];
  appliedAt: string;
}

export interface ApplyServiceChangeResult {
  serviceId: PtvContentId;
  publishingStatus: Service['publishingStatus'];
  appliedAt: string;
}

/**
 * The one interface every PTV API version implements. MCP tools, the
 * diff engine, and validation call only this — never a version-specific
 * client directly. A concrete instance is already fully credentialed by
 * the time PtvAdapterRegistry (Phase 3) hands it out; no auth parameters
 * appear on these methods.
 */
export class OntologySearchUnsupportedError extends Error {
  constructor(apiVersion: string) {
    super(
      `Ontology term search is not available on PTV ${apiVersion}: it has no ontology ` +
        `endpoint. Reconnect with v12 as the read API version to search ontology terms.`,
    );
    this.name = 'OntologySearchUnsupportedError';
  }
}

export interface PtvAdapter {
  getCapabilities(): PtvAdapterCapabilities;

  searchServices(params: SearchParams): Promise<PaginatedResult<Service>>;
  getService(id: PtvContentId): Promise<Service | null>;

  searchChannels(params: SearchParams): Promise<PaginatedResult<ServiceChannel>>;
  getChannel(id: PtvContentId): Promise<ServiceChannel | null>;

  searchOrganisations(params: SearchParams): Promise<PaginatedResult<Organization>>;
  getOrganisation(id: PtvContentId): Promise<Organization | null>;
  getOrganisationHierarchy(id: PtvContentId): Promise<Organization[]>;

  searchServiceCollections(params: SearchParams): Promise<PaginatedResult<ServiceCollection>>;
  searchGeneralDescriptions(params: SearchParams): Promise<PaginatedResult<GeneralDescription>>;
  /** One general description, or null when unknown (or the adapter can't read them). */
  getGeneralDescription(id: PtvContentId): Promise<GeneralDescription | null>;

  getConnectionsFor(entityId: PtvContentId): Promise<Connection[]>;

  listCodes(codeListName: string): Promise<CodeListEntry[]>;

  /**
   * Search PTV's ontology terms (KOKO concepts, which include YSO, MAO and
   * other Finto ontologies) by name. Entries carry the KOKO `uri` that a
   * service's `ontologyTerms` must use. Only valid (non-deprecated) terms
   * are returned. Adapters whose API has no ontology endpoint (v11) throw
   * OntologySearchUnsupportedError.
   */
  searchOntologyTerms(params: SearchParams): Promise<PaginatedResult<CodeListEntry>>;

  /**
   * Writes an approved change to PTV. Throws if `getCapabilities().supportsWrite`
   * is false — callers (Phase 4's ptv_apply_changes) must check capabilities
   * first and surface a clear error rather than relying on this throwing.
   */
  applyServiceChange(proposal: ServiceChangeProposal): Promise<ApplyServiceChangeResult>;

  /** Creates a new service; same write-capability rules as applyServiceChange. */
  createService(service: NewService): Promise<ApplyServiceChangeResult>;

  /** Writes an approved change to an existing service channel; same rules as applyServiceChange. */
  applyChannelChange(proposal: ChannelChangeProposal): Promise<ApplyChannelChangeResult>;

  /** Creates a new service channel; same write-capability rules as applyServiceChange. */
  createChannel(channel: NewChannel): Promise<ApplyChannelChangeResult>;

  /**
   * Writes an approved change to an existing connection's extra info; same
   * write-capability rules as applyServiceChange.
   */
  applyConnectionChange(proposal: ConnectionChangeProposal): Promise<ApplyConnectionChangeResult>;

  /** Writes an approved change to an existing organisation; same rules as applyServiceChange. */
  applyOrganizationChange(
    proposal: OrganizationChangeProposal,
  ): Promise<ApplyOrganizationChangeResult>;

  /** Creates a sub-organisation; same write-capability rules as applyServiceChange. */
  createOrganization(organization: NewOrganization): Promise<ApplyOrganizationChangeResult>;
}
