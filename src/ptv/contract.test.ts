import { InMemoryPtvAdapter } from './testing/inMemoryAdapter.js';
import { runPtvAdapterContractTests } from './testing/contractTests.js';
import type { Organization, Service, ServiceChannel } from './domain.js';

const parentOrg: Organization = {
  id: 'org-parent',
  publishingStatus: 'Published',
  names: { fi: 'Riihimäen seurakuntayhtymä' },
  modifiedAt: '2026-01-01T00:00:00Z',
};

const childOrg: Organization = {
  id: 'org-child',
  parentOrganizationId: 'org-parent',
  publishingStatus: 'Published',
  names: { fi: 'Riihimäen seurakunta' },
  modifiedAt: '2026-01-01T00:00:00Z',
};

const service: Service = {
  id: 'service-1',
  organizationId: 'org-child',
  serviceType: 'Service',
  publishingStatus: 'Published',
  names: { fi: 'Perheneuvonta' },
  summaries: { fi: 'Perheneuvontapalvelu' },
  descriptions: { fi: 'Perheneuvonta tarjoaa tukea perheille.' },
  serviceClasses: [],
  ontologyTerms: [],
  targetGroups: [],
  lifeEvents: [],
  industrialClasses: [],
  languages: ['fi'],
  serviceChannelIds: ['channel-1'],
  modifiedAt: '2026-01-01T00:00:00Z',
};

const channel: ServiceChannel = {
  id: 'channel-1',
  organizationId: 'org-child',
  channelType: 'Phone',
  publishingStatus: 'Published',
  names: { fi: 'Perheneuvonnan puhelinpalvelu' },
  descriptions: {},
  languages: ['fi'],
  modifiedAt: '2026-01-01T00:00:00Z',
};

// Validates the contract suite itself against a fake, before any real
// adapter exists — Phase 1's stated sync point. Phase 2's PtvV11Adapter
// and PtvV12Adapter should each get their own call to
// runPtvAdapterContractTests once built.
runPtvAdapterContractTests(
  'InMemoryPtvAdapter (read/write)',
  () =>
    new InMemoryPtvAdapter({
      services: [service],
      channels: [channel],
      organizations: [parentOrg, childOrg],
      connections: [
        { serviceId: 'service-1', channelId: 'channel-1', modifiedAt: '2026-01-01T00:00:00Z' },
      ],
      codeLists: { serviceClasses: [{ code: 'P1', names: { fi: 'Perhepalvelut' } }] },
      capabilities: {
        apiVersion: 'fake',
        environment: 'test',
        credentialScope: 'tenant',
        supportsRead: true,
        supportsWrite: true,
        supportsDraftRead: false,
      },
    }),
  {
    knownServiceId: 'service-1',
    knownChannelId: 'channel-1',
    knownOrganizationId: 'org-child',
    unknownId: 'does-not-exist',
    knownCodeListName: 'serviceClasses',
  },
);

runPtvAdapterContractTests(
  'InMemoryPtvAdapter (read-only)',
  () =>
    new InMemoryPtvAdapter({
      services: [service],
      channels: [channel],
      organizations: [parentOrg, childOrg],
      codeLists: { serviceClasses: [{ code: 'P1', names: { fi: 'Perhepalvelut' } }] },
      capabilities: {
        apiVersion: 'fake',
        environment: 'production',
        credentialScope: 'user',
        supportsRead: true,
        supportsWrite: false,
        supportsDraftRead: false,
      },
    }),
  {
    knownServiceId: 'service-1',
    knownChannelId: 'channel-1',
    knownOrganizationId: 'org-child',
    unknownId: 'does-not-exist',
    knownCodeListName: 'serviceClasses',
  },
);
