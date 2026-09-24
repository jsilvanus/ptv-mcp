import type { PtvContentId } from '../domain.js';
import type { V11ServiceChannelRelation, V11ServiceWire } from './wireModel.js';

/** One `PUT /api/v11/Connection/serviceId/{serviceId}` body. */
export interface V11ServiceConnectionsBody {
  deleteAllChannelRelations?: boolean;
  channelRelations: Record<string, unknown>[];
}

/**
 * Plans the `PUT /api/v11/Connection/serviceId/{id}` calls that turn the
 * service's current connections into `desiredChannelIds`.
 *
 * That PUT adds or updates the listed relations and leaves the others
 * alone. The only way to remove one is `deleteAllChannelRelations: true`,
 * which the schema says must come with an empty list. So:
 * - only additions: one call listing the new channels;
 * - any removal: one call deleting all, then one re-adding every channel
 *   that stays (with its connection extra info: charge type,
 *   descriptions, service hours, contact details) plus the new ones.
 *
 * An empty result means nothing changes.
 */
export function planServiceConnections(
  current: V11ServiceWire,
  desiredChannelIds: PtvContentId[],
): V11ServiceConnectionsBody[] {
  const currentRelations = current.serviceChannels ?? [];
  const currentIds = new Set(currentRelations.map((relation) => relation.serviceChannel.id));
  const desired = [...new Set(desiredChannelIds)];
  const added = desired.filter((id) => !currentIds.has(id));
  const removed = [...currentIds].filter((id) => !desired.includes(id));

  if (removed.length === 0) {
    return added.length === 0
      ? []
      : [{ channelRelations: added.map((id) => ({ serviceChannelId: id })) }];
  }

  const kept = currentRelations.filter((relation) => desired.includes(relation.serviceChannel.id));
  const readd = [...kept.map(relationToWrite), ...added.map((id) => ({ serviceChannelId: id }))];
  return [
    { deleteAllChannelRelations: true, channelRelations: [] },
    ...(readd.length > 0 ? [{ channelRelations: readd }] : []),
  ];
}

function relationToWrite(relation: V11ServiceChannelRelation): Record<string, unknown> {
  const description = (relation.description ?? []).filter((item) => !!item.value);
  return {
    serviceChannelId: relation.serviceChannel.id,
    ...(relation.serviceChargeType ? { serviceChargeType: relation.serviceChargeType } : {}),
    ...(description.length > 0 ? { description } : {}),
    ...(relation.serviceHours && relation.serviceHours.length > 0
      ? { serviceHours: relation.serviceHours }
      : {}),
    ...(relation.contactDetails ? { contactDetails: relation.contactDetails } : {}),
  };
}
