import { describe, expect, it } from 'vitest';
import { V11ChangeValidator } from '../../validation/changeValidator.js';
import { mapV12Service } from './mappers/service.js';
import type { PtvOrganizationCacheService } from '../../db/ptvOrganizationCacheService.js';
import type { Organization } from '../domain.js';
import { PtvV12Adapter } from './adapter.js';

/** A 200 JSON response, as PTV returns it. */
function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/** A test-environment adapter over `fetchImpl`. */
function v12Adapter(fetchImpl: typeof fetch): PtvV12Adapter {
  return new PtvV12Adapter({ environment: 'test', apiKey: 'test-key', fetchImpl });
}

describe('PTV v12 service mapping', () => {
  it('maps languageVersions and v12 scalar fields without losing content', () => {
    const result = mapV12Service({
      contentId: 'service-123',
      organizationId: 'org-456',
      serviceType: 'Service',
      publishingStatus: 'Published',
      languageVersions: {
        fi: {
          name: 'Osallistuva budjetointi',
          summary: 'Tee ehdotuksia ja äänestä.',
          description: 'Palvelun pitkä kuvaus.',
        },
        sv: {
          name: 'Deltagande budgetering',
          summary: 'Lämna förslag och rösta.',
          description: 'Lång beskrivning.',
        },
      },
      serviceClasses: [
        {
          contentId: 'class-1',
          languageVersions: {
            fi: { name: 'Koulutus' },
            sv: { name: 'Utbildning' },
          },
        },
      ],
      ontologyTerms: [
        {
          id: 'term-1',
          languageVersions: { fi: { name: 'esimerkki' } },
        },
      ],
      targetGroups: [{ contentId: 'target-1', languageVersions: { fi: { name: 'Lapset' } } }],
      lifeEvents: [{ contentId: 'life-1', languageVersions: { fi: { name: 'Lapsen syntymä' } } }],
      industrialClasses: ['class-code-1'],
      languages: ['fi', 'sv'],
      serviceChannels: ['channel-1', { contentId: 'channel-2' }],
      modifiedAt: '2026-09-18T12:34:56Z',
    });

    expect(result).toMatchObject({
      id: 'service-123',
      organizationId: 'org-456',
      names: {
        fi: 'Osallistuva budjetointi',
        sv: 'Deltagande budgetering',
      },
      summaries: {
        fi: 'Tee ehdotuksia ja äänestä.',
        sv: 'Lämna förslag och rösta.',
      },
      descriptions: {
        fi: 'Palvelun pitkä kuvaus.',
        sv: 'Lång beskrivning.',
      },
      languages: ['fi', 'sv'],
      serviceChannelIds: ['channel-1', 'channel-2'],
      modifiedAt: '2026-09-18T12:34:56.000Z',
    });

    expect(result.serviceClasses).toEqual([
      {
        code: 'class-1',
        names: { fi: 'Koulutus', sv: 'Utbildning' },
      },
    ]);
    expect(result.ontologyTerms).toEqual([{ code: 'term-1', names: { fi: 'esimerkki' } }]);
    expect(result.targetGroups).toEqual([{ code: 'target-1', names: { fi: 'Lapset' } }]);
    expect(result.lifeEvents).toEqual([{ code: 'life-1', names: { fi: 'Lapsen syntymä' } }]);
    expect(result.industrialClasses).toEqual([{ code: 'class-code-1', names: {} }]);
  });

  it('derives languages from languageVersions when the API omits languages', () => {
    const result = mapV12Service({
      contentId: 'service-456',
      organization: { contentId: 'org-789' },
      languageVersions: {
        fi: { name: 'Palvelu' },
        en: { name: 'Service' },
      },
    });

    expect(result.organizationId).toBe('org-789');
    expect(result.languages).toEqual(['fi', 'en']);
    expect(result.names).toEqual({ fi: 'Palvelu', en: 'Service' });
  });
});

describe('PTV v12 service search parameters', () => {
  it('uses the v12 organization filter parameter names', async () => {
    const requestedUrls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      requestedUrls.push(String(input));
      return json({ items: [], totalCount: 0 });
    };
    const adapter = v12Adapter(fetchImpl);

    await adapter.searchServices({
      query: 'nuoret',
      page: 2,
      pageSize: 5,
    });

    const serviceUrl = requestedUrls.find((url) => url.includes('/service/search'));
    expect(serviceUrl).toBeDefined();
    expect(new URL(serviceUrl!).searchParams.has('searchText')).toBe(false);
    expect(new URL(serviceUrl!).searchParams.has('organizationId')).toBe(false);
    expect(new URL(serviceUrl!).searchParams.has('organizationContentIds')).toBe(false);
    expect(new URL(serviceUrl!).searchParams.get('pageSize')).toBe('100');

    await adapter.searchServices({
      organizationId: 'org-123',
      page: 1,
      pageSize: 10,
    });
    const filteredServiceUrl = requestedUrls.find(
      (url) => url.includes('/service/search') && url.includes('organizationContentIds=org-123'),
    );
    expect(filteredServiceUrl).toBeDefined();
    expect(new URL(filteredServiceUrl!).searchParams.getAll('organizationContentIds')).toEqual([
      'org-123',
    ]);
  });
});

