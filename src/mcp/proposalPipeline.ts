import type { AuditService } from '../audit/auditService.js';
import type { PtvAdapter } from '../ptv/adapter.js';
import type { PtvAdapterRegistry } from '../ptv/registry.js';
import type {
  ProposalKind,
  ProposalService,
  ProposalStatus,
} from '../proposals/proposalService.js';
import type { QualityReport, ServiceCheckContext } from '../quality/contentChecks.js';
import type { ChangeValidator, ValidationResult } from '../validation/changeValidator.js';
import { requireTenantRole, type MembershipRoleResolver } from './authorization.js';
import { assertLocalizedTextFields } from './localizedInput.js';
import {
  PROPOSAL_KINDS,
  type KindChanges,
  type KindHandler,
  type KindProposed,
} from './proposalKinds.js';
import type { ServiceDiffEntry } from './proposeChanges.js';
import { resolveWriteAdapter, WriteApiNotSelectedError, type ToolContext } from './toolContext.js';

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

export interface QueueDeps {
  resolveRole: MembershipRoleResolver;
  auditService: AuditService;
  proposalService: ProposalService;
  /** Service kinds validate against the active adapter's schema. */
  validator?: ChangeValidator;
}

/** A kind's proposal read against PTV, or normalized when it is a new item. */
export interface PreparedChange<K extends ProposalKind> {
  proposed: KindProposed<K>;
  diff: ServiceDiffEntry[];
}

/** What a kind's queue function hands the pipeline to queue. */
export interface QueueRequest<K extends ProposalKind, T extends PreparedChange<K>> {
  kind: K;
  /** The caller's changes or new item, checked for plain-string texts first. */
  input: object;
  /** Stored as the proposal's `serviceId`: the target, or '' for a new item. */
  targetId: string;
  /** The audit resource id of an update's target; a new item has none yet. */
  resourceId?: string;
  /** Reads the target and diffs, or normalizes a new item. */
  prepare(): Promise<T>;
  /** What is stored as the proposal's changes: an update's changes, a new item whole. */
  changes(prepared: T): KindChanges<K>;
  /** What the quality checks need besides the proposed entity; nothing by default. */
  qualityContext?(proposed: KindProposed<K>): Promise<ServiceCheckContext>;
  correlationId?: string | undefined;
  reviewItemId?: string | undefined;
}

export interface QueuedChange<T, V> {
  prepared: T;
  validation: V;
  correlationId: string;
  proposalId: string;
  status: ProposalStatus;
  /** Automated content checks on the proposed entity. */
  quality: QualityReport;
}

/** What queueing adds to a kind's prepared change in its tool's result. */
export type QueuedFields = Omit<QueuedChange<unknown, ValidationResult>, 'prepared'>;

/**
 * The steps every proposal is queued with (Contributor+): check the texts,
 * prepare, validate, audit the Propose* action, store it as `pending`, and
 * run the quality checks. Nothing is written to PTV. A service change is
 * queued with `validate: false`: it is validated when it is applied or
 * exported.
 */
export async function queueKindProposal<K extends ProposalKind, T extends PreparedChange<K>>(
  deps: QueueDeps,
  ctx: ToolContext,
  request: QueueRequest<K, T> & { validate: false },
): Promise<QueuedChange<T, null>>;
export async function queueKindProposal<K extends ProposalKind, T extends PreparedChange<K>>(
  deps: QueueDeps,
  ctx: ToolContext,
  request: QueueRequest<K, T>,
): Promise<QueuedChange<T, ValidationResult>>;
export async function queueKindProposal<K extends ProposalKind, T extends PreparedChange<K>>(
  deps: QueueDeps,
  ctx: ToolContext,
  request: QueueRequest<K, T> & { validate?: false },
): Promise<QueuedChange<T, ValidationResult | null>> {
  await requireTenantRole(deps.resolveRole, ctx.tenantId, ctx.actingUserId, 'contributor');
  assertLocalizedTextFields(request.input);
  const handler: KindHandler<K> = PROPOSAL_KINDS[request.kind];
  const prepared = await request.prepare();
  const { proposed, diff } = prepared;
  const validation = request.validate === false ? null : handler.validate(proposed, deps.validator);
  const auditEntry = await deps.auditService.record({
    tenantId: ctx.tenantId,
    userId: ctx.actingUserId,
    action: handler.audit.propose,
    resourceType: handler.audit.resourceType,
    ...(request.resourceId !== undefined ? { resourceId: request.resourceId } : {}),
    afterState: {
      // A new item is recorded whole; an update by what it changes.
      ...(handler.creates ? { proposed } : { diff }),
      ...(validation ? { validationErrors: validation.errors } : {}),
    },
    result: 'Proposed',
    ...(request.correlationId ? { correlationId: request.correlationId } : {}),
  });
  const proposal = await deps.proposalService.createPending({
    tenantId: ctx.tenantId,
    kind: request.kind,
    serviceId: request.targetId,
    environment: ctx.environment,
    proposedByUserId: ctx.actingUserId,
    changes: handler.store(request.changes(prepared)),
    queuedDiff: diff,
    correlationId: auditEntry.correlationId,
    ...(request.reviewItemId ? { reviewItemId: request.reviewItemId } : {}),
  });
  const context = request.qualityContext ? await request.qualityContext(proposed) : {};
  return {
    prepared,
    validation,
    correlationId: auditEntry.correlationId,
    proposalId: proposal.id,
    status: proposal.status,
    quality: handler.quality(proposed, context),
  };
}

