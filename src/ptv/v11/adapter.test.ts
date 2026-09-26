import { describe, expect, it } from 'vitest';
import { PtvV11Adapter } from './adapter.js';
import type { V11ApiTokenCache } from './auth/apiLogin.js';
import type { V11ServiceWire } from './wireModel.js';

const SERVICE_ID = 'c67da57e-ea12-4c90-bd53-1fa5f82e26af';

function serviceWire(overrides: Partial<V11ServiceWire> = {}): V11ServiceWire {
  return {
    id: SERVICE_ID,
    type: 'Service',
    generalDescriptionId: null,
    publishingStatus: 'Published',
    serviceNames: [{ language: 'fi', value: 'Hautauspalvelu', type: 'Name' }],
    serviceDescriptions: [
      { language: 'fi', value: 'Tiivistelmä', type: 'Summary' },
      { language: 'fi', value: 'Kuvaus', type: 'Description' },
    ],
    serviceClasses: [],
    ontologyTerms: [],
    targetGroups: [],
    lifeEvents: [],
    industrialClasses: [],
    languages: ['fi'],
    organizations: [
      { organization: { id: 'ae788356-6950-48fc-b3ff-63243f74fe53' }, roleType: 'Responsible' },
    ],
    serviceChannels: null,
    modified: '2026-09-24T00:00:00',
    ...overrides,
  };
}

describe('PtvV11Adapter organisation-scoped search', () => {
  it('downloads the organisation list once per adapter instance across pages', async () => {
    const organizationId = 'ae788356-6950-48fc-b3ff-63243f74fe53';
    const { fetchImpl, calls } = fakeFetch({
      'GET /api/v11/Service/list/organization': () =>
        Response.json({
          pageNumber: 1,
          pageSize: 1000,
          pageCount: 1,
          itemList: [serviceWire(), serviceWire({ id: 'second' })],
        }),
    });
    const adapter = new PtvV11Adapter({ environment: 'test', fetchImpl });

    const first = await adapter.searchServices({ organizationId, page: 1, pageSize: 1 });
    const second = await adapter.searchServices({ organizationId, page: 2, pageSize: 1 });

    expect(first.items.map((item) => item.id)).toEqual([SERVICE_ID]);
    expect(second.items.map((item) => item.id)).toEqual(['second']);
    expect(second.totalCount).toBe(2);
    expect(calls).toHaveLength(1);
  });
});

