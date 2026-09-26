import { resolveReadAdapter } from './toolContext.js';
import type { PtvAdapterRegistry } from '../ptv/registry.js';
import type {
  CodeListEntry,
  LocalizedText,
  PtvContentId,
  Service,
  ServiceHour,
} from '../ptv/domain.js';
import { canonicalServiceHours } from '../ptv/serviceHours.js';
import type { AuditService } from '../audit/auditService.js';
import { requireTenantRole, type MembershipRoleResolver } from './authorization.js';
import type { ToolContext } from './toolContext.js';

export class ServiceNotFoundError extends Error {
  constructor(serviceId: PtvContentId) {
    super(`Service not found: ${serviceId}`);
    this.name = 'ServiceNotFoundError';
  }
}

/**
 * One changed field. `field` is a dot/bracket path — a bare field name
 * for scalar/array fields (whole-value replace, e.g. `'languages'`), or
 * `'<field>.<languageCode>'` for a single language of a localized text
 * field, since AI agents and human reviewers alike want to see which
 * *language* changed in `names`/`summaries`/`descriptions`, not just
 * that the object differs.
 */
export interface ServiceDiffEntry {
  field: string;
  before: unknown;
  after: unknown;
}

/**
 * `ptv_propose_changes`'s result shape. **Frozen contract** (per
 * docs/phase-plan.md's Phase 4 Stream B note) — Phase 5's diff-viewer UI
 * builds against this exact shape, so changing it later means
 * coordinating both sides, not just this file.
 */
export interface ProposeChangesResult {
  serviceId: PtvContentId;
  current: Service;
  proposed: Service;
  diff: ServiceDiffEntry[];
  /**
   * Links this step to the ones that follow (`ptv_validate_changes`,
   * `ptv_export_for_manual_publish`/`ptv_apply_changes`) in the audit log
   * — pass it through to those calls so `AuditService.listByCorrelationId`
   * can trace one logical operation start to finish (docs/phase-plan.md's
   * Phase 4 sync point: "every step in the audit log").
   */
  correlationId: string;
}

const LOCALIZED_FIELDS = ['names', 'summaries', 'descriptions'] as const;

const CODE_LIST_FIELDS = [
  'serviceClasses',
  'ontologyTerms',
  'targetGroups',
  'lifeEvents',
  'industrialClasses',
] as const;

/**
 * Classifications are compared as sets of their identity (uri, else code):
 * PTV returns names in every language and in its own order, so comparing
 * whole entries would report a change that isn't one.
 */
function codeListKey(value: unknown): string {
  if (!Array.isArray(value)) return JSON.stringify(value ?? []);
  return JSON.stringify(
    (value as CodeListEntry[]).map((entry) => entry.uri ?? entry.code ?? '').sort(),
  );
}

/**
 * A proposal usually names classification entries by uri or code only;
 * copies the names of entries the service already has, so the diff reads
 * "P11.6 Seurakunnat ja uskonnolliset yhteisöt" rather than a bare code.
 */
function withKnownNames(before: unknown, after: unknown): unknown {
  if (!Array.isArray(before) || !Array.isArray(after)) return after;
  const known = before as CodeListEntry[];
  return (after as CodeListEntry[]).map((entry) => {
    if (Object.keys(entry.names ?? {}).length > 0) return entry;
    const match = known.find(
      (candidate) =>
        (entry.uri !== undefined && candidate.uri === entry.uri) ||
        (entry.code !== undefined && candidate.code === entry.code),
    );
    return match ? { ...entry, names: match.names } : entry;
  });
}

/**
 * Merges `changes` onto `current` using the same "field presence, not
 * truthiness" semantics as the write model (src/ptv/v11/writeMapping.ts):
 * a key present in `changes` fully replaces that field (even with an
 * empty value), a key absent leaves the current value untouched. This is
 * the merge PTV's own PUT will end up performing, so the proposal the
 * caller reviews matches what applying it would actually produce.
 */
function mergeService(current: Service, changes: Partial<Service>): Service {
  return { ...current, ...changes };
}

export interface PreparedProposal {
  serviceId: PtvContentId;
  current: Service;
  proposed: Service;
  diff: ServiceDiffEntry[];
}

function diffLocalizedField(
  field: string,
  before: LocalizedText,
  after: LocalizedText,
): ServiceDiffEntry[] {
  const languages = new Set([...Object.keys(before), ...Object.keys(after)]);
  const entries: ServiceDiffEntry[] = [];
  for (const language of languages) {
    const beforeValue = before[language];
    const afterValue = after[language];
    if (beforeValue !== afterValue) {
      entries.push({ field: `${field}.${language}`, before: beforeValue, after: afterValue });
    }
  }
  return entries;
}

