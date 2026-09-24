import { describe, expect, it } from 'vitest';
import { assertLocalizedTextFields, InvalidLocalizedTextError } from './localizedInput.js';
import { checkService } from '../quality/contentChecks.js';
import type { Service } from '../ptv/domain.js';

describe('assertLocalizedTextFields', () => {
  it('accepts language-keyed text and fields that are absent', () => {
    expect(() =>
      assertLocalizedTextFields({
        names: { fi: 'Rippikoulu', sv: 'Skriftskola' },
        languages: ['fi'],
      }),
    ).not.toThrow();
  });

  it('refuses a list of {language, value} pairs and non-text values', () => {
    expect(() =>
      assertLocalizedTextFields({ names: [{ language: 'fi', value: 'Rippikoulu' }] }),
    ).toThrow(InvalidLocalizedTextError);
    expect(() => assertLocalizedTextFields({ summaries: { fi: { value: 'x' } } })).toThrow(
      /summaries/,
    );
  });
});

describe('checkService on a malformed stored proposal', () => {
  it('reports the non-text name as missing instead of throwing', () => {
    const service = {
      organizationId: 'org',
      serviceType: 'Service',
      publishingStatus: 'Draft',
      names: [{ language: 'fi', value: 'Rippikoulu' }],
      summaries: {},
      descriptions: {},
      serviceClasses: [],
      ontologyTerms: [],
      targetGroups: [],
      lifeEvents: [],
      industrialClasses: [],
      languages: ['fi'],
      serviceChannelIds: [],
    } as unknown as Service;
    const report = checkService(service);
    expect(report.findings).toContainEqual(
      expect.objectContaining({ checkId: 'Q-LANG-2', field: 'names' }),
    );
  });
});
