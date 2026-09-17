import { Ajv, type AnySchema, type ErrorObject } from 'ajv';
import addFormats from 'ajv-formats';
import openapi from './openapi.json' with { type: 'json' };

/**
 * Plain (draft-07-targeting) Ajv, not an `Ajv2020` 2020-12 instance — even
 * though OpenAPI 3.1.1 (this spec's version) nominally uses JSON Schema
 * 2020-12. Confirmed by inspecting the vendored openapi.json directly:
 * none of its schemas declare a `$schema` dialect or use a 2020-12-only
 * keyword (`prefixItems`, `$dynamicRef`, `$dynamicAnchor`,
 * `unevaluatedProperties`/`unevaluatedItems`), so plain Ajv validates them
 * correctly in practice. This is a real gap, not a non-issue: `strict:
 * false` means an actual 2020-12 keyword added in a future spec update
 * would be silently ignored rather than erroring, so a validator "passing"
 * would not mean the data is actually valid. Re-check this whenever the
 * vendored spec is re-fetched; switch to `Ajv2020` from `ajv/dist/2020`
 * if any of those keywords ever appear.
 */
const ajv = new Ajv({ strict: false, useDefaults: true });
/**
 * Without this, Ajv silently no-ops every `format` keyword (confirmed:
 * plain `new Ajv()` logs "unknown format ... ignored" and passes values
 * regardless of format) — the vendored spec uses `format: uri` 57 times,
 * `uuid` 9 times, `date` 6 times, `email` twice, several on exactly the
 * controlled-code-list fields (`ontologyTerms`, `serviceClasses`, etc.)
 * docs/plan.md calls out as needing real validation. `ajv-formats` is the
 * Ajv team's own companion package for this, not a third-party add-on.
 */
// ajv-formats' bundled .d.ts doesn't resolve to a callable default export
// under this project's NodeNext moduleResolution (a known upstream typing
// gap, not a runtime issue — confirmed the actual runtime export is a
// plain callable function). The cast documents that mismatch instead of
// silently loosening a type elsewhere.
(addFormats as unknown as (instance: Ajv) => void)(ajv);

// Extract the components.schemas from the spec
const components = openapi.components as Record<string, unknown>;
const schemas = (components?.schemas as Record<string, AnySchema>) || {};

// Add all schemas to Ajv so references can be resolved
Object.entries(schemas).forEach(([schemaName, schema]) => {
  ajv.addSchema(schema, `#/components/schemas/${schemaName}`);
});

/**
 * Fails fast at module load if the vendored spec is ever re-fetched and a
 * schema this file depends on gets renamed or removed, rather than
 * `ajv.compile(undefined)` throwing an opaque error deep in Ajv's own code.
 */
function requireSchema(name: string): AnySchema {
  const schema = schemas[name];
  if (!schema) {
    throw new Error(`PTV v12 openapi.json is missing expected schema '${name}'`);
  }
  return schema;
}

/** Validation result type for all validators — reuses Ajv's own `ErrorObject` shape directly rather than a hand-duplicated one, so it can't drift from what Ajv actually returns. */
export interface ValidationResult {
  valid: boolean;
  errors: ErrorObject[] | null;
}

/** Helper function to create a validation result from Ajv validation. */
function createValidationResult(
  valid: boolean,
  errors: ErrorObject[] | null | undefined,
): ValidationResult {
  return {
    valid,
    errors: valid ? null : (errors ?? []),
  };
}

// PostServiceRequest validator
const validatePostServiceRequestFn = ajv.compile(requireSchema('PostServiceRequest'));

export function validatePostServiceRequest(data: unknown): ValidationResult {
  const valid = validatePostServiceRequestFn(data) as boolean;
  return createValidationResult(valid, validatePostServiceRequestFn.errors);
}

// PostEServiceChannelRequest validator
const validatePostEServiceChannelRequestFn = ajv.compile(
  requireSchema('PostEServiceChannelRequest'),
);

export function validatePostEServiceChannelRequest(data: unknown): ValidationResult {
  const valid = validatePostEServiceChannelRequestFn(data) as boolean;
  return createValidationResult(valid, validatePostEServiceChannelRequestFn.errors);
}