describe('PTV v12 organizationContentIds filters', () => {
  it('uses the OpenAPI organizationContentIds array on services, channels, collections, and general descriptions', async () => {
    const requestedUrls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      requestedUrls.push(String(input));
      return json({ items: [], totalItems: 0, totalCount: 0 });
    };
    const adapter = v12Adapter(fetchImpl);

    const params = { organizationId: '2de11b91-2552-4f51-b10e-5dfad8bade77' };
    await adapter.searchServices(params);
    await adapter.searchChannels(params);
    await adapter.searchServiceCollections(params);
    await adapter.searchGeneralDescriptions(params);

    for (const path of [
      '/service/search',
      '/service-channel/search',
      '/service-collection/search',
      '/general-description/search',
    ]) {
      const url = requestedUrls.find((value) => value.includes(path));
      expect(url).toBeDefined();
      const parsed = new URL(url!);
      expect(parsed.searchParams.getAll('organizationContentIds')).toEqual([
        '2de11b91-2552-4f51-b10e-5dfad8bade77',
      ]);
      expect(parsed.searchParams.has('organizationId')).toBe(false);
    }
  });

  it('does not send a name/search-text parameter for organization search', async () => {
    const requestedUrls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      requestedUrls.push(String(input));
      if (String(input).includes('/organization/search')) {
        return json({ items: [], totalItems: 0 });
      }
      throw new Error(`Unexpected URL: ${String(input)}`);
    };
    const adapter = v12Adapter(fetchImpl);

    await adapter.searchOrganisations({ query: 'Riihimäen seurakunta' });

    const url = new URL(requestedUrls[0]!);
    expect(url.searchParams.has('name')).toBe(false);
    expect(url.searchParams.has('searchText')).toBe(false);
    expect(url.searchParams.has('organizationId')).toBe(false);
  });
});

describe('PTV v12 search hydration', () => {
  it('hydrates an incomplete service search result before filtering', async () => {
    const requested: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      requested.push(url);
      if (url.includes('/service/search')) {
        return json({
          items: [
            {
              contentId: 'service-1',
              languageVersions: { fi: { name: 'Kirkkoon liittyminen' } },
            },
          ],
          totalCount: 1,
        });
      }
      if (url.includes('/service/service-1')) {
        return json({
          contentId: 'service-1',
          organization: { contentId: 'org-1' },
          languageVersions: { fi: { name: 'Kirkkoon liittyminen' } },
          modifiedAt: '2026-09-19T00:00:00Z',
        });
      }
      if (url.includes('/connection/search')) {
        return json({ items: [], totalItems: 0, totalPages: 1 });
      }
      throw new Error(`Unexpected URL: ${url}`);
    };
    const adapter = v12Adapter(fetchImpl);
    const result = await adapter.searchServices({ query: 'Kirkkoon liittyminen' });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.organizationId).toBe('org-1');
    expect(requested.some((url) => url.includes('/service/service-1'))).toBe(true);
  });

  it('hydrates organisation search results before applying text matching', async () => {
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes('/organization/search')) {
        return json({
          items: [{ contentId: 'org-1' }],
          totalCount: 1,
        });
      }
      if (url.includes('/organization/org-1')) {
        return json({
          contentId: 'org-1',
          languageVersions: { fi: { name: 'Riihimäen seurakunta' } },
          modifiedAt: '2026-09-19T00:00:00Z',
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    };
    const adapter = v12Adapter(fetchImpl);
    const result = await adapter.searchOrganisations({ query: 'Riihimäen seurakunta' });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      id: 'org-1',
      names: { fi: 'Riihimäen seurakunta' },
    });
  });

  it('hydrates channel search results before applying text matching', async () => {
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes('/service-channel/search')) {
        return json({
          items: [{ contentId: 'channel-1' }],
          totalCount: 1,
        });
      }
      if (url.includes('/service-channel/channel-1')) {
        return json({
          contentId: 'channel-1',
          organization: { contentId: 'org-1' },
          languageVersions: { fi: { name: 'Keskuskirkko' } },
          modifiedAt: '2026-09-19T00:00:00Z',
          serviceChannelType: 'ServiceLocation',
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    };
    const adapter = v12Adapter(fetchImpl);
    const result = await adapter.searchChannels({ query: 'Keskuskirkko' });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      id: 'channel-1',
      organizationId: 'org-1',
      names: { fi: 'Keskuskirkko' },
    });
  });
});

