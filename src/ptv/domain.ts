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
 *
 * `Modified` is v11's state for a published entity with a newer, unpublished
 * version on top of it: the public read still returns the published
 * version, the restricted `active` read returns the modified one.
 */
export type PublishingStatus = 'Draft' | 'Published' | 'Modified' | 'Archived' | 'Withdrawn';

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
  modifiedAt?: string;
}

export type ServiceChannelType =
  'EChannel' | 'Phone' | 'PrintableForm' | 'ServiceLocation' | 'WebPage';

/** One localized value in a list that may hold several per language (e.g. emails). */
export interface LanguageValue {
  language: LanguageCode;
  value: string;
}

/**
 * A phone, text message or fax number. Normal numbers carry a country
 * prefix (e.g. +358) and are written without the leading 0; Finnish
 * service numbers (e.g. 020202) have no prefix.
 */
export interface PhoneNumber {
  language: LanguageCode;
  /** Phone channels and service locations; defaults to Phone. */
  type?: 'Phone' | 'Sms' | 'Fax';
  prefixNumber?: string;
  number: string;
  isFinnishServiceNumber?: boolean;
  /** e.g. "Vaihde", "Asiakaspalvelu"; never a person's name. */
  additionalInformation?: string;
  /** Chargeable = normal call cost, Other = extra charge, FreeOfCharge = free. */
  chargeType?: 'Chargeable' | 'FreeOfCharge' | 'Other';
  chargeDescription?: string;
}

/** A named web link, e.g. a service location's own web page or an attachment. */
export interface WebLink {
  language: LanguageCode;
  url: string;
  name?: string;
}

export type Weekday =
  'Monday' | 'Tuesday' | 'Wednesday' | 'Thursday' | 'Friday' | 'Saturday' | 'Sunday';

/** One opening time within a service hour: `from`/`to` as HH:mm. */
export interface OpeningTime {
  dayFrom: Weekday;
  /**
   * OverMidnight: the day the time ends on. Otherwise shorthand for the same
   * times on every day from dayFrom to dayTo (written out one per day).
   */
  dayTo?: Weekday;
  from: string;
  to: string;
}

/**
 * Service hours (palveluajat). DaysOfTheWeek is the normal weekly
 * schedule; Exceptional overrides it for a date range (isClosed for
 * closures); OverMidnight spans days. Without openingTimes, isAlwaysOpen
 * or isReservation (open by appointment) describe the hour.
 */
export interface ServiceHour {
  type: 'DaysOfTheWeek' | 'Exceptional' | 'OverMidnight';
  /** ISO date (YYYY-MM-DD); omit with validForNow for "until further notice". */
  validFrom?: string;
  validTo?: string;
  validForNow?: boolean;
  isClosed?: boolean;
  isAlwaysOpen?: boolean;
  isReservation?: boolean;
  /** A short title such as "Kesäaika" (max 150 characters). */
  additionalInformation?: LocalizedText;
  openingTimes?: OpeningTime[];
}

/**
 * A visiting address (service locations) or a delivery address (printable
 * forms). `Street` addresses are what map services and Suomi.fi show;
 * `Other` is coordinates plus a description for places without a street
 * address; `Foreign` is free text abroad; `PostOfficeBox` and `NoAddress`
 * (delivery instructions in text) only for delivery addresses.
 */
export interface ChannelAddress {
  kind: 'Street' | 'Other' | 'Foreign' | 'PostOfficeBox' | 'NoAddress';
  /** Service locations: a visiting address (default) or a postal address. */
  purpose?: 'Visiting' | 'Postal';
  street?: LocalizedText;
  streetNumber?: string;
  postalCode?: string;
  /** Municipality code, e.g. 694 (read only; PTV derives it). */
  municipality?: string;
  postOfficeBox?: LocalizedText;
  latitude?: string;
  longitude?: string;
  /** Helps the customer find the place, e.g. the entrance (max 150 characters). */
  additionalInformation?: LocalizedText;
  /** Foreign addresses, and NoAddress delivery instructions. */
  text?: LocalizedText;
  /** Delivery addresses only: who receives the form. */
  receiver?: LocalizedText;
}

/** Accessibility assessment of an e-service or web page (saavutettavuus). */
export type AccessibilityLevel =
  'FullyCompliant' | 'PartiallyCompliant' | 'NonCompliant' | 'Unknown';

/** A printable form file; one per language and file format. */
export interface FormFile {
  language: LanguageCode;
  format: 'PDF' | 'DOC' | 'Excel';
  url: string;
}

/**
 * A service channel. The common fields are always present; the rest are
 * optional because not every adapter or channel type carries them (see
 * CHANNEL_TYPE_FIELDS in src/mcp/channelProposal.ts for which type uses
 * which).
 */
