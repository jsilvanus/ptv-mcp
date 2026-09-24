import type { NewService } from '../adapter.js';
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
  /**
   * URIs of the classifications the linked general description brings.
   * PTV's read merges them into the service's own lists without marking
   * them, so they are filtered out of whatever is sent back; otherwise
   * they would become the service's own.
   */
  inheritedUris: ReadonlySet<string> = new Set(),
): Record<string, unknown> {
  const body: Record<string, unknown> = {};

  if ('serviceType' in changes && changes.serviceType) {
    body.type = changes.serviceType;
  }

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
  applyIndustrialClassField(body, changes.industrialClasses);

  // Required only without a general description; with one linked they're
  // left alone.
  const keepsGeneralDescription =
    'generalDescriptionId' in changes
      ? !!changes.generalDescriptionId
      : !!current?.generalDescriptionId;
  if (current && !keepsGeneralDescription) {
    for (const field of REQUIRED_WITHOUT_GENERAL_DESCRIPTION) {
      if (!(field in changes)) body[field] = wireUris(current[field]);
    }
  }

  for (const field of CLASSIFICATION_FIELDS) {
    const value = body[field];
    if (Array.isArray(value) && inheritedUris.size > 0) {
      body[field] = value.filter((uri) => !inheritedUris.has(uri as string));
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
      // Live 400: "Type: The field is required when 'DeleteGeneralDescriptionId'
      // has value 'True'" (the type came from the general description).
      body.type ??= current?.type;
    }
  }

  return body;
}

const CLASSIFICATION_FIELDS = [
  'serviceClasses',
  'ontologyTerms',
  'targetGroups',
  'lifeEvents',
  'industrialClasses',
] as const;

/**
 * The body for `POST /api/v11/Service`. Besides the domain fields, PTV
 * requires fundingType, areaType, mainResponsibleOrganization and
 * serviceProducers, which the domain model doesn't carry. Defaults for a
 * parish's own service: publicly funded, nationwide, produced by the
 * responsible organisation itself. They can be changed in PTV's UI.
 */
export function newServiceToV11Body(service: NewService): Record<string, unknown> {
  const uris = (entries: CodeListEntry[] | undefined) =>
    (entries ?? []).map((entry) => entry.uri).filter((uri): uri is string => !!uri);
  return {
    type: service.serviceType,
    publishingStatus: toV11WritePublishingStatus(service.publishingStatus),
    serviceNames: localizedTextToWireList(service.names, 'Name'),
    serviceDescriptions: [
      ...localizedTextToWireList(service.summaries, 'Summary'),
      ...localizedTextToWireList(service.descriptions, 'Description'),
    ],
    languages: service.languages,
    serviceClasses: uris(service.serviceClasses),
    ontologyTerms: uris(service.ontologyTerms),
    targetGroups: uris(service.targetGroups),
    lifeEvents: uris(service.lifeEvents),
    industrialClasses: (service.industrialClasses ?? [])
      .map(industrialClassUri)
      .filter((uri): uri is string => !!uri),
    ...(service.generalDescriptionId ? { generalDescriptionId: service.generalDescriptionId } : {}),
    ...(service.sourceId ? { sourceId: service.sourceId } : {}),
    fundingType: 'PubliclyFunded',
    areaType: 'Nationwide',
    mainResponsibleOrganization: service.organizationId,
    serviceProducers: [
      { provisionType: 'SelfProducedServices', organizations: [service.organizationId] },
    ],
    ...(service.serviceChannelIds.length > 0 ? { serviceChannels: service.serviceChannelIds } : {}),
  };
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

/**
 * Statistics Finland's TOL 2008 URI prefix. v11's schema says
 * industrialClasses takes codes, but a plain code (e.g. "94910") makes PTV
 * answer 500; the full URI is what it accepts (verified live 2026-09-24).
 */
const INDUSTRIAL_CLASS_URI_PREFIX = 'http://www.stat.fi/meta/luokitukset/toimiala/001-2008/';

/**
 * Built from the code when there is one: a v12-read entry's `uri` is a
 * koodistot.suomi.fi URI (.../toimiala_1_20080101/code/55109) that v11
 * doesn't know.
 */
function industrialClassUri(entry: CodeListEntry): string | undefined {
  const code = entry.code?.trim();
  if (code) return code.startsWith('http') ? code : `${INDUSTRIAL_CLASS_URI_PREFIX}${code}`;
  if (entry.uri?.startsWith(INDUSTRIAL_CLASS_URI_PREFIX)) return entry.uri;
  const lastSegment = entry.uri?.split('/').pop();
  return lastSegment ? `${INDUSTRIAL_CLASS_URI_PREFIX}${lastSegment}` : undefined;
}

/** industrialClasses is written as TOL 2008 URIs (see INDUSTRIAL_CLASS_URI_PREFIX). */
function applyIndustrialClassField(
  body: Record<string, unknown>,
  entries: CodeListEntry[] | undefined,
): void {
  if (entries === undefined) return;
  if (entries.length === 0) {
    setDeleteFlag(body, 'Service', 'industrialClasses', () => {
      body.industrialClasses = [];
    });
    return;
  }
  body.industrialClasses = entries.map(industrialClassUri).filter((uri): uri is string => !!uri);
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
