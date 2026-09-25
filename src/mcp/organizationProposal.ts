import { resolveReadAdapter, resolveWriteAdapter } from './toolContext.js';
import { assertLocalizedTextFields } from './localizedInput.js';
import { checkOrganization, type QualityReport } from '../quality/contentChecks.js';
import type { AuditService } from '../audit/auditService.js';
import type { ApplyOrganizationChangeResult, NewOrganization } from '../ptv/adapter.js';
import type { Organization, PtvContentId, Service } from '../ptv/domain.js';
import type { PtvAdapterRegistry } from '../ptv/registry.js';
import type { ProposalService, ProposalStatus } from '../proposals/proposalService.js';
import { validateOrganization } from '../validation/organizationRules.js';
import { ValidationFailedError, WriteApiNotSelectedError } from './applyOrExport.js';
import { requireTenantRole, type MembershipRoleResolver } from './authorization.js';
import { diffService, type ServiceDiffEntry } from './proposeChanges.js';
import type { ToolContext } from './toolContext.js';

/** The organisation fields an `organisation_update` proposal may change. */
export const WRITABLE_ORGANIZATION_FIELDS = [
  'names',
  'alternativeNames',
  'alternativeNameShownIn',
  'summaries',
  'descriptions',
  'businessCode',
  'publishingStatus',
  'emails',
  'phoneNumbers',
  'webPages',
  'addresses',
] as const;

/** Fields only a new sub-organisation sets; after that PTV's UI changes them. */
const CREATE_ONLY_FIELDS = ['parentOrganizationId', 'organizationType', 'area', 'municipality'];

/** DVV: sub-organisations go at most five levels below the main organisation. */
export const MAX_SUB_ORGANIZATION_LEVELS = 5;

export class OrganizationNotFoundError extends Error {
  constructor(organizationId: PtvContentId) {
    super(`PTV organisation not found: ${organizationId}`);
    this.name = 'OrganizationNotFoundError';
  }
}

export class UnsupportedOrganizationFieldError extends Error {
  constructor(fields: string[], creating = false) {
    const writable = creating
      ? [...WRITABLE_ORGANIZATION_FIELDS, ...CREATE_ONLY_FIELDS]
      : WRITABLE_ORGANIZATION_FIELDS;
    super(
      `These organisation fields can't be ${creating ? 'set' : 'changed'} through PTV-MCP: ${fields.join(', ')}. Writable fields: ${writable.join(', ')}.`,
    );
    this.name = 'UnsupportedOrganizationFieldError';
  }
}

export class InvalidNewOrganizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidNewOrganizationError';
  }
}

function diffOrganization(
  current: Partial<Organization>,
  changes: Partial<Organization>,
): ServiceDiffEntry[] {
  // names, summaries and descriptions diff per language, like a service's.
  return diffService(current as unknown as Service, changes as unknown as Partial<Service>);
}

export interface PreparedOrganizationProposal {
  organizationId: PtvContentId;
  current: Organization;
  proposed: Organization;
  diff: ServiceDiffEntry[];
}

/** Reads the organisation, merges `changes` and diffs, like prepareChannelProposal. */
export async function prepareOrganizationProposal(
  registry: PtvAdapterRegistry,
  ctx: ToolContext,
  organizationId: PtvContentId,
  changes: Partial<Organization>,
): Promise<PreparedOrganizationProposal> {
  const unsupported = Object.keys(changes).filter(
    (field) => !(WRITABLE_ORGANIZATION_FIELDS as readonly string[]).includes(field),
  );
  if (unsupported.length > 0) throw new UnsupportedOrganizationFieldError(unsupported);
  const adapter = await resolveReadAdapter(registry, ctx);
  const current = await adapter.getOrganisation(organizationId);
  if (!current) throw new OrganizationNotFoundError(organizationId);
  const proposed: Organization = { ...current, ...changes };
  return { organizationId, current, proposed, diff: diffOrganization(current, changes) };
}

export interface QueuedOrganizationProposalResult extends PreparedOrganizationProposal {
  validation: { valid: boolean; errors: { field: string; message: string }[] };
  correlationId: string;
  proposalId: string;
  status: ProposalStatus;
  quality: QualityReport;
}

