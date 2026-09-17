import { describe, it, expect } from 'vitest';
import {
  validatePostServiceRequest,
  validatePostEServiceChannelRequest,
} from './writeSchemaValidators.js';

describe('writeSchemaValidators', () => {
  describe('validatePostServiceRequest', () => {
    it('should accept a minimal well-formed PostServiceRequest', () => {
      // Confirms the validator can actually pass something, not just reject
      // everything — every required field below (per the vendored spec's
      // ServiceServiceRequest branch, oneOf[0] of PostServiceRequest) is
      // filled with the simplest value satisfying its own sub-schema.
      const validRequest = {
        organizationContentId: '11111111-2222-3333-4444-555555555555',
        targetGroups: ['x'],
        // industrialClasses/ontologyTerms are `format: uri` per the vendored
        // spec (PTV's controlled URI code lists) — 'x' fails real format
        // validation now that ajv-formats is wired in, confirming that fix
        // actually catches something rather than being a no-op addition.
        industrialClasses: ['http://urn.fi/URN:NBN:fi:au:ptvl:v1101'],
        lifeEvents: ['x'],
        ontologyTerms: ['http://urn.fi/URN:NBN:fi:au:ptvl:v1101'],
        serviceClasses: ['x'],
        otherResponsibleOrganizations: ['11111111-2222-3333-4444-555555555555'],
        producers: {
          selfProducedProducers: { organizations: ['11111111-2222-3333-4444-555555555555'] },
          procuredProducers: {
            organizations: ['11111111-2222-3333-4444-555555555555'],
            other: [{ name: {} }],
          },
          otherProducers: {
            organizations: ['11111111-2222-3333-4444-555555555555'],
            other: [{ name: {} }],
          },
        },
        area: { areaType: 'WholeCountry' },
        chargeType: 'Free',
        fundingType: 'MarketFunded',
        serviceLanguages: ['se'],
        generalDescriptionContentId: '11111111-2222-3333-4444-555555555555',
        serviceType: 'Service',
        languageVersions: {},
      };

      const result = validatePostServiceRequest(validRequest);

      expect(result.valid).toBe(true);
      expect(result.errors).toBeNull();
    });

    it('should reject a PostServiceRequest with invalid type', () => {
      const invalidRequest = null;

      const result = validatePostServiceRequest(invalidRequest);

      expect(result.valid).toBe(false);
      expect(result.errors).not.toBeNull();
      if (result.errors) {
        expect(result.errors.length).toBeGreaterThan(0);
        // Should have validation errors for type mismatch
        expect(result.errors.some((e) => e.keyword === 'type' || e.keyword === 'oneOf')).toBe(true);
      }
    });

    it('should reject a PostServiceRequest with missing required fields', () => {
      const invalidRequest = {
        // Empty object missing required 'serviceType' field and oneOf requirements
      };

      const result = validatePostServiceRequest(invalidRequest);

      expect(result.valid).toBe(false);
      expect(result.errors).not.toBeNull();
      if (result.errors) {
        expect(result.errors.length).toBeGreaterThan(0);
        // The error should mention required field or oneOf validation failure
        expect(result.errors.some((e) => e.keyword === 'required' || e.keyword === 'oneOf')).toBe(
          true,
        );
      }
    });
  });

  describe('validatePostEServiceChannelRequest', () => {
    it('should accept a minimal well-formed PostEServiceChannelRequest', () => {
      const validRequest = {
        organizationContentId: '11111111-2222-3333-4444-555555555555',
        allowedConnectionType: 'AllOrganizations',
        serviceLanguages: ['se'],
        area: { areaType: 'WholeCountry' },
        languageVersions: {},
        electronicSignature: { type: 'Required', numberOfRequiredSignatures: 1 },
        electronicIdentification: 'Required',
      };

      const result = validatePostEServiceChannelRequest(validRequest);

      expect(result.valid).toBe(true);
      expect(result.errors).toBeNull();
    });

    it('should catch validation errors for invalid input type', () => {
      const invalidRequest = null;

      const result = validatePostEServiceChannelRequest(invalidRequest);

      // Null should fail type validation
      expect(result.valid).toBe(false);
      expect(result.errors).not.toBeNull();
    });

    it('should return validation result with proper structure', () => {
      const testRequest = {};

      const result = validatePostEServiceChannelRequest(testRequest);

      // The result should have the proper structure
      expect(result.valid).toBeDefined();
      expect(typeof result.valid).toBe('boolean');
      if (!result.valid) {
        expect(Array.isArray(result.errors)).toBe(true);
      } else {
        expect(result.errors).toBeNull();
      }
    });
  });
});
