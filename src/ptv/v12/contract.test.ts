import { describe, expect, it } from 'vitest';
import { runPtvAdapterContractTests } from '../testing/contractTests.js';
import { PtvV12Adapter } from './adapter.js';
import { CodeNameCache } from './codeNameCache.js';

const SERVICE_ID = 'service-1';
const CHANNEL_ID = 'channel-1';
const ORG_CHILD = 'org-child';
const ORG_PARENT = 'org-parent';
const GENERAL_DESCRIPTION_ID = 'gd-1';

const serviceWire = {
  contentId: SERVICE_ID,
  organizationContentId: ORG_CHILD,
  serviceType: 'Service',
  publishingStatus: 'Published',
  languageVersions: {
    fi: { name: 'Perheneuvonta', summary: 'Perheneuvontapalvelu', description: 'Tukea perheille.' },
  },
  serviceClasses: ['P1'],
  ontologyTerms: [],
  targetGroups: [],
  lifeEvents: [],
  industrialClasses: [],
  languages: ['fi'],
  serviceChannels: [CHANNEL_ID],
  modified: '2026-01-01T00:00:00Z',
};

const channelWire = {
  contentId: CHANNEL_ID,
  organization: { contentId: ORG_CHILD },
  serviceChannelType: 'Phone',
  publishingStatus: 'Published',
  languageVersions: { fi: { name: 'Perheneuvonnan puhelinpalvelu' } },
  languages: ['fi'],
  modified: '2026-01-01T00:00:00Z',
};

const orgChildWire = {
  contentId: ORG_CHILD,
  parentOrganizationContentId: ORG_PARENT,
  publishingStatus: 'Published',
  languageVersions: { fi: { name: 'Riihimäen seurakunta' } },
  modified: '2026-01-01T00:00:00Z',
};

const orgParentWire = {
  contentId: ORG_PARENT,
  publishingStatus: 'Published',
  languageVersions: { fi: { name: 'Riihimäen seurakuntayhtymä' } },
  modified: '2026-01-01T00:00:00Z',
};

const NOT_FOUND = new Response('not found', { status: 404 });

/** A v12 fixture server: known entities, empty lists, 404 for anything else. */
function fixtureFetch(): typeof fetch {
  const routes: Record<string, unknown> = {
    '/api/v12/service/search': { items: [serviceWire], totalCount: 1, totalItems: 1 },
    [`/api/v12/service/${SERVICE_ID}`]: serviceWire,
    '/api/v12/service-channel/search': { items: [channelWire], totalCount: 1, totalItems: 1 },
    [`/api/v12/service-channel/${CHANNEL_ID}`]: channelWire,
    '/api/v12/organization/search': {
      items: [orgParentWire, orgChildWire],
      totalCount: 2,
      totalItems: 2,
    },
    [`/api/v12/organization/${ORG_CHILD}`]: orgChildWire,
    [`/api/v12/organization/${ORG_PARENT}`]: orgParentWire,
    '/api/v12/service-collection/search': { items: [], totalCount: 0, totalItems: 0 },
    '/api/v12/general-description/search': { items: [], totalCount: 0, totalItems: 0 },
    [`/api/v12/general-description/${GENERAL_DESCRIPTION_ID}`]: {
      contentId: GENERAL_DESCRIPTION_ID,
      organizationContentId: ORG_CHILD,
      languageVersions: { fi: { name: 'Pohjakuvaus' } },
      modified: '2026-01-01T00:00:00Z',
    },
    '/api/v12/connection/search': {
      items: [{ serviceContentId: SERVICE_ID, channelContentId: CHANNEL_ID }],
      totalCount: 1,
      totalItems: 1,
      totalPages: 1,
    },
    '/api/v12/service-classes': [{ code: 'P1', uri: 'uri-P1', name: { fi: 'Perhepalvelut' } }],
  };
  return (async (input: string | URL | Request) => {
    const path = new URL(String(input)).pathname;
    if (path in routes) return Response.json(routes[path]);
    // Unknown list endpoints answer empty; unknown entity ids answer 404.
    if (path.endsWith('/search')) return Response.json({ items: [], totalCount: 0, totalItems: 0 });
    if (
      path.startsWith('/api/v12/ontology-terms') ||
      path.startsWith('/api/v12/target-groups') ||
      path.startsWith('/api/v12/life-events') ||
      path.startsWith('/api/v12/industrial-classes')
    ) {
      return Response.json([]);
    }
    return NOT_FOUND.clone();
  }) as typeof fetch;
}

runPtvAdapterContractTests(
  'PtvV12Adapter (read-only, fixture fetch)',
  () =>
    new PtvV12Adapter({
      environment: 'test',
      apiKey: 'test-key',
      fetchImpl: fixtureFetch(),
      codeNameCache: new CodeNameCache(),
    }),
  {
    knownServiceId: SERVICE_ID,
    knownChannelId: CHANNEL_ID,
    knownOrganizationId: ORG_CHILD,
    unknownId: 'does-not-exist',
    knownCodeListName: 'serviceClasses',
    knownGeneralDescriptionId: GENERAL_DESCRIPTION_ID,
  },
);

describe('PtvV12Adapter write surface', () => {
  it('reports writes unsupported and rejects every write method with the clear message', async () => {
    const adapter = new PtvV12Adapter({
      environment: 'test',
      apiKey: 'test-key',
      fetchImpl: fixtureFetch(),
      codeNameCache: new CodeNameCache(),
    });
    expect(adapter.getCapabilities()).toMatchObject({
      apiVersion: 'v12',
      supportsRead: true,
      supportsWrite: false,
    });
    const message = 'PTV v12 write operations are not enabled yet';
    const writes = [
      () => adapter.applyServiceChange({ serviceId: SERVICE_ID, changes: {} } as never),
      () => adapter.createService({} as never),
      () => adapter.applyChannelChange({ channelId: CHANNEL_ID, changes: {} } as never),
      () => adapter.createChannel({} as never),
      () => adapter.applyConnectionChange({} as never),
      () => adapter.applyOrganizationChange({ organizationId: ORG_CHILD, changes: {} } as never),
      () => adapter.createOrganization({} as never),
    ];
    for (const write of writes) {
      await expect(write()).rejects.toThrow(message);
    }
  });
});
