import { describe, expect, it } from 'vitest';
import { runPtvAdapterContractTests } from '../testing/contractTests.js';
import { PtvV11Adapter } from './adapter.js';

const SERVICE_ID = 'c67da57e-ea12-4c90-bd53-1fa5f82e26af';
const CHANNEL_ID = '5d1b0a7e-3f0c-4a57-9b0e-0c1f2a3b4c5d';
const ORG_ID = 'ae788356-6950-48fc-b3ff-63243f74fe53';
const UNKNOWN_ID = '00000000-0000-4000-8000-000000000000';
// v11 serves only standalone lists under CodeList/ (no service classes).
const CODE_LIST = 'languages';

const serviceWire = {
  id: SERVICE_ID,
  type: 'Service',
  generalDescriptionId: null,
  publishingStatus: 'Published',
  serviceNames: [{ language: 'fi', value: 'Perheneuvonta', type: 'Name' }],
  serviceDescriptions: [
    { language: 'fi', value: 'Perheneuvontapalvelu', type: 'Summary' },
    { language: 'fi', value: 'Tukea perheille.', type: 'Description' },
  ],
  serviceClasses: [],
  ontologyTerms: [],
  targetGroups: [],
  lifeEvents: [],
  industrialClasses: [],
  languages: ['fi'],
  organizations: [{ organization: { id: ORG_ID }, roleType: 'Responsible' }],
  serviceChannels: [
    {
      serviceChannel: { id: CHANNEL_ID },
      serviceChargeType: 'FreeOfCharge',
      description: [{ language: 'fi', value: 'Puhelinpalvelu', type: 'Description' }],
    },
  ],
  modified: '2026-01-01T00:00:00',
};

const channelWire = {
  id: CHANNEL_ID,
  serviceChannelType: 'Phone',
  publishingStatus: 'Published',
  serviceChannelNames: [{ language: 'fi', value: 'Perheneuvonnan puhelinpalvelu', type: 'Name' }],
  serviceChannelDescriptions: [],
  languages: ['fi'],
  organizations: [{ organization: { id: ORG_ID }, roleType: 'Responsible' }],
  modified: '2026-01-01T00:00:00',
};

const orgWire = {
  id: ORG_ID,
  organizationNames: [{ language: 'fi', value: 'Riihimäen seurakunta', type: 'Name' }],
  publishingStatus: 'Published',
  modified: '2026-01-01T00:00:00',
};

function envelope(items: unknown[]): Response {
  return Response.json({
    pageNumber: 1,
    pageSize: 1000,
    pageCount: 1,
    totalCount: items.length,
    itemList: items,
  });
}

/** Public v11 fixture: known entities, empty lists, 404 for unknown ids. */
function fixtureFetch(): typeof fetch {
  const routes: Record<string, () => Response> = {
    'GET /api/v11/Service': () => envelope([serviceWire]),
    // Id lookups (`/list?guids=`) answer a bare array, as PTV does.
    'GET /api/v11/Service/list': () => Response.json([serviceWire]),
    'GET /api/v11/Service/list/organization': () => envelope([serviceWire]),
    [`GET /api/v11/Service/${SERVICE_ID}`]: () => Response.json(serviceWire),
    'GET /api/v11/ServiceChannel': () => envelope([channelWire]),
    'GET /api/v11/ServiceChannel/list': () => Response.json([channelWire]),
    'GET /api/v11/ServiceChannel/list/organization': () => envelope([channelWire]),
    [`GET /api/v11/ServiceChannel/${CHANNEL_ID}`]: () => Response.json(channelWire),
    'GET /api/v11/Organization': () => envelope([{ id: ORG_ID, name: 'Riihimäen seurakunta' }]),
    'GET /api/v11/Organization/list': () => Response.json([orgWire]),
    'GET /api/v11/CodeList/GetLanguageCodes': () =>
      Response.json([{ code: 'fi', name: 'suomi', uri: 'http://uri.suomi.fi/codelist/fi' }]),
    [`GET /api/v11/Organization/${ORG_ID}`]: () => Response.json(orgWire),
    'GET /api/v11/GeneralDescription': () => envelope([]),
    'GET /api/v11/GeneralDescription/list': () => envelope([]),
    'GET /api/v11/ServiceCollection': () => envelope([]),
  };
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const route = routes[`${method} ${url.pathname}`];
    if (route) return route();
    // Unknown entity ids answer 404 (PTV's behaviour); unknown lists answer empty.
    if (/\/api\/v11\/[A-Za-z]+\/[0-9a-f-]{36}$/.test(url.pathname)) {
      return new Response('not found', { status: 404 });
    }
    return envelope([]);
  }) as typeof fetch;
}

const fixtures = {
  knownServiceId: SERVICE_ID,
  knownChannelId: CHANNEL_ID,
  knownOrganizationId: ORG_ID,
  unknownId: UNKNOWN_ID,
  knownCodeListName: CODE_LIST,
};

runPtvAdapterContractTests(
  'PtvV11Adapter (read-only, fixture fetch)',
  () => new PtvV11Adapter({ environment: 'test', fetchImpl: fixtureFetch() }),
  fixtures,
);

describe('PtvV11Adapter write surface without canWrite', () => {
  it('reports writes unsupported and refuses service writes before any request', async () => {
    const adapter = new PtvV11Adapter({ environment: 'test', fetchImpl: fixtureFetch() });
    expect(adapter.getCapabilities()).toMatchObject({
      apiVersion: 'v11',
      supportsRead: true,
      supportsWrite: false,
    });
    await expect(
      adapter.applyServiceChange({ serviceId: SERVICE_ID, changes: {} } as never),
    ).rejects.toThrow('write is not enabled');
  });
});
