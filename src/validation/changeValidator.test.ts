import { describe, expect, it } from 'vitest';
import type { Service } from '../ptv/domain.js';
import { V11ChangeValidator } from './changeValidator.js';

/** Helper: minimal valid Service fixture that passes all rules. */
function validService(): Service {
  return {
    id: 'service-123',
    organizationId: 'org-456',
    serviceType: 'Service',
    publishingStatus: 'Published',
    names: { fi: 'Test Service', en: 'Test Service' },
    summaries: { fi: 'Summary', en: 'Summary' },
    descriptions: { fi: 'Description', en: 'Description' },
    serviceClasses: [
      { uri: 'http://example.com/class1', names: { fi: 'Class 1' } },
      { uri: 'http://example.com/class2', names: { fi: 'Class 2' } },
    ],
    ontologyTerms: [{ uri: 'http://www.yso.fi/onto/koko/p1', names: { fi: 'Term 1' } }],
    targetGroups: [
      { code: 'KR2', uri: 'http://urn.fi/URN:NBN:fi:au:ptvl:v2008', names: {} },
      { code: 'KR2.3', uri: 'http://urn.fi/URN:NBN:fi:au:ptvl:v2011', names: {} },
    ],
    lifeEvents: [{ uri: 'http://example.com/event1', names: { fi: 'Event 1' } }],
    industrialClasses: [{ code: 'CODE1', names: { fi: 'Industrial 1' } }],
    languages: ['fi', 'en'],
    serviceChannelIds: [],
    modifiedAt: new Date().toISOString(),
  };
}

