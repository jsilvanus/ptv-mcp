import type { PtvAdapter } from '../ptv/adapter.js';
import type { GeneralDescription, PtvContentId, Service, ServiceChannel } from '../ptv/domain.js';
import type { OrganisationContent } from '../ptv/organisationContent.js';
import type { ChannelCheckContext, ServiceCheckContext } from './contentChecks.js';

/**
 * The general description a service links to, for the Q-GD-1 copy check.
 * A failed or unsupported read leaves the check out rather than failing
 * the caller. Pass `cache` when checking many services: they often share
 * a general description.
 */
export async function loadGeneralDescription(
  adapter: Pick<PtvAdapter, 'getGeneralDescription'>,
  id: PtvContentId | undefined,
  cache?: Map<PtvContentId, Promise<GeneralDescription | null>>,
): Promise<GeneralDescription | undefined> {
  if (!id) return undefined;
  let pending = cache?.get(id);
  if (!pending) {
    pending = adapter.getGeneralDescription(id).catch(() => null);
    cache?.set(id, pending);
  }
  return (await pending) ?? undefined;
}

/**
 * What checkService needs besides the service: its organisation's names
 * and its general description, read in parallel. A failed read leaves that
 * check out.
 */
export async function serviceCheckContext(
  adapter: Pick<PtvAdapter, 'getGeneralDescription' | 'getOrganisation'>,
  service: Pick<Service, 'organizationId' | 'generalDescriptionId'>,
  generalDescriptions?: Map<PtvContentId, Promise<GeneralDescription | null>>,
): Promise<ServiceCheckContext> {
  const [organisation, generalDescription] = await Promise.all([
    service.organizationId
      ? adapter.getOrganisation(service.organizationId).catch(() => null)
      : null,
    loadGeneralDescription(adapter, service.generalDescriptionId, generalDescriptions),
  ]);
  return { organisationNames: organisation?.names, generalDescription };
}

/**
 * What checkChannel needs: how many services the channel is connected to.
 * A failed read leaves the connection check out.
 */
export async function channelCheckContext(
  adapter: Pick<PtvAdapter, 'getConnectionsFor'>,
  channelId: PtvContentId,
): Promise<ChannelCheckContext> {
  const connections = await adapter.getConnectionsFor(channelId, 'channel').catch(() => undefined);
  return connections ? { connectedServiceCount: connections.length } : {};
}

/**
 * The service and channel check contexts from content already read
 * (collectOrganisationContent), without reading PTV again: a service's
 * organisation names and general description, a channel's connection count.
 */
export function collectedCheckContexts(content: OrganisationContent): {
  service(service: Service): ServiceCheckContext;
  channel(channel: ServiceChannel): ChannelCheckContext;
} {
  const organisationNames = new Map(content.organisations.map((org) => [org.id, org.names]));
  return {
    service: (service) => ({
      organisationNames: organisationNames.get(service.organizationId),
      generalDescription: service.generalDescriptionId
        ? content.generalDescriptions.get(service.generalDescriptionId)
        : undefined,
    }),
    channel: (channel) => ({
      connectedServiceCount: content.connectedServiceCount.get(channel.id) ?? 0,
    }),
  };
}
