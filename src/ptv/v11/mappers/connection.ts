import type { Connection } from '../../domain.js';
import type { V11ServiceChannelWire, V11ServiceWire } from '../wireModel.js';
import { connectionDetailsToDomain } from '../connectionDetails.js';

/**
 * v11 has no dedicated connection-read endpoint — connections only ever
 * appear embedded in a Service's `serviceChannels` or a ServiceChannel's
 * `services` field (see docs/ptv-v11-notes.md, "No read-back for
 * connections"). These two functions extract the same `Connection[]`
 * shape from either direction, so `PtvV11Adapter.getConnectionsFor` can
 * fetch whichever entity type the id belongs to and get a consistent
 * result either way, extra info (liitoksen lisätiedot) included.
 */
export function connectionsFromService(wire: V11ServiceWire): Connection[] {
  return (wire.serviceChannels ?? []).map((relation) => ({
    serviceId: wire.id,
    channelId: relation.serviceChannel.id,
    ...connectionDetailsToDomain(relation),
    modifiedAt: relation.modified ?? wire.modified,
  }));
}

export function connectionsFromChannel(wire: V11ServiceChannelWire): Connection[] {
  return (wire.services ?? []).map((relation) => ({
    serviceId: relation.service.id,
    channelId: wire.id,
    ...connectionDetailsToDomain(relation),
    modifiedAt: relation.modified ?? wire.modified,
  }));
}
