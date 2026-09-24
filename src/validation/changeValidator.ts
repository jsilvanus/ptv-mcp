import type { Service, ServiceChannel, ServiceType } from '../ptv/domain.js';

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
    this.validateOntologyTermUris(proposed, errors);
    this.validateRequiredClassifications(proposed, errors);
    this.validateNotOnlyMainServiceClasses(proposed, errors);
    this.validateWritablePublishingStatus(proposed, errors);
    this.validateIndustrialClassTargetGroups(proposed, errors);

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
        if (!entry.code?.trim() && !entry.uri?.trim()) {
          errors.push({
            field: `industrialClasses[${index}]`,
            message: 'Entry must have a non-empty `code` or `uri` to be written to PTV',
          });
        }
      });
    }
  }

  /**
   * Rule 9: ontologyTerms URIs must be KOKO concept URIs
   * (`http://www.yso.fi/onto/koko/pNNN`), the form PTV stores. A YSO
   * (`.../onto/yso/pNNN`) or other Finto URI is a different concept id —
   * KOKO numbers don't match YSO's — so it must be looked up, not rewritten.
   * Entries without a uri are already reported by rule 7.
   */
  private validateOntologyTermUris(proposed: Service, errors: ValidationError[]): void {
    if (!Array.isArray(proposed.ontologyTerms)) return;
    proposed.ontologyTerms.forEach((entry, index) => {
      if (typeof entry.uri !== 'string' || entry.uri.trim() === '') return;
      if (KOKO_URI.test(entry.uri)) return;
      const hint = /\/onto\/yso\/p\d+$/.test(entry.uri)
        ? ' This is a YSO URI; KOKO numbers differ from YSO, so find the matching KOKO concept (e.g. with ptv_search_ontology_terms) instead of rewriting the prefix.'
        : ' Find the term with ptv_search_ontology_terms.';
      errors.push({
        field: `ontologyTerms[${index}]`,
        message: `Ontology term URI must be a KOKO URI of the form http://www.yso.fi/onto/koko/p<number> (got "${entry.uri}").${hint}`,
      });
    });
  }

  /**
   * Rule 10: without a general description, PTV requires serviceClasses,
   * ontologyTerms and targetGroups (live 400: "The field is required when
   * 'GeneralDescriptionId' has value 'null'").
   */
  private validateRequiredClassifications(proposed: Service, errors: ValidationError[]): void {
    if (proposed.generalDescriptionId) return;
    for (const field of ['serviceClasses', 'ontologyTerms', 'targetGroups'] as const) {
      if (!Array.isArray(proposed[field]) || proposed[field].length === 0) {
        errors.push({
          field,
          message: 'Required when the service has no general description',
        });
      }
    }
  }

  /**
   * Rule 11: at least one service class must be a subclass (a code with a
   * dot, e.g. P11.6); PTV rejects only main classes such as P11 (live 400:
   * "All the service classes are main service classes. Not allowed!").
   * Entries without a code can't be classified here and let the rule pass.
   */
  private validateNotOnlyMainServiceClasses(proposed: Service, errors: ValidationError[]): void {
    const classes = proposed.serviceClasses ?? [];
    if (classes.length === 0) return;
    const onlyMain = classes.every((entry) => !!entry.code && !entry.code.includes('.'));
    if (onlyMain) {
      errors.push({
        field: 'serviceClasses',
        message:
          'At least one service class must be a subclass (e.g. P11.6), not only main classes (e.g. P11)',
      });
    }
  }

  /**
   * Rule 12: only Draft, Published and Archived can be written through the
   * v11 API. A Modified version locks the service against API updates until
   * it is published or discarded in PTV's UI (live 400: "You cannot update
   * entity with status Modified"), and Withdrawn has no v11 write value.
   */
  private validateWritablePublishingStatus(proposed: Service, errors: ValidationError[]): void {
    if (proposed.publishingStatus === 'Modified') {
      errors.push({
        field: 'publishingStatus',
        message:
          "PTV has an unpublished modified version of this service; the v11 API can't update it. Publish or discard it in PTV's web UI first, or propose publishingStatus Published.",
      });
    } else if (proposed.publishingStatus === 'Withdrawn') {
      errors.push({
        field: 'publishingStatus',
        message: 'Withdrawn cannot be written through the v11 API; use Archived to archive.',
      });
    }
  }

  /**
   * Rule 13: industrial classes need target group KR2 (businesses and
   * non-government organisations) and one of its subgroups (live 400s:
   * "Target group 'Businesses and non-government organizations (KR2)' or
   * one of the sub target groups is required if industrial classes are
   * attached" and "... one of the sub target groups is required").
   */
  private validateIndustrialClassTargetGroups(proposed: Service, errors: ValidationError[]): void {
    if (!proposed.industrialClasses?.length) return;
    const codes = (proposed.targetGroups ?? []).map((entry) => entry.code ?? '');
    if (!codes.includes('KR2') || !codes.some((code) => code.startsWith('KR2.'))) {
      errors.push({
        field: 'targetGroups',
        message:
          'Industrial classes require target group KR2 (businesses and non-government organizations) and one of its subgroups (KR2.x)',
      });
    }
  }
}

const KOKO_URI = /^http:\/\/www\.yso\.fi\/onto\/koko\/p\d+$/;

/**
 * Rules for a proposed (merged) service channel: a name, at least one
 * language, and a publishing status the v11 API can write (see rule 12).
 */
export function validateChannel(proposed: ServiceChannel): ValidationResult {
  const errors: ValidationError[] = [];
  const hasName = Object.values(proposed.names ?? {}).some(
    (value) => typeof value === 'string' && value.trim().length > 0,
  );
  if (!hasName) {
    errors.push({ field: 'names', message: 'Must have at least one non-empty language version' });
  }
  if (!Array.isArray(proposed.languages) || proposed.languages.length === 0) {
    errors.push({ field: 'languages', message: 'Must be a non-empty array' });
  }
  if (proposed.publishingStatus === 'Modified' || proposed.publishingStatus === 'Withdrawn') {
    errors.push({
      field: 'publishingStatus',
      message:
        proposed.publishingStatus === 'Modified'
          ? "PTV has an unpublished modified version of this channel; the v11 API can't update it. Publish or discard it in PTV's web UI first."
          : 'Withdrawn cannot be written through the v11 API; use Archived to archive.',
    });
  }
  return { valid: errors.length === 0, errors };
}