describe('PTV v12 read parity mappings', () => {
  it('maps the v12 organization reference and preserves the v12 timestamp representation', async () => {
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes('/service/service-1')) {
        return json({
          contentId: 'service-1',
          organizationContentId: 'org-1',
          languageVersions: { fi: { name: 'Kirkkoon liittyminen' } },
          modified: '2024-10-30T20:30:10.613502Z',
          serviceClasses: ['class-1'],
          ontologyTerms: ['term-1'],
          targetGroups: ['target-1'],
          lifeEvents: ['life-1'],
          industrialClasses: ['TOL-1'],
        });
      }
      if (
        url.includes('/connection/search') ||
        /\/api\/v12\/(service-classes|ontology-terms|target-groups|life-events|industrial-classes)/.test(
          url,
        )
      ) {
        return json({ items: [], totalItems: 0, totalPages: 1 });
      }
      throw new Error(`Unexpected URL: ${url}`);
    };
    const adapter = v12Adapter(fetchImpl);
    const result = await adapter.getService('service-1');

    expect(result).toMatchObject({
      organizationId: 'org-1',
      modifiedAt: '2024-10-30T20:30:10.613Z',
      serviceClasses: [{ code: 'class-1', names: {} }],
      ontologyTerms: [{ code: 'term-1', names: {} }],
      targetGroups: [{ code: 'target-1', names: {} }],
      lifeEvents: [{ code: 'life-1', names: {} }],
      industrialClasses: [{ code: 'TOL-1', names: {} }],
    });
    expect(result?.modifiedAt).not.toBe(new Date(0).toISOString());
  });

  it('maps organization businessCode and contentId from a search result', async () => {
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes('/organization/search')) {
        return json({
          items: [
            {
              contentId: 'org-1',
              businessCode: '0152574-9',
              languageVersions: { fi: { name: 'Riihimäen seurakunta' } },
              modified: '2024-10-30T20:30:10.613502Z',
            },
          ],
          totalCount: 1,
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    };
    const adapter = v12Adapter(fetchImpl);
    const result = await adapter.searchOrganisations({ query: 'Riihimäen seurakunta' });

    expect(result.items[0]).toMatchObject({
      id: 'org-1',
      businessCode: '0152574-9',
      names: { fi: 'Riihimäen seurakunta' },
      modifiedAt: '2024-10-30T20:30:10.613Z',
    });
  });

  it('implements service collection search with organization filtering and pagination', async () => {
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes('/service-collection/search')) {
        return json({
          items: [
            {
              contentId: 'collection-1',
              organizationContentId: 'org-1',
              languageVersions: { fi: { name: 'Kirkon jäsenyys', description: 'Kuvaus' } },
              services: ['service-1'],
              modified: '2026-09-19T00:00:00Z',
            },
            {
              contentId: 'collection-2',
              organizationContentId: 'org-2',
              languageVersions: { fi: { name: 'Muu kokonaisuus' } },
              services: ['service-2'],
              modified: '2026-09-19T00:00:00Z',
            },
          ],
          totalCount: 2,
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    };
    const adapter = v12Adapter(fetchImpl);
    const result = await adapter.searchServiceCollections({
      organizationId: 'org-1',
      page: 1,
      pageSize: 1,
    });

    expect(result).toMatchObject({
      page: 1,
      pageSize: 1,
      totalCount: 1,
    });
    expect(result.items[0]).toMatchObject({
      id: 'collection-1',
      names: { fi: 'Kirkon jäsenyys' },
      serviceIds: ['service-1'],
    });
  });

  it('requests localized organization search results explicitly', async () => {
    const requested: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      requested.push(url);
      return json({
        items: [
          {
            contentId: 'org-1',
            languageVersions: { fi: { name: 'Riihimäen seurakunta' } },
            modified: '2026-09-19T00:00:00Z',
          },
        ],
        totalCount: 1,
      });
    };
    const adapter = v12Adapter(fetchImpl);
    await adapter.searchOrganisations({ query: 'Riihimäen seurakunta' });

    expect(requested[0]).toContain('languageVersions=fi');
  });

  it('maps localized names from v12 classification objects', async () => {
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes('/service/service-1')) {
        return json({
          contentId: 'service-1',
          organizationContentId: 'org-1',
          languageVersions: { fi: { name: 'Palvelu' } },
          serviceClasses: [{ code: 'class-1', name: { fi: 'Palveluluokka' } }],
          ontologyTerms: [{ code: 'term-1', languageVersions: { fi: { name: 'Ontologiatermi' } } }],
          targetGroups: [{ code: 'target-1', names: { fi: 'Kohderyhmä' } }],
          lifeEvents: [{ code: 'life-1', label: { fi: 'Elämäntapahtuma' } }],
          industrialClasses: [{ code: 'TOL-1', displayName: { fi: 'Toimiala' } }],
        });
      }
      if (url.includes('/connection/search')) {
        return json({ items: [], totalItems: 0, totalPages: 1 });
      }
      throw new Error(`Unexpected URL: ${url}`);
    };
    const adapter = v12Adapter(fetchImpl);
    const result = await adapter.getService('service-1');

    expect(result).toMatchObject({
      serviceClasses: [{ code: 'class-1', names: { fi: 'Palveluluokka' } }],
      ontologyTerms: [{ code: 'term-1', names: { fi: 'Ontologiatermi' } }],
      targetGroups: [{ code: 'target-1', names: { fi: 'Kohderyhmä' } }],
      lifeEvents: [{ code: 'life-1', names: { fi: 'Elämäntapahtuma' } }],
      industrialClasses: [{ code: 'TOL-1', names: { fi: 'Toimiala' } }],
    });
  });

  it('implements general description search with organization filtering', async () => {
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes('/general-description/search')) {
        return json({
          items: [
            {
              contentId: 'gd-1',
              organizationContentId: 'org-1',
              languageVersions: { fi: { name: 'Pohjakuvaus 1', description: 'Kuvaus' } },
              modified: '2026-09-19T00:00:00Z',
            },
            {
              contentId: 'gd-2',
              organizationContentId: 'org-2',
              languageVersions: { fi: { name: 'Pohjakuvaus 2' } },
              modified: '2026-09-19T00:00:00Z',
            },
          ],
          totalCount: 2,
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    };
    const adapter = v12Adapter(fetchImpl);
    const result = await adapter.searchGeneralDescriptions({ organizationId: 'org-1' });

    expect(result.totalCount).toBe(1);
    expect(result.items[0]).toMatchObject({
      id: 'gd-1',
      names: { fi: 'Pohjakuvaus 1' },
    });
  });

  it('supports all documented v12 reference-data lists', async () => {
    const requested: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      requested.push(url);
      return json([
        {
          code: 'FI',
          languageVersions: { fi: { name: 'Suomi' } },
        },
      ]);
    };
    const adapter = v12Adapter(fetchImpl);

    for (const name of [
      'countries',
      'industrialClasses',
      'languages',
      'lifeEvents',
      'municipalities',
      'ontologyTerms',
      'postalCodes',
      'regions',
      'serviceClasses',
      'targetGroups',
      'wellbeingServicesCounties',
    ]) {
      const result = await adapter.listCodes(name);
      expect(result[0]).toMatchObject({ code: 'FI', names: { fi: 'Suomi' } });
    }

    expect(requested).toHaveLength(11);
    expect(requested).toContain(
      'https://api-gw.palvelutietovaranto.trn.suomi.fi/api/v12/service-classes?page=1&pageSize=100',
    );
  });
});

