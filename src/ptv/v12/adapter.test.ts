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
