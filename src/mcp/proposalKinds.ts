import type { AuditService } from '../audit/auditService.js';
import { CHANNEL_TYPE_LABELS, EMPTY } from '../format/ptvFormat.js';
import type { NewChannel, NewOrganization, NewService, PtvAdapter } from '../ptv/adapter.js';
import type {
  Connection,
  LocalizedText,
  Organization,
  PtvContentId,
  Service,
  ServiceChannel,
} from '../ptv/domain.js';
import type { PtvAdapterRegistry } from '../ptv/registry.js';
import type { ProposalKind, StoredChanges } from '../proposals/proposalService.js';
import {
  checkChannel,
  checkConnection,
  checkOrganization,
  checkService,
  type QualityReport,
  type ServiceCheckContext,
} from '../quality/contentChecks.js';
import { serviceCheckContext } from '../quality/serviceCheckContext.js';
import type { ReviewTargetKind } from '../reviews/reviewService.js';
import {
  validateChannel,
  type ChangeValidator,
  type ValidationResult,
} from '../validation/changeValidator.js';
import { validateConnectionDetails } from '../validation/channelRules.js';
import { validateOrganization } from '../validation/organizationRules.js';
import { applyChanges, exportForManualPublish } from './applyOrExport.js';
import type { MembershipRoleResolver } from './authorization.js';
import {
  applyChannelChanges,
  ChannelNotFoundError,
  prepareChannelProposal,
} from './channelProposal.js';
import {
  applyConnectionChanges,
  ConnectionNotFoundError,
  prepareConnectionProposal,
  splitConnectionChanges,
  type ConnectionChange,
  type ConnectionChanges,
} from './connectionProposal.js';
import { asChannel, createNewChannel, normalizeNewChannel } from './newChannelProposal.js';
import { asService, createNewService, normalizeNewService } from './newServiceProposal.js';
import {
  applyOrganizationChanges,
  createNewOrganization,
  OrganizationNotFoundError,
  prepareOrganizationProposal,
} from './organizationProposal.js';
import { prepareProposal, ServiceNotFoundError, type ServiceDiffEntry } from './proposeChanges.js';
import { resolveReadAdapter, type ToolContext } from './toolContext.js';

/**
 * Each kind's changes, as read from the stored jsonb, and the entity it
 * proposes: what validation and the quality checks look at. A new item's
 * changes are the whole item, normalized when it was queued.
 */
interface KindTypes {
  service_update: { changes: Partial<Service>; proposed: Service };
  service_create: { changes: NewService; proposed: NewService };
  channel_update: { changes: Partial<ServiceChannel>; proposed: ServiceChannel };
  channel_create: { changes: NewChannel; proposed: NewChannel };
  connection_update: { changes: ConnectionChange; proposed: Connection };
  organisation_update: { changes: Partial<Organization>; proposed: Organization };
  organisation_create: { changes: NewOrganization; proposed: NewOrganization };
}

export type KindChanges<K extends ProposalKind> = KindTypes[K]['changes'];
export type KindProposed<K extends ProposalKind> = KindTypes[K]['proposed'];

/** What any proposal proposes. */
export type ProposedEntity = KindProposed<ProposalKind>;

/** What an update's target is in PTV now. */
export type CurrentEntity = Service | ServiceChannel | Connection | Organization;

/** A proposal compared with PTV now. */
export interface LiveDiff<P> {
  diff: ServiceDiffEntry[];
  current: CurrentEntity | null;
  proposed: P | null;
}

/** What approving or applying a stored proposal works on. */
export interface StoredProposal<C> {
  /** The proposal's `serviceId`: the target, or '' for a new item. */
  targetId: string;
  changes: C;
  queuedDiff: ServiceDiffEntry[];
  correlationId: string;
}

export interface ApplyDeps {
  resolveRole: MembershipRoleResolver;
  registry: PtvAdapterRegistry;
  auditService: AuditService;
  validator: ChangeValidator;
}

export interface AppliedOutcome {
  /** PTV's id for a created item, recorded on the proposal. */
  createdId?: string;
  afterState?: object;
}

