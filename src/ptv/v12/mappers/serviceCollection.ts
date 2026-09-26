import type { ServiceCollection } from '../../domain.js';
import type { V12ServiceCollectionWire } from '../wireModel.js';
import {
  contentIdOf,
  descriptionsOf,
  ids,
  modifiedAtField,
  namesOf,
  normalizePublishingStatus,
} from './common.js';

export function mapV12ServiceCollection(wire: V12ServiceCollectionWire): ServiceCollection {
  return {
    id: contentIdOf(wire, 'service collection'),
    publishingStatus: normalizePublishingStatus(wire.publishingStatus),
    names: namesOf(wire),
    descriptions: descriptionsOf(wire),
    serviceIds: wire.items
      ? wire.items.flatMap((item) =>
          item.itemType === 'Service' && item.contentId ? [item.contentId] : [],
        )
      : ids(wire.serviceIds ?? wire.services),
    ...modifiedAtField(wire),
  };
}
