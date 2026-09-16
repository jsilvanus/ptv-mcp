/** Shared version-neutral PTV domain model. */
export type LanguageCode = string;
export type LocalizedText = Partial<Record<LanguageCode, string>>;
export type PublishingStatus = 'Draft' | 'Published' | 'Archived' | 'Withdrawn';
export type PtvContentId = string;

export interface CodeListEntry { code?: string; uri?: string; names: LocalizedText; }
export type ServiceType = 'Service' | 'ProfessionalQualification' | 'PermitOrObligation';

export interface Service {
  id: PtvContentId; sourceId?: string; organizationId: PtvContentId; serviceType: ServiceType;
  publishingStatus: PublishingStatus; names: LocalizedText; summaries: LocalizedText;
  descriptions: LocalizedText; serviceClasses: CodeListEntry[]; ontologyTerms: CodeListEntry[];
  targetGroups: CodeListEntry[]; lifeEvents: CodeListEntry[]; industrialClasses: CodeListEntry[];
  languages: LanguageCode[]; generalDescriptionId?: PtvContentId;
  serviceChannelIds: PtvContentId[]; modifiedAt: string;
}

export type ServiceChannelType = 'EChannel' | 'Phone' | 'PrintableForm' | 'ServiceLocation' | 'WebPage';
export interface ServiceChannel {
  id: PtvContentId; sourceId?: string; organizationId: PtvContentId; channelType: ServiceChannelType;
  publishingStatus: PublishingStatus; names: LocalizedText; descriptions: LocalizedText;
  languages: LanguageCode[]; modifiedAt: string;
}
export interface Organization {
  id: PtvContentId; sourceId?: string; parentOrganizationId?: PtvContentId; businessCode?: string;
  publishingStatus: PublishingStatus; names: LocalizedText; modifiedAt: string;
}
export interface GeneralDescription {
  id: PtvContentId; serviceType: ServiceType; publishingStatus: PublishingStatus;
  names: LocalizedText; descriptions: LocalizedText; serviceClasses: CodeListEntry[];
  ontologyTerms: CodeListEntry[]; targetGroups: CodeListEntry[]; lifeEvents: CodeListEntry[];
  industrialClasses: CodeListEntry[]; modifiedAt: string;
}
export interface ServiceCollection {
  id: PtvContentId; publishingStatus: PublishingStatus; names: LocalizedText;
  descriptions: LocalizedText; serviceIds: PtvContentId[]; modifiedAt: string;
}
export interface Connection {
  serviceId: PtvContentId; channelId: PtvContentId; descriptions?: LocalizedText; modifiedAt: string;
}

export interface Pagination {
  page: number;
  pageSize: number;
  pageCount?: number;
  totalCount?: number;
}
export interface PaginatedResult<T> extends Pagination { items: T[]; }

export interface PageParams {
  page?: number;
  /** Logical result size; adapters may use smaller upstream batches. */
  pageSize?: number;
}

/** Version-neutral search intent; adapters translate this to their native API. */
export interface SearchCriteria {
  keyword?: string;
  organizationIds?: PtvContentId[];
  serviceClassUris?: string[];
  industrialClassCodes?: string[];
  targetGroupUris?: string[];
  areaCodes?: string[];
  serviceType?: ServiceType;
  channelTypes?: ServiceChannelType[];
  organizationTypes?: string[];
  generalDescriptionTypes?: ServiceType[];
  serviceId?: PtvContentId;
  channelId?: PtvContentId;
}
export interface SearchParams extends PageParams { criteria?: SearchCriteria; }