describe('PtvV11Adapter connection reads', () => {
  const organizationId = 'ae788356-6950-48fc-b3ff-63243f74fe53';
  const connected = (id: string) =>
    serviceWire({
      id,
      serviceChannels: [
        {
          serviceChannel: { id: `${id}-channel` },
          serviceChargeType: 'FreeOfCharge',
          description: [{ language: 'fi', value: 'Vastaanotto', type: 'Description' }],
        },
      ],
    });

  it('reads the connections of searched services without another request', async () => {
    const { fetchImpl, calls } = fakeFetch({
      'GET /api/v11/Service/list/organization': () =>
        Response.json({
          pageNumber: 1,
          pageSize: 1000,
          pageCount: 1,
          itemList: [connected(SERVICE_ID), connected('second')],
        }),
      [`GET /api/v11/Service/${SERVICE_ID}`]: () => Response.json(connected(SERVICE_ID)),
    });
    const adapter = new PtvV11Adapter({ environment: 'test', fetchImpl });
    await adapter.searchServices({ organizationId, page: 1, pageSize: 10 });

    const connections = await adapter.getConnectionsForServices([SERVICE_ID, 'second']);

    expect(calls).toHaveLength(1);
    expect(connections).toEqual([
      {
        serviceId: SERVICE_ID,
        channelId: `${SERVICE_ID}-channel`,
        chargeType: 'FreeOfCharge',
        descriptions: { fi: 'Vastaanotto' },
        modifiedAt: '2026-09-24T00:00:00',
      },
      expect.objectContaining({ serviceId: 'second', channelId: 'second-channel' }),
    ]);
    // The same connections, extra info included, as the per-service read.
    expect(connections.slice(0, 1)).toEqual(await adapter.getConnectionsFor(SERVICE_ID));
  });

  it('reads other services 100 per Service/list request instead of one each', async () => {
    const ids = Array.from({ length: 150 }, (_, i) => `service-${i}`);
    const { fetchImpl, calls } = fakeFetch({
      'GET /api/v11/Service/list': () =>
        Response.json(calls.at(-1)!.query.get('guids')!.split(',').map(connected)),
    });
    const adapter = new PtvV11Adapter({ environment: 'test', fetchImpl });

    const connections = await adapter.getConnectionsForServices(ids);

    expect(calls.map((call) => call.path)).toEqual([
      '/api/v11/Service/list',
      '/api/v11/Service/list',
    ]);
    expect(calls.map((call) => call.query.get('guids')!.split(',').length)).toEqual([100, 50]);
    expect(connections.map((connection) => connection.serviceId)).toEqual(ids);
  });

  it('reads a channel id straight from ServiceChannel when told it is a channel', async () => {
    const { fetchImpl, calls } = fakeFetch({
      'GET /api/v11/ServiceChannel/channel-1': () =>
        Response.json({ id: 'channel-1', services: [{ service: { id: SERVICE_ID } }] }),
    });
    const adapter = new PtvV11Adapter({ environment: 'test', fetchImpl });

    expect(await adapter.getConnectionsFor('channel-1', 'channel')).toMatchObject([
      { serviceId: SERVICE_ID, channelId: 'channel-1' },
    ]);
    expect(calls.map((call) => call.path)).toEqual(['/api/v11/ServiceChannel/channel-1']);

    // Without the hint the id is tried as a service first.
    await adapter.getConnectionsFor('channel-1');
    expect(calls.map((call) => call.path).slice(1)).toEqual([
      '/api/v11/Service/channel-1',
      '/api/v11/ServiceChannel/channel-1',
    ]);
  });

  it('reads no connections when PTV finds none of the services (404)', async () => {
    const { fetchImpl } = fakeFetch({});
    const adapter = new PtvV11Adapter({ environment: 'test', fetchImpl });

    expect(await adapter.getConnectionsForServices(['missing'])).toEqual([]);
  });

  it('does not try an unknown service id as a channel when told it is a service', async () => {
    const { fetchImpl, calls } = fakeFetch({});
    const adapter = new PtvV11Adapter({ environment: 'test', fetchImpl });

    expect(await adapter.getConnectionsFor('missing', 'service')).toEqual([]);
    expect(calls.map((call) => call.path)).toEqual(['/api/v11/Service/missing']);
  });
});

interface Call {
  method: string;
  path: string;
  query: URLSearchParams;
  authorization: string | undefined;
  body: unknown;
}

