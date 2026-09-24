import type { ServiceChannel } from '../../domain.js';
import type { V11ServiceChannelWire } from '../wireModel.js';
import { toLocalizedText, toPublishingStatus } from './common.js';
import {
  accessibilityToDomain,
  deliveryAddressToDomain,
  formFilesToDomain,
  languageItemsToText,
  languageValues,
  locationAddressToDomain,
  phoneToDomain,
  serviceHourToDomain,
  webPagesToUrls,
  webPageToDomain,
} from '../channelFields.js';

const CHANNEL_TYPE_MAP: Record<string, ServiceChannel['channelType']> = {
  EChannel: 'EChannel',
  Phone: 'Phone',
  PrintableForm: 'PrintableForm',
  ServiceLocation: 'ServiceLocation',
  WebPage: 'WebPage',
};

function toChannelType(wireType: string): ServiceChannel['channelType'] {
  const mapped = CHANNEL_TYPE_MAP[wireType];
  if (!mapped) throw new Error(`Unknown v11 service channel type: ${wireType}`);
  return mapped;
}

/** Channel types whose web page list is the channel's own address (webPage on write). */
const URL_CHANNEL_TYPES = new Set(['EChannel', 'WebPage', 'Phone']);

export function serviceChannelWireToDomain(wire: V11ServiceChannelWire): ServiceChannel {
  const channelType = toChannelType(wire.serviceChannelType);
  const summaries = toLocalizedText(
    (wire.serviceChannelDescriptions ?? []).filter((item) => item.type === 'Summary'),
    ['Summary'],
  );
  const descriptions = toLocalizedText(
    (wire.serviceChannelDescriptions ?? []).filter((item) => item.type === 'Description'),
    ['Description'],
  );
  const phones = (wire.phoneNumbers ?? []).map(phoneToDomain);
  const supportPhones = (wire.supportPhones ?? []).map(phoneToDomain);
  const emails = languageValues(wire.supportEmails);
  const serviceHours = (wire.serviceHours ?? []).map(serviceHourToDomain);
  const urlChannel = URL_CHANNEL_TYPES.has(channelType);
  const urls = urlChannel ? webPagesToUrls(wire.webPages) : {};
  const webPages = urlChannel ? [] : (wire.webPages ?? []).map(webPageToDomain);
  const accessibility = accessibilityToDomain(wire.accessibilityClassification);
  const signatureQuantity = Number(wire.signatureQuantity);
  return {
    id: wire.id,
    ...(wire.sourceId ? { sourceId: wire.sourceId } : {}),
    organizationId: wire.organizationId,
    channelType,
    publishingStatus: toPublishingStatus(wire.publishingStatus),
    names: toLocalizedText(wire.serviceChannelNames, ['Name']),
    summaries,
    descriptions,
    languages: wire.languages ?? [],
    ...(typeof wire.isVisibleForAll === 'boolean' ? { isVisibleForAll: wire.isVisibleForAll } : {}),
    ...(Object.keys(urls).length > 0 ? { urls } : {}),
    ...(webPages.length > 0 ? { webPages } : {}),
    ...(phones.length > 0 ? { phoneNumbers: phones } : {}),
    // A service location's supportEmails are its contact emails.
    ...(emails.length > 0
      ? channelType === 'ServiceLocation'
        ? { emails }
        : { supportEmails: emails }
      : {}),
    ...(supportPhones.length > 0 ? { supportPhones } : {}),
    ...(serviceHours.length > 0 ? { serviceHours } : {}),
    ...(wire.addresses?.length ? { addresses: wire.addresses.map(locationAddressToDomain) } : {}),
    ...(wire.deliveryAddresses?.length
      ? { deliveryAddresses: wire.deliveryAddresses.map(deliveryAddressToDomain) }
      : {}),
    ...(wire.formIdentifier?.length
      ? { formIdentifiers: languageItemsToText(wire.formIdentifier) }
      : {}),
    ...(wire.channelUrls?.length ? { formFiles: formFilesToDomain(wire.channelUrls) } : {}),
    ...(channelType === 'EChannel'
      ? {
          requiresAuthentication: wire.requiresAuthentication ?? false,
          requiresSignature: wire.requiresSignature ?? false,
          ...(Number.isFinite(signatureQuantity) && signatureQuantity > 0
            ? { signatureQuantity }
            : {}),
        }
      : {}),
    ...(accessibility ? { accessibility } : {}),
    modifiedAt: wire.modified,
  };
}
