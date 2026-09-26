/**
 * The v12 wire shapes the mappers read. v12's responses have varied between
 * environments and spec revisions, so each field lists every name seen;
 * the mappers take the first one present.
 */

/** A content id, bare or as a reference object. */
export type V12IdRef = string | { contentId?: string; id?: string };

export interface V12Timestamps {
  modifiedAt?: string | number;
  modified?: string | number;
  lastModified?: string | number;
  lastModifiedAt?: string | number;
  updatedAt?: string | number;
}

export interface V12OrganizationRef {
  organizationId?: string;
  organizationContentId?: string;
  organization?: {
    contentId?: string;
    id?: string;
    organizationId?: string;
    organizationContentId?: string;
  };
}

/** Localized texts: per field, or all together in `languageVersions` (`{fi: {name, ...}}`). */
export interface V12Names {
  name?: unknown;
  names?: unknown;
  languageVersions?: Record<string, unknown>;
}

export interface V12Described extends V12Names {
  description?: unknown;
  descriptions?: unknown;
}

export interface V12Classified {
  serviceClasses?: unknown[];
  ontologyTerms?: unknown[];
  targetGroups?: unknown[];
  lifeEvents?: unknown[];
  industrialClasses?: unknown[];
}

interface V12Content extends V12Timestamps {
  contentId?: string;
  id?: string;
  publishingStatus?: string;
}

export interface V12ServiceChannelWire extends V12Content, V12OrganizationRef, V12Described {
  sourceId?: string;
  serviceChannelType?: string;
  serviceLanguages?: string[];
  channelType?: string;
  type?: string;
  languages?: string[];
  publishedAt?: string;
  migratedAt?: string;
}

export interface V12OrganizationWire extends V12Content, V12Names {
  sourceId?: string;
  parentOrganizationContentId?: string | null;
  parentOrganizationId?: string;
  parentOrganization?: { contentId?: string; id?: string };
  businessCode?: string;
  businessId?: string;
}

export interface V12ServiceWire
  extends V12Content, V12OrganizationRef, V12Described, V12Classified {
  sourceId?: string;
  serviceType?: string;
  type?: string;
  summary?: unknown;
  summaries?: unknown;
  languages?: string[];
  generalDescriptionContentId?: string | null;
  generalDescriptionId?: string;
  serviceLanguages?: string[];
  serviceChannelIds?: V12IdRef[];
  serviceChannels?: V12IdRef[];
}

export interface V12ServiceCollectionWire extends V12Content, V12Described {
  organizationContentId?: string;
  organizationId?: string;
  services?: V12IdRef[];
  serviceIds?: V12IdRef[];
  /** v12: collection members, each tagged Service or Channel. */
  items?: Array<{ itemType?: string; contentId?: string }>;
  serviceChannels?: V12IdRef[];
}

export interface V12GeneralDescriptionWire extends V12Content, V12Described, V12Classified {
  serviceType?: string;
  type?: string;
  organizationContentId?: string;
  organizationId?: string;
}
