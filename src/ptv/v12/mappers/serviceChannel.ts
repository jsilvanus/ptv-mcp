import type { ServiceChannel } from '../../domain.js';
import type { V12ServiceChannelWire } from '../wireModel.js';
import {
  contentIdOf,
  descriptionsOf,
  languagesOf,
  modifiedAtField,
  namesOf,
  normalizePublishingStatus,
  organizationIdOf,
} from './common.js';

export function mapV12ServiceChannel(wire: V12ServiceChannelWire): ServiceChannel {
  return {
    id: contentIdOf(wire, 'service channel'),
    ...(wire.sourceId ? { sourceId: wire.sourceId } : {}),
    organizationId: organizationIdOf(wire),
    channelType: normalizeChannelType(wire.serviceChannelType ?? wire.channelType ?? wire.type),
    publishingStatus: normalizePublishingStatus(wire.publishingStatus),
    names: namesOf(wire),
    descriptions: descriptionsOf(wire),
    languages: languagesOf(wire),
    ...modifiedAtField(wire),
  };
}

function normalizeChannelType(value: string | undefined): ServiceChannel['channelType'] {
  if (
    value === 'Phone' ||
    value === 'PrintableForm' ||
    value === 'ServiceLocation' ||
    value === 'WebPage'
  )
    return value;
  // v12's wire name for the phone channel subtype (see ChannelResponse's discriminator).
  if (value === 'TelephoneService') return 'Phone';
  return 'EChannel';
}
