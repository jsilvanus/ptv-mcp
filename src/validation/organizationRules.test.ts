import { describe, expect, it } from 'vitest';
import { isValidBusinessCode, validateOrganization } from './organizationRules.js';

describe('isValidBusinessCode', () => {
  it('checks the format and the check digit', () => {
    expect(isValidBusinessCode('0204819-8')).toBe(true);
    expect(isValidBusinessCode('0204819-7')).toBe(false);
    expect(isValidBusinessCode('204819-8')).toBe(false);
    expect(isValidBusinessCode('02048198')).toBe(false);
  });
});

describe('validateOrganization', () => {
  const valid = {
    names: { fi: 'Diakoniakeskus' },
    summaries: { fi: 'Seurakunnan diakoniatyö' },
    descriptions: { fi: 'Diakoniakeskus auttaa.' },
    publishingStatus: 'Published' as const,
  };

  it('accepts a complete organisation', () => {
    expect(validateOrganization(valid)).toEqual({ valid: true, errors: [] });
  });

  it('needs a summary and a description for every named language, within the limits', () => {
    const { errors } = validateOrganization({
      ...valid,
      names: { fi: 'Diakoniakeskus', sv: 'Diakonicentret' },
      descriptions: { fi: 'x'.repeat(2501) },
    });
    expect(errors.map((e) => e.field)).toEqual(
      expect.arrayContaining(['summaries.sv', 'descriptions.sv', 'descriptions.fi']),
    );
  });

  it('refuses a bad business ID, two visiting addresses and a hidden alternative name', () => {
    const street = {
      kind: 'Street' as const,
      street: { fi: 'Kirkkokatu' },
      streetNumber: '1',
      postalCode: '11100',
    };
    const { errors } = validateOrganization({
      ...valid,
      businessCode: '1234567-8',
      addresses: [street, street],
      alternativeNameShownIn: ['fi'],
    });
    expect(errors.map((e) => e.field)).toEqual(
      expect.arrayContaining(['businessCode', 'addresses', 'alternativeNameShownIn']),
    );
  });

  it('needs a parent and a writable type for a new sub-organisation', () => {
    const { errors } = validateOrganization({ ...valid, organizationType: 'SotePublic' }, true);
    expect(errors.map((e) => e.field)).toEqual(['parentOrganizationId', 'organizationType']);
    expect(
      validateOrganization(
        { ...valid, parentOrganizationId: 'root', organizationType: 'Municipality' },
        true,
      ).errors.map((e) => e.field),
    ).toEqual(['municipality']);
  });
});
