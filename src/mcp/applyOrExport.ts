import { resolveWriteAdapter, WriteApiNotSelectedError } from './toolContext.js';
import { buildManualPublishSheet, type ManualPublishSheet } from './manualPublish.js';
import type { ApplyServiceChangeResult } from '../ptv/adapter.js';
import type { PtvAdapterRegistry } from '../ptv/registry.js';
import type { LanguageCode, PtvContentId, Service } from '../ptv/domain.js';
import type { AuditService } from '../audit/auditService.js';
import type { ChangeValidator } from '../validation/changeValidator.js';
import type { MembershipRoleResolver } from './authorization.js';
import { proposeChanges } from './proposeChanges.js';
import type { ToolContext } from './toolContext.js';

export { WriteApiNotSelectedError };

export class ValidationFailedError extends Error {
  constructor(public readonly errors: { field: string; message: string }[]) {
    super(
      [
        'Proposed changes failed validation:',
        ...errors.map((e) => `- ${e.field}: ${e.message}`),
      ].join('\n'),
    );
    this.name = 'ValidationFailedError';
  }
}

/** One language's rendered preview, for a human to paste into PTV's own admin UI. */
export interface ManualPublishLanguageEntry {
  name?: string;
  summary?: string;
  description?: string;
}

/**
 * `ptv_export_for_manual_publish` (Phase 4 Stream D): MVP-0's fallback for
 * any tenant/environment without a write-capable adapter connected yet
 * (docs/plan.md's "vientitoiminto ilman API-kirjoitusta"). Renders the
 * proposed service per language and records `ReadyForManualPublish` —
 * this is the terminal state for the normal approval chain until someone
 * actually copies it into PTV's UI, which happens outside this system.
 */
export interface ManualPublishExport {
  serviceId: PtvContentId;
  languages: Record<LanguageCode, ManualPublishLanguageEntry>;
  proposed: Service;
  /** Every changed field to enter in PTV's own UI, with the steps. */
  sheet: ManualPublishSheet;
  correlationId: string;
}

export async function exportForManualPublish(
  resolveRole: MembershipRoleResolver,
  registry: PtvAdapterRegistry,
  auditService: AuditService,
  ctx: ToolContext,
  serviceId: PtvContentId,
  changes: Partial<Service>,
  correlationId?: string,
): Promise<ManualPublishExport> {
  const {
    current,
    proposed,
    diff,
    correlationId: chainId,
  } = await proposeChanges(
    resolveRole,
    registry,
    auditService,
    ctx,
    serviceId,
    changes,
    correlationId,
  );

  const languages: Record<LanguageCode, ManualPublishLanguageEntry> = {};
  for (const language of proposed.languages) {
    languages[language] = {
      ...(proposed.names[language] !== undefined ? { name: proposed.names[language] } : {}),
      ...(proposed.summaries[language] !== undefined
        ? { summary: proposed.summaries[language] }
        : {}),
      ...(proposed.descriptions[language] !== undefined
        ? { description: proposed.descriptions[language] }
        : {}),
    };
  }

  await auditService.record({
    tenantId: ctx.tenantId,
    userId: ctx.actingUserId,
    action: 'ExportForManualPublish',
    resourceType: 'Service',
    resourceId: serviceId,
    afterState: proposed,
    result: 'ReadyForManualPublish',
    correlationId: chainId,
  });

  const sheet = buildManualPublishSheet({
    kind: 'service_update',
    diff,
    ptvId: serviceId,
    names: current.names,
    languages: Object.keys(proposed.names),
  });
  return { serviceId, languages, proposed, sheet, correlationId: chainId };
}

export interface ApplyChangesResult extends ApplyServiceChangeResult {
  correlationId: string;
}

/**
 * `ptv_apply_changes` (Phase 4 Stream D): validates, then asks the
 * registry for a write-capable adapter for this tenant/environment/acting
 * user (Publisher role, `supports_write`, and a valid credential are all
 * enforced there — `PtvAdapterResolutionError` surfaces a clear reason,
 * never a generic API error, per docs/plan.md's "ptv_apply_changes
 * vaatii" section), then writes and audits the outcome either way.
 */
export async function applyChanges(
  resolveRole: MembershipRoleResolver,
  registry: PtvAdapterRegistry,
  auditService: AuditService,
  validator: ChangeValidator,
  ctx: ToolContext,
  serviceId: PtvContentId,
  changes: Partial<Service>,
  correlationId?: string,
): Promise<ApplyChangesResult> {
  if (!ctx.writeApiVersion) {
    throw new WriteApiNotSelectedError();
  }

  const {
    current,
    proposed,
    correlationId: chainId,
  } = await proposeChanges(
    resolveRole,
    registry,
    auditService,
    ctx,
    serviceId,
    changes,
    correlationId,
  );

  const validation = validator.validate(proposed);
  await auditService.record({
    tenantId: ctx.tenantId,
    userId: ctx.actingUserId,
    action: 'ValidateServiceChange',
    resourceType: 'Service',
    resourceId: serviceId,
    apiVersion: validator.apiVersion,
    afterState: { errors: validation.errors },
    result: validation.valid ? 'Valid' : 'Invalid',
    correlationId: chainId,
  });
  if (!validation.valid) {
    throw new ValidationFailedError(validation.errors);
  }

  const writeAdapter = await resolveWriteAdapter(registry, ctx);
  const capabilities = writeAdapter.getCapabilities();

  try {
    const result = await writeAdapter.applyServiceChange({ serviceId, changes });
    await auditService.record({
      tenantId: ctx.tenantId,
      userId: ctx.actingUserId,
      action: 'ApplyServiceChange',
      resourceType: 'Service',
      resourceId: serviceId,
      apiVersion: capabilities.apiVersion,
      environment: capabilities.environment,
      beforeState: current,
      afterState: proposed,
      result: 'Success',
      correlationId: chainId,
    });
    return { ...result, correlationId: chainId };
  } catch (err) {
    await auditService.record({
      tenantId: ctx.tenantId,
      userId: ctx.actingUserId,
      action: 'ApplyServiceChange',
      resourceType: 'Service',
      resourceId: serviceId,
      apiVersion: capabilities.apiVersion,
      environment: capabilities.environment,
      beforeState: current,
      result: 'Failed',
      correlationId: chainId,
    });
    throw err;
  }
}
