import type { PtvAdapter } from './adapter.js';
import type {
  Connection,
  GeneralDescription,
  Organization,
  PaginatedResult,
  PtvContentId,
  SearchParams,
  Service,
  ServiceChannel,
} from './domain.js';
import { mapWithConcurrency, PAGE_FETCH_CONCURRENCY } from './http.js';

/**
 * Reading everything an organisation has in PTV: the organisation and its
 * sub-organisations, their services and channels, the general
 * descriptions the services link to and how the channels are connected.
 * Review campaigns and the content report (src/export) both start here.
 * Per-item reads run PAGE_FETCH_CONCURRENCY at a time.
 */

export class OrganizationNotFoundError extends Error {
  constructor(organizationId: PtvContentId) {
    super(`PTV organisation not found: ${organizationId}`);
    this.name = 'OrganizationNotFoundError';
  }
}

/** Safety cap on services or channels read per organisation; PTV organisations rarely have more. */
export const MAX_ORGANISATION_ITEMS = 5000;
const PAGE_SIZE = 200;

/** Every page of an organisation's services or channels, up to `limit`. */
export async function fetchAll<T>(
  search: (params: SearchParams) => Promise<PaginatedResult<T>>,
  organizationId: string,
  limit = MAX_ORGANISATION_ITEMS,
): Promise<T[]> {
  const items: T[] = [];
  for (let page = 1; ; page += 1) {
    const result = await search({ organizationId, page, pageSize: PAGE_SIZE });
    items.push(...result.items);
    if (
      result.items.length < PAGE_SIZE ||
      items.length >= result.totalCount ||
      items.length >= limit
    ) {
      return items.slice(0, limit);
    }
  }
}

/** The organisation and, optionally, every organisation below it in the tenant's catalogue. */
export async function organisationsInScope(
  adapter: PtvAdapter,
  organizationId: string,
  includeSubOrganisations: boolean,
): Promise<Organization[]> {
  const root = await adapter.getOrganisation(organizationId);
  if (!root) throw new OrganizationNotFoundError(organizationId);
  if (!includeSubOrganisations) return [root];
  // The whole catalogue: searchOrganisations has no parent filter, and v11
  // serves it from the tenant's cached copy.
  const catalogue = await adapter
    .searchOrganisations({ page: 1, pageSize: 100000 })
    .then((result) => result.items)
    .catch(() => [] as Organization[]);
  const result = [root];
  const seen = new Set([root.id]);
  for (let i = 0; i < result.length; i += 1) {
    const parentId = result[i]!.id;
    for (const org of catalogue) {
      if (org.parentOrganizationId === parentId && !seen.has(org.id)) {
        seen.add(org.id);
        result.push(org);
      }
    }
  }
  return result;
}

export interface OrganisationContent {
  organisations: Organization[];
  services: Service[];
  channels: ServiceChannel[];
  /** The linked general descriptions by id; ones that can't be read are left out. */
  generalDescriptions: Map<PtvContentId, GeneralDescription>;
  /**
   * Services each channel is connected to. Counted from the organisations'
   * own services; a channel none of them uses is asked from PTV, since
   * another organisation's service may use it.
   */
  connectedServiceCount: Map<PtvContentId, number>;
}

/** Reads the organisations' services and channels and what their checks need. */
export async function collectOrganisationContent(
  adapter: PtvAdapter,
  organisations: Organization[],
): Promise<OrganisationContent> {
  const perOrganisation = await Promise.all(
    organisations.map(async (org) => {
      const [services, channels] = await Promise.all([
        fetchAll((p) => adapter.searchServices(p), org.id),
        fetchAll((p) => adapter.searchChannels(p), org.id),
      ]);
      return { services, channels };
    }),
  );
  const services = perOrganisation.flatMap((org) => org.services);
  const channels = perOrganisation.flatMap((org) => org.channels);

  const connectedServiceCount = new Map<PtvContentId, number>();
  for (const service of services) {
    for (const channelId of service.serviceChannelIds) {
      connectedServiceCount.set(channelId, (connectedServiceCount.get(channelId) ?? 0) + 1);
    }
  }
  const unconnected = channels.filter((channel) => !connectedServiceCount.has(channel.id));
  const generalDescriptionIds = [
    ...new Set(services.map((s) => s.generalDescriptionId).filter((id): id is string => !!id)),
  ];
  const [connectedElsewhere, generalDescriptions] = await Promise.all([
    mapWithConcurrency(unconnected, PAGE_FETCH_CONCURRENCY, (channel) =>
      adapter
        .getConnectionsFor(channel.id, 'channel')
        .then((connections) => connections.length)
        .catch(() => 0),
    ),
    mapWithConcurrency(generalDescriptionIds, PAGE_FETCH_CONCURRENCY, (id) =>
      adapter.getGeneralDescription(id).catch(() => null),
    ),
  ]);
  unconnected.forEach((channel, i) =>
    connectedServiceCount.set(channel.id, connectedElsewhere[i] ?? 0),
  );
  return {
    organisations,
    services,
    channels,
    generalDescriptions: new Map(
      generalDescriptions
        .filter((gd): gd is GeneralDescription => gd !== null)
        .map((gd) => [gd.id, gd]),
    ),
    connectedServiceCount,
  };
}

/**
 * Every connection of the services, with its extra info, in one batched
 * read (see PtvAdapter.getConnectionsForServices). A failed batch read
 * falls back to one read per service, so one unreadable service leaves
 * out only its own connections.
 */
export async function connectionsOf(
  adapter: PtvAdapter,
  services: Service[],
): Promise<Connection[]> {
  const connected = services
    .filter((service) => service.serviceChannelIds.length > 0)
    .map((service) => service.id);
  try {
    return await adapter.getConnectionsForServices(connected);
  } catch {
    const perService = await mapWithConcurrency(connected, PAGE_FETCH_CONCURRENCY, (id) =>
      adapter.getConnectionsFor(id, 'service').catch(() => [] as Connection[]),
    );
    return perService.flat();
  }
}