/**
 * Computes a field-by-field diff for every field the proposal actually
 * touches — not the full merged object. Works for any entity (services,
 * channels, connections, organisations): localized texts diff per
 * language, classifications and channel ids as sets, the rest by value.
 */
export function diffFields<T extends object>(
  currentEntity: T,
  changeSet: Partial<T>,
): ServiceDiffEntry[] {
  const current = currentEntity as Record<string, unknown>;
  const changes = changeSet as Record<string, unknown>;
  const entries: ServiceDiffEntry[] = [];

  for (const field of Object.keys(changes)) {
    if (LOCALIZED_FIELDS.includes(field as (typeof LOCALIZED_FIELDS)[number])) {
      entries.push(
        ...diffLocalizedField(
          field,
          (current[field] as LocalizedText) ?? {},
          (changes[field] as LocalizedText) ?? {},
        ),
      );
      continue;
    }

    const before = current[field];
    const after = changes[field];
    if (field === 'serviceChannelIds') {
      const key = (ids: unknown) => JSON.stringify([...((ids as string[]) ?? [])].sort());
      if (key(before) !== key(after)) entries.push({ field, before, after });
      continue;
    }
    if (CODE_LIST_FIELDS.includes(field as (typeof CODE_LIST_FIELDS)[number])) {
      if (codeListKey(before) !== codeListKey(after)) {
        entries.push({ field, before, after: withKnownNames(before, after) });
      }
      continue;
    }
    if (comparable(field, before) !== comparable(field, after)) {
      entries.push({ field, before, after });
    }
  }

  return entries;
}

/** The keys of `input` that aren't in `allowed`, for a proposal's unsupported-field error. */
export function unknownFields(input: object, allowed: readonly string[]): string[] {
  return Object.keys(input).filter((field) => !allowed.includes(field));
}

/** The fields a new item sets (not undefined or ''), which its diff against an empty one lists. */
export function setFields<T extends object>(item: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(item).filter(([, value]) => value !== undefined && value !== ''),
  ) as Partial<T>;
}

/**
 * A value's comparison key: key order and undefined members don't matter,
 * and service hours compare in canonical form (PTV returns weekly hours
 * one day per entry), so data read back from PTV equals what was written.
 */
function comparable(field: string, value: unknown): string {
  const normalized =
    field === 'serviceHours' ? canonicalServiceHours(value as ServiceHour[] | undefined) : value;
  return stableStringify(normalized ?? null);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, member]) => member !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, member]) => `${JSON.stringify(key)}:${stableStringify(member)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export async function prepareProposal(
  registry: PtvAdapterRegistry,
  ctx: ToolContext,
  serviceId: PtvContentId,
  changes: Partial<Service>,
): Promise<PreparedProposal> {
  const adapter = await resolveReadAdapter(registry, ctx);

  const current = await adapter.getService(serviceId);
  if (!current) {
    throw new ServiceNotFoundError(serviceId);
  }

  const proposed = mergeService(current, changes);
  const diff = diffFields(current, changes);
  return { serviceId, current, proposed, diff };
}

/**
 * Fetches the current service, merges the proposed changes, and returns
 * current/proposed/diff — never writes anything. Read-only against PTV
 * (`PtvAdapterRegistry` only needs `operation: 'read'`), so this checks
 * tenant role itself rather than relying on the registry's coarser
 * read/write distinction.
 *
 * Originally *was* `ptv_propose_changes` itself (Phase 4 Stream B), gated
 * at Editor+ per docs/plan.md's original role model. Since Phase 8 (the
 * proposal queue), the `ptv_propose_changes` **tool** is `queueProposal`
 * (mcp/proposalQueue.ts), gated at Contributor+ — a Contributor can queue a
 * proposal without being able to approve one. This function now only runs
 * internally, as the re-diff step `exportForManualPublish`/`applyChanges`
 * use when resolving an already-queued proposal — both of those are
 * already gated Approver+ by `resolveProposal`, so the Approver check here is
 * a redundant-but-harmless double-check, not a second authorization gate.
 */
export async function proposeChanges(
  resolveRole: MembershipRoleResolver,
  registry: PtvAdapterRegistry,
  auditService: AuditService,
  ctx: ToolContext,
  serviceId: PtvContentId,
  changes: Partial<Service>,
  correlationId?: string,
): Promise<ProposeChangesResult> {
  await requireTenantRole(resolveRole, ctx.tenantId, ctx.actingUserId, 'approver');
  const { current, proposed, diff } = await prepareProposal(registry, ctx, serviceId, changes);

  const entry = await auditService.record({
    tenantId: ctx.tenantId,
    userId: ctx.actingUserId,
    action: 'ProposeServiceChange',
    resourceType: 'Service',
    resourceId: serviceId,
    afterState: { diff },
    result: 'Proposed',
    ...(correlationId ? { correlationId } : {}),
  });

  return { serviceId, current, proposed, diff, correlationId: entry.correlationId };
}
