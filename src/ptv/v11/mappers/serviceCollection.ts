import type { ServiceCollection } from '../../domain.js';
import type { V11ServiceCollectionWire } from '../wireModel.js';
import { toLocalizedText, toPublishingStatus } from './common.js';

export function serviceCollectionWireToDomain(wire: V11ServiceCollectionWire): ServiceCollection {
  return {
    id: wire.id,
    publishingStatus: toPublishingStatus(wire.publishingStatus),
    names: toLocalizedText(wire.serviceCollectionNames, ['Name']),
    descriptions: toLocalizedText(wire.serviceCollectionDescriptions, ['Description', 'Summary']),
    serviceIds: (wire.services ?? []).map((service) => service.id),
    modifiedAt: wire.modified,
  };
}
