import type { Service, ServiceType } from '../ptv/domain.js';

/** Dot-path validation error for a field in the Service shape. */
export interface ValidationError {
  /** Dot-path into the Service shape, e.g. 'names', 'ontologyTerms', 'ontologyTerms[2]'. */
  field: string;
  message: string;
}

/** Collected validation result with all errors found. */
export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

/**
 * Common interface so a second rule set (v12's, once its write schemas are
 * final — see docs/phase-plan.md Phase 9) can be registered without
 * restructuring how callers use this.
 */
export interface ChangeValidator {
  /** `apiVersion` this validator's rules apply to, e.g. 'v11'. */
  readonly apiVersion: string;
  /** Validates the fully-merged proposed Service (current merged with a proposal's changes — not a bare partial diff). */
  validate(proposed: Service): ValidationResult;
}

/**
 * Validates a Service against v11's structural rules: required fields,
 * language coverage, list size limits, and URI/code presence to prevent
 * silent data loss during write mapping (see docs/plan.md validation section
 * and src/ptv/v11/writeMapping.ts for why URI/code checks matter).
 */
export class V11ChangeValidator implements ChangeValidator {
  apiVersion = 'v11';

  validate(proposed: Service): ValidationResult {
    const errors: ValidationError[] = [];

    this.validateNames(proposed, errors);
    this.validateOrganizationId(proposed, errors);
    this.validateServiceType(proposed, errors);
    this.validateLanguages(proposed, errors);
    this.validateOntologyTermsLimit(proposed, errors);
    this.validateServiceClassesLimit(proposed, errors);
    this.validateUriFields(proposed, errors);
    this.validateIndustrialClassesCode(proposed, errors);

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /** Rule 1: names must have at least one non-empty string. */
  private validateNames(proposed: Service, errors: ValidationError[]): void {
    const hasValidName = Object.values(proposed.names ?? {}).some(
      (v) => typeof v === 'string' && v.trim().length > 0,
    );
    if (!hasValidName) {
      errors.push({
        field: 'names',
        message: 'Must have at least one non-empty language version',
      });
    }
  }

  /** Rule 2: organizationId must be non-empty. */
  private validateOrganizationId(proposed: Service, errors: ValidationError[]): void {
    if (
      !proposed.organizationId ||
      typeof proposed.organizationId !== 'string' ||
      proposed.organizationId.trim() === ''
    ) {
      errors.push({
        field: 'organizationId',
        message: 'Must be a non-empty string',
      });
    }
  }

  /** Rule 3: serviceType must be one of the valid types. */
  private validateServiceType(proposed: Service, errors: ValidationError[]): void {
    const validTypes: ServiceType[] = [
      'Service',
      'ProfessionalQualification',
      'PermitOrObligation',
    ];
    if (!validTypes.includes(proposed.serviceType as ServiceType)) {
      errors.push({
        field: 'serviceType',
        message: `Must be one of: ${validTypes.join(', ')}`,
      });
    }
  }

  /** Rule 4: languages must be non-empty array. */
  private validateLanguages(proposed: Service, errors: ValidationError[]): void {
    if (!Array.isArray(proposed.languages) || proposed.languages.length === 0) {
      errors.push({
        field: 'languages',
        message: 'Must be a non-empty array',
      });
    }
  }

  /** Rule 5: ontologyTerms.length ≤ 10 (PTV v12 beta schema limit). */
  private validateOntologyTermsLimit(proposed: Service, errors: ValidationError[]): void {
    if (Array.isArray(proposed.ontologyTerms) && proposed.ontologyTerms.length > 10) {
      errors.push({
        field: 'ontologyTerms',
        message: `Must contain at most 10 entries (current: ${proposed.ontologyTerms.length})`,
      });
    }
  }

  /** Rule 6: serviceClasses.length ≤ 4 (PTV v12 beta schema limit). */
  private validateServiceClassesLimit(proposed: Service, errors: ValidationError[]): void {
    if (Array.isArray(proposed.serviceClasses) && proposed.serviceClasses.length > 4) {
      errors.push({
        field: 'serviceClasses',
        message: `Must contain at most 4 entries (current: ${proposed.serviceClasses.length})`,
      });
    }
  }

  /**
   * Rule 7: serviceClasses, ontologyTerms, targetGroups, lifeEvents entries
   * must have non-empty `uri` — these are written back as URI strings, and
   * entries without a uri are silently filtered out by writeMapping.ts.
   */
  private validateUriFields(proposed: Service, errors: ValidationError[]): void {
    const uriArrayFields = [
      { name: 'serviceClasses', entries: proposed.serviceClasses },
      { name: 'ontologyTerms', entries: proposed.ontologyTerms },
      { name: 'targetGroups', entries: proposed.targetGroups },
      { name: 'lifeEvents', entries: proposed.lifeEvents },
    ];

    for (const field of uriArrayFields) {
      if (Array.isArray(field.entries)) {
        field.entries.forEach((entry, index) => {
          if (!entry.uri || typeof entry.uri !== 'string' || entry.uri.trim() === '') {
            errors.push({
              field: `${field.name}[${index}]`,
              message: 'Entry must have a non-empty `uri` to be written to PTV',
            });
          }
        });
      }
    }
  }

  /**
   * Rule 8: industrialClasses entries must have non-empty `code` — written
   * back as code strings, entries without a code are silently filtered out.
   */
  private validateIndustrialClassesCode(proposed: Service, errors: ValidationError[]): void {
    if (Array.isArray(proposed.industrialClasses)) {
      proposed.industrialClasses.forEach((entry, index) => {
        if (!entry.code || typeof entry.code !== 'string' || entry.code.trim() === '') {
          errors.push({
            field: `industrialClasses[${index}]`,
            message: 'Entry must have a non-empty `code` to be written to PTV',
          });
        }
      });
    }
  }
}