/** What a write validates, records and does. */
export interface WritePlan<K extends ProposalKind, R> {
  correlationId: string;
  /** Validated, and recorded as the state after the write. */
  proposed: KindProposed<K>;
  /**
   * An update is recorded against its target, with its state before; a new
   * item against the id PTV gave it, once created.
   */
  target: { resourceId: string; before: object } | { createdId(result: R): string };
  write(adapter: PtvAdapter): Promise<R>;
}

/**
 * The steps every write to PTV takes: validate, audit the Validate* action,
 * resolve a write-capable adapter (Publisher, a write API version and a
 * valid credential, all enforced by the registry), write, and audit the
 * Apply* or Create* action as Success or Failed. `plan` runs after the
 * write API check, so an update re-reads PTV only when it can be written.
 */
export async function auditedApply<K extends ProposalKind, R>(
  deps: {
    registry: PtvAdapterRegistry;
    auditService: AuditService;
    /** Service kinds validate against the active adapter's schema, recording its version. */
    validator?: ChangeValidator;
  },
  ctx: ToolContext,
  kind: K,
  plan: () => Promise<WritePlan<K, R>>,
): Promise<R> {
  if (!ctx.writeApiVersion) throw new WriteApiNotSelectedError();
  const handler: KindHandler<K> = PROPOSAL_KINDS[kind];
  const { correlationId, proposed, target, write } = await plan();
  const validation = handler.validate(proposed, deps.validator);
  await deps.auditService.record({
    tenantId: ctx.tenantId,
    userId: ctx.actingUserId,
    action: handler.audit.validate,
    resourceType: handler.audit.resourceType,
    ...('resourceId' in target ? { resourceId: target.resourceId } : {}),
    ...(deps.validator ? { apiVersion: deps.validator.apiVersion } : {}),
    afterState: { errors: validation.errors },
    result: validation.valid ? 'Valid' : 'Invalid',
    correlationId,
  });
  if (!validation.valid) throw new ValidationFailedError(validation.errors);

  const writeAdapter = await resolveWriteAdapter(deps.registry, ctx);
  const capabilities = writeAdapter.getCapabilities();
  const audit = (result: 'Success' | 'Failed', states: object) =>
    deps.auditService.record({
      tenantId: ctx.tenantId,
      userId: ctx.actingUserId,
      action: handler.audit.write,
      resourceType: handler.audit.resourceType,
      apiVersion: capabilities.apiVersion,
      environment: capabilities.environment,
      ...states,
      result,
      correlationId,
    });
  try {
    const written = await write(writeAdapter);
    await audit('Success', writeStates(target, proposed, { written }));
    return written;
  } catch (err) {
    await audit('Failed', writeStates(target, proposed));
    throw err;
  }
}

/**
 * What an Apply* or Create* entry records: an update its target, its state
 * before and, once written, after; a new item what was sent and, once
 * created, the id PTV gave it.
 */
function writeStates<R>(
  target: WritePlan<ProposalKind, R>['target'],
  proposed: object,
  success?: { written: R },
): object {
  if ('resourceId' in target) {
    return {
      resourceId: target.resourceId,
      beforeState: target.before,
      ...(success ? { afterState: proposed } : {}),
    };
  }
  const createdId = success && target.createdId(success.written);
  return { ...(createdId ? { resourceId: createdId } : {}), afterState: proposed };
}
