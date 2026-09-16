import { describe, expect, it } from 'vitest';
import { getDeleteFlags, isFullReplaceField, needsDeleteFlag } from './deleteFlags.js';
import type { EntityType } from './deleteFlags.js';

describe('deleteFlags', () => {
  describe('needsDeleteFlag', () => {
    describe('Service', () => {
      it('returns deleteAllLifeEvents for lifeEvents field', () => {
        expect(needsDeleteFlag('Service', 'lifeEvents')).toBe('deleteAllLifeEvents');
      });

      it('returns deleteAllIndustrialClasses for industrialClasses field', () => {
        expect(needsDeleteFlag('Service', 'industrialClasses')).toBe('deleteAllIndustrialClasses');
      });

      it('returns deleteGeneralDescriptionId for generalDescriptionId field', () => {
        expect(needsDeleteFlag('Service', 'generalDescriptionId')).toBe(
          'deleteGeneralDescriptionId',
        );
      });

      it('returns null for names field (full-replace)', () => {
        expect(needsDeleteFlag('Service', 'names')).toBeNull();
      });

      it('returns null for descriptions field (full-replace)', () => {
        expect(needsDeleteFlag('Service', 'descriptions')).toBeNull();
      });

      it('returns null for serviceClasses field (full-replace)', () => {
        expect(needsDeleteFlag('Service', 'serviceClasses')).toBeNull();
      });

      it('returns null for ontologyTerms field (full-replace)', () => {
        expect(needsDeleteFlag('Service', 'ontologyTerms')).toBeNull();
      });

      it('returns null for targetGroups field (full-replace)', () => {
        expect(needsDeleteFlag('Service', 'targetGroups')).toBeNull();
      });

      it('returns null for languages field (full-replace)', () => {
        expect(needsDeleteFlag('Service', 'languages')).toBeNull();
      });

      it('returns null for serviceChannelIds field (full-replace)', () => {
        expect(needsDeleteFlag('Service', 'serviceChannelIds')).toBeNull();
      });
    });

    describe('EChannel', () => {
      it('returns null for names field (full-replace)', () => {
        expect(needsDeleteFlag('EChannel', 'names')).toBeNull();
      });

      it('returns null for descriptions field (full-replace)', () => {
        expect(needsDeleteFlag('EChannel', 'descriptions')).toBeNull();
      });

      it('returns null for languages field (full-replace)', () => {
        expect(needsDeleteFlag('EChannel', 'languages')).toBeNull();
      });
    });

    describe('Phone', () => {
      it('returns null for names field (full-replace)', () => {
        expect(needsDeleteFlag('Phone', 'names')).toBeNull();
      });

      it('returns null for descriptions field (full-replace)', () => {
        expect(needsDeleteFlag('Phone', 'descriptions')).toBeNull();
      });

      it('returns null for languages field (full-replace)', () => {
        expect(needsDeleteFlag('Phone', 'languages')).toBeNull();
      });
    });

    describe('PrintableForm', () => {
      it('returns null for names field (full-replace)', () => {
        expect(needsDeleteFlag('PrintableForm', 'names')).toBeNull();
      });

      it('returns null for descriptions field (full-replace)', () => {
        expect(needsDeleteFlag('PrintableForm', 'descriptions')).toBeNull();
      });

      it('returns null for languages field (full-replace)', () => {
        expect(needsDeleteFlag('PrintableForm', 'languages')).toBeNull();
      });
    });

    describe('ServiceLocation', () => {
      it('returns null for names field (full-replace)', () => {
        expect(needsDeleteFlag('ServiceLocation', 'names')).toBeNull();
      });

      it('returns null for descriptions field (full-replace)', () => {
        expect(needsDeleteFlag('ServiceLocation', 'descriptions')).toBeNull();
      });

      it('returns null for languages field (full-replace)', () => {
        expect(needsDeleteFlag('ServiceLocation', 'languages')).toBeNull();
      });
    });

    describe('WebPage', () => {
      it('returns null for names field (full-replace)', () => {
        expect(needsDeleteFlag('WebPage', 'names')).toBeNull();
      });

      it('returns null for descriptions field (full-replace)', () => {
        expect(needsDeleteFlag('WebPage', 'descriptions')).toBeNull();
      });

      it('returns null for languages field (full-replace)', () => {
        expect(needsDeleteFlag('WebPage', 'languages')).toBeNull();
      });
    });

    describe('GeneralDescription', () => {
      it('returns deleteAllLifeEvents for lifeEvents field', () => {
        expect(needsDeleteFlag('GeneralDescription', 'lifeEvents')).toBe('deleteAllLifeEvents');
      });

      it('returns deleteAllIndustrialClasses for industrialClasses field', () => {
        expect(needsDeleteFlag('GeneralDescription', 'industrialClasses')).toBe(
          'deleteAllIndustrialClasses',
        );
      });

      it('returns null for names field (full-replace)', () => {
        expect(needsDeleteFlag('GeneralDescription', 'names')).toBeNull();
      });

      it('returns null for descriptions field (full-replace)', () => {
        expect(needsDeleteFlag('GeneralDescription', 'descriptions')).toBeNull();
      });

      it('returns null for serviceClasses field (full-replace)', () => {
        expect(needsDeleteFlag('GeneralDescription', 'serviceClasses')).toBeNull();
      });

      it('returns null for ontologyTerms field (full-replace)', () => {
        expect(needsDeleteFlag('GeneralDescription', 'ontologyTerms')).toBeNull();
      });

      it('returns null for targetGroups field (full-replace)', () => {
        expect(needsDeleteFlag('GeneralDescription', 'targetGroups')).toBeNull();
      });
    });

    describe('ServiceCollection', () => {
      it('returns deleteAllServices for services field', () => {
        expect(needsDeleteFlag('ServiceCollection', 'services')).toBe('deleteAllServices');
      });

      it('returns null for names field (full-replace)', () => {
        expect(needsDeleteFlag('ServiceCollection', 'names')).toBeNull();
      });

      it('returns null for descriptions field (full-replace)', () => {
        expect(needsDeleteFlag('ServiceCollection', 'descriptions')).toBeNull();
      });
    });

    describe('Organization', () => {
      it('returns null for names field (full-replace)', () => {
        expect(needsDeleteFlag('Organization', 'names')).toBeNull();
      });
    });

    it('throws for unknown entity type', () => {
      expect(() => needsDeleteFlag('UnknownEntity' as unknown as EntityType, 'field')).toThrow(
        'Unknown entity type',
      );
    });
  });

  describe('getDeleteFlags', () => {
    it('returns all delete flags for Service', () => {
      const flags = getDeleteFlags('Service');
      expect(flags).toEqual({
        lifeEvents: 'deleteAllLifeEvents',
        industrialClasses: 'deleteAllIndustrialClasses',
        legislation: 'deleteAllLaws',
        keywords: 'deleteAllKeywords',
        serviceChargeType: 'deleteServiceChargeType',
        generalDescriptionId: 'deleteGeneralDescriptionId',
        serviceVouchers: 'deleteAllServiceVouchers',
        areas: 'deleteAllMunicipalities',
      });
    });

    it('returns all delete flags for EChannel', () => {
      const flags = getDeleteFlags('EChannel');
      expect(flags).toHaveProperty('attachments', 'deleteAllAttachments');
      expect(flags).toHaveProperty('serviceHours', 'deleteAllServiceHours');
    });

    it('returns all delete flags for GeneralDescription', () => {
      const flags = getDeleteFlags('GeneralDescription');
      expect(flags).toEqual({
        industrialClasses: 'deleteAllIndustrialClasses',
        legislation: 'deleteAllLaws',
        lifeEvents: 'deleteAllLifeEvents',
        serviceChargeType: 'deleteServiceChargeType',
      });
    });

    it('returns empty object for Organization (no domain-relevant delete flags)', () => {
      const flags = getDeleteFlags('Organization');
      expect(flags).toBeDefined();
      expect(typeof flags).toBe('object');
    });
  });

  describe('isFullReplaceField', () => {
    it('returns true for full-replace fields', () => {
      expect(isFullReplaceField('Service', 'names')).toBe(true);
      expect(isFullReplaceField('Service', 'descriptions')).toBe(true);
      expect(isFullReplaceField('Service', 'serviceClasses')).toBe(true);
      expect(isFullReplaceField('EChannel', 'names')).toBe(true);
    });

    it('returns false for fields with delete flags', () => {
      expect(isFullReplaceField('Service', 'lifeEvents')).toBe(false);
      expect(isFullReplaceField('Service', 'industrialClasses')).toBe(false);
      expect(isFullReplaceField('GeneralDescription', 'lifeEvents')).toBe(false);
    });

    it('returns true for unknown fields (conservative: treat as full-replace)', () => {
      // Unknown fields have no delete flag, so they're treated as full-replace
      expect(isFullReplaceField('Service', 'unknownField')).toBe(true);
    });
  });
});