export interface ServiceChannel {
  id: PtvContentId;
  sourceId?: string;
  organizationId: PtvContentId;
  channelType: ServiceChannelType;
  publishingStatus: PublishingStatus;
  names: LocalizedText;
  /** Short summary shown in search results (max 150 characters). */
  summaries?: LocalizedText;
  descriptions: LocalizedText;
  /** Languages the channel serves customers in. */
  languages: LanguageCode[];
  /** Whether other organisations may connect it to their services (default true). */
  isVisibleForAll?: boolean;
  /** EChannel and WebPage: the channel's address; Phone: an optional info page. */
  urls?: LocalizedText;
  /** Extra links (attachments, additional information pages; a service location's web pages). */
  webPages?: WebLink[];
  /** Phone and ServiceLocation. */
  phoneNumbers?: PhoneNumber[];
  /** ServiceLocation contact emails. */
  emails?: LanguageValue[];
  /** Käytön tuki: support contacts for using the channel (not ServiceLocation). */
  supportPhones?: PhoneNumber[];
  supportEmails?: LanguageValue[];
  serviceHours?: ServiceHour[];
  /** ServiceLocation visiting addresses. */
  addresses?: ChannelAddress[];
  /** PrintableForm: where to send the form, when the form doesn't say. */
  deliveryAddresses?: ChannelAddress[];
  /** PrintableForm: the form's own identifier, e.g. "LL 1". */
  formIdentifiers?: LocalizedText;
  formFiles?: FormFile[];
  /** EChannel. */
  requiresAuthentication?: boolean;
  requiresSignature?: boolean;
  signatureQuantity?: number;
  /** EChannel and WebPage. */
  accessibility?: AccessibilityLevel;
  modifiedAt?: string;
}

/**
 * PTV organisation types. Public: State, Region (maakunta),
 * RegionalOrganization (e.g. a wellbeing services county), Municipality;
 * private: Organization (järjestöt ja yhteisöt; parishes are described as
 * this or as their parent's type), Company. SotePublic/SotePrivate are
 * read-only legacy types.
 */
export type OrganizationType =
  | 'State'
  | 'Region'
  | 'RegionalOrganization'
  | 'Municipality'
  | 'Organization'
  | 'Company'
  | 'SotePublic'
  | 'SotePrivate';

/** Where an organisation mainly offers its services. */
export interface OrganizationArea {
  areaType: 'Nationwide' | 'NationwideExceptAlandIslands' | 'LimitedType';
  /** LimitedType: e.g. { type: 'Municipality', code: '694' }. */
  areas?: { type: string; code: string }[];
}

/**
 * An organisation. The fields after `names` are optional because not every
 * adapter reads them (v12 today reads names only).
 */
export interface Organization {
  id: PtvContentId;
  sourceId?: string;
  parentOrganizationId?: PtvContentId;
  /** Y-tunnus, 1234567-8. */
  businessCode?: string;
  publishingStatus: PublishingStatus;
  names: LocalizedText;
  organizationType?: OrganizationType;
  /** An unofficial name customers use (vaihtoehtoinen nimi). */
  alternativeNames?: LocalizedText;
  /** Languages that show the alternative name instead of the official one. */
  alternativeNameShownIn?: LanguageCode[];
  /** Max 150 characters; not a copy of the name. */
  summaries?: LocalizedText;
  /** Max 2500 characters (DVV); no contact details. */
  descriptions?: LocalizedText;
  area?: OrganizationArea;
  /** Municipality code, for a Municipality organisation. */
  municipality?: string;
  emails?: LanguageValue[];
  phoneNumbers?: PhoneNumber[];
  webPages?: WebLink[];
  /** A visiting address (the main office) and postal addresses. */
  addresses?: ChannelAddress[];
  modifiedAt?: string;
}

export interface GeneralDescription {
  id: PtvContentId;
  serviceType: ServiceType;
  publishingStatus: PublishingStatus;
  names: LocalizedText;
  descriptions: LocalizedText;
  /**
   * Every free text of the general description (summary, description,
   * background, instructions, ...) by language, for the copy check
   * (Q-GD-1). Present when the adapter reads it.
   */
  texts?: Partial<Record<LanguageCode, string[]>>;
  serviceClasses: CodeListEntry[];
  ontologyTerms: CodeListEntry[];
  targetGroups: CodeListEntry[];
  lifeEvents: CodeListEntry[];
  industrialClasses: CodeListEntry[];
  modifiedAt?: string;
}

export interface ServiceCollection {
  id: PtvContentId;
  publishingStatus: PublishingStatus;
  names: LocalizedText;
  descriptions: LocalizedText;
  serviceIds: PtvContentId[];
  modifiedAt?: string;
}

/**
 * A service↔channel relationship. v12 exposes this as its own fetchable
 * resource; v11 has no equivalent endpoint and only ever returns this
 * data embedded inside a Service/ServiceChannel payload — each adapter
 * is responsible for producing this same shape either way (see
 * docs/ptv-v11-notes.md, "No read-back for connections").
 */
export interface Connection extends ConnectionDetails {
  serviceId: PtvContentId;
  channelId: PtvContentId;
  modifiedAt?: string;
}

/**
 * A connection's extra info (liitoksen lisätiedot): what is specific to
 * this service in this channel, e.g. the service's own hours or phone
 * number at a shared service location. Every field is optional.
 */
export interface ConnectionDetails {
  /** Chargeable = the service costs something here, FreeOfCharge, Other. */
  chargeType?: 'Chargeable' | 'FreeOfCharge' | 'Other';
  /** Max 500 characters. */
  descriptions?: LocalizedText;
  /** More about the charge (ChargeTypeAdditionalInfo), max 500 characters. */
  chargeDescriptions?: LocalizedText;
  serviceHours?: ServiceHour[];
  emails?: LanguageValue[];
  /** Phone numbers; type Fax for fax numbers. */
  phoneNumbers?: PhoneNumber[];
  webPages?: WebLink[];
  /** Postal addresses only: Street, PostOfficeBox or Foreign. */
  addresses?: ChannelAddress[];
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
