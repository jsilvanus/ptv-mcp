import type { ConnectionDetails, PtvContentId } from '../domain.js';
import { connectionDetailsToDomain, connectionDetailsToWire } from './connectionDetails.js';
import type { V11ServiceChannelRelation, V11ServiceWire } from './wireModel.js';

/** One `PUT /api/v11/Connection/serviceId/{serviceId}` body. */
export interface V11ServiceConnectionsBody {
  deleteAllChannelRelations?: boolean;
  channelRelations: Record<string, unknown>[];
}

/**
 * Plans the `PUT /api/v11/Connection/serviceId/{id}` call that turns the
 * service's current connections into `desiredChannelIds`.
 *
 * Verified live: that PUT **replaces** the service's connections with the
 * listed ones (sending only a new channel dropped the existing two), even
 * though the schema reads as if it only adds. So the body lists every
 * desired channel, the kept ones with their connection extra info (charge
 * type, descriptions, service hours, contact details), so PTV doesn't
 * drop it. Removing every connection is `deleteAllChannelRelations: true`
 * with an empty list, as the schema asks.
 *
 * `null` means nothing changes.
 */
export function planServiceConnections(
  current: V11ServiceWire,
  desiredChannelIds: PtvContentId[],
): V11ServiceConnectionsBody | null {
  const currentRelations = current.serviceChannels ?? [];
  const currentIds = new Set(currentRelations.map((relation) => relation.serviceChannel.id));
  const desired = [...new Set(desiredChannelIds)];
  const unchanged = desired.length === currentIds.size && desired.every((id) => currentIds.has(id));
  if (unchanged) return null;
  if (desired.length === 0) return { deleteAllChannelRelations: true, channelRelations: [] };

  const byId = new Map(currentRelations.map((relation) => [relation.serviceChannel.id, relation]));
  return {
    channelRelations: desired.map((id) => {
      const relation = byId.get(id);
      return relation ? relationToWrite(relation) : { serviceChannelId: id };
    }),
  };
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

/**
 * Plans the `PUT /api/v11/Connection/serviceId/{id}` call that changes one
 * connection's extra info. The PUT replaces the service's connections, so
 * every other connection is resent as it is; the changed one carries its
 * current extra info merged with `changes` (a field present in `changes`
 * replaces it, an empty one clears it).
 */
export function planConnectionDetails(
  current: V11ServiceWire,
  channelId: PtvContentId,
  changes: Partial<ConnectionDetails>,
): V11ServiceConnectionsBody {
  const relations = current.serviceChannels ?? [];
  const target = relations.find((relation) => relation.serviceChannel.id === channelId);
  if (!target) {
    throw new Error(`Service ${current.id} is not connected to channel ${channelId}`);
  }
  return {
    channelRelations: relations.map((relation) =>
      relation === target
        ? {
            serviceChannelId: channelId,
            ...connectionDetailsToWire({ ...connectionDetailsToDomain(relation), ...changes }),
          }
        : relationToWrite(relation),
    ),
  };
}
