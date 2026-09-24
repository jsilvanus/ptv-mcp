/**
 * Hand-typed, narrow views of PTV v11's wire format — only the fields the
 * mappers in ./mappers actually read, verified against the real API
 * (both api.palvelutietovaranto.suomi.fi and its .trn.suomi.fi test
 * counterpart return identical shapes) rather than assumed from the
 * OpenAPI doc alone. The full generated types in ./wire-types.ts (from
 * the vendored swagger.json) remain available for reference and for
 * anything needing the complete wire contract; these narrower types trade
 * that completeness for mapper code that's easy to read and verify.
 */

export interface V11LocalizedItem {
  language: string;
  /** PTV returns `null` for an empty optional text, e.g. `UserInstruction`. */
  value: string | null;
  type?: string;
}

export interface V11CodeListItem {
  name: V11LocalizedItem[];
  description?: V11LocalizedItem[];
  code?: string | null;
  uri?: string | null;
}

/**
 * Shape of v11's standalone reference code-list endpoints
 * (CodeList/GetLanguageCodes, GetCountryCodes, GetMunicipalityCodes,
 * GetPostalCodes) — confirmed live: `[{"code":"am","names":[{"value":...,
 * "language":...}]}]`, a plain array with plural `names`, distinct from
 * V11CodeListItem's singular `name` used on entity-embedded
 * classifications (serviceClasses, ontologyTerms, etc).
 */
export interface V11ReferenceCodeItem {
  code: string;
  names: V11LocalizedItem[];
}

export interface V11PagedList<T> {
  pageNumber: number;
  pageSize: number;
  pageCount: number;
  itemList: T[];
}

export interface V11IdNamePair {
  id: string;
  name?: string;
}

export type V11PublishingStatus =
  'Draft' | 'Published' | 'Modified' | 'Deleted' | 'Archived' | 'Withdrawn';

export interface V11ServiceOrganizationRole {
  organization: V11IdNamePair;
  roleType: 'Responsible' | 'Producer' | string;
}

export interface V11ServiceChannelRelation {
  serviceChannel: V11IdNamePair;
  /** Connection extra info, only kept to resend it (see connectionWrite.ts). */
  serviceChargeType?: string | null;
  description?: V11LocalizedItem[] | null;
  serviceHours?: unknown[] | null;
  contactDetails?: unknown;
  modified?: string;
}

export interface V11ServiceWire {
  id: string;
  sourceId?: string | null;
  type: 'Service' | 'PermitOrObligation' | 'ProfessionalQualification' | string;
  generalDescriptionId?: string | null;
  publishingStatus: V11PublishingStatus;
  serviceNames: V11LocalizedItem[];
  serviceDescriptions: V11LocalizedItem[];
  serviceClasses: V11CodeListItem[];
  ontologyTerms: V11CodeListItem[];
  targetGroups: V11CodeListItem[];
  lifeEvents: V11CodeListItem[];
  industrialClasses: V11CodeListItem[];
  languages: string[];
  organizations: V11ServiceOrganizationRole[];
  /** `null`, not `[]`, when the service has no connections. */
  serviceChannels: V11ServiceChannelRelation[] | null;
  modified: string;
}

/** Summary item returned by GET /api/v11/ServiceCollection/organization. */
export interface V11ServiceCollectionSummaryWire {
  id: string;
  serviceCollectionNames?: V11LocalizedItem[];
  serviceCollectionDescriptions?: V11LocalizedItem[];
  services?: V11IdNamePair[];
  serviceChannels?: V11IdNamePair[];
  name?: string;
}

export interface V11ServiceRelation {
  service: V11IdNamePair;
  modified?: string;
}

export interface V11ServiceChannelWire {
  id: string;
  sourceId?: string | null;
  serviceChannelType: string;
  organizationId: string;
  publishingStatus: V11PublishingStatus;
  serviceChannelNames: V11LocalizedItem[];
  serviceChannelDescriptions: V11LocalizedItem[];
  languages: string[];
  services?: V11ServiceRelation[];
  modified: string;
}

export interface V11OrganizationWire {
  id: string;
  sourceId?: string | null;
  parentOrganizationId?: string | null;
  businessCode?: string | null;
  publishingStatus: V11PublishingStatus;
  organizationNames: V11LocalizedItem[];
  modified: string;
}

export interface V11GeneralDescriptionWire {
  id: string;
  type: string;
  publishingStatus: V11PublishingStatus;
  names: V11LocalizedItem[];
  descriptions: V11LocalizedItem[];
  serviceClasses: V11CodeListItem[];
  ontologyTerms: V11CodeListItem[];
  targetGroups: V11CodeListItem[];
  lifeEvents: V11CodeListItem[];
  industrialClasses: V11CodeListItem[];
  modified: string;
}

export interface V11ServiceCollectionWire {
  id: string;
  sourceId?: string | null;
  serviceCollectionNames: V11LocalizedItem[];
  serviceCollectionDescriptions: V11LocalizedItem[];
  services?: V11IdNamePair[];
  publishingStatus: V11PublishingStatus;
  modified: string;
}
