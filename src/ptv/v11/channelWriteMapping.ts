import type { ServiceChannel } from '../domain.js';
import type { NewChannel } from '../adapter.js';
import { localizedTextToWireList, toV11WritePublishingStatus } from './mappers/common.js';
import {
  accessibilityToWire,
  deliveryAddressToWire,
  formFilesToWire,
  locationAddressToWire,
  phoneToWire,
  serviceHourToWire,
  textToLanguageItems,
  webLinkToWire,
} from './channelFields.js';
import type { V11LocalizedItem, V11ServiceChannelWire } from './wireModel.js';

/**
 * The body for `PUT /api/v11/ServiceChannel/{type}/{id}`, built on the
 * channel's current record the same way as a service PUT (see
 * writeMapping.ts): publishingStatus is always sent, and the localized
 * lists keep the entry types the domain model doesn't carry.
 *
 * The domain's `descriptions` and `summaries` are the `Description` and
 * `Summary` entries; the one not being changed is kept as it is. When
 * `languages` changes, kept entries of dropped languages go too.
 *
 * The type-specific fields (channelDetailsToV11) are sent only when they
 * are in `changes`: a PUT leaves a list it doesn't mention untouched
 * (verified live for descriptions-only PUTs), and an emptied list is
 * cleared with its `deleteAll*` flag.
 */
export function channelChangesToV11Body(
  changes: Partial<ServiceChannel>,
  current: V11ServiceChannelWire,
): Record<string, unknown> {
  const languages = changes.languages;
  const kept = (items: V11LocalizedItem[] | null | undefined, replacedTypes: string[]) =>
    (items ?? []).filter(
      (item) =>
        !!item.value &&
        !replacedTypes.includes(item.type ?? '') &&
        (languages === undefined || languages.includes(item.language)),
    );

  const body: Record<string, unknown> = {
    publishingStatus: changes.publishingStatus
      ? toV11WritePublishingStatus(changes.publishingStatus)
      : current.publishingStatus,
  };

  if (current.serviceChannelType === 'EChannel') {
    body.requiresAuthentication =
      changes.requiresAuthentication ?? current.requiresAuthentication ?? false;
  }

  if ('names' in changes) {
    body.serviceChannelNames = [
      ...kept(current.serviceChannelNames, ['Name']),
      ...localizedTextToWireList(changes.names, 'Name'),
    ];
  }
  const replaced = [
    ...('descriptions' in changes ? ['Description'] : []),
    ...('summaries' in changes ? ['Summary'] : []),
  ];
  if (replaced.length > 0 || languages !== undefined) {
    body.serviceChannelDescriptions = [
      ...kept(current.serviceChannelDescriptions, replaced),
      ...('summaries' in changes ? localizedTextToWireList(changes.summaries, 'Summary') : []),
      ...('descriptions' in changes
        ? localizedTextToWireList(changes.descriptions, 'Description')
        : []),
    ];
  }
  if (languages !== undefined) {
    body.languages = languages;
    if (!('names' in changes)) {
      body.serviceChannelNames = kept(current.serviceChannelNames, []);
    }
  }
  const type = current.serviceChannelType as ServiceChannel['channelType'];
  Object.assign(
    body,
    channelDetailsToV11(
      changes,
      type,
      changes.names
        ? Object.keys(changes.names)
        : [...new Set((current.serviceChannelNames ?? []).map((item) => item.language))],
      true,
    ),
  );
  return body;
}

/** The body for `POST /api/v11/ServiceChannel/{type}`. */
export function newChannelToV11Body(channel: NewChannel): Record<string, unknown> {
  const body: Record<string, unknown> = {
    organizationId: channel.organizationId,
    publishingStatus: toV11WritePublishingStatus(channel.publishingStatus),
    languages: channel.languages,
    serviceChannelNames: localizedTextToWireList(channel.names, 'Name'),
    serviceChannelDescriptions: [
      ...localizedTextToWireList(channel.summaries, 'Summary'),
      ...localizedTextToWireList(channel.descriptions, 'Description'),
    ],
    isVisibleForAll: channel.isVisibleForAll ?? true,
    ...(channel.serviceIds?.length ? { services: channel.serviceIds } : {}),
    ...channelDetailsToV11(channel, channel.channelType, Object.keys(channel.names), false),
  };
  if (channel.channelType === 'ServiceLocation') {
    body.displayNameType = channel.languages.map((language) => ({ type: 'Name', language }));
  }
  if (channel.channelType === 'EChannel') {
    body.requiresAuthentication = channel.requiresAuthentication ?? false;
  }
  if (
    (channel.channelType === 'EChannel' || channel.channelType === 'WebPage') &&
    !body.accessibilityClassification
  ) {
    // Required on create; "Ei tietoa" unless an assessment has been made.
    body.accessibilityClassification = accessibilityToWire('Unknown', Object.keys(channel.names));
  }
  return body;
}

