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

interface Call {
  method: string;
  path: string;
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