describe('PTV v12 catalogue pagination', () => {
  it('keeps fetching pages until totalItems is reached', async () => {
    const requestedPages: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const url = new URL(String(input));
      if (url.pathname === '/api/v12/organization/search') {
        const page = url.searchParams.get('page') ?? '';
        requestedPages.push(page);
        const items =
          page === '1'
            ? Array.from({ length: 100 }, (_, i) => ({
                contentId: `org-${i}`,
                languageVersions: { fi: { name: `Organisaatio ${i}` } },
              }))
            : [
                {
                  contentId: 'org-riihimaki',
                  languageVersions: { fi: { name: 'Riihimäen seurakunta' } },
                },
              ];
        return json({
          page: Number(page),
          pageSize: 100,
          totalItems: 101,
          totalPages: 2,
          items,
        });
      }
      throw new Error(`Unexpected URL: ${url.toString()}`);
    };
    const adapter = v12Adapter(fetchImpl);
    const result = await adapter.searchOrganisations({ query: 'Riihimäen seurakunta' });

    expect(requestedPages).toEqual(['1', '2']);
    expect(result.items.map((org) => org.id)).toEqual(['org-riihimaki']);
  });
});

describe('PTV v12 wire-shape mappings', () => {
  it('maps v12 service field names and the PermitOrOtherObligation subtype', () => {
    const result = mapV12Service({
      contentId: 'service-1',
      organizationContentId: 'org-1',
      serviceType: 'PermitOrOtherObligation',
      generalDescriptionContentId: 'gd-1',
      serviceLanguages: ['fi', 'sv'],
      languageVersions: { fi: { name: 'Lupa' } },
    });

    expect(result).toMatchObject({
      serviceType: 'PermitOrObligation',
      generalDescriptionId: 'gd-1',
      languages: ['fi', 'sv'],
    });
  });

  it('walks the hierarchy through parentOrganizationContentId', async () => {
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith('/organization/child'))
        return json({
          contentId: 'child',
          parentOrganizationContentId: 'parent',
          languageVersions: { fi: { name: 'Riihimäen seurakunta' } },
        });
      if (url.endsWith('/organization/parent'))
        return json({
          contentId: 'parent',
          parentOrganizationContentId: null,
          languageVersions: { fi: { name: 'Hämeenlinnan hiippakunta' } },
        });
      throw new Error(`Unexpected URL: ${url}`);
    };
    const adapter = v12Adapter(fetchImpl);
    const hierarchy = await adapter.getOrganisationHierarchy('child');

    expect(hierarchy.map((org) => org.id)).toEqual(['child', 'parent']);
  });

  it('maps TelephoneService channels to Phone', async () => {
    const fetchImpl: typeof fetch = async () =>
      json({
        contentId: 'channel-1',
        organizationContentId: 'org-1',
        serviceChannelType: 'TelephoneService',
        serviceLanguages: ['fi'],
        languageVersions: { fi: { name: 'Puhelinpalvelu' } },
      });
    const adapter = v12Adapter(fetchImpl);

    expect(await adapter.getChannel('channel-1')).toMatchObject({
      channelType: 'Phone',
      languages: ['fi'],
    });
  });

  it('searches connections server-side by service and by channel id', async () => {
    const requested: URL[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const url = new URL(String(input));
      requested.push(url);
      const items = url.searchParams.has('serviceContentIds')
        ? [{ serviceContentId: 'service-1', channelContentId: 'channel-1' }]
        : [];
      return json({ page: 1, pageSize: 100, totalItems: items.length, totalPages: 1, items });
    };
    const adapter = v12Adapter(fetchImpl);
    const connections = await adapter.getConnectionsFor('service-1');

    expect(connections).toMatchObject([{ serviceId: 'service-1', channelId: 'channel-1' }]);
    expect(requested.map((url) => url.searchParams.getAll('serviceContentIds'))).toContainEqual([
      'service-1',
    ]);
    expect(requested.map((url) => url.searchParams.getAll('channelContentIds'))).toContainEqual([
      'service-1',
    ]);
  });

  it('fills serviceChannelIds from connection search', async () => {
    const fetchImpl: typeof fetch = async (input) => {
      const url = new URL(String(input));
      if (url.pathname === '/api/v12/service/service-1')
        return json({
          contentId: 'service-1',
          organizationContentId: 'org-1',
          serviceType: 'Service',
          languageVersions: { fi: { name: 'Kaste' } },
        });
      if (url.pathname === '/api/v12/connection/search') {
        if (url.searchParams.getAll('serviceContentIds').join() !== 'service-1')
          return json({ page: 1, pageSize: 100, totalItems: 0, totalPages: 1, items: [] });
        return json({
          page: 1,
          pageSize: 100,
          totalItems: 2,
          totalPages: 1,
          items: [
            {
              serviceContentId: 'service-1',
              channelContentId: 'channel-1',
              publishedAt: '2026-09-01T10:00:00Z',
              languageVersions: { fi: { description: 'Toimisto' } },
            },
            { serviceContentId: 'service-1', channelContentId: 'channel-2' },
          ],
        });
      }
      throw new Error(`Unexpected URL: ${url.toString()}`);
    };
    const adapter = v12Adapter(fetchImpl);

    expect((await adapter.getService('service-1'))?.serviceChannelIds).toEqual([
      'channel-1',
      'channel-2',
    ]);
    expect(await adapter.getConnectionsFor('service-1')).toContainEqual({
      serviceId: 'service-1',
      channelId: 'channel-1',
      descriptions: { fi: 'Toimisto' },
      modifiedAt: '2026-09-01T10:00:00.000Z',
    });
  });

  it('reads service collection members from items', async () => {
    const fetchImpl: typeof fetch = async () =>
      json({
        page: 1,
        pageSize: 100,
        totalItems: 1,
        totalPages: 1,
        items: [
          {
            contentId: 'collection-1',
            organizationContentId: 'org-1',
            languageVersions: { fi: { name: 'Kokoelma' } },
            items: [
              { itemType: 'Service', contentId: 'service-1' },
              { itemType: 'Channel', contentId: 'channel-1' },
            ],
          },
        ],
      });
    const adapter = v12Adapter(fetchImpl);
    const result = await adapter.searchServiceCollections({});

    expect(result.items[0]?.serviceIds).toEqual(['service-1']);
  });

  it('fetches every page listed in totalPages, in order', async () => {
    const fetchImpl: typeof fetch = async (input) => {
      const page = Number(new URL(String(input)).searchParams.get('page'));
      return json({
        page,
        pageSize: 1,
        totalItems: 4,
        totalPages: 4,
        items: [{ contentId: `org-${page}`, languageVersions: { fi: { name: `Org ${page}` } } }],
      });
    };
    const adapter = v12Adapter(fetchImpl);
    const result = await adapter.searchOrganisations({});

    expect(result.items.map((org) => org.id)).toEqual(['org-1', 'org-2', 'org-3', 'org-4']);
    expect(result.totalCount).toBe(4);
  });
});

