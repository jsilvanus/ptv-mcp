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
  'Archived',
  'Withdrawn',
];

export function toPublishingStatus(status: V11PublishingStatus): PublishingStatus {
  if ((KNOWN_PUBLISHING_STATUSES as readonly string[]).includes(status)) {
    return status as PublishingStatus;
  }
  throw new Error(`Unknown v11 publishingStatus: ${status}`);
}
