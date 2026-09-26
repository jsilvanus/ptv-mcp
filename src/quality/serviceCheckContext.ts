import type { PtvAdapter } from '../ptv/adapter.js';
import type { GeneralDescription, PtvContentId, Service } from '../ptv/domain.js';
import type { ServiceCheckContext } from './contentChecks.js';

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
