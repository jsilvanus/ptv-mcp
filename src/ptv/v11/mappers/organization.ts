import type {
  ChannelAddress,
  LocalizedText,
  Organization,
  OrganizationArea,
  OrganizationType,
} from '../../domain.js';
import {
  locationAddressToDomain,
  locationAddressToWire,
  phoneToDomain,
  webPageToDomain,
  type V11LocationAddress,
  type V11Phone,
  type V11WebPage,
} from '../channelFields.js';
import type { V11LocalizedItem, V11OrganizationWire } from '../wireModel.js';
import { toLocalizedText, toPublishingStatus } from './common.js';

const ORGANIZATION_TYPES: OrganizationType[] = [
  'State',
  'Region',
  'RegionalOrganization',
  'Municipality',
  'Organization',
  'Company',
  'SotePublic',
  'SotePrivate',
];

/** Entries of exactly one type (toLocalizedText falls back to other types). */
export function itemsOfType(
  items: V11LocalizedItem[] | null | undefined,
  type: string,
): LocalizedText {
  const text: LocalizedText = {};
  for (const item of items ?? []) {
    if (item.type === type && item.value) text[item.language] = item.value;
  }
  return text;
}

function nonEmpty(text: LocalizedText): LocalizedText | undefined {
  return Object.keys(text).length > 0 ? text : undefined;
}

/**
 * Organisation addresses (V9VmOpenApiAddress) read like service location
 * addresses, except that a foreign address is sub type `Foreign`, not
 * `Abroad`.
 */
function organizationAddressToDomain(wire: V11LocationAddress): ChannelAddress {
  return locationAddressToDomain(
    wire.subType === 'Foreign' ? { ...wire, subType: 'Abroad' } : wire,
  );
}

/** V9VmOpenApiAddressIn: type Visiting or Postal; sub type Street, PostOfficeBox, Foreign or Other. */
export function organizationAddressToWire(address: ChannelAddress): V11LocationAddress {
  const wire = locationAddressToWire(address);
  return {
    ...wire,
    type: address.purpose === 'Postal' ? 'Postal' : 'Visiting',
    ...(wire.subType === 'Abroad' ? { subType: 'Foreign' } : {}),
  };
}

function organizationArea(wire: V11OrganizationWire): OrganizationArea | undefined {
  const areaType = wire.areaType;
  if (
    areaType !== 'Nationwide' &&
    areaType !== 'NationwideExceptAlandIslands' &&
    areaType !== 'LimitedType'
  ) {
    return undefined;
  }
  const areas = (wire.areas ?? [])
    .filter((area) => area.type && area.code)
    .map((area) => ({ type: area.type as string, code: area.code as string }));
  return { areaType, ...(areaType === 'LimitedType' ? { areas } : {}) };
}

export function organizationWireToDomain(wire: V11OrganizationWire): Organization {
  const organizationType = ORGANIZATION_TYPES.find((type) => type === wire.organizationType);
  const alternativeNames = nonEmpty(itemsOfType(wire.organizationNames, 'AlternativeName'));
  const alternativeNameShownIn = (wire.displayNameType ?? [])
    .filter((entry) => entry.type === 'AlternativeName' || entry.type === 'AlternateName')
    .map((entry) => entry.language);
  const summaries = nonEmpty(itemsOfType(wire.organizationDescriptions, 'Summary'));
  const descriptions = nonEmpty(itemsOfType(wire.organizationDescriptions, 'Description'));
  const area = organizationArea(wire);
  const emails = (wire.emails ?? [])
    .filter((email) => !!email.value)
    .map((email) => ({ language: email.language, value: email.value as string }));
  const phoneNumbers = ((wire.phoneNumbers ?? []) as V11Phone[]).map(phoneToDomain);
  const webPages = ((wire.webPages ?? []) as V11WebPage[]).map(webPageToDomain);
  const addresses = ((wire.addresses ?? []) as V11LocationAddress[]).map(
    organizationAddressToDomain,
  );
  return {
    id: wire.id,
    ...(wire.sourceId ? { sourceId: wire.sourceId } : {}),
    ...(wire.parentOrganizationId ? { parentOrganizationId: wire.parentOrganizationId } : {}),
    ...(wire.businessCode ? { businessCode: wire.businessCode } : {}),
    publishingStatus: toPublishingStatus(wire.publishingStatus),
    names: toLocalizedText(wire.organizationNames, ['Name']),
    ...(organizationType ? { organizationType } : {}),
    ...(alternativeNames ? { alternativeNames } : {}),
    ...(alternativeNameShownIn.length > 0 ? { alternativeNameShownIn } : {}),
    ...(summaries ? { summaries } : {}),
    ...(descriptions ? { descriptions } : {}),
    ...(area ? { area } : {}),
    ...(wire.municipality?.code ? { municipality: wire.municipality.code } : {}),
    ...(emails.length > 0 ? { emails } : {}),
    ...(phoneNumbers.length > 0 ? { phoneNumbers } : {}),
    ...(webPages.length > 0 ? { webPages } : {}),
    ...(addresses.length > 0 ? { addresses } : {}),
    modifiedAt: wire.modified,
  };
}
