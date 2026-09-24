import type { PtvAdapterRegistry } from '../ptv/registry.js';
import type { CodeListEntry, LocalizedText, PtvContentId, Service } from '../ptv/domain.js';
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

/** Computes a field-by-field diff for every field the proposal actually touches — not the full merged object. */
export function diffService(current: Service, changes: Partial<Service>): ServiceDiffEntry[] {
  const entries: ServiceDiffEntry[] = [];

  for (const field of Object.keys(changes) as (keyof Service)[]) {
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
    if (CODE_LIST_FIELDS.includes(field as (typeof CODE_LIST_FIELDS)[number])) {
      if (codeListKey(before) !== codeListKey(after)) {
        entries.push({ field, before, after });
      }
      continue;
    }
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      entries.push({ field, before, after });
    }
  }

  return entries;
}

export async function prepareProposal(
  registry: PtvAdapterRegistry,
  ctx: ToolContext,
  serviceId: PtvContentId,
  changes: Partial<Service>,
): Promise<PreparedProposal> {
  const adapter = await registry.resolve({
    tenantId: ctx.tenantId,
    environment: ctx.environment,
    apiVersion: ctx.readApiVersion ?? ctx.apiVersion ?? 'v11',
    operation: 'read',
    actingUserId: ctx.actingUserId,
  });

  const current = await adapter.getService(serviceId);
  if (!current) {
    throw new ServiceNotFoundError(serviceId);
  }

  const proposed = mergeService(current, changes);
  const diff = diffService(current, changes);
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
 * (mcp/proposalQueue.ts), gated at Reader+ — a Reader can queue a proposal
 * without being able to approve one. This function now only runs
 * internally, as the re-diff step `exportForManualPublish`/`applyChanges`
 * use when resolving an already-queued proposal — both of those are
 * already gated Editor+ by `resolveProposal`, so the Editor check here is
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
  await requireTenantRole(resolveRole, ctx.tenantId, ctx.actingUserId, 'editor');
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