/**
 * The type-specific fields present in `fields`. With `forUpdate`, an empty
 * list becomes its `deleteAll*` flag (PTV ignores an empty list on PUT).
 */
function channelDetailsToV11(
  fields: Partial<ServiceChannel>,
  type: ServiceChannel['channelType'],
  languages: string[],
  forUpdate: boolean,
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  const list = (key: string, deleteFlag: string | null, items: unknown[]) => {
    if (items.length > 0) body[key] = items;
    else if (forUpdate && deleteFlag) body[deleteFlag] = true;
    else if (forUpdate) body[key] = [];
  };

  if ('isVisibleForAll' in fields && fields.isVisibleForAll !== undefined) {
    body.isVisibleForAll = fields.isVisibleForAll;
  }
  if ('serviceHours' in fields) {
    list(
      'serviceHours',
      'deleteAllServiceHours',
      (fields.serviceHours ?? []).map(serviceHourToWire),
    );
  }
  if ('supportPhones' in fields) {
    list(
      'supportPhones',
      'deleteAllSupportPhones',
      (fields.supportPhones ?? []).map((phone) => phoneToWire(phone)),
    );
  }
  if ('supportEmails' in fields && type !== 'ServiceLocation') {
    list(
      'supportEmails',
      'deleteAllSupportEmails',
      (fields.supportEmails ?? []).map((email) => ({
        language: email.language,
        value: email.value,
      })),
    );
  }
  if ('urls' in fields && (type === 'EChannel' || type === 'WebPage' || type === 'Phone')) {
    body.webPage = textToLanguageItems(fields.urls);
  }
  if ('webPages' in fields && (type === 'ServiceLocation' || type === 'PrintableForm')) {
    list('webPages', 'deleteAllWebPages', (fields.webPages ?? []).map(webLinkToWire));
  }
  if ('phoneNumbers' in fields) {
    const phones = fields.phoneNumbers ?? [];
    if (type === 'Phone') {
      body.phoneNumbers = phones.map((phone) => phoneToWire(phone, true));
    } else if (type === 'ServiceLocation') {
      // V4VmOpenApiPhone has no type: faxes go in their own list.
      list(
        'phoneNumbers',
        'deleteAllPhoneNumbers',
        phones.filter((phone) => phone.type !== 'Fax').map((phone) => phoneToWire(phone)),
      );
      list(
        'faxNumbers',
        'deleteAllFaxNumbers',
        phones
          .filter((phone) => phone.type === 'Fax')
          .map((phone) => ({
            language: phone.language,
            number: phone.number,
            ...(phone.isFinnishServiceNumber
              ? { isFinnishServiceNumber: true }
              : { prefixNumber: phone.prefixNumber ?? '+358' }),
          })),
      );
    }
  }
  if (type === 'ServiceLocation') {
    if ('addresses' in fields) body.addresses = (fields.addresses ?? []).map(locationAddressToWire);
    if ('emails' in fields) {
      list(
        'emails',
        null,
        (fields.emails ?? []).map((email) => ({ language: email.language, value: email.value })),
      );
    }
  }
  if (type === 'PrintableForm') {
    if ('deliveryAddresses' in fields) {
      list(
        'deliveryAddresses',
        'deleteAllDeliveryAddresses',
        (fields.deliveryAddresses ?? []).map(deliveryAddressToWire),
      );
    }
    if ('formIdentifiers' in fields) {
      list(
        'formIdentifier',
        'deleteAllFormIdentifiers',
        textToLanguageItems(fields.formIdentifiers),
      );
    }
    if ('formFiles' in fields) {
      list('channelUrls', 'deleteAllChannelUrls', formFilesToWire(fields.formFiles ?? []));
    }
  }
  if (type === 'EChannel') {
    if (fields.requiresSignature !== undefined) body.requiresSignature = fields.requiresSignature;
    if (fields.requiresSignature && fields.signatureQuantity) {
      body.signatureQuantity = String(fields.signatureQuantity);
    }
  }
  if ((type === 'EChannel' || type === 'WebPage') && fields.accessibility) {
    body.accessibilityClassification = accessibilityToWire(fields.accessibility, languages);
  }
  return body;
}

/** v11's per-type channel write paths; the type comes from the channel's current record. */
export const V11_CHANNEL_WRITE_TYPES = [
  'EChannel',
  'Phone',
  'PrintableForm',
  'ServiceLocation',
  'WebPage',
] as const;