describe('PTV v12 classification code names', () => {
  const page = (items: unknown[]) =>
    json({ page: 1, pageSize: 100, totalItems: items.length, totalPages: 1, items });
  const ontologyUri = 'http://www.yso.fi/onto/koko/p4416';

  function serviceFetch(requested: URL[], serviceClasses: string[]): typeof fetch {
    return async (input) => {
      const url = new URL(String(input));
      requested.push(url);
      if (url.pathname === '/api/v12/service/service-1')
        return json({
          contentId: 'service-1',
          organizationContentId: 'org-1',
          serviceType: 'Service',
          languageVersions: { fi: { name: 'Nuoren tai aikuisen kaste' } },
          serviceClasses,
          ontologyTerms: [ontologyUri],
        });
      if (url.pathname === '/api/v12/connection/search') return page([]);
      if (url.pathname === '/api/v12/service-classes')
        return page(
          url.searchParams
            .getAll('codes')
            .filter((code) => code === 'P25.6')
            .map((code) => ({
              code,
              uri: `http://uri.suomi.fi/codelist/ptv/ptvserclass2/code/${code}`,
              name: { fi: 'Uskonnot ja vakaumukset', en: 'Religions and beliefs' },
            })),
        );
      if (url.pathname === '/api/v12/ontology-terms') {
        expect(url.searchParams.getAll('uris')).toEqual([ontologyUri]);
        return page([{ uri: ontologyUri, name: { fi: 'kaste' } }]);
      }
      throw new Error(`Unexpected URL: ${url.toString()}`);
    };
  }

  it('fills names by code and by URI, and serves repeats from the cache', async () => {
    const requested: URL[] = [];
    const { CodeNameCache } = await import('./codeNameCache.js');
    const adapter = new PtvV12Adapter({
      environment: 'test',
      apiKey: 'test-key',
      fetchImpl: serviceFetch(requested, ['P25.6', 'P99.9']),
      codeNameCache: new CodeNameCache(),
    });

    const service = await adapter.getService('service-1');

    expect(service?.serviceClasses).toEqual([
      {
        code: 'P25.6',
        uri: 'http://uri.suomi.fi/codelist/ptv/ptvserclass2/code/P25.6',
        names: { fi: 'Uskonnot ja vakaumukset', en: 'Religions and beliefs' },
      },
      { code: 'P99.9', names: {} },
    ]);
    expect(service?.ontologyTerms).toEqual([{ uri: ontologyUri, names: { fi: 'kaste' } }]);

    const lookups = () =>
      requested.filter((url) => /service-classes|ontology-terms/.test(url.pathname)).length;
    expect(lookups()).toBe(2);
    await adapter.getService('service-1');
    // Known and unknown codes are both cached: no further lookups.
    expect(lookups()).toBe(2);
  });

  it('persists resolved names to the store, so a fresh process skips PTV lookups', async () => {
    const { CodeNameCache } = await import('./codeNameCache.js');
    type Store = import('./codeNameCache.js').CodeNameStore;
    type Row = import('./codeNameCache.js').StoredCodeName;
    const rows = new Map<string, Row>();
    const store: Store = {
      load: async (environment, kind, keys) =>
        keys.flatMap((key) => rows.get(`${environment}|${kind}|${key}`) ?? []),
      save: async (saved) => {
        for (const row of saved) rows.set(`${row.environment}|${row.kind}|${row.key}`, row);
      },
    };

    const firstRequests: URL[] = [];
    await new PtvV12Adapter({
      environment: 'test',
      apiKey: 'test-key',
      fetchImpl: serviceFetch(firstRequests, ['P25.6', 'P99.9']),
      codeNameCache: new CodeNameCache(undefined, undefined, store),
    }).getService('service-1');
    expect(rows.get(`test|ontologyTerms|${ontologyUri}`)?.entry).toEqual({
      uri: ontologyUri,
      names: { fi: 'kaste' },
    });
    // The unknown code is persisted as a miss too.
    expect(rows.get('test|serviceClasses|P99.9')?.entry).toEqual({ names: {} });

    const secondRequests: URL[] = [];
    const service = await new PtvV12Adapter({
      environment: 'test',
      apiKey: 'test-key',
      fetchImpl: serviceFetch(secondRequests, ['P25.6', 'P99.9']),
      codeNameCache: new CodeNameCache(undefined, undefined, store),
    }).getService('service-1');
    expect(
      secondRequests.filter((url) => /service-classes|ontology-terms/.test(url.pathname)),
    ).toEqual([]);
    expect(service?.serviceClasses[0]?.names.fi).toBe('Uskonnot ja vakaumukset');
    expect(service?.ontologyTerms).toEqual([{ uri: ontologyUri, names: { fi: 'kaste' } }]);
  });

  it('falls back to PTV when the store fails', async () => {
    const requested: URL[] = [];
    const { CodeNameCache } = await import('./codeNameCache.js');
    const failing = {
      load: async () => {
        throw new Error('db down');
      },
      save: async () => {
        throw new Error('db down');
      },
    };
    const service = await new PtvV12Adapter({
      environment: 'test',
      apiKey: 'test-key',
      fetchImpl: serviceFetch(requested, ['P25.6']),
      codeNameCache: new CodeNameCache(undefined, undefined, failing),
    }).getService('service-1');
    expect(service?.serviceClasses[0]?.names.fi).toBe('Uskonnot ja vakaumukset');
  });

  it('batches code lookups to 20 per request', async () => {
    const requested: URL[] = [];
    const codes = Array.from({ length: 25 }, (_, i) => `P${i + 1}`);
    const { CodeNameCache } = await import('./codeNameCache.js');
    const adapter = new PtvV12Adapter({
      environment: 'test',
      apiKey: 'test-key',
      fetchImpl: serviceFetch(requested, codes),
      codeNameCache: new CodeNameCache(),
    });

    await adapter.getService('service-1');

    const batches = requested
      .filter((url) => url.pathname === '/api/v12/service-classes')
      .map((url) => url.searchParams.getAll('codes').length)
      .sort((a, b) => a - b);
    expect(batches).toEqual([5, 20]);
  });

  it('expires cached names after the TTL', async () => {
    const { CodeNameCache } = await import('./codeNameCache.js');
    let now = 0;
    const cache = new CodeNameCache(1000, () => now);
    cache.set('test', 'serviceClasses', 'P25.6', { names: { fi: 'Uskonnot' } });

    now = 999;
    expect(cache.get('test', 'serviceClasses', 'P25.6')).toEqual({ names: { fi: 'Uskonnot' } });
    expect(cache.get('production', 'serviceClasses', 'P25.6')).toBeUndefined();
    now = 1000;
    expect(cache.get('test', 'serviceClasses', 'P25.6')).toBeUndefined();
  });
});

