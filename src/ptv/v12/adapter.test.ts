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
      targetGroups: [
        { contentId: 'target-1', languageVersions: { fi: { name: 'Lapset' } } },
      ],
      lifeEvents: [
        { contentId: 'life-1', languageVersions: { fi: { name: 'Lapsen syntymä' } } },
      ],
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
    expect(result.ontologyTerms).toEqual([
      { code: 'term-1', names: { fi: 'esimerkki' } },
    ]);
    expect(result.targetGroups).toEqual([
      { code: 'target-1', names: { fi: 'Lapset' } },
    ]);
    expect(result.lifeEvents).toEqual([
      { code: 'life-1', names: { fi: 'Lapsen syntymä' } },
    ]);
    expect(result.industrialClasses).toEqual([
      { code: 'class-code-1', names: {} },
    ]);
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
  it('passes query, organisation filter and pagination separately from tenant context', async () => {
    let requestedUrl = '';
    const fetchImpl: typeof fetch = async (input) => {
      requestedUrl = String(input);
      return new Response(JSON.stringify({
        items: [],
        totalCount: 0,
      }), {
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
      organizationId: '11111111-1111-1111-1111-111111111111',
      page: 2,
      pageSize: 5,
    });

    const url = new URL(requestedUrl);
    expect(url.pathname).toBe('/api/v12/service/search');
    expect(url.searchParams.get('searchText')).toBe('nuoret');
    expect(url.searchParams.get('organizationId')).toBe('11111111-1111-1111-1111-111111111111');
    expect(url.searchParams.get('page')).toBe('2');
    expect(url.searchParams.get('pageSize')).toBe('5');
  });
});
