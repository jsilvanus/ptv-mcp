/** The text fields that are keyed by language version. */
const LOCALIZED_TEXT_FIELDS = ['names', 'summaries', 'descriptions'] as const;

export class InvalidLocalizedTextError extends Error {
  constructor(field: string) {
    super(
      `${field} must be an object of language code to text, e.g. {"fi": "…", "sv": "…"}; got something else.`,
    );
    this.name = 'InvalidLocalizedTextError';
  }
}

/**
 * Refuses a proposal whose names, summaries or descriptions are not
 * `{ language: text }` (an array of {language, value} pairs, say). Checked
 * when a proposal is queued, so a malformed one is never stored.
 */
export function assertLocalizedTextFields(input: object): void {
  for (const field of LOCALIZED_TEXT_FIELDS) {
    const value = (input as Record<string, unknown>)[field];
    if (value === undefined) continue;
    const valid =
      !!value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.entries(value).every(
        ([language, text]) =>
          /^[a-z]{2,3}$/.test(language) && (text === undefined || typeof text === 'string'),
      );
    if (!valid) throw new InvalidLocalizedTextError(field);
  }
}
