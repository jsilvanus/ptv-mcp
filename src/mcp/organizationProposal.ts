import { OrganizationNotFoundError } from '../ptv/organisationContent.js';
import { resolveReadAdapter } from './toolContext.js';
import type { QualityReport } from '../quality/contentChecks.js';
import type { AuditService } from '../audit/auditService.js';
import type { ApplyOrganizationChangeResult, NewOrganization } from '../ptv/adapter.js';
import type { Organization, PtvContentId } from '../ptv/domain.js';
import type { PtvAdapterRegistry } from '../ptv/registry.js';
import type { ProposalService, ProposalStatus } from '../proposals/proposalService.js';
import type { MembershipRoleResolver } from './authorization.js';
import { auditedApply, queueKindProposal } from './proposalPipeline.js';
import { diffFields, type ServiceDiffEntry } from './proposeChanges.js';
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

export { OrganizationNotFoundError };

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
  return {
    organizationId,
    current,
    proposed,
    diff: diffFields<Partial<Organization>>(current, changes),
  };
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
  const { prepared, ...queued } = await queueKindProposal(
    { resolveRole, auditService, proposalService },
    ctx,
    {
      kind: 'organisation_update',
      input: changes,
      targetId: organizationId,
      resourceId: organizationId,
      prepare: () => prepareOrganizationProposal(registry, ctx, organizationId, changes),
      changes: () => changes,
      correlationId,
    },
  );
  return { ...prepared, ...queued };
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
  return auditedApply({ registry, auditService }, ctx, 'organisation_update', async () => {
    const { current, proposed } = await prepareOrganizationProposal(
      registry,
      ctx,
      organizationId,
      changes,
    );
    return {
      correlationId,
      proposed,
      target: { resourceId: organizationId, before: current },
      write: (adapter) => adapter.applyOrganizationChange({ organizationId, changes }),
    };
  });
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
  const { prepared, validation, quality, ...queued } = await queueKindProposal(
    { resolveRole, auditService, proposalService },
    ctx,
    {
      kind: 'organisation_create',
      input,
      targetId: '',
      prepare: () => prepareNewOrganization(registry, ctx, input),
      changes: ({ proposed }) => proposed,
      correlationId,
    },
  );
  return { ...prepared, validation, quality, ...queued };
}

/**
 * Checks the parent (it must exist and leave room for one more level),
 * fills in what the new sub-organisation copies from it, and diffs it
 * against an empty one.
 */
async function prepareNewOrganization(
  registry: PtvAdapterRegistry,
  ctx: ToolContext,
  input: Partial<NewOrganization>,
): Promise<{ proposed: NewOrganization; diff: ServiceDiffEntry[] }> {
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
  const diff = diffFields<Partial<Organization>>(
    EMPTY_ORGANIZATION,
    Object.fromEntries(
      Object.entries(proposed).filter(([, value]) => value !== undefined && value !== ''),
    ) as Partial<Organization>,
  );
  return { proposed, diff };
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
  return auditedApply({ registry, auditService }, ctx, 'organisation_create', async () => ({
    correlationId,
    proposed: organization,
    target: {
      createdId: (result: ApplyOrganizationChangeResult) => result.organizationId,
    },
    write: (adapter) => adapter.createOrganization(organization),
  }));
}