describe('V11ChangeValidator', () => {
  const validator = new V11ChangeValidator();

  /** `validService()` with `overrides`; a field set to `undefined` is left out of the type check. */
  const withFields = (overrides: Record<string, unknown>) =>
    ({ ...validService(), ...overrides }) as Service;
  const hasError = (service: Service, field: string) =>
    validator.validate(service).errors.some((e) => e.field === field);

  /** Asserts `service` is invalid with an error on `field`. */
  function expectError(service: Service, field: string) {
    const result = validator.validate(service);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === field)).toBe(true);
  }

  const ontologyTerms = (length: number) =>
    Array.from({ length }, (_, i) => ({
      uri: `http://www.yso.fi/onto/koko/p${i}`,
      names: { fi: `Term ${i}` },
    }));
  const serviceClasses = (length: number) =>
    Array.from({ length }, (_, i) => ({
      uri: `http://example.com/class${i}`,
      names: { fi: `Class ${i}` },
    }));

  describe('apiVersion', () => {
    it('has apiVersion = "v11"', () => {
      expect(validator.apiVersion).toBe('v11');
    });
  });

  describe('fully valid service', () => {
    it('passes with valid: true and empty errors', () => {
      const result = validator.validate(validService());
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });
  });

  describe('names validation (Rule 1)', () => {
    it('fails when names is an empty object', () => {
      const result = validator.validate(withFields({ names: {} }));
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual({
        field: 'names',
        message: expect.stringContaining('at least one non-empty language version'),
      });
    });

    it.each([
      ['all name values are empty strings', { fi: '', en: '   ' }],
      ['names is undefined', undefined],
    ])('fails when %s', (_case, names) => {
      expectError(withFields({ names }), 'names');
    });

    it('passes when at least one name has a non-empty value', () => {
      expect(hasError(withFields({ names: { fi: 'Palvelu', en: '' } }), 'names')).toBe(false);
    });
  });

  describe('organizationId validation (Rule 2)', () => {
    it.each([
      ['empty string', ''],
      ['whitespace only', '   '],
      ['undefined', undefined],
    ])('fails when organizationId is %s', (_case, organizationId) => {
      expectError(withFields({ organizationId }), 'organizationId');
    });

    it('passes when organizationId is a non-empty string', () => {
      expect(hasError(withFields({ organizationId: 'org-789' }), 'organizationId')).toBe(false);
    });
  });

  describe('serviceType validation (Rule 3)', () => {
    it('fails when serviceType is invalid', () => {
      expectError(withFields({ serviceType: 'InvalidType' }), 'serviceType');
    });

    it.each(['Service', 'ProfessionalQualification', 'PermitOrObligation'] as const)(
      'passes for serviceType: %s',
      (serviceType) => {
        expect(hasError(withFields({ serviceType }), 'serviceType')).toBe(false);
      },
    );
  });

  describe('languages validation (Rule 4)', () => {
    it.each([
      ['empty array', []],
      ['undefined', undefined],
    ])('fails when languages is %s', (_case, languages) => {
      expectError(withFields({ languages }), 'languages');
    });

    it('passes when languages is non-empty array', () => {
      expect(hasError(withFields({ languages: ['fi'] }), 'languages')).toBe(false);
    });
  });

  describe('ontologyTerms limit (Rule 5)', () => {
    it('fails when ontologyTerms has more than 10 entries', () => {
      expectError(withFields({ ontologyTerms: ontologyTerms(11) }), 'ontologyTerms');
    });

    it.each([
      ['exactly 10', ontologyTerms(10)],
      ['fewer than 10', validService().ontologyTerms],
    ])('passes when ontologyTerms has %s entries', (_case, terms) => {
      expect(hasError(withFields({ ontologyTerms: terms }), 'ontologyTerms')).toBe(false);
    });
  });

  describe('serviceClasses limit (Rule 6)', () => {
    it('fails when serviceClasses has more than 4 entries', () => {
      expectError(withFields({ serviceClasses: serviceClasses(5) }), 'serviceClasses');
    });

    it.each([
      ['exactly 4', serviceClasses(4)],
      ['fewer than 4', validService().serviceClasses],
    ])('passes when serviceClasses has %s entries', (_case, classes) => {
      expect(hasError(withFields({ serviceClasses: classes }), 'serviceClasses')).toBe(false);
    });
  });

  describe('classifications required without a general description (Rule 10)', () => {
    it.each(['serviceClasses', 'ontologyTerms', 'targetGroups'] as const)(
      'fails when %s is empty and there is no general description',
      (field) => {
        const result = validator.validate({ ...validService(), [field]: [] });
        expect(result.errors).toContainEqual({
          field,
          message: 'Required when the service has no general description',
        });
      },
    );

    it('passes with empty classifications when a general description is linked', () => {
      const result = validator.validate({
        ...validService(),
        generalDescriptionId: 'gd-1',
        serviceClasses: [],
        ontologyTerms: [],
        targetGroups: [],
        industrialClasses: [],
      });
      expect(result.valid).toBe(true);
    });
  });

  describe('not only main service classes (Rule 11)', () => {
    const mainClass = { code: 'P11', uri: 'http://urn.fi/URN:NBN:fi:au:ptvl:v1105', names: {} };
    const subClass = { code: 'P11.6', uri: 'http://urn.fi/URN:NBN:fi:au:ptvl:v1111', names: {} };

    it('fails when every service class is a main class', () => {
      const result = validator.validate({ ...validService(), serviceClasses: [mainClass] });
      expect(result.errors.some((e) => e.field === 'serviceClasses')).toBe(true);
    });

    it('passes when at least one service class is a subclass', () => {
      const result = validator.validate({
        ...validService(),
        serviceClasses: [mainClass, subClass],
      });
      expect(result.valid).toBe(true);
    });
  });

  describe('URI field validation (Rule 7)', () => {
    it.each([
      [
        'serviceClasses entry has no uri',
        'serviceClasses',
        { code: 'CODE1', names: { fi: 'Class without uri' } },
      ],
      [
        'ontologyTerms entry has empty uri',
        'ontologyTerms',
        { uri: '', names: { fi: 'Term with empty uri' } },
      ],
      [
        'ontologyTerms entry has whitespace-only uri',
        'ontologyTerms',
        { uri: '   ', names: { fi: 'Term with whitespace uri' } },
      ],
      [
        'targetGroups entry has no uri',
        'targetGroups',
        { code: 'GROUP1', names: { fi: 'Group without uri' } },
      ],
      [
        'lifeEvents entry has no uri',
        'lifeEvents',
        { code: 'EVENT1', names: { fi: 'Event without uri' } },
      ],
    ])('fails when %s', (_case, field, entry) => {
      expectError(withFields({ [field]: [entry] }), `${field}[0]`);
    });

    it('correctly identifies array index in error field for multiple violations', () => {
      const service = withFields({
        ontologyTerms: [
          { uri: 'http://valid.com', names: { fi: 'Valid' } },
          { uri: '', names: { fi: 'Invalid at index 1' } },
          { uri: 'http://valid.com', names: { fi: 'Valid' } },
          { names: { fi: 'Invalid at index 3' } },
        ],
      });
      expect(hasError(service, 'ontologyTerms[1]')).toBe(true);
      expect(hasError(service, 'ontologyTerms[3]')).toBe(true);
    });
  });

  describe('industrialClasses code validation (Rule 8)', () => {
    it.each([
      ['neither code nor uri', { names: { fi: 'Industrial without code' } }],
      ['empty code', { code: '', names: { fi: 'Industrial with empty code' } }],
      ['whitespace-only code', { code: '   ', names: { fi: 'Industrial with whitespace code' } }],
    ])('fails when industrialClasses entry has %s', (_case, entry) => {
      expectError(withFields({ industrialClasses: [entry] }), 'industrialClasses[0]');
    });

    it('correctly identifies array index for multiple violations', () => {
      const service = withFields({
        industrialClasses: [
          { code: 'VALID1', names: { fi: 'Valid' } },
          { code: '', names: { fi: 'Invalid at index 1' } },
          { names: { fi: 'Invalid at index 2' } },
        ],
      });
      expect(hasError(service, 'industrialClasses[1]')).toBe(true);
      expect(hasError(service, 'industrialClasses[2]')).toBe(true);
    });
  });

  describe('multiple simultaneous violations', () => {
    it('collects all errors without short-circuiting', () => {
      const service = {
        ...validService(),
        names: {}, // violates Rule 1
        organizationId: '', // violates Rule 2
        languages: [], // violates Rule 4
        ontologyTerms: ontologyTerms(11), // violates Rule 5
        serviceClasses: [
          // violates Rule 6
          { uri: 'http://example.com/class1', names: { fi: 'Class 1' } },
          { uri: 'http://example.com/class2', names: { fi: 'Class 2' } },
          { uri: 'http://example.com/class3', names: { fi: 'Class 3' } },
          { uri: 'http://example.com/class4', names: { fi: 'Class 4' } },
          { uri: 'http://example.com/class5', names: { fi: 'Class 5' } },
        ],
      };
      const result = validator.validate(service);
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(expect.objectContaining({ field: 'names' }));
      expect(result.errors).toContainEqual(expect.objectContaining({ field: 'organizationId' }));
      expect(result.errors).toContainEqual(expect.objectContaining({ field: 'languages' }));
      expect(result.errors).toContainEqual(expect.objectContaining({ field: 'ontologyTerms' }));
      expect(result.errors).toContainEqual(expect.objectContaining({ field: 'serviceClasses' }));
    });
  });

  describe('ontologyTerms KOKO URIs (Rule 9)', () => {
    const withTerm = (uri: string) => ({
      ...validService(),
      ontologyTerms: [{ uri, names: { fi: 'kaste' } }],
    });

    it('passes for a KOKO concept URI', () => {
      const result = validator.validate(withTerm('http://www.yso.fi/onto/koko/p71748'));
      expect(result.valid).toBe(true);
    });

    it('rejects a YSO URI with a hint that numbers differ', () => {
      const result = validator.validate(withTerm('http://www.yso.fi/onto/yso/p5473'));
      expect(result.valid).toBe(false);
      const error = result.errors.find((e) => e.field === 'ontologyTerms[0]');
      expect(error?.message).toMatch(/YSO URI/);
      expect(error?.message).toMatch(/ptv_search_ontology_terms/);
    });

    it.each([
      'https://www.yso.fi/onto/koko/p71748',
      'http://www.yso.fi/onto/koko/p71748/',
      'http://www.yso.fi/onto/mao/p1234',
      'http://example.com/term1',
      'koko:p71748',
    ])('rejects %s', (uri) => {
      const result = validator.validate(withTerm(uri));
      expect(result.errors.some((e) => e.field === 'ontologyTerms[0]')).toBe(true);
    });

    it('reports an empty uri only once (rule 7)', () => {
      const result = validator.validate(withTerm(''));
      expect(result.errors.filter((e) => e.field === 'ontologyTerms[0]')).toHaveLength(1);
    });
  });

  describe('writable publishing status (Rule 12)', () => {
    it.each(['Modified', 'Withdrawn'] as const)('fails for %s', (publishingStatus) => {
      const result = validator.validate({ ...validService(), publishingStatus });
      expect(result.errors.some((e) => e.field === 'publishingStatus')).toBe(true);
    });

    it.each(['Draft', 'Published', 'Archived'] as const)('passes for %s', (publishingStatus) => {
      const result = validator.validate({ ...validService(), publishingStatus });
      expect(result.valid).toBe(true);
    });
  });

  describe('industrial classes need target group KR2 and a subgroup (Rule 13)', () => {
    const kr1 = { code: 'KR1', uri: 'http://urn.fi/URN:NBN:fi:au:ptvl:v2001', names: {} };
    const kr2 = { code: 'KR2', uri: 'http://urn.fi/URN:NBN:fi:au:ptvl:v2008', names: {} };

    it('fails without KR2', () => {
      const result = validator.validate({ ...validService(), targetGroups: [kr1] });
      expect(result.errors.some((e) => e.field === 'targetGroups')).toBe(true);
    });

    it('fails with KR2 but no subgroup', () => {
      const result = validator.validate({ ...validService(), targetGroups: [kr1, kr2] });
      expect(result.errors.some((e) => e.field === 'targetGroups')).toBe(true);
    });

    it('passes without industrial classes', () => {
      const result = validator.validate({
        ...validService(),
        targetGroups: [kr1],
        industrialClasses: [],
      });
      expect(result.valid).toBe(true);
    });
  });
});