/** `ptv_propose_organisation_changes`: queues an `organisation_update` proposal (Contributor+). */
export async function queueOrganizationProposal(
  resolveRole: MembershipRoleResolver,
  registry: PtvAdapterRegistry,
  auditService: AuditService,
  proposalService: ProposalService,
  ctx: ToolContext,
  organizationId: PtvContentId,
  changes: Partial<Organization>,
  correlationId?: string,
): Promise<QueuedOrganizationProposalResult> {
  await requireTenantRole(resolveRole, ctx.tenantId, ctx.actingUserId, 'contributor');
  assertLocalizedTextFields(changes);
  const prepared = await prepareOrganizationProposal(registry, ctx, organizationId, changes);
  const errors = validateOrganization(prepared.proposed);
  const auditEntry = await auditService.record({
    tenantId: ctx.tenantId,
    userId: ctx.actingUserId,
    action: 'ProposeOrganizationChange',
    resourceType: 'Organization',
    resourceId: organizationId,
    afterState: { diff: prepared.diff, validationErrors: errors },
    result: 'Proposed',
    ...(correlationId ? { correlationId } : {}),
  });
  const proposal = await proposalService.createPending({
    tenantId: ctx.tenantId,
    kind: 'organisation_update',
    serviceId: organizationId,
    environment: ctx.environment,
    proposedByUserId: ctx.actingUserId,
    changes: changes as unknown as Partial<Service>,
    queuedDiff: prepared.diff,
    correlationId: auditEntry.correlationId,
  });
  return {
    ...prepared,
    validation: { valid: errors.length === 0, errors },
    correlationId: auditEntry.correlationId,
    proposalId: proposal.id,
    status: proposal.status,
    quality: checkOrganization(prepared.proposed),
  };
}

/**
 * Re-diffs against the organisation's current state, validates, and writes
 * through a write-capable adapter (Publisher, enforced by the registry),
 * auditing the outcome either way.
 */
export async function applyOrganizationChanges(
  registry: PtvAdapterRegistry,
  auditService: AuditService,
  ctx: ToolContext,
  organizationId: PtvContentId,
  changes: Partial<Organization>,
  correlationId: string,
): Promise<ApplyOrganizationChangeResult> {
  if (!ctx.writeApiVersion) throw new WriteApiNotSelectedError();
  const { current, proposed } = await prepareOrganizationProposal(
    registry,
    ctx,
    organizationId,
    changes,
  );
  const errors = validateOrganization(proposed);
  await auditService.record({
    tenantId: ctx.tenantId,
    userId: ctx.actingUserId,
    action: 'ValidateOrganizationChange',
    resourceType: 'Organization',
    resourceId: organizationId,
    afterState: { errors },
    result: errors.length === 0 ? 'Valid' : 'Invalid',
    correlationId,
  });
  if (errors.length > 0) throw new ValidationFailedError(errors);

  const writeAdapter = await resolveWriteAdapter(registry, ctx);
  const capabilities = writeAdapter.getCapabilities();
  const audit = (result: 'Success' | 'Failed') =>
    auditService.record({
      tenantId: ctx.tenantId,
      userId: ctx.actingUserId,
      action: 'ApplyOrganizationChange',
      resourceType: 'Organization',
      resourceId: organizationId,
      apiVersion: capabilities.apiVersion,
      environment: capabilities.environment,
      beforeState: current,
      ...(result === 'Success' ? { afterState: proposed } : {}),
      result,
      correlationId,
    });
  try {
    const result = await writeAdapter.applyOrganizationChange({ organizationId, changes });
    await audit('Success');
    return result;
  } catch (err) {
    await audit('Failed');
    throw err;
  }
}

/**
 * A new sub-organisation with what a caller may leave out filled in from
 * its parent: the type, the area and, for a municipality, the
 * municipality. It starts as a Draft. The business ID is never copied: DVV
 * asks for the sub-organisation's own, which may or may not be the
 * parent's.
 */
export function normalizeNewOrganization(
  input: Partial<NewOrganization>,
  parent: Organization,
): NewOrganization {
  const allowed: readonly string[] = [...WRITABLE_ORGANIZATION_FIELDS, ...CREATE_ONLY_FIELDS];
  const unsupported = Object.keys(input).filter((field) => !allowed.includes(field));
  if (unsupported.length > 0) throw new UnsupportedOrganizationFieldError(unsupported, true);
  const organizationType = input.organizationType ?? parent.organizationType;
  if (!organizationType) {
    throw new InvalidNewOrganizationError(
      `The parent organisation has no type to copy; give organizationType.`,
    );
  }
  const area = input.area ?? parent.area;
  const municipality =
    input.municipality ?? (organizationType === 'Municipality' ? parent.municipality : undefined);
  return {
    publishingStatus: 'Draft',
    names: {},
    summaries: {},
    descriptions: {},
    ...input,
    parentOrganizationId: parent.id,
    organizationType,
    ...(area ? { area } : {}),
    ...(municipality ? { municipality } : {}),
  } as NewOrganization;
}

export interface QueuedNewOrganizationResult {
  proposed: NewOrganization;
  diff: ServiceDiffEntry[];
  validation: { valid: boolean; errors: { field: string; message: string }[] };
  quality: QualityReport;
  correlationId: string;
  proposalId: string;
  status: ProposalStatus;
}

