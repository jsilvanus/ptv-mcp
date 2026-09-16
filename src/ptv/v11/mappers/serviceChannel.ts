import type { ServiceChannel } from '../../domain.js';
import type { V11ServiceChannelWire } from '../wireModel.js';
import { toLocalizedText, toPublishingStatus } from './common.js';

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

export function serviceChannelWireToDomain(wire: V11ServiceChannelWire): ServiceChannel {
  return {
    id: wire.id,
    ...(wire.sourceId ? { sourceId: wire.sourceId } : {}),
    organizationId: wire.organizationId,
    channelType: toChannelType(wire.serviceChannelType),
    publishingStatus: toPublishingStatus(wire.publishingStatus),
    names: toLocalizedText(wire.serviceChannelNames, ['Name']),
    descriptions: toLocalizedText(wire.serviceChannelDescriptions, ['Description', 'Summary']),
    languages: wire.languages,
    modifiedAt: wire.modified,
  };
}