describe('PTV v12 empty translations and code-name TTLs', () => {
  it('drops empty-string translations', () => {
    const result = mapV12Service({
      contentId: 'service-1',
      organizationContentId: 'org-1',
      languageVersions: {
        fi: { name: 'Kahvitilaisuus', summary: '', description: '  ' },
        sv: { name: '' },
      },
    });

    expect(result.names).toEqual({ fi: 'Kahvitilaisuus' });
    expect(result.summaries).toEqual({});
    expect(result.descriptions).toEqual({});
  });

  it('keeps found names for 30 days but unknown codes for only a day', async () => {
    const { CodeNameCache, DEFAULT_CODE_NAME_TTL_MS, MISSING_CODE_NAME_TTL_MS } =
      await import('./codeNameCache.js');
    const day = 24 * 60 * 60 * 1000;
    expect(DEFAULT_CODE_NAME_TTL_MS).toBe(30 * day);
    expect(MISSING_CODE_NAME_TTL_MS).toBe(day);

    let now = 0;
    const cache = new CodeNameCache(DEFAULT_CODE_NAME_TTL_MS, () => now);
    cache.set('test', 'ontologyTerms', 'known', { names: { fi: 'kaste' } });
    cache.set('test', 'ontologyTerms', 'unknown', { names: {} }, MISSING_CODE_NAME_TTL_MS);

    now = day;
    expect(cache.get('test', 'ontologyTerms', 'unknown')).toBeUndefined();
    now = 30 * day - 1;
    expect(cache.get('test', 'ontologyTerms', 'known')).toEqual({ names: { fi: 'kaste' } });
  });
});