/** How a new item entered in PTV's own UI is found and checked (confirmManualPublish). */
export interface CreatedItemCheck<C> {
  what: 'service' | 'channel' | 'organisation';
  /** The organisation it must belong to (a sub-organisation's parent) and its names. */
  expected(changes: C): { organizationId: string | undefined; names: LocalizedText };
  read(
    adapter: PtvAdapter,
    ptvId: string,
  ): Promise<{ organizationId: string; names: LocalizedText } | null>;
}

/** The names, languages and ids a manual-publishing sheet shows. */
export interface SheetSubject {
  names: LocalizedText;
  languages: string[];
  channelType?: string;
  organizationId?: string;
  /** connection_update: the connected channel (the sheet's ptvId is the service). */
  channelId?: string;
}

/** What the steps of a manual-publishing sheet refer to. */
export interface SheetFacts {
  target: string;
  name: string | null;
  ptvId: string | null;
  organizationId: string | undefined;
  channelId: string | undefined;
  /** The language versions to publish, e.g. "fi, sv". */
  languageList: string;
}

/** The manual-publishing sheet of a kind (src/mcp/manualPublish.ts). */
export interface SheetSpec<C, P> {
  /** What the sheet is about, e.g. "Palvelu"; a channel adds its type. */
  target(channelType: string | undefined): string;
  /** A channel lists the languages it serves in, a service those it is available in. */
  channel: boolean;
  subject(changes: C, details: LiveDiff<P>): SheetSubject;
  /** The steps in PTV's own UI. */
  steps(facts: SheetFacts): string[];
}

/** The review item (docs/review-campaigns-plan.md) a proposal is linked to. */
export interface ReviewItemTarget {
  targetKind: ReviewTargetKind;
  targetId: string;
  targetName: string;
}

/**
 * Everything specific to one proposal kind. The queue (proposalPipeline.ts,
 * proposalQueue.ts), the manual-publishing sheet and review campaigns
 * dispatch through PROPOSAL_KINDS rather than branching on the kind.
 */
export interface ProposalKindHandler<C, P> {
  /** Creates a new item: PTV assigns its id when it is applied or entered. */
  creates: boolean;
  /** The target's audit resourceType and the Propose*, Validate* and Apply* or Create* actions. */
  audit: { resourceType: string; propose: string; validate: string; write: string };
  /** The stored changes as this kind's changes. */
  parse(stored: StoredChanges): C;
  /** This kind's changes as stored; the inverse of parse. */
  store(changes: C): StoredChanges;
  /**
   * The proposal against PTV now, read in the context's environment:
   * updates re-read the target and re-diff, new items keep the queue-time
   * diff.
   */
  liveDiff(
    registry: PtvAdapterRegistry,
    ctx: ToolContext,
    proposal: Pick<StoredProposal<C>, 'targetId' | 'changes' | 'queuedDiff'>,
  ): Promise<LiveDiff<P>>;
  /** PTV's hard rules. Service kinds validate against the active adapter's schema. */
  validate(proposed: P, validator: ChangeValidator | undefined): ValidationResult;
  /** What the quality checks need besides the proposed entity, when it is shown. */
  qualityContext?(
    registry: PtvAdapterRegistry,
    ctx: ToolContext,
    proposed: P | null,
  ): Promise<ServiceCheckContext>;
  /** Automated content checks (src/quality/contentChecks.ts). */
  quality(proposed: P, context: ServiceCheckContext): QualityReport;
  /**
   * approve_and_export: checks what needs checking before a person enters
   * the change in PTV, and returns the afterState of the approval's audit
   * entry, if any.
   */
  approveForExport(
    deps: ApplyDeps,
    ctx: ToolContext,
    proposal: StoredProposal<C>,
  ): Promise<object | undefined>;
  /**
   * Writes an approved proposal through a write-capable adapter (Publisher,
   * enforced by the registry): updates re-diff against PTV first, new items
   * are created and their id returned.
   */
  apply(deps: ApplyDeps, ctx: ToolContext, proposal: StoredProposal<C>): Promise<AppliedOutcome>;
  /** New items only. */
  created?: CreatedItemCheck<C>;
  /** Whether `err` says the target can no longer be read (archived items 404). */
  isNotFound(err: unknown): boolean;
  sheet: SheetSpec<C, P>;
  /**
   * Why a review item can't take a proposal of this kind, or null when it
   * can. `changes` are the proposal's (stored) changes, when known.
   */
  reviewItemMismatch(
    item: ReviewItemTarget,
    targetId: string | undefined,
    changes: StoredChanges | undefined,
  ): string | null;
}

