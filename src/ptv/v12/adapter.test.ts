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
