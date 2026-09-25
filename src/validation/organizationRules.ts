import type { NewOrganization } from '../ptv/adapter.js';
import type { Organization, OrganizationType } from '../ptv/domain.js';
import type { ValidationError, ValidationResult } from './changeValidator.js';
import { checkAddress, checkContactDetails, SUMMARY_MAX } from './channelRules.js';

/** DVV: "Kenttään mahtuu korkeintaan 2500 merkkiä". */
export const ORGANIZATION_DESCRIPTION_MAX = 2500;

/** Types a new organisation can have; SotePublic and SotePrivate are legacy. */
export const WRITABLE_ORGANIZATION_TYPES: OrganizationType[] = [
  'State',
  'Region',
  'RegionalOrganization',
  'Municipality',
  'Organization',
  'Company',
];

const BUSINESS_CODE = /^(\d{7})-(\d)$/;
const WEIGHTS = [7, 9, 10, 5, 8, 4, 2];

/** A Finnish business ID (Y-tunnus): seven digits, a hyphen and its check digit. */
export function isValidBusinessCode(code: string): boolean {
  const match = BUSINESS_CODE.exec(code);
  if (!match) return false;
  const digits = match[1]!;
  const sum = WEIGHTS.reduce((total, weight, i) => total + weight * Number(digits[i]), 0);
  const remainder = sum % 11;
  if (remainder === 1) return false;
  return (remainder === 0 ? 0 : 11 - remainder) === Number(match[2]);
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * PTV's rules for an organisation (V9VmOpenApiOrganizationIn and DVV's
 * organisation guidelines): every language version has a name, a summary
 * and a description within their limits, a valid business ID, and contact
 * details in PTV's formats. `creating` adds what a new sub-organisation
 * needs: a parent and a type.
 */
export function validateOrganization(
  organization: Partial<Organization> | NewOrganization,
  creating = false,
): ValidationResult {
  const errors: ValidationError[] = [];
  const names = organization.names ?? {};
  const languages = Object.keys(names).filter((language) => text(names[language]));
  if (languages.length === 0) {
    errors.push({ field: 'names', message: 'Must have at least one non-empty language version' });
  }
  for (const language of languages) {
    const summary = text(organization.summaries?.[language]);
    const description = text(organization.descriptions?.[language]);
    if (!summary) {
      errors.push({
        field: `summaries.${language}`,
        message: 'Every language version needs a summary',
      });
    } else if (summary.length > SUMMARY_MAX) {
      errors.push({
        field: `summaries.${language}`,
        message: `Longer than ${SUMMARY_MAX} characters`,
      });
    }
    if (!description) {
      errors.push({
        field: `descriptions.${language}`,
        message: 'Every language version needs a description',
      });
    } else if (description.length > ORGANIZATION_DESCRIPTION_MAX) {
      errors.push({
        field: `descriptions.${language}`,
        message: `Longer than ${ORGANIZATION_DESCRIPTION_MAX} characters`,
      });
    }
  }
  for (const language of organization.alternativeNameShownIn ?? []) {
    if (!text(organization.alternativeNames?.[language])) {
      errors.push({
        field: 'alternativeNameShownIn',
        message: `No alternative name in ${language} to show`,
      });
    }
  }
  if (organization.businessCode && !isValidBusinessCode(organization.businessCode)) {
    errors.push({
      field: 'businessCode',
      message: `Not a valid business ID (Y-tunnus, 1234567-8): ${organization.businessCode}`,
    });
  }
  const status = organization.publishingStatus;
  if (status === 'Modified' || status === 'Withdrawn') {
    errors.push({
      field: 'publishingStatus',
      message:
        status === 'Modified'
          ? "PTV has an unpublished modified version of this organisation; the v11 API can't update it. Publish or discard it in PTV's web UI first."
          : 'Withdrawn cannot be written through the v11 API; use Archived to archive.',
    });
  }
  checkContactDetails(organization, errors);
  (organization.addresses ?? []).forEach((address, i) =>
    checkAddress(address, `addresses[${i}]`, errors, false),
  );
  const visiting = (organization.addresses ?? []).filter((address) => address.purpose !== 'Postal');
  if (visiting.length > 1) {
    errors.push({
      field: 'addresses',
      message:
        'An organisation has one visiting address (its main office); give the others as Postal',
    });
  }

  if (creating) {
    if (!organization.parentOrganizationId) {
      errors.push({
        field: 'parentOrganizationId',
        message: 'A sub-organisation needs its parent organisation',
      });
    }
    const type = organization.organizationType;
    if (!type || !WRITABLE_ORGANIZATION_TYPES.includes(type)) {
      errors.push({
        field: 'organizationType',
        message: `organizationType is one of ${WRITABLE_ORGANIZATION_TYPES.join(', ')}`,
      });
    }
    if (type === 'Municipality' && !organization.municipality) {
      errors.push({
        field: 'municipality',
        message: 'A Municipality organisation needs its municipality code',
      });
    }
  }
  return { valid: errors.length === 0, errors };
}
