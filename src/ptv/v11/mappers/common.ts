import type { CodeListEntry, LocalizedText, PublishingStatus } from '../../domain.js';
import type { V11CodeListItem, V11LocalizedItem, V11PublishingStatus } from '../wireModel.js';

/**
 * Collapses v11's `{language, value, type}[]` shape into the domain
 * model's `Record<language, string>`. When multiple entries share a
 * language (e.g. serviceDescriptions carries both "Summary" and
 * "UserInstruction" per language), the preferred `type` wins; if none of
 * the preferred types is present, the first entry for that language is
 * used rather than silently dropping the language.
 */
export function toLocalizedText(
  items: V11LocalizedItem[] | undefined,
  preferredTypes: string[] = [],
): LocalizedText {
  const result: LocalizedText = {};
  const byLanguage = new Map<string, V11LocalizedItem[]>();

  for (const item of items ?? []) {
    const existing = byLanguage.get(item.language);
    if (existing) existing.push(item);
    else byLanguage.set(item.language, [item]);
  }

  for (const [language, entries] of byLanguage) {
    const preferred = preferredTypes
      .map((type) => entries.find((entry) => entry.type === type))
      .find((entry) => entry !== undefined);
    result[language] = (preferred ?? entries[0])?.value ?? '';
  }

  return result;
}

export function toCodeListEntries(items: V11CodeListItem[] | undefined): CodeListEntry[] {
  return (items ?? []).map((item) => ({
    code: item.code ?? undefined,
    uri: item.uri ?? undefined,
    names: toLocalizedText(item.name),
  })) as CodeListEntry[];
}

const KNOWN_PUBLISHING_STATUSES: readonly PublishingStatus[] = [
  'Draft',
  'Published',
  'Modified',
  'Archived',
  'Withdrawn',
];

export function toPublishingStatus(status: V11PublishingStatus): PublishingStatus {
  // v11's write model calls archiving `Deleted`.
  if (status === 'Deleted') return 'Archived';
  if ((KNOWN_PUBLISHING_STATUSES as readonly string[]).includes(status)) {
    return status as PublishingStatus;
  }
  throw new Error(`Unknown v11 publishingStatus: ${status}`);
}

/**
 * v11's write model lists Draft, Published, Modified and Deleted, but only
 * Draft, Published and Deleted (archive) are usable (verified live):
 * - a published service can't go back to Draft ("You cannot set
 *   Publishing status as Draft when current one is Published");
 * - `Modified` is accepted once, but then every further API write of that
 *   service fails ("You cannot update entity with status Modified") until
 *   someone publishes or discards the version in PTV's own UI.
 */
export function toV11WritePublishingStatus(status: PublishingStatus): V11PublishingStatus {
  switch (status) {
    case 'Archived':
      return 'Deleted';
    case 'Draft':
    case 'Published':
      return status;
    case 'Modified':
      throw new Error(
        'PTV v11 publishingStatus Modified is not writable through the API: it locks the ' +
          'service against further API updates. Keep it Published (edits publish ' +
          'immediately) or use Draft for a service that has never been published.',
      );
    case 'Withdrawn':
      throw new Error(
        'PTV v11 cannot set publishingStatus Withdrawn; use Archived to archive the service',
      );
  }
}

/** Thrown before a PUT that PTV would refuse because the latest version is Modified. */
export class V11ModifiedVersionLockedError extends Error {
  constructor(public readonly entityId: string) {
    super(
      `PTV has an unpublished modified version of ${entityId}, and the v11 API refuses ` +
        `to update it ("You cannot update entity with status Modified"). Publish or ` +
        `discard that version in PTV's web UI first, then propose the change again.`,
    );
    this.name = 'V11ModifiedVersionLockedError';
  }
}