// PostServiceLocationChannelRequest validator
const validatePostServiceLocationChannelRequestFn = ajv.compile(
  requireSchema('PostServiceLocationChannelRequest'),
);

export function validatePostServiceLocationChannelRequest(data: unknown): ValidationResult {
  const valid = validatePostServiceLocationChannelRequestFn(data) as boolean;
  return createValidationResult(valid, validatePostServiceLocationChannelRequestFn.errors);
}

// PostPrintableFormChannelRequest validator
const validatePostPrintableFormChannelRequestFn = ajv.compile(
  requireSchema('PostPrintableFormChannelRequest'),
);

export function validatePostPrintableFormChannelRequest(data: unknown): ValidationResult {
  const valid = validatePostPrintableFormChannelRequestFn(data) as boolean;
  return createValidationResult(valid, validatePostPrintableFormChannelRequestFn.errors);
}

// PostTelephoneChannelRequest validator
const validatePostTelephoneChannelRequestFn = ajv.compile(
  requireSchema('PostTelephoneChannelRequest'),
);

export function validatePostTelephoneChannelRequest(data: unknown): ValidationResult {
  const valid = validatePostTelephoneChannelRequestFn(data) as boolean;
  return createValidationResult(valid, validatePostTelephoneChannelRequestFn.errors);
}

// PostWebPageChannelRequest validator
const validatePostWebPageChannelRequestFn = ajv.compile(requireSchema('PostWebPageChannelRequest'));

export function validatePostWebPageChannelRequest(data: unknown): ValidationResult {
  const valid = validatePostWebPageChannelRequestFn(data) as boolean;
  return createValidationResult(valid, validatePostWebPageChannelRequestFn.errors);
}

// PutServiceRequest validator
const validatePutServiceRequestFn = ajv.compile(requireSchema('PutServiceRequest'));

export function validatePutServiceRequest(data: unknown): ValidationResult {
  const valid = validatePutServiceRequestFn(data) as boolean;
  return createValidationResult(valid, validatePutServiceRequestFn.errors);
}

// PutEServiceChannelRequestSchema validator
const validatePutEServiceChannelRequestFn = ajv.compile(
  requireSchema('PutEServiceChannelRequestSchema'),
);

export function validatePutEServiceChannelRequest(data: unknown): ValidationResult {
  const valid = validatePutEServiceChannelRequestFn(data) as boolean;
  return createValidationResult(valid, validatePutEServiceChannelRequestFn.errors);
}

// PutServiceLocationChannelRequestSchema validator
const validatePutServiceLocationChannelRequestFn = ajv.compile(
  requireSchema('PutServiceLocationChannelRequestSchema'),
);

export function validatePutServiceLocationChannelRequest(data: unknown): ValidationResult {
  const valid = validatePutServiceLocationChannelRequestFn(data) as boolean;
  return createValidationResult(valid, validatePutServiceLocationChannelRequestFn.errors);
}

// PutPrintableFormChannelRequestSchema validator
const validatePutPrintableFormChannelRequestFn = ajv.compile(
  requireSchema('PutPrintableFormChannelRequestSchema'),
);

export function validatePutPrintableFormChannelRequest(data: unknown): ValidationResult {
  const valid = validatePutPrintableFormChannelRequestFn(data) as boolean;
  return createValidationResult(valid, validatePutPrintableFormChannelRequestFn.errors);
}

// PutTelephoneChannelRequestSchema validator
const validatePutTelephoneChannelRequestFn = ajv.compile(
  requireSchema('PutTelephoneChannelRequestSchema'),
);

export function validatePutTelephoneChannelRequest(data: unknown): ValidationResult {
  const valid = validatePutTelephoneChannelRequestFn(data) as boolean;
  return createValidationResult(valid, validatePutTelephoneChannelRequestFn.errors);
}

// PutWebPageChannelRequest validator
const validatePutWebPageChannelRequestFn = ajv.compile(requireSchema('PutWebPageChannelRequest'));

export function validatePutWebPageChannelRequest(data: unknown): ValidationResult {
  const valid = validatePutWebPageChannelRequestFn(data) as boolean;
  return createValidationResult(valid, validatePutWebPageChannelRequestFn.errors);
}