describe('PTV v12 classifications are writable through v11', () => {
  it('fills code and uri so a v12-read service passes the v11 change validator', async () => {
    const base = 'http://uri.suomi.fi/codelist';
    const lists: Record<string, Array<{ code?: string; uri: string }>> = {
      '/api/v12/service-classes': [{ code: 'P25.6', uri: `${base}/ptv/ptvserclass2/code/P25.6` }],
      '/api/v12/target-groups': [
        { code: 'KR1', uri: `${base}/ptv/ptvkohderyhmat/code/KR1` },
        { code: 'KR2', uri: `${base}/ptv/ptvkohderyhmat/code/KR2` },
        { code: 'KR2.3', uri: `${base}/ptv/ptvkohderyhmat/code/KR2.3` },
      ],
      '/api/v12/life-events': [{ code: 'KE4', uri: `${base}/ptv/ptvelamantilanteet/code/KE4` }],
      '/api/v12/industrial-classes': [
        { code: '55109', uri: `${base}/jhs/toimiala_1_20080101/code/55109` },
      ],
      '/api/v12/ontology-terms': [{ uri: 'http://www.yso.fi/onto/koko/p76271' }],
    };
    const fetchImpl: typeof fetch = async (input) => {
      const url = new URL(String(input));
      const page = (items: unknown[]) =>
        json({
          page: 1,
          pageSize: 100,
          totalItems: items.length,
          totalPages: 1,
          items,
        });
      if (url.pathname === '/api/v12/service/service-1')
        return json({
          contentId: 'service-1',
          organizationContentId: 'org-1',
          serviceType: 'Service',
          languageVersions: {
            fi: { name: 'Kodin siunaaminen', summary: 'Tiivistelmä', description: 'Kuvaus' },
          },
          serviceClasses: ['P25.6'],
          // Industrial classes need KR2 and a subgroup (validator rule 13).
          targetGroups: ['KR1', 'KR2', 'KR2.3'],
          lifeEvents: ['KE4'],
          industrialClasses: [`${base}/jhs/toimiala_1_20080101/code/55109`],
          ontologyTerms: ['http://www.yso.fi/onto/koko/p76271'],
        });
      if (url.pathname === '/api/v12/connection/search') return page([]);
      const list = lists[url.pathname];
      if (list)
        return page(list.map((item) => ({ ...item, name: { fi: `nimi ${item.code ?? ''}` } })));
      throw new Error(`Unexpected URL: ${url.toString()}`);
    };
    const { CodeNameCache } = await import('./codeNameCache.js');
    const adapter = new PtvV12Adapter({
      environment: 'test',
      apiKey: 'test-key',
      fetchImpl,
      codeNameCache: new CodeNameCache(),
    });
    const service = await adapter.getService('service-1');

    expect(service?.industrialClasses).toMatchObject([
      { code: '55109', uri: `${base}/jhs/toimiala_1_20080101/code/55109` },
    ]);
    expect(service?.ontologyTerms).toMatchObject([{ uri: 'http://www.yso.fi/onto/koko/p76271' }]);
    expect(service?.lifeEvents).toMatchObject([
      { code: 'KE4', uri: `${base}/ptv/ptvelamantilanteet/code/KE4` },
    ]);
    const result = new V11ChangeValidator().validate(service!);
    expect(result.errors).toEqual([]);
  });
});

