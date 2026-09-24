import { describe, expect, it } from 'vitest';
import type { Service, ServiceType } from '../ptv/domain.js';
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
    targetGroups: [{ uri: 'http://example.com/group1', names: { fi: 'Group 1' } }],
    lifeEvents: [{ uri: 'http://example.com/event1', names: { fi: 'Event 1' } }],
    industrialClasses: [{ code: 'CODE1', names: { fi: 'Industrial 1' } }],
    languages: ['fi', 'en'],
    serviceChannelIds: [],
    modifiedAt: new Date().toISOString(),
  };
}

describe('V11ChangeValidator', () => {
  const validator = new V11ChangeValidator();

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
      const service = { ...validService(), names: {} };
      const result = validator.validate(service);
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual({
        field: 'names',
        message: expect.stringContaining('at least one non-empty language version'),
      });
    });

    it('fails when all name values are empty strings', () => {
      const service = { ...validService(), names: { fi: '', en: '   ' } };
      const result = validator.validate(service);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.field === 'names')).toBe(true);
    });

    it('fails when names is undefined', () => {
      const service = { ...validService() } as Service;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (service as any).names = undefined;
      const result = validator.validate(service);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.field === 'names')).toBe(true);
    });

    it('passes when at least one name has a non-empty value', () => {
      const service = { ...validService(), names: { fi: 'Palvelu', en: '' } };
      const result = validator.validate(service);
      expect(result.errors.some((e) => e.field === 'names')).toBe(false);
    });
  });

  describe('organizationId validation (Rule 2)', () => {
    it('fails when organizationId is empty string', () => {
      const service = { ...validService(), organizationId: '' };
      const result = validator.validate(service);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.field === 'organizationId')).toBe(true);
    });

    it('fails when organizationId is whitespace only', () => {
      const service = { ...validService(), organizationId: '   ' };
      const result = validator.validate(service);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.field === 'organizationId')).toBe(true);
    });

    it('fails when organizationId is undefined', () => {
      const service = { ...validService() } as Service;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (service as any).organizationId = undefined;
      const result = validator.validate(service);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.field === 'organizationId')).toBe(true);
    });

    it('passes when organizationId is a non-empty string', () => {
      const service = { ...validService(), organizationId: 'org-789' };
      const result = validator.validate(service);
      expect(result.errors.some((e) => e.field === 'organizationId')).toBe(false);
    });
  });

  describe('serviceType validation (Rule 3)', () => {
    it('fails when serviceType is invalid', () => {
      const service = { ...validService() } as Service;
      service.serviceType = 'InvalidType' as unknown as ServiceType;
      const result = validator.validate(service);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.field === 'serviceType')).toBe(true);
    });

    it('passes for serviceType: Service', () => {
      const service = { ...validService() } as Service;
      service.serviceType = 'Service';
      const result = validator.validate(service);
      expect(result.errors.some((e) => e.field === 'serviceType')).toBe(false);
    });

    it('passes for serviceType: ProfessionalQualification', () => {
      const service = { ...validService() } as Service;
      service.serviceType = 'ProfessionalQualification';
      const result = validator.validate(service);
      expect(result.errors.some((e) => e.field === 'serviceType')).toBe(false);
    });

    it('passes for serviceType: PermitOrObligation', () => {
      const service = { ...validService() } as Service;
      service.serviceType = 'PermitOrObligation';
      const result = validator.validate(service);
      expect(result.errors.some((e) => e.field === 'serviceType')).toBe(false);
    });
  });

  describe('languages validation (Rule 4)', () => {
    it('fails when languages is empty array', () => {
      const service = { ...validService(), languages: [] };
      const result = validator.validate(service);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.field === 'languages')).toBe(true);
    });

    it('fails when languages is undefined', () => {
      const service = { ...validService() } as Service;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (service as any).languages = undefined;
      const result = validator.validate(service);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.field === 'languages')).toBe(true);
    });

    it('passes when languages is non-empty array', () => {
      const service = { ...validService(), languages: ['fi'] };
      const result = validator.validate(service);
      expect(result.errors.some((e) => e.field === 'languages')).toBe(false);
    });
  });

  describe('ontologyTerms limit (Rule 5)', () => {
    it('fails when ontologyTerms has more than 10 entries', () => {
      const terms = Array.from({ length: 11 }, (_, i) => ({
        uri: `http://www.yso.fi/onto/koko/p${i}`,
        names: { fi: `Term ${i}` },
      }));
      const service = { ...validService(), ontologyTerms: terms };
      const result = validator.validate(service);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.field === 'ontologyTerms')).toBe(true);
    });

    it('passes when ontologyTerms has exactly 10 entries', () => {
      const terms = Array.from({ length: 10 }, (_, i) => ({
        uri: `http://www.yso.fi/onto/koko/p${i}`,
        names: { fi: `Term ${i}` },
      }));
      const service = { ...validService(), ontologyTerms: terms };
      const result = validator.validate(service);
      expect(result.errors.some((e) => e.field === 'ontologyTerms')).toBe(false);
    });

    it('passes when ontologyTerms has fewer than 10 entries', () => {
      const service = validService();
      const result = validator.validate(service);
      expect(result.errors.some((e) => e.field === 'ontologyTerms')).toBe(false);
    });
  });

  describe('serviceClasses limit (Rule 6)', () => {
    it('fails when serviceClasses has more than 4 entries', () => {
      const classes = Array.from({ length: 5 }, (_, i) => ({
        uri: `http://example.com/class${i}`,
        names: { fi: `Class ${i}` },
      }));
      const service = { ...validService(), serviceClasses: classes };
      const result = validator.validate(service);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.field === 'serviceClasses')).toBe(true);
    });

    it('passes when serviceClasses has exactly 4 entries', () => {
      const classes = Array.from({ length: 4 }, (_, i) => ({
        uri: `http://example.com/class${i}`,
        names: { fi: `Class ${i}` },
      }));
      const service = { ...validService(), serviceClasses: classes };
      const result = validator.validate(service);
      expect(result.errors.some((e) => e.field === 'serviceClasses')).toBe(false);
    });

    it('passes when serviceClasses has fewer than 4 entries', () => {
      const service = validService();
      const result = validator.validate(service);
      expect(result.errors.some((e) => e.field === 'serviceClasses')).toBe(false);
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
    it('fails when serviceClasses entry has no uri', () => {
      const service = {
        ...validService(),
        serviceClasses: [{ code: 'CODE1', names: { fi: 'Class without uri' } }],
      };
      const result = validator.validate(service);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.field === 'serviceClasses[0]')).toBe(true);
    });

    it('fails when ontologyTerms entry has empty uri', () => {
      const service = {
        ...validService(),
        ontologyTerms: [{ uri: '', names: { fi: 'Term with empty uri' } }],
      };
      const result = validator.validate(service);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.field === 'ontologyTerms[0]')).toBe(true);
    });

    it('fails when ontologyTerms entry has whitespace-only uri', () => {
      const service = {
        ...validService(),
        ontologyTerms: [{ uri: '   ', names: { fi: 'Term with whitespace uri' } }],
      };
      const result = validator.validate(service);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.field === 'ontologyTerms[0]')).toBe(true);
    });

    it('fails when targetGroups entry has no uri', () => {
      const service = {
        ...validService(),
        targetGroups: [{ code: 'GROUP1', names: { fi: 'Group without uri' } }],
      };
      const result = validator.validate(service);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.field === 'targetGroups[0]')).toBe(true);
    });

    it('fails when lifeEvents entry has no uri', () => {
      const service = {
        ...validService(),
        lifeEvents: [{ code: 'EVENT1', names: { fi: 'Event without uri' } }],
      };
      const result = validator.validate(service);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.field === 'lifeEvents[0]')).toBe(true);
    });

    it('correctly identifies array index in error field for multiple violations', () => {
      const service = {
        ...validService(),
        ontologyTerms: [
          { uri: 'http://valid.com', names: { fi: 'Valid' } },
          { uri: '', names: { fi: 'Invalid at index 1' } },
          { uri: 'http://valid.com', names: { fi: 'Valid' } },
          { names: { fi: 'Invalid at index 3' } },
        ],
      };
      const result = validator.validate(service);
      expect(result.errors.some((e) => e.field === 'ontologyTerms[1]')).toBe(true);
      expect(result.errors.some((e) => e.field === 'ontologyTerms[3]')).toBe(true);
    });
  });

  describe('industrialClasses code validation (Rule 8)', () => {
    it('fails when industrialClasses entry has no code', () => {
      const service = {
        ...validService(),
        industrialClasses: [
          { uri: 'http://example.com/industrial1', names: { fi: 'Industrial without code' } },
        ],
      };
      const result = validator.validate(service);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.field === 'industrialClasses[0]')).toBe(true);
    });

    it('fails when industrialClasses entry has empty code', () => {
      const service = {
        ...validService(),
        industrialClasses: [{ code: '', names: { fi: 'Industrial with empty code' } }],
      };
      const result = validator.validate(service);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.field === 'industrialClasses[0]')).toBe(true);
    });

    it('fails when industrialClasses entry has whitespace-only code', () => {
      const service = {
        ...validService(),
        industrialClasses: [{ code: '   ', names: { fi: 'Industrial with whitespace code' } }],
      };
      const result = validator.validate(service);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.field === 'industrialClasses[0]')).toBe(true);
    });

    it('correctly identifies array index for multiple violations', () => {
      const service = {
        ...validService(),
        industrialClasses: [
          { code: 'VALID1', names: { fi: 'Valid' } },
          { code: '', names: { fi: 'Invalid at index 1' } },
          { uri: 'http://example.com', names: { fi: 'Invalid at index 2' } },
        ],
      };
      const result = validator.validate(service);
      expect(result.errors.some((e) => e.field === 'industrialClasses[1]')).toBe(true);
      expect(result.errors.some((e) => e.field === 'industrialClasses[2]')).toBe(true);
    });
  });

  describe('multiple simultaneous violations', () => {
    it('collects all errors without short-circuiting', () => {
      const service = {
        ...validService(),
        names: {}, // violates Rule 1
        organizationId: '', // violates Rule 2
        languages: [], // violates Rule 4
        ontologyTerms: Array.from({ length: 11 }, (_, i) => ({
          // violates Rule 5
          uri: `http://www.yso.fi/onto/koko/p${i}`,
          names: { fi: `Term ${i}` },
        })),
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
});
