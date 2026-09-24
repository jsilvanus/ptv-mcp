import type { CodeListEntry, LocalizedText, Service } from '../domain.js';
import { needsDeleteFlag } from './deleteFlags.js';
import { toV11WritePublishingStatus } from './mappers/common.js';
import type { V11CodeListItem, V11LocalizedItem, V11ServiceWire } from './wireModel.js';

/**
 * Translates a domain-level partial Service change into the body v11's
 * `PUT /api/v11/Service/{id}` expects.
 *
 * Verified live against the test environment (2026-09-24), the PUT is not
 * a plain partial update:
 * - `publishingStatus` is always required.
 * - `serviceClasses`, `ontologyTerms` and `targetGroups` are required
 *   whenever the service has no general description.
 * - `serviceDescriptions` is replaced as a whole list and must still carry
 *   a `Summary`, so changing only the description has to resend the rest.
 *
 * So the body starts from `current`, the raw wire record the change is
 * applied to: those required fields are always sent (from `changes` when
 * it touches them, otherwise unchanged from `current`), and the localized
 * lists keep the entry types the domain model doesn't carry
 * (`AlternativeName`, `UserInstruction`, ...).
 *
 * Field presence in `changes` (via `in`, not just truthiness) is what
 * signals "the proposal touches this field": an explicit empty
 * array/undefined means "clear it", while an absent key means "leave it
 * alone".
 */
export function serviceChangesToV11Body(
  changes: Partial<Service>,
  current?: V11ServiceWire,
): Record<string, unknown> {
  const body: Record<string, unknown> = {};

  if (changes.publishingStatus) {
    body.publishingStatus = toV11WritePublishingStatus(changes.publishingStatus);
  } else if (current) {
    body.publishingStatus = current.publishingStatus;
  }

  if ('names' in changes) {
    body.serviceNames = [
      ...keptWireItems(current?.serviceNames, ['Name']),
      ...localizedTextToWireList(changes.names, 'Name'),
    ];
  }

  if ('summaries' in changes || 'descriptions' in changes) {
    const summaries =
      'summaries' in changes
        ? localizedTextToWireList(changes.summaries, 'Summary')
        : wireItemsOfType(current?.serviceDescriptions, 'Summary');
    const descriptions =
      'descriptions' in changes
        ? localizedTextToWireList(changes.descriptions, 'Description')
        : wireItemsOfType(current?.serviceDescriptions, 'Description');
    body.serviceDescriptions = [
      ...keptWireItems(current?.serviceDescriptions, ['Summary', 'Description']),
      ...summaries,
      ...descriptions,
    ];
  }

  applyUriListField(body, 'Service', 'serviceClasses', changes.serviceClasses);
  applyUriListField(body, 'Service', 'ontologyTerms', changes.ontologyTerms);
  applyUriListField(body, 'Service', 'targetGroups', changes.targetGroups);
  applyUriListField(body, 'Service', 'lifeEvents', changes.lifeEvents);
  applyCodeListField(body, 'Service', 'industrialClasses', changes.industrialClasses);

  if (current) {
    for (const field of REQUIRED_WITHOUT_GENERAL_DESCRIPTION) {
      if (!(field in changes)) body[field] = wireUris(current[field]);
    }
  }

  if ('languages' in changes) {
    body.languages = changes.languages ?? [];
  }

  if ('generalDescriptionId' in changes) {
    if (changes.generalDescriptionId) {
      body.generalDescriptionId = changes.generalDescriptionId;
    } else {
      setDeleteFlag(body, 'Service', 'generalDescriptionId');
    }
  }

  return body;
}

/** Full-replace lists PTV requires on every PUT of a service without a general description. */
const REQUIRED_WITHOUT_GENERAL_DESCRIPTION = [
  'serviceClasses',
  'ontologyTerms',
  'targetGroups',
] as const;

function wireUris(items: V11CodeListItem[] | null | undefined): string[] {
  return (items ?? []).map((item) => item.uri).filter((uri): uri is string => !!uri);
}

/** Wire entries whose type the change leaves alone; PTV's empty-text `null`s are dropped. */
function keptWireItems(
  items: V11LocalizedItem[] | null | undefined,
  replacedTypes: string[],
): V11LocalizedItem[] {
  return (items ?? []).filter((item) => !!item.value && !replacedTypes.includes(item.type ?? ''));
}

function wireItemsOfType(
  items: V11LocalizedItem[] | null | undefined,
  type: string,
): V11LocalizedItem[] {
  return (items ?? []).filter((item) => !!item.value && item.type === type);
}

function localizedTextToWireList(
  text: LocalizedText | undefined,
  type: string,
): V11LocalizedItem[] {
  return Object.entries(text ?? {})
    .filter((entry): entry is [string, string] => !!entry[1])
    .map(([language, value]) => ({ language, value, type }));
}

/**
 * Fields like serviceClasses/ontologyTerms/targetGroups/lifeEvents are
 * written as an array of URI strings (confirmed against v11's write
 * schema — "List of service class urls" etc.), not code strings.
 */
function applyUriListField(
  body: Record<string, unknown>,
  entityType: Parameters<typeof needsDeleteFlag>[0],
  fieldName: string,
  entries: CodeListEntry[] | undefined,
): void {
  if (entries === undefined) return;
  if (entries.length === 0) {
    setDeleteFlag(body, entityType, fieldName, () => {
      body[fieldName] = [];
    });
    return;
  }
  body[fieldName] = entries.map((entry) => entry.uri).filter((uri): uri is string => !!uri);
}

/** industrialClasses is written as an array of codes, not URIs — confirmed against v11's write schema. */
function applyCodeListField(
  body: Record<string, unknown>,
  entityType: Parameters<typeof needsDeleteFlag>[0],
  fieldName: string,
  entries: CodeListEntry[] | undefined,
): void {
  if (entries === undefined) return;
  if (entries.length === 0) {
    setDeleteFlag(body, entityType, fieldName, () => {
      body[fieldName] = [];
    });
    return;
  }
  body[fieldName] = entries.map((entry) => entry.code).filter((code): code is string => !!code);
}

/**
 * Sets the field's delete flag if v11 has one for it; otherwise falls
 * back to `onFullReplace` (sending an explicit empty value), which is
 * the correct way to clear a full-replace field that has no flag.
 */
function setDeleteFlag(
  body: Record<string, unknown>,
  entityType: Parameters<typeof needsDeleteFlag>[0],
  fieldName: string,
  onFullReplace?: () => void,
): void {
  const flag = needsDeleteFlag(entityType, fieldName);
  if (flag) {
    body[flag] = true;
  } else if (onFullReplace) {
    onFullReplace();
  }
}
