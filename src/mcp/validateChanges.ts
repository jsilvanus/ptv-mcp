import type { Service } from '../ptv/domain.js';
import type { ChangeValidator, ValidationError } from '../validation/changeValidator.js';
import type { AuditService } from '../audit/auditService.js';
import type { ToolContext } from './toolContext.js';

export interface ValidateChangesResult {
  valid: boolean;
  errors: ValidationError[];
  correlationId: string;
}

/**
 * `ptv_validate_changes` (Phase 4 Stream C wiring): runs `validator` against
 * the already-merged proposed service (the shape `ptv_propose_changes`
 * returns as `.proposed`) and records the outcome — pass the same
 * `correlationId` `ptv_propose_changes` returned so this step joins the
 * same audit trail entry, per docs/phase-plan.md's Phase 4 sync point
 * ("every step in the audit log").
 */
export async function validateChanges(
  auditService: AuditService,
  validator: ChangeValidator,
  ctx: ToolContext,
  proposed: Service,
  correlationId?: string,
): Promise<ValidateChangesResult> {
  const result = validator.validate(proposed);

  const entry = await auditService.record({
    tenantId: ctx.tenantId,
    userId: ctx.actingUserId,
    action: 'ValidateServiceChange',
    resourceType: 'Service',
    resourceId: proposed.id,
    apiVersion: validator.apiVersion,
    afterState: { errors: result.errors },
    result: result.valid ? 'Valid' : 'Invalid',
    ...(correlationId ? { correlationId } : {}),
  });

  return { ...result, correlationId: entry.correlationId };
}
