/**
 * PTV's field limits, shared by validation (src/validation, hard rules) and
 * the content checks (src/quality), so the two never disagree.
 */

/** Summaries of services, channels and organisations. */
export const SUMMARY_MAX = 150;
/** Service and channel descriptions. */
export const DESCRIPTION_MAX = 5000;
/** DVV's limit for an organisation's description (the API takes 5000). */
export const ORGANIZATION_DESCRIPTION_MAX = 2500;
export const MAX_SERVICE_CLASSES = 4;
export const MAX_ONTOLOGY_TERMS = 10;
