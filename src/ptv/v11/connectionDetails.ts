import type { ChannelAddress, ConnectionDetails } from '../domain.js';
import {
  CHARGE_TYPES,
  languageValues,
  locationAddressToDomain,
  phoneToDomain,
  phoneToWire,
  postOfficeBoxToWire,
  serviceHourToDomain,
  serviceHourToWire,
  streetToWire,
  textToLanguageItems,
  webLinkToWire,
  webPageToDomain,
  type V11LanguageItem,
  type V11LocationAddress,
  type V11Phone,
  type V11ServiceHour,
  type V11WebPage,
} from './channelFields.js';
import { itemsOfType, localizedTextToWireList } from './mappers/common.js';
import type { V11LocalizedItem } from './wireModel.js';

/**
 * A connection's extra info (liitoksen lisätiedot) on the v11 wire: the
 * relation fields of `V11VmOpenApiServiceServiceChannel` (GET, inside a
 * service's `serviceChannels`) and `V11VmOpenApiServiceServiceChannelInBase`
 * (PUT /api/v11/Connection/serviceId/{id}).
 *
 * GET and In differ in the contact details: GET lists fax numbers among
 * `phoneNumbers` (typed), In takes them as separate `faxNumbers`; GET
 * addresses read like service location addresses, In wants
 * `type: 'Postal'` (the only type PTV accepts here).
 */

export interface V11ContactDetails {
  emails?: V11LanguageItem[] | null;
  phoneNumbers?: V11Phone[] | null;
  faxNumbers?: V11Phone[] | null;
  webPages?: V11WebPage[] | null;
  addresses?: V11LocationAddress[] | null;
}

/** The extra-info fields of a v11 connection, as read (GET). */
export interface V11ConnectionExtraInfo {
  serviceChargeType?: string | null;
  description?: V11LocalizedItem[] | null;
  serviceHours?: unknown[] | null;
  contactDetails?: unknown;
}

export function connectionDetailsToDomain(wire: V11ConnectionExtraInfo): ConnectionDetails {
  const chargeType = wire.serviceChargeType ? CHARGE_TYPES[wire.serviceChargeType] : undefined;
  const descriptions = itemsOfType(wire.description, 'Description');
  const chargeDescriptions = itemsOfType(wire.description, 'ChargeTypeAdditionalInfo');
  const serviceHours = ((wire.serviceHours ?? []) as V11ServiceHour[]).map(serviceHourToDomain);
  const contact = (wire.contactDetails ?? {}) as V11ContactDetails;
  const emails = languageValues(contact.emails);
  const phoneNumbers = [
    ...(contact.phoneNumbers ?? []).map(phoneToDomain),
    ...(contact.faxNumbers ?? []).map((fax) => ({ ...phoneToDomain(fax), type: 'Fax' as const })),
  ];
  const webPages = (contact.webPages ?? []).map(webPageToDomain);
  // Connection addresses are all postal; `purpose` would add nothing.
  const addresses = (contact.addresses ?? []).map((address) => {
    const domain = locationAddressToDomain(address);
    delete domain.purpose;
    return domain;
  });
  return {
    ...(chargeType ? { chargeType } : {}),
    ...(descriptions ? { descriptions } : {}),
    ...(chargeDescriptions ? { chargeDescriptions } : {}),
    ...(serviceHours.length > 0 ? { serviceHours } : {}),
    ...(emails.length > 0 ? { emails } : {}),
    ...(phoneNumbers.length > 0 ? { phoneNumbers } : {}),
    ...(webPages.length > 0 ? { webPages } : {}),
    ...(addresses.length > 0 ? { addresses } : {}),
  };
}

/** V7VmOpenApiAddressContactIn: Postal only, sub type Street, PostOfficeBox or Abroad. */
function contactAddressToWire(address: ChannelAddress): Record<string, unknown> {
  switch (address.kind) {
    case 'PostOfficeBox':
      return {
        type: 'Postal',
        subType: 'PostOfficeBox',
        postOfficeBoxAddress: postOfficeBoxToWire(address),
      };
    case 'Foreign':
      return {
        type: 'Postal',
        subType: 'Abroad',
        locationAbroad: textToLanguageItems(address.text),
      };
    default:
      return { type: 'Postal', subType: 'Street', streetAddress: streetToWire(address) };
  }
}

/**
 * The extra-info fields of one `channelRelations` entry. An empty or
 * missing field is sent with its delete flag, so the connection ends up
 * holding exactly `details`.
 */
export function connectionDetailsToWire(details: ConnectionDetails): Record<string, unknown> {
  const description = [
    ...localizedTextToWireList(details.descriptions, 'Description'),
    ...localizedTextToWireList(details.chargeDescriptions, 'ChargeTypeAdditionalInfo'),
  ];
  const hours = details.serviceHours ?? [];
  const phones = (details.phoneNumbers ?? []).filter((phone) => phone.type !== 'Fax');
  const faxes = (details.phoneNumbers ?? []).filter((phone) => phone.type === 'Fax');
  const emails = details.emails ?? [];
  const webPages = details.webPages ?? [];
  const addresses = details.addresses ?? [];
  return {
    ...(details.chargeType
      ? { serviceChargeType: details.chargeType }
      : { deleteServiceChargeType: true }),
    ...(description.length > 0 ? { description } : { deleteAllDescriptions: true }),
    ...(hours.length > 0
      ? { serviceHours: hours.map(serviceHourToWire) }
      : { deleteAllServiceHours: true }),
    contactDetails: {
      ...(emails.length > 0
        ? { emails: emails.map((email) => ({ language: email.language, value: email.value })) }
        : { deleteAllEmails: true }),
      ...(phones.length > 0
        ? { phoneNumbers: phones.map((phone) => phoneToWire(phone)) }
        : { deleteAllPhones: true }),
      ...(faxes.length > 0
        ? {
            faxNumbers: faxes.map((fax) => ({
              language: fax.language,
              number: fax.number,
              ...(fax.isFinnishServiceNumber
                ? { isFinnishServiceNumber: true }
                : { prefixNumber: fax.prefixNumber ?? '+358' }),
            })),
          }
        : { deleteAllFaxNumbers: true }),
      ...(webPages.length > 0
        ? { webPages: webPages.map(webLinkToWire) }
        : { deleteAllWebPages: true }),
      ...(addresses.length > 0
        ? { addresses: addresses.map(contactAddressToWire) }
        : { deleteAllAddresses: true }),
    },
  };
}
