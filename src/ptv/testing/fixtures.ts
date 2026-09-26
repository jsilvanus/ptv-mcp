import type { PtvAdapterCapabilities } from '../adapter.js';
import type { AdapterFactory } from '../dbAdapterRegistry.js';
import type { Service } from '../domain.js';
import { InMemoryPtvAdapter } from './inMemoryAdapter.js';

/**
 * A v11 adapter's capabilities in PTV's test environment with a per-user
 * credential: read-only unless `overrides` says otherwise.
 */
export function v11Capabilities(
  overrides: Partial<PtvAdapterCapabilities> = {},
): PtvAdapterCapabilities {
  return {
    apiVersion: 'v11',
    environment: 'test',
    credentialScope: 'user',
    supportsRead: true,
    supportsWrite: false,
    supportsDraftRead: false,
    ...overrides,
  };
}

/**
 * A published Finnish service that passes `V11ChangeValidator` as is: one
 * service class, ontology term and target group, with real PTV URIs.
 */
export function validService(overrides: Partial<Service> = {}): Service {
  return {
    id: 'svc-1',
    organizationId: 'org-1',
    serviceType: 'Service',
    publishingStatus: 'Published',
    names: { fi: 'Palvelu' },
    summaries: {},
    descriptions: {},
    serviceClasses: [{ code: 'P11.6', uri: 'http://urn.fi/URN:NBN:fi:au:ptvl:v1111', names: {} }],
    ontologyTerms: [{ uri: 'http://www.yso.fi/onto/koko/p34462', names: {} }],
    targetGroups: [{ code: 'KR1', uri: 'http://urn.fi/URN:NBN:fi:au:ptvl:v2001', names: {} }],
    lifeEvents: [],
    industrialClasses: [],
    languages: ['fi'],
    serviceChannelIds: [],
    modifiedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

type InMemorySeed = Omit<ConstructorParameters<typeof InMemoryPtvAdapter>[0], 'capabilities'>;

/**
 * An `adapterFactories.v11` for `buildApp`: every resolution gets a fresh
 * `InMemoryPtvAdapter` over `seed()` (called per resolution, so writes in
 * one request never leak into the next), with the registry's own
 * environment and write decision as its capabilities.
 */
export function inMemoryV11Factory(seed: () => InMemorySeed): AdapterFactory {
  return (options) =>
    new InMemoryPtvAdapter({
      ...seed(),
      capabilities: v11Capabilities({
        environment: options.environment,
        supportsWrite: options.canWrite,
      }),
    });
}
