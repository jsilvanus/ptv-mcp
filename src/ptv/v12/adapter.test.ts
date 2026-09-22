import { describe, expect, it } from 'vitest';
import { mapV12Service } from './adapter.js';

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
      modifiedAt: '2026-09-18T12:34:56Z',
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
  it('never sends the unsupported searchText parameter', async () => {
    const requestedUrls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      requestedUrls.push(String(input));
      return new Response(JSON.stringify({ items: [], totalCount: 0 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const { PtvV12Adapter } = await import('./adapter.js');
    const adapter = new PtvV12Adapter({
      environment: 'test',
      apiKey: 'test-key',
      fetchImpl,
    });

    await adapter.searchServices({
      query: 'nuoret',
      page: 2,
      pageSize: 5,
    });

    const serviceUrl = requestedUrls.find((url) => url.includes('/service/search'));
    expect(serviceUrl).toBeDefined();
    expect(new URL(serviceUrl!).searchParams.has('searchText')).toBe(false);
    expect(new URL(serviceUrl!).searchParams.get('pageSize')).toBe('100');
  });
});

describe('PTV v12 search hydration', () => {
  it('hydrates an incomplete service search result before filtering', async () => {
    const requested: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      requested.push(url);
      if (url.includes('/service/search')) {
        return new Response(
          JSON.stringify({
            items: [
              {
                contentId: 'service-1',
                languageVersions: { fi: { name: 'Kirkkoon liittyminen' } },
              },
            ],
            totalCount: 1,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.includes('/service/service-1')) {
        return new Response(
          JSON.stringify({
            contentId: 'service-1',
            organization: { contentId: 'org-1' },
            languageVersions: { fi: { name: 'Kirkkoon liittyminen' } },
            modifiedAt: '2026-09-19T00:00:00Z',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const { PtvV12Adapter } = await import('./adapter.js');
    const adapter = new PtvV12Adapter({ environment: 'test', apiKey: 'test-key', fetchImpl });
    const result = await adapter.searchServices({ query: 'Kirkkoon liittyminen' });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.organizationId).toBe('org-1');
    expect(requested.some((url) => url.includes('/service/service-1'))).toBe(true);
  });

  it('hydrates organisation search results before applying text matching', async () => {
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes('/organization/search')) {
        return new Response(
          JSON.stringify({
            items: [{ contentId: 'org-1' }],
            totalCount: 1,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.includes('/organization/org-1')) {
        return new Response(
          JSON.stringify({
            contentId: 'org-1',
            languageVersions: { fi: { name: 'Riihimäen seurakunta' } },
            modifiedAt: '2026-09-19T00:00:00Z',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const { PtvV12Adapter } = await import('./adapter.js');
    const adapter = new PtvV12Adapter({ environment: 'test', apiKey: 'test-key', fetchImpl });
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
        return new Response(
          JSON.stringify({
            items: [{ contentId: 'channel-1' }],
            totalCount: 1,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.includes('/service-channel/channel-1')) {
        return new Response(
          JSON.stringify({
            contentId: 'channel-1',
            organization: { contentId: 'org-1' },
            languageVersions: { fi: { name: 'Keskuskirkko' } },
            modifiedAt: '2026-09-19T00:00:00Z',
            serviceChannelType: 'ServiceLocation',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const { PtvV12Adapter } = await import('./adapter.js');
    const adapter = new PtvV12Adapter({ environment: 'test', apiKey: 'test-key', fetchImpl });
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
  it('uses organizationContentId and preserves the v12 timestamp representation', async () => {
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes('/service/service-1')) {
        return new Response(
          JSON.stringify({
            contentId: 'service-1',
            organizationContentId: 'org-1',
            languageVersions: { fi: { name: 'Kirkkoon liittyminen' } },
            modified: '2024-10-30T20:30:10.613502Z',
            serviceClasses: ['class-1'],
            ontologyTerms: ['term-1'],
            targetGroups: ['target-1'],
            lifeEvents: ['life-1'],
            industrialClasses: ['TOL-1'],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const { PtvV12Adapter } = await import('./adapter.js');
    const adapter = new PtvV12Adapter({ environment: 'test', apiKey: 'test-key', fetchImpl });
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

  it('maps organization businessCode and organizationContentId from a search result', async () => {
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes('/organization/search')) {
        return new Response(
          JSON.stringify({
            items: [
              {
                contentId: 'org-1',
                businessCode: '0152574-9',
                languageVersions: { fi: { name: 'Riihimäen seurakunta' } },
                modified: '2024-10-30T20:30:10.613502Z',
              },
            ],
            totalCount: 1,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const { PtvV12Adapter } = await import('./adapter.js');
    const adapter = new PtvV12Adapter({ environment: 'test', apiKey: 'test-key', fetchImpl });
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
        return new Response(
          JSON.stringify({
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
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const { PtvV12Adapter } = await import('./adapter.js');
    const adapter = new PtvV12Adapter({ environment: 'test', apiKey: 'test-key', fetchImpl });
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

  it('implements general description search with organization filtering', async () => {
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes('/general-description/search')) {
        return new Response(
          JSON.stringify({
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
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const { PtvV12Adapter } = await import('./adapter.js');
    const adapter = new PtvV12Adapter({ environment: 'test', apiKey: 'test-key', fetchImpl });
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
      return new Response(
        JSON.stringify([
          {
            code: 'FI',
            languageVersions: { fi: { name: 'Suomi' } },
          },
        ]),
        { status: 200, headers: { 'content-type': 'application/json' },
      });
    };

    const { PtvV12Adapter } = await import('./adapter.js');
    const adapter = new PtvV12Adapter({ environment: 'test', apiKey: 'test-key', fetchImpl });

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
      'https://api-gw.palvelutietovaranto.trn.suomi.fi/api/v12/service-classes',
    );
  });
});