export type KindHandler<K extends ProposalKind> = ProposalKindHandler<
  KindChanges<K>,
  KindProposed<K>
>;

/** The organisation and general description a proposed service is checked against. */
export async function proposedServiceContext(
  registry: PtvAdapterRegistry,
  ctx: ToolContext,
  service: Service | NewService | null,
): Promise<ServiceCheckContext> {
  if (!service) return {};
  const adapter = await resolveReadAdapter(registry, ctx).catch(() => null);
  return adapter ? serviceCheckContext(adapter, service) : {};
}

function channelTarget(channelType: string | undefined): string {
  return `Asiointikanava: ${CHANNEL_TYPE_LABELS[channelType ?? ''] ?? channelType ?? ''}`;
}

/**
 * A sheet's names and languages from the proposed entity (or PTV's, when
 * the proposal can't be read against it), and its organisation: a new
 * sub-organisation is added under its parent.
 */
function entitySubject(
  details: LiveDiff<object>,
  organizationField: 'organizationId' | 'parentOrganizationId' = 'organizationId',
): SheetSubject {
  const entity = (details.proposed ?? details.current) as
    (Partial<ServiceChannel> & { names?: LocalizedText; parentOrganizationId?: string }) | null;
  const organizationId = entity?.[organizationField];
  return {
    names: ((details.current ?? entity) as { names?: LocalizedText } | null)?.names ?? {},
    languages: Object.keys(entity?.names ?? {}),
    ...(entity?.channelType ? { channelType: entity.channelType } : {}),
    ...(organizationId ? { organizationId } : {}),
  };
}

const CONFIRM_UPDATE =
  'When the change shows in PTV, confirm it here (ptv_confirm_manual_publish, or Mark as published in the Proposal queue). The MCP compares PTV with the proposal and closes it.';

function updateSteps(facts: SheetFacts): string[] {
  return [
    `In PTV (palvelutietovaranto.suomi.fi), open the ${facts.target.toLowerCase()} "${facts.name ?? facts.ptvId}" (id ${facts.ptvId}) and choose Muokkaa.`,
    `Change the fields below. Copy each new value as it is; ${EMPTY} means clear the field.`,
    `Publish every language version: ${facts.languageList}. Publishing only some sends the others back to draft.`,
    CONFIRM_UPDATE,
  ];
}

/** Steps for a new item, after the first one: where in PTV to add it. */
function createSteps(first: string, facts: SheetFacts): string[] {
  return [
    first,
    'Fill in the fields below, in every language version listed. Copy each value as it is.',
    `Save it and publish the language versions ${facts.languageList}, or leave it a draft if the Julkaisutila row says Luonnos.`,
    "Copy the new item's id from PTV and confirm here (ptv_confirm_manual_publish with ptvId, or Mark as published in the Proposal queue). The MCP checks the item in PTV and closes the proposal.",
  ];
}

function addNewStep(facts: SheetFacts): string {
  return `In PTV (palvelutietovaranto.suomi.fi), add a new ${facts.target.toLowerCase()}${facts.organizationId ? ` for organisation ${facts.organizationId}` : ''}.`;
}

/** A review item this kind answers only when it is about the proposal's own target. */
function sameTarget(
  item: ReviewItemTarget,
  kind: ReviewTargetKind,
  targetId: string | undefined,
): string | null {
  return item.targetKind === kind && item.targetId === targetId
    ? null
    : `Review item "${item.targetName}" is the ${item.targetKind} ${item.targetId}; this proposal targets another ${kind}.`;
}

/** New items and organisation changes may come from any review item. */
const anyReviewItem = (): null => null;

/** approve_and_export for kinds validated when queued and re-diffed on every read. */
const nothingToCheck = async (): Promise<undefined> => undefined;

/** A sheet subject from the proposal's entity alone (see entitySubject). */
const proposedSubject = (_changes: unknown, details: LiveDiff<object>): SheetSubject =>
  entitySubject(details);