const EMPTY_ORGANIZATION = { names: {}, summaries: {}, descriptions: {} };

/**
 * `ptv_propose_new_organisation`: queues an `organisation_create` proposal
 * for a sub-organisation. The parent must exist and be at most four levels
 * below the main organisation, so the new one is at most five. Nothing is
 * written until an Approver+ resolves it (approve_and_apply also needs
 * Publisher).
 */
export async function queueNewOrganizationProposal(
  resolveRole: MembershipRoleResolver,
  registry: PtvAdapterRegistry,
  auditService: AuditService,
  proposalService: ProposalService,
  ctx: ToolContext,
  input: Partial<NewOrganization>,
  correlationId?: string,
): Promise<QueuedNewOrganizationResult> {
  await requireTenantRole(resolveRole, ctx.tenantId, ctx.actingUserId, 'contributor');
  assertLocalizedTextFields(input);
  if (!input.parentOrganizationId) {
    throw new InvalidNewOrganizationError(
      'Give parentOrganizationId: the organisation the new sub-organisation goes under.',
    );
  }
  const adapter = await resolveReadAdapter(registry, ctx);
  const hierarchy = await adapter.getOrganisationHierarchy(input.parentOrganizationId);
  const parent = hierarchy[0];
  if (!parent) throw new OrganizationNotFoundError(input.parentOrganizationId);
  // The hierarchy lists the parent and its ancestors up to the main organisation.
  if (hierarchy.length > MAX_SUB_ORGANIZATION_LEVELS) {
    throw new InvalidNewOrganizationError(
      `The parent is already ${hierarchy.length - 1} levels below the main organisation; DVV allows at most ${MAX_SUB_ORGANIZATION_LEVELS} levels of sub-organisations.`,
    );
  }
  const proposed = normalizeNewOrganization(input, parent);
  const diff = diffOrganization(
    EMPTY_ORGANIZATION,
    Object.fromEntries(
      Object.entries(proposed).filter(([, value]) => value !== undefined && value !== ''),
    ) as Partial<Organization>,
  );
  const errors = validateOrganization(proposed, true);
  const auditEntry = await auditService.record({
    tenantId: ctx.tenantId,
    userId: ctx.actingUserId,
    action: 'ProposeNewOrganization',
    resourceType: 'Organization',
    afterState: { proposed, validationErrors: errors },
    result: 'Proposed',
    ...(correlationId ? { correlationId } : {}),
  });
  const proposal = await proposalService.createPending({
    tenantId: ctx.tenantId,
    kind: 'organisation_create',
    serviceId: '',
    environment: ctx.environment,
    proposedByUserId: ctx.actingUserId,
    changes: proposed as unknown as Partial<Service>,
    queuedDiff: diff,
    correlationId: auditEntry.correlationId,
  });
  return {
    proposed,
    diff,
    validation: { valid: errors.length === 0, errors },
    quality: checkOrganization(proposed),
    correlationId: auditEntry.correlationId,
    proposalId: proposal.id,
    status: proposal.status,
  };
}

/**
 * Validates and creates the sub-organisation through a write-capable
 * adapter (Publisher, enforced by the registry), auditing the outcome
 * either way.
 */
export async function createNewOrganization(
  registry: PtvAdapterRegistry,
  auditService: AuditService,
  ctx: ToolContext,
  organization: NewOrganization,
  correlationId: string,
): Promise<ApplyOrganizationChangeResult> {
  if (!ctx.writeApiVersion) throw new WriteApiNotSelectedError();
  const errors = validateOrganization(organization, true);
  await auditService.record({
    tenantId: ctx.tenantId,
    userId: ctx.actingUserId,
    action: 'ValidateNewOrganization',
    resourceType: 'Organization',
    afterState: { errors },
    result: errors.length === 0 ? 'Valid' : 'Invalid',
    correlationId,
  });
  if (errors.length > 0) throw new ValidationFailedError(errors);

  const writeAdapter = await resolveWriteAdapter(registry, ctx);
  const capabilities = writeAdapter.getCapabilities();
  const audit = (result: 'Success' | 'Failed', organizationId?: string) =>
    auditService.record({
      tenantId: ctx.tenantId,
      userId: ctx.actingUserId,
      action: 'CreateOrganization',
      resourceType: 'Organization',
      ...(organizationId ? { resourceId: organizationId } : {}),
      apiVersion: capabilities.apiVersion,
      environment: capabilities.environment,
      afterState: organization,
      result,
      correlationId,
    });
  try {
    const result = await writeAdapter.createOrganization(organization);
    await audit('Success', result.organizationId);
    return result;
  } catch (err) {
    await audit('Failed');
    throw err;
  }
}