function fakeFetch(routes: Record<string, () => Response>): {
  fetchImpl: typeof fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({
      method,
      path: url.pathname,
      query: url.searchParams,
      authorization: headers.Authorization,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const route = routes[`${method} ${url.pathname}`];
    return route ? route() : new Response('not found', { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const tokenCache = {
  getToken: async () => 'api-user-token',
  invalidate: () => {},
} as unknown as V11ApiTokenCache;

const apiUser = { username: 'API15', password: 'not-a-real-password' };

describe('PtvV11Adapter draft reads', () => {
  it('reads Service/active with the API-user token when an API user is configured', async () => {
    const { fetchImpl, calls } = fakeFetch({
      [`GET /api/v11/Service/active/${SERVICE_ID}`]: () =>
        Response.json(serviceWire({ publishingStatus: 'Draft' })),
    });
    const adapter = new PtvV11Adapter({
      environment: 'test',
      apiUser,
      apiTokenCache: tokenCache,
      fetchImpl,
    });

    const service = await adapter.getService(SERVICE_ID);

    expect(service?.publishingStatus).toBe('Draft');
    expect(calls).toEqual([
      expect.objectContaining({
        path: `/api/v11/Service/active/${SERVICE_ID}`,
        authorization: 'Bearer api-user-token',
      }),
    ]);
    expect(adapter.getCapabilities().supportsDraftRead).toBe(true);
  });

  it('falls back to the public read, without a token, if the restricted read fails', async () => {
    const { fetchImpl, calls } = fakeFetch({
      [`GET /api/v11/Service/active/${SERVICE_ID}`]: () => new Response('no', { status: 403 }),
      [`GET /api/v11/Service/${SERVICE_ID}`]: () => Response.json(serviceWire()),
    });
    const adapter = new PtvV11Adapter({
      environment: 'test',
      apiUser,
      apiTokenCache: tokenCache,
      fetchImpl,
    });

    const service = await adapter.getService(SERVICE_ID);

    expect(service?.publishingStatus).toBe('Published');
    expect(calls.at(-1)).toEqual(
      expect.objectContaining({ path: `/api/v11/Service/${SERVICE_ID}`, authorization: undefined }),
    );
  });

  it('uses only the public read without an API user', async () => {
    const { fetchImpl, calls } = fakeFetch({
      [`GET /api/v11/Service/${SERVICE_ID}`]: () => Response.json(serviceWire()),
    });
    const adapter = new PtvV11Adapter({ environment: 'test', fetchImpl });

    await adapter.getService(SERVICE_ID);

    expect(calls.map((call) => call.path)).toEqual([`/api/v11/Service/${SERVICE_ID}`]);
    expect(adapter.getCapabilities().supportsDraftRead).toBe(false);
  });
});

describe('PtvV11Adapter.applyServiceChange', () => {
  it('builds the PUT on the latest (draft) version and sends the token', async () => {
    const draft = serviceWire({
      publishingStatus: 'Draft',
      serviceDescriptions: [
        { language: 'fi', value: 'Luonnoksen tiivistelmä', type: 'Summary' },
        { language: 'fi', value: 'Kuvaus', type: 'Description' },
      ],
    });
    const { fetchImpl, calls } = fakeFetch({
      [`GET /api/v11/Service/active/${SERVICE_ID}`]: () => Response.json(draft),
      [`PUT /api/v11/Service/${SERVICE_ID}`]: () => Response.json(draft),
    });
    const adapter = new PtvV11Adapter({
      environment: 'test',
      apiUser,
      apiTokenCache: tokenCache,
      canWrite: true,
      fetchImpl,
    });

    await adapter.applyServiceChange({
      serviceId: SERVICE_ID,
      changes: { descriptions: { fi: 'Uusi kuvaus' } },
    });

    const put = calls.find((call) => call.method === 'PUT');
    expect(put?.authorization).toBe('Bearer api-user-token');
    expect(put?.body).toEqual(
      expect.objectContaining({
        publishingStatus: 'Draft',
        serviceDescriptions: [
          { language: 'fi', value: 'Luonnoksen tiivistelmä', type: 'Summary' },
          { language: 'fi', value: 'Uusi kuvaus', type: 'Description' },
        ],
      }),
    );
  });
});

describe('PtvV11Adapter Modified lock', () => {
  it('refuses to PUT when the latest version is Modified, before calling PTV', async () => {
    const { fetchImpl, calls } = fakeFetch({
      [`GET /api/v11/Service/active/${SERVICE_ID}`]: () =>
        Response.json(serviceWire({ publishingStatus: 'Modified' })),
    });
    const adapter = new PtvV11Adapter({
      environment: 'test',
      apiUser,
      apiTokenCache: tokenCache,
      canWrite: true,
      fetchImpl,
    });

    await expect(
      adapter.applyServiceChange({ serviceId: SERVICE_ID, changes: { names: { fi: 'X' } } }),
    ).rejects.toThrow(/Publish or discard that version in PTV's web UI/);
    expect(calls.some((call) => call.method === 'PUT')).toBe(false);
  });
});

describe('PtvV11Adapter connection writes', () => {
  it('writes serviceChannelIds through the Connection endpoint after the service PUT', async () => {
    const current = serviceWire({ serviceChannels: [{ serviceChannel: { id: 'a' } }] });
    const { fetchImpl, calls } = fakeFetch({
      [`GET /api/v11/Service/active/${SERVICE_ID}`]: () => Response.json(current),
      [`PUT /api/v11/Service/${SERVICE_ID}`]: () => Response.json(current),
      [`PUT /api/v11/Connection/serviceId/${SERVICE_ID}`]: () => Response.json({}),
    });
    const adapter = new PtvV11Adapter({
      environment: 'test',
      apiUser,
      apiTokenCache: tokenCache,
      canWrite: true,
      fetchImpl,
    });

    await adapter.applyServiceChange({ serviceId: SERVICE_ID, changes: { serviceChannelIds: [] } });

    expect(
      calls.filter((call) => call.method === 'PUT').map((call) => [call.path, call.body]),
    ).toEqual([
      [`/api/v11/Service/${SERVICE_ID}`, expect.any(Object)],
      [
        `/api/v11/Connection/serviceId/${SERVICE_ID}`,
        { deleteAllChannelRelations: true, channelRelations: [] },
      ],
    ]);
  });
});

describe('PtvV11Adapter.applyConnectionChange', () => {
  it('PUTs every connection, the changed one with its new extra info', async () => {
    const current = serviceWire({
      serviceChannels: [
        { serviceChannel: { id: 'a' }, serviceChargeType: 'FreeOfCharge' },
        { serviceChannel: { id: 'b' } },
      ],
    });
    const { fetchImpl, calls } = fakeFetch({
      [`GET /api/v11/Service/active/${SERVICE_ID}`]: () => Response.json(current),
      [`PUT /api/v11/Connection/serviceId/${SERVICE_ID}`]: () => Response.json({}),
    });
    const adapter = new PtvV11Adapter({
      environment: 'test',
      apiUser,
      apiTokenCache: tokenCache,
      canWrite: true,
      fetchImpl,
    });

    await adapter.applyConnectionChange({
      serviceId: SERVICE_ID,
      channelId: 'a',
      changes: { descriptions: { fi: 'Vastaanotto' } },
    });

    const put = calls.find((call) => call.method === 'PUT');
    expect(put?.authorization).toBe('Bearer api-user-token');
    expect(put?.body).toMatchObject({
      channelRelations: [
        {
          serviceChannelId: 'a',
          serviceChargeType: 'FreeOfCharge',
          description: [{ language: 'fi', value: 'Vastaanotto', type: 'Description' }],
        },
        { serviceChannelId: 'b' },
      ],
    });
  });
});

describe('PtvV11Adapter organisation writes', () => {
  const org = {
    id: 'org-1',
    publishingStatus: 'Published',
    organizationType: 'Organization',
    organizationNames: [{ language: 'fi', value: 'Vanha', type: 'Name' }],
    modified: '2026-09-24T00:00:00',
  };
  function adapterWith(routes: Record<string, () => Response>) {
    const { fetchImpl, calls } = fakeFetch(routes);
    const adapter = new PtvV11Adapter({
      environment: 'test',
      apiUser,
      apiTokenCache: tokenCache,
      canWrite: true,
      fetchImpl,
    });
    return { adapter, calls };
  }

  it('PUTs an organisation change built on the current record', async () => {
    const { adapter, calls } = adapterWith({
      'GET /api/v11/Organization/org-1': () => Response.json(org),
      'PUT /api/v11/Organization/org-1': () => Response.json(org),
    });
    await adapter.applyOrganizationChange({
      organizationId: 'org-1',
      changes: { names: { fi: 'Uusi' } },
    });
    const put = calls.find((call) => call.method === 'PUT');
    expect(put?.authorization).toBe('Bearer api-user-token');
    expect(put?.body).toEqual({
      publishingStatus: 'Published',
      organizationNames: [{ language: 'fi', value: 'Uusi', type: 'Name' }],
      displayNameType: [{ language: 'fi', type: 'Name' }],
    });
  });

  it('POSTs a new sub-organisation', async () => {
    const { adapter, calls } = adapterWith({
      'POST /api/v11/Organization': () =>
        Response.json({ ...org, id: 'org-2', publishingStatus: 'Draft' }),
    });
    const result = await adapter.createOrganization({
      parentOrganizationId: 'org-1',
      organizationType: 'Organization',
      publishingStatus: 'Draft',
      names: { fi: 'Diakoniakeskus' },
      summaries: { fi: 'Diakoniatyö' },
      descriptions: { fi: 'Kuvaus' },
    });
    expect(result).toMatchObject({ organizationId: 'org-2', publishingStatus: 'Draft' });
    expect(calls[0]?.body).toMatchObject({ parentOrganizationId: 'org-1', areaType: 'Nationwide' });
  });
});

describe('PtvV11Adapter.applyChannelChange', () => {
  it.each(['EChannel', 'Phone', 'PrintableForm', 'ServiceLocation', 'WebPage'])(
    'PUTs a %s channel to its own type path with the token',
    async (type) => {
      const wire = {
        id: 'ch-1',
        serviceChannelType: type,
        organizationId: 'org-15',
        publishingStatus: 'Published',
        serviceChannelNames: [{ language: 'fi', value: 'Vanha', type: 'Name' }],
        serviceChannelDescriptions: [],
        languages: ['fi'],
        modified: '2026-09-24T00:00:00',
      };
      const { fetchImpl, calls } = fakeFetch({
        'GET /api/v11/ServiceChannel/active/ch-1': () => Response.json(wire),
        [`PUT /api/v11/ServiceChannel/${type}/ch-1`]: () => Response.json(wire),
      });
      const adapter = new PtvV11Adapter({
        environment: 'test',
        apiUser,
        apiTokenCache: tokenCache,
        canWrite: true,
        fetchImpl,
      });

      await adapter.applyChannelChange({ channelId: 'ch-1', changes: { names: { fi: 'Uusi' } } });

      const put = calls.find((call) => call.method === 'PUT');
      expect(put?.path).toBe(`/api/v11/ServiceChannel/${type}/ch-1`);
      expect(put?.authorization).toBe('Bearer api-user-token');
    },
  );
});

describe('PtvV11Adapter.createService', () => {
  it("POSTs the new service with its organisation's area", async () => {
    const { fetchImpl, calls } = fakeFetch({
      'GET /api/v11/Organization/org-15': () =>
        Response.json({
          id: 'org-15',
          areaType: 'LimitedType',
          areas: [{ type: 'WellbeingServiceCounties', code: '16' }],
        }),
      'POST /api/v11/Service': () =>
        Response.json(serviceWire({ id: 'new-1', publishingStatus: 'Draft' })),
    });
    const adapter = new PtvV11Adapter({
      environment: 'test',
      apiUser,
      apiTokenCache: tokenCache,
      canWrite: true,
      fetchImpl,
    });

    const result = await adapter.createService({
      organizationId: 'org-15',
      serviceType: 'Service',
      publishingStatus: 'Draft',
      names: { fi: 'Testi' },
      summaries: { fi: 'Tiivistelmä' },
      descriptions: { fi: 'Kuvaus' },
      serviceClasses: [],
      ontologyTerms: [],
      targetGroups: [],
      lifeEvents: [],
      industrialClasses: [],
      languages: ['fi'],
      serviceChannelIds: [],
    });

    expect(result.serviceId).toBe('new-1');
    const post = calls.find((call) => call.method === 'POST' && call.path === '/api/v11/Service');
    expect(post?.body).toMatchObject({
      areaType: 'LimitedType',
      areas: [{ type: 'WellbeingServiceCounties', areaCodes: ['16'] }],
    });
  });
});
