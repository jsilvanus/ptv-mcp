/**
 * Shared domain model every PtvAdapter maps its own wire format to/from.
 * MCP tools, the diff engine, and validation only ever touch these types
 * — never a version-specific wire shape. See docs/plan.md's
 * "PTV-sovitinkerros" section and docs/ptv-v11-notes.md for why v11 and
 * v12 need this translation layer rather than sharing one wire format.
 */

/** ISO 639-1-ish language code as PTV uses them, e.g. "fi", "sv", "en". */
export type LanguageCode = string;

/** Text that varies by language, present only for the languages it's translated into. */
export type LocalizedText = Partial<Record<LanguageCode, string>>;

/**
 * PTV's own lifecycle state for an entity. Not exposed by v12's current
 * read-only API (which only ever returns Published/Archived split across
 * different endpoints), but explicit in v11's `publishingStatus` field —
 * see docs/ptv-v11-notes.md. Modeled here regardless so the domain model
 * doesn't need to change shape once v12 write ships and its equivalent
 * becomes visible too.
 */
export type PublishingStatus = 'Draft' | 'Published' | 'Archived' | 'Withdrawn';

/** PTV's own identifier for an entity (its `contentId` / `id`), not our DB's primary key. */
export type PtvContentId = string;

export interface CodeListEntry {
  /**
   * Optional: PTV v11's real data shows entries with no `code`, only a
   * `uri` (e.g. ontology terms) — confirmed against the live API during
   * Phase 2, not assumed. At least one of `code`/`uri` is expected to be
   * present in practice, but that isn't encoded in the type.
   */
  code?: string;
  uri?: string;
  names: LocalizedText;
}

/**
 * Normalizes PTV's three service subtypes (named differently across v11
 * and v12's beta schemas — see docs/ptv-v11-notes.md) to one domain enum.
 * Each adapter maps its own wire-format name to/from this value.
 */
export type ServiceType = 'Service' | 'ProfessionalQualification' | 'PermitOrObligation';

export interface Service {
  id: PtvContentId;
  /** An external system's own identifier for this entity, if it created/owns it. */
  sourceId?: string;
  organizationId: PtvContentId;
  serviceType: ServiceType;
  publishingStatus: PublishingStatus;
  names: LocalizedText;
  /** Short summary and full description, keyed the same way as `names`. */
  summaries: LocalizedText;
  descriptions: LocalizedText;
  serviceClasses: CodeListEntry[];
  /** Max 10 per PTV's v12 beta schema — see docs/plan.md's validation section. */
  ontologyTerms: CodeListEntry[];
  targetGroups: CodeListEntry[];
  lifeEvents: CodeListEntry[];
  industrialClasses: CodeListEntry[];
  languages: LanguageCode[];
  generalDescriptionId?: PtvContentId;
  /** IDs of connected service channels — see `Connection` for the fuller relationship. */
  serviceChannelIds: PtvContentId[];
  modifiedAt: string;
}

export type ServiceChannelType =
  'EChannel' | 'Phone' | 'PrintableForm' | 'ServiceLocation' | 'WebPage';

export interface ServiceChannel {
  id: PtvContentId;
  sourceId?: string;
  organizationId: PtvContentId;
  channelType: ServiceChannelType;
  publishingStatus: PublishingStatus;
  names: LocalizedText;
  descriptions: LocalizedText;
  languages: LanguageCode[];
  modifiedAt: string;
}

export interface Organization {
  id: PtvContentId;
  sourceId?: string;
  parentOrganizationId?: PtvContentId;
  businessCode?: string;
  publishingStatus: PublishingStatus;
  names: LocalizedText;
  modifiedAt: string;
}

export interface GeneralDescription {
  id: PtvContentId;
  serviceType: ServiceType;
  publishingStatus: PublishingStatus;
  names: LocalizedText;
  descriptions: LocalizedText;
  serviceClasses: CodeListEntry[];
  ontologyTerms: CodeListEntry[];
  targetGroups: CodeListEntry[];
  lifeEvents: CodeListEntry[];
  industrialClasses: CodeListEntry[];
  modifiedAt: string;
}

export interface ServiceCollection {
  id: PtvContentId;
  publishingStatus: PublishingStatus;
  names: LocalizedText;
  descriptions: LocalizedText;
  serviceIds: PtvContentId[];
  modifiedAt: string;
}

/**
 * A service↔channel relationship. v12 exposes this as its own fetchable
 * resource; v11 has no equivalent endpoint and only ever returns this
 * data embedded inside a Service/ServiceChannel payload — each adapter
 * is responsible for producing this same shape either way (see
 * docs/ptv-v11-notes.md, "No read-back for connections").
 */
export interface Connection {
  serviceId: PtvContentId;
  channelId: PtvContentId;
  descriptions?: LocalizedText;
  modifiedAt: string;
}

export interface PaginatedResult<T> {
  items: T[];
  page: number;
  pageSize: number;
  totalCount: number;
}

export interface SearchParams {
  /** User's PTV search text. Separate from tenant/environment context. */
  query?: string;
  /** Optional PTV organisation filter; this is not the OAuth tenant. */
  organizationId?: PtvContentId;
  page?: number;
  pageSize?: number;
}