/** A new item's liveDiff: nothing in PTV to diff against, so the queue-time diff stands. */
function queuedLiveDiff<C, P>(toProposed: (changes: C) => P) {
  return async (
    _registry: PtvAdapterRegistry,
    _ctx: ToolContext,
    { changes, queuedDiff }: Pick<StoredProposal<C>, 'changes' | 'queuedDiff'>,
  ): Promise<LiveDiff<P>> => ({ diff: queuedDiff, current: null, proposed: toProposed(changes) });
}

/** A new service or channel must belong to the proposal's organisation and carry its names. */
const ownOrganization = (changes: {
  organizationId: string;
  names?: LocalizedText;
}): { organizationId: string; names: LocalizedText } => ({
  organizationId: changes.organizationId,
  names: changes.names ?? {},
});

/**
 * Every proposal kind, described in one place; a kind missing here is a
 * compile error. The handlers are plain functions calling into the kind's
 * own module, so this table is only read at call time.
 */
export const PROPOSAL_KINDS: { [K in ProposalKind]: KindHandler<K> } = {
  service_update: {
    creates: false,
    audit: {
      resourceType: 'Service',
      propose: 'ProposeServiceChange',
      validate: 'ValidateServiceChange',
      write: 'ApplyServiceChange',
    },
    parse: (stored) => stored as Partial<Service>,
    store: (changes) => changes,
    liveDiff: (registry, ctx, { targetId, changes }) =>
      prepareProposal(registry, ctx, targetId, changes),
    validate: (proposed, validator) => requireValidator(validator).validate(proposed),
    qualityContext: proposedServiceContext,
    quality: (proposed, context) => checkService(proposed, { ...context, creating: false }),
    // A service change is re-validated before export; the other kinds were
    // validated when queued and are re-diffed on every read.
    approveForExport: async (deps, ctx, { targetId, changes, correlationId }) => {
      await exportForManualPublish(
        deps.resolveRole,
        deps.registry,
        deps.auditService,
        ctx,
        targetId,
        changes,
        correlationId,
      );
      return undefined;
    },
    apply: async (deps, ctx, { targetId, changes, correlationId }) => {
      await applyChanges(
        deps.resolveRole,
        deps.registry,
        deps.auditService,
        deps.validator,
        ctx,
        targetId,
        changes,
        correlationId,
      );
      return {};
    },
    isNotFound: (err) => err instanceof ServiceNotFoundError,
    sheet: {
      target: () => 'Palvelu',
      channel: false,
      subject: proposedSubject,
      steps: updateSteps,
    },
    reviewItemMismatch: (item, targetId, changes) =>
      // A service change that edits connections may answer a channel's item
      // ("this channel should be linked to service X").
      item.targetKind === 'channel' && changes && 'serviceChannelIds' in changes
        ? null
        : sameTarget(item, 'service', targetId),
  },

  service_create: {
    creates: true,
    audit: {
      resourceType: 'Service',
      propose: 'ProposeNewService',
      validate: 'ValidateNewService',
      write: 'CreateService',
    },
    parse: (stored) => normalizeNewService(stored as Partial<Service>),
    store: (changes) => changes,
    liveDiff: queuedLiveDiff((changes: NewService) => changes),
    validate: (proposed, validator) => requireValidator(validator).validate(asService(proposed)),
    qualityContext: proposedServiceContext,
    quality: (proposed, context) => checkService(proposed, { ...context, creating: true }),
    approveForExport: async (_deps, _ctx, { changes }) => changes,
    apply: async (deps, ctx, { changes, correlationId }) => {
      const { serviceId } = await createNewService(
        deps.registry,
        deps.auditService,
        deps.validator,
        ctx,
        changes,
        correlationId,
      );
      return { createdId: serviceId, afterState: { serviceId } };
    },
    created: {
      what: 'service',
      expected: ownOrganization,
      read: (adapter, ptvId) => adapter.getService(ptvId),
    },
    isNotFound: (err) => err instanceof ServiceNotFoundError,
    sheet: {
      target: () => 'Palvelu',
      channel: false,
      subject: proposedSubject,
      steps: (facts) => createSteps(addNewStep(facts), facts),
    },
    reviewItemMismatch: anyReviewItem,
  },

  channel_update: {
    creates: false,
    audit: {
      resourceType: 'ServiceChannel',
      propose: 'ProposeChannelChange',
      validate: 'ValidateChannelChange',
      write: 'ApplyChannelChange',
    },
    parse: (stored) => stored as Partial<ServiceChannel>,
    store: (changes) => changes,
    liveDiff: (registry, ctx, { targetId, changes }) =>
      prepareChannelProposal(registry, ctx, targetId, changes),
    validate: (proposed) => validateChannel(proposed),
    // A channel update doesn't know the channel's connections, so its
    // Q-STRUCT-5 is left to the review item and ptv_check_quality.
    quality: (proposed) => checkChannel(proposed),
    approveForExport: nothingToCheck,
    apply: async (deps, ctx, { targetId, changes, correlationId }) => {
      await applyChannelChanges(
        deps.registry,
        deps.auditService,
        ctx,
        targetId,
        changes,
        correlationId,
      );
      return {};
    },
    isNotFound: (err) => err instanceof ChannelNotFoundError,
    sheet: {
      target: channelTarget,
      channel: true,
      subject: proposedSubject,
      steps: updateSteps,
    },
    reviewItemMismatch: (item, targetId) => sameTarget(item, 'channel', targetId),
  },

  channel_create: {
    creates: true,
    audit: {
      resourceType: 'ServiceChannel',
      propose: 'ProposeNewChannel',
      validate: 'ValidateNewChannel',
      write: 'CreateChannel',
    },
    parse: (stored) => normalizeNewChannel(stored as Partial<NewChannel>),
    store: (changes) => changes,
    liveDiff: queuedLiveDiff(asChannel),
    validate: (proposed) => validateChannel(asChannel(proposed), true),
    // A new channel is connected to exactly its serviceIds.
    quality: (proposed) =>
      checkChannel(asChannel(proposed), {
        connectedServiceCount: proposed.serviceIds?.length ?? 0,
        creating: true,
      }),
    approveForExport: nothingToCheck,
    apply: async (deps, ctx, { changes, correlationId }) => {
      const { channelId } = await createNewChannel(
        deps.registry,
        deps.auditService,
        ctx,
        changes,
        correlationId,
      );
      return { createdId: channelId, afterState: { channelId } };
    },
    created: {
      what: 'channel',
      expected: ownOrganization,
      read: (adapter, ptvId) => adapter.getChannel(ptvId),
    },
    isNotFound: (err) => err instanceof ChannelNotFoundError,
    sheet: {
      target: channelTarget,
      channel: true,
      subject: proposedSubject,
      steps: (facts) => createSteps(addNewStep(facts), facts),
    },
    reviewItemMismatch: anyReviewItem,
  },

  connection_update: {
    creates: false,
    audit: {
      resourceType: 'Connection',
      propose: 'ProposeConnectionChange',
      validate: 'ValidateConnectionChange',
      write: 'ApplyConnectionChange',
    },
    // The channel id is stored among the changes; the service is the target.
    parse: (stored) => splitConnectionChanges(stored as ConnectionChanges),
    store: ({ channelId, details }): ConnectionChanges => ({ channelId, ...details }),
    liveDiff: (registry, ctx, { targetId, changes }) =>
      prepareConnectionProposal(registry, ctx, targetId, changes.channelId, changes.details),
    validate: (proposed) => validateConnectionDetails(proposed),
    quality: (proposed) => checkConnection(proposed),
    approveForExport: nothingToCheck,
    apply: async (deps, ctx, { targetId, changes, correlationId }) => {
      await applyConnectionChanges(
        deps.registry,
        deps.auditService,
        ctx,
        targetId,
        changes.channelId,
        changes.details,
        correlationId,
      );
      return {};
    },
    isNotFound: (err) => err instanceof ConnectionNotFoundError,
    sheet: {
      target: () => 'Liitoksen lisätiedot',
      channel: false,
      subject: ({ channelId }) => ({ names: {}, languages: [], channelId }),
      steps: (facts) => [
        `In PTV (palvelutietovaranto.suomi.fi), open the service "${facts.name ?? facts.ptvId}" (id ${facts.ptvId}) and its Liitokset (connections) tab.`,
        `Open the connection to channel ${facts.channelId ?? ''} and edit its additional information (lisätiedot).`,
        `Change the fields below. Copy each new value as it is; ${EMPTY} means clear the field. Save the connection.`,
        CONFIRM_UPDATE,
      ],
    },
    // A connection's extra info answers the item of its service or its channel.
    reviewItemMismatch: (item, targetId, changes) => {
      const channelId = changes?.channelId;
      return (item.targetKind === 'service' && item.targetId === targetId) ||
        (item.targetKind === 'channel' && item.targetId === channelId)
        ? null
        : `Review item "${item.targetName}" is the ${item.targetKind} ${item.targetId}; this connection is between service ${targetId} and channel ${String(channelId)}.`;
    },
  },

  organisation_update: {
    creates: false,
    audit: {
      resourceType: 'Organization',
      propose: 'ProposeOrganizationChange',
      validate: 'ValidateOrganizationChange',
      write: 'ApplyOrganizationChange',
    },
    parse: (stored) => stored as Partial<Organization>,
    store: (changes) => changes,
    liveDiff: (registry, ctx, { targetId, changes }) =>
      prepareOrganizationProposal(registry, ctx, targetId, changes),
    validate: (proposed) => validateOrganization(proposed),
    quality: (proposed) => checkOrganization(proposed),
    approveForExport: nothingToCheck,
    apply: async (deps, ctx, { targetId, changes, correlationId }) => {
      await applyOrganizationChanges(
        deps.registry,
        deps.auditService,
        ctx,
        targetId,
        changes,
        correlationId,
      );
      return {};
    },
    isNotFound: (err) => err instanceof OrganizationNotFoundError,
    sheet: {
      target: () => 'Organisaatio',
      channel: false,
      subject: proposedSubject,
      steps: updateSteps,
    },
    reviewItemMismatch: anyReviewItem,
  },

  organisation_create: {
    creates: true,
    audit: {
      resourceType: 'Organization',
      propose: 'ProposeNewOrganization',
      validate: 'ValidateNewOrganization',
      write: 'CreateOrganization',
    },
    // Stored normalized at queue time (the parent's defaults filled in).
    parse: (stored) => stored as NewOrganization,
    store: (changes) => changes,
    liveDiff: queuedLiveDiff(
      (changes: NewOrganization): NewOrganization & { id: PtvContentId } => ({
        ...changes,
        id: '',
      }),
    ),
    validate: (proposed) => validateOrganization(proposed, true),
    quality: (proposed) => checkOrganization(proposed),
    approveForExport: nothingToCheck,
    apply: async (deps, ctx, { changes, correlationId }) => {
      const { organizationId } = await createNewOrganization(
        deps.registry,
        deps.auditService,
        ctx,
        changes,
        correlationId,
      );
      return { createdId: organizationId, afterState: { organizationId } };
    },
    // A sub-organisation must sit under its parent.
    created: {
      what: 'organisation',
      expected: (changes) => ({
        organizationId: changes.parentOrganizationId,
        names: changes.names ?? {},
      }),
      read: async (adapter, ptvId) => {
        const org = await adapter.getOrganisation(ptvId);
        return org && { organizationId: org.parentOrganizationId ?? '', names: org.names };
      },
    },
    isNotFound: (err) => err instanceof OrganizationNotFoundError,
    sheet: {
      target: () => 'Alaorganisaatio',
      channel: false,
      subject: (_changes, details) => entitySubject(details, 'parentOrganizationId'),
      steps: (facts) =>
        createSteps(
          `In PTV (palvelutietovaranto.suomi.fi), choose Lisää → Organisaatio and add the sub-organisation under organisation ${facts.organizationId ?? ''} (only a PTV main user, pääkäyttäjä, can do this).`,
          facts,
        ),
    },
    reviewItemMismatch: anyReviewItem,
  },
};

/**
 * The handler of any kind, for code that works on a stored proposal of
 * whatever kind: it parses the proposal's changes with the same handler it
 * then passes them to.
 */
export function kindHandler(
  kind: ProposalKind,
): ProposalKindHandler<KindChanges<ProposalKind>, ProposedEntity> {
  return PROPOSAL_KINDS[kind];
}

/** Service kinds are validated against the active adapter's schema. */
function requireValidator(validator: ChangeValidator | undefined): ChangeValidator {
  if (!validator) throw new Error('A service proposal is validated with a ChangeValidator');
  return validator;
}