describe('PTV v12 ontology term search', () => {
  it('searches by name server-side, valid terms only, and returns KOKO URIs', async () => {
    const requested: URL[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const url = new URL(String(input));
      requested.push(url);
      return json({
        page: 2,
        pageSize: 20,
        totalItems: 23,
        totalPages: 2,
        items: [
          {
            uri: 'http://www.yso.fi/onto/koko/p71748',
            type: null,
            parentUris: [],
            isValid: true,
            name: { fi: 'kaste (uskonto)', sv: 'dop (religion)', en: 'baptism' },
          },
        ],
      });
    };
    const { CodeNameCache } = await import('./codeNameCache.js');
    const cache = new CodeNameCache();
    const adapter = new PtvV12Adapter({
      environment: 'test',
      apiKey: 'test-key',
      fetchImpl,
      codeNameCache: cache,
    });
    const result = await adapter.searchOntologyTerms({ query: ' kaste ', page: 2 });

    expect(requested).toHaveLength(1);
    expect(requested[0]!.pathname).toBe('/api/v12/ontology-terms');
    expect(Object.fromEntries(requested[0]!.searchParams)).toEqual({
      name: 'kaste',
      isValid: 'true',
      page: '2',
      pageSize: '20',
    });
    expect(result).toEqual({
      items: [
        {
          uri: 'http://www.yso.fi/onto/koko/p71748',
          names: { fi: 'kaste (uskonto)', sv: 'dop (religion)', en: 'baptism' },
        },
      ],
      page: 2,
      pageSize: 20,
      totalCount: 23,
    });
    // Found terms also warm the code-name cache.
    expect(cache.get('test', 'ontologyTerms', 'http://www.yso.fi/onto/koko/p71748')?.names).toEqual(
      { fi: 'kaste (uskonto)', sv: 'dop (religion)', en: 'baptism' },
    );
  });

  it('caps pageSize at the v12 maximum of 100', async () => {
    let pageSize: string | null = null;
    const fetchImpl: typeof fetch = async (input) => {
      pageSize = new URL(String(input)).searchParams.get('pageSize');
      return json({ items: [], totalItems: 0, totalPages: 0 });
    };
    const adapter = v12Adapter(fetchImpl);

    await adapter.searchOntologyTerms({ query: 'kaste', pageSize: 500 });

    expect(pageSize).toBe('100');
  });
});

describe('PTV v12 connection batches and organisation cache', () => {
  const page = (items: unknown[]) =>
    json({ page: 1, pageSize: 100, totalItems: items.length, totalPages: 1, items });

  it('reads the connections of 25 services in 2 requests, in service order', async () => {
    const requested: URL[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const url = new URL(String(input));
      requested.push(url);
      return page(
        url.searchParams
          .getAll('serviceContentIds')
          .reverse()
          .map((id) => ({ serviceContentId: id, channelContentId: `${id}-channel` })),
      );
    };
    const ids = Array.from({ length: 25 }, (_, i) => `service-${i}`);
    const adapter = v12Adapter(fetchImpl);
    const connections = await adapter.getConnectionsForServices(ids);

    expect(requested.map((url) => url.searchParams.getAll('serviceContentIds').length)).toEqual([
      20, 5,
    ]);
    expect(connections.map((connection) => connection.serviceId)).toEqual(ids);
  });

  it('searches connections by one end only when told which it is', async () => {
    const requested: URL[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const url = new URL(String(input));
      requested.push(url);
      return page([{ serviceContentId: 'service-1', channelContentId: 'channel-1' }]);
    };
    const adapter = v12Adapter(fetchImpl);

    expect(await adapter.getConnectionsFor('channel-1', 'channel')).toHaveLength(1);
    expect(requested).toHaveLength(1);
    expect(requested[0]?.searchParams.getAll('channelContentIds')).toEqual(['channel-1']);
  });

  it('serves organisation searches from the tenant cache until it goes stale', async () => {
    const stored = new Map<string, Organization[]>();
    const cache = {
      hasFreshCatalogue: async (key: { apiVersion: string }) => stored.has(key.apiVersion),
      replaceCatalogue: async (key: { apiVersion: string }, organizations: Organization[]) => {
        stored.set(key.apiVersion, organizations);
      },
      search: async (key: { apiVersion: string }) => stored.get(key.apiVersion) ?? [],
    } as unknown as PtvOrganizationCacheService;
    const requested: URL[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      requested.push(new URL(String(input)));
      return page([
        { contentId: 'org-1', languageVersions: { fi: { name: 'Riihimäen seurakunta' } } },
        { contentId: 'org-2', languageVersions: { fi: { name: 'Hyvinkään seurakunta' } } },
      ]);
    };
    const adapter = () =>
      new PtvV12Adapter({
        environment: 'test',
        apiKey: 'test-key',
        fetchImpl,
        organizationCache: cache,
        tenantId: 'tenant-1',
      });

    const first = await adapter().searchOrganisations({ query: 'riihimäen' });
    const second = await adapter().searchOrganisations({ query: 'riihimäen' });

    expect(first.items.map((org) => org.id)).toEqual(['org-1']);
    expect(second).toEqual(first);
    expect(requested).toHaveLength(1);
    expect(stored.get('v12')?.map((org) => org.id)).toEqual(['org-1', 'org-2']);
  });
});
