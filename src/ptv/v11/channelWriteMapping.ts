import type { ServiceChannel } from '../domain.js';
import { toV11WritePublishingStatus } from './mappers/common.js';
import type { V11LocalizedItem, V11ServiceChannelWire } from './wireModel.js';

/**
 * The body for `PUT /api/v11/ServiceChannel/{type}/{id}`, built on the
 * channel's current record the same way as a service PUT (see
 * writeMapping.ts): publishingStatus is always sent, and the localized
 * lists keep the entry types the domain model doesn't carry.
 *
 * The domain's channel `descriptions` are the `Description` entries; the
 * `Summary` entries are kept as they are. When `languages` changes, kept
 * entries of dropped languages go too.
 */
export function channelChangesToV11Body(
  changes: Partial<ServiceChannel>,
  current: V11ServiceChannelWire,
): Record<string, unknown> {
  const languages = changes.languages;
  const kept = (items: V11LocalizedItem[] | null | undefined, replacedType: string) =>
    (items ?? []).filter(
      (item) =>
        !!item.value &&
        item.type !== replacedType &&
        (languages === undefined || languages.includes(item.language)),
    );

  const body: Record<string, unknown> = {
    publishingStatus: changes.publishingStatus
      ? toV11WritePublishingStatus(changes.publishingStatus)
      : current.publishingStatus,
  };

  if (current.serviceChannelType === 'EChannel') {
    body.requiresAuthentication = current.requiresAuthentication ?? false;
  }

  if ('names' in changes) {
    body.serviceChannelNames = [
      ...kept(current.serviceChannelNames, 'Name'),
      ...toWireList(changes.names, 'Name'),
    ];
  }
  if ('descriptions' in changes || languages !== undefined) {
    body.serviceChannelDescriptions = [
      ...kept(current.serviceChannelDescriptions, 'Description'),
      ...('descriptions' in changes
        ? toWireList(changes.descriptions, 'Description')
        : (current.serviceChannelDescriptions ?? []).filter(
            (item) =>
              !!item.value &&
              item.type === 'Description' &&
              (languages === undefined || languages.includes(item.language)),
          )),
    ];
  }
  if (languages !== undefined) {
    body.languages = languages;
    if (!('names' in changes)) {
      body.serviceChannelNames = kept(current.serviceChannelNames, '');
    }
  }
  return body;
}

function toWireList(text: Record<string, string | undefined> | undefined, type: string) {
  return Object.entries(text ?? {})
    .filter((entry): entry is [string, string] => !!entry[1])
    .map(([language, value]) => ({ language, value, type }));
}

/** v11's per-type channel write paths; the type comes from the channel's current record. */
export const V11_CHANNEL_WRITE_TYPES = [
  'EChannel',
  'Phone',
  'PrintableForm',
  'ServiceLocation',
  'WebPage',
] as const;
