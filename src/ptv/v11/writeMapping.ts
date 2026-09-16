import type { CodeListEntry, LocalizedText, Service } from '../domain.js';
import { needsDeleteFlag } from './deleteFlags.js';
import type { V11LocalizedItem } from './wireModel.js';

/**
 * Translates a domain-level partial Service change into the flat body
 * v11's `PUT /api/v11/Service/{id}` expects, applying the right strategy
 * per field: some fields are always sent whole ("full replace" — see
 * deleteFlags.ts), others need an explicit `deleteX: true` flag set when
 * the caller wants to clear them, since PUT is otherwise a partial update
 * that leaves omitted fields untouched.
 *
 * Field presence in `changes` (via `in`, not just truthiness) is what
 * signals "the proposal touches this field" — an explicit empty
 * array/undefined means "clear it," while a key absent from `changes`
 * entirely means "leave it alone" and is never sent.
 */
export function serviceChangesToV11Body(changes: Partial<Service>): Record<string, unknown> {
  const body: Record<string, unknown> = {};

  if ('names' in changes) {
    body.serviceNames = localizedTextToWireList(changes.names, 'Name');
  }

  if ('summaries' in changes || 'descriptions' in changes) {
    body.serviceDescriptions = [
      ...localizedTextToWireList(changes.summaries, 'Summary'),
      ...localizedTextToWireList(changes.descriptions, 'Description'),
    ];
  }

  applyUriListField(body, 'Service', 'serviceClasses', changes.serviceClasses);
  applyUriListField(body, 'Service', 'ontologyTerms', changes.ontologyTerms);
  applyUriListField(body, 'Service', 'targetGroups', changes.targetGroups);
  applyUriListField(body, 'Service', 'lifeEvents', changes.lifeEvents);
  applyCodeListField(body, 'Service', 'industrialClasses', changes.industrialClasses);

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

function localizedTextToWireList(
  text: LocalizedText | undefined,
  type: string,
): V11LocalizedItem[] {
  return Object.entries(text ?? {})
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
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
