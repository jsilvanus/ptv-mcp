/** Mirrors src/auth/rbac.ts's MembershipRole — kept in sync by hand since the web app has no shared package with the backend. */
export type MembershipRole = 'viewer' | 'contributor' | 'approver' | 'publisher' | 'tenant_admin';

export type PtvEnvironment = 'test' | 'production';

export interface TenantMembership {
  tenantId: string;
  tenantName: string;
  tenantSlug: string;
  role: MembershipRole;
}

export interface Member {
  userId: string;
  email: string;
  name: string;
  role: MembershipRole;
}

export interface ConnectionStatus {
  apiVersion: string;
  environment: PtvEnvironment;
  connectedAt: string;
  tokenExpiresAt: string | null;
  lastValidatedAt: string | null;
  revokedAt: string | null;
}

export interface PtvV12ConnectionStatus {
  environment: PtvEnvironment;
  apiVersion: 'v12';
  authMode: 'api_key';
  credentialScope: 'tenant';
  supportsRead: boolean;
  supportsWrite: boolean;
}

export interface AuditEntry {
  id: string;
  correlationId: string;
  tenantId: string;
  userId: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  apiVersion: string | null;
  environment: PtvEnvironment | null;
  beforeState: unknown;
  afterState: unknown;
  prompt: string | null;
  result: string;
  createdAt: string;
}

/** Mirrors src/mcp/proposeChanges.ts's ServiceDiffEntry — the frozen Phase 4 contract. */
export interface ServiceDiffEntry {
  field: string;
  before: unknown;
  after: unknown;
}

export type ProposalStatus = 'pending' | 'approved' | 'rejected' | 'applied' | 'failed';

export type ProposalResolveAction = 'approve_and_export' | 'approve_and_apply' | 'reject';

/** Mirrors src/db/schema/enums.ts's proposalKindEnum. */
export type ProposalKind =
  | 'service_update'
  | 'service_create'
  | 'channel_update'
  | 'channel_create'
  | 'connection_update'
  | 'organisation_update'
  | 'organisation_create';

export interface ProposalSummary {
  id: string;
  kind: ProposalKind;
  /**
   * Target service, channel or organisation (connection_update: the
   * service); empty for a *_create proposal until applied.
   */
  serviceId: string;
  environment: PtvEnvironment;
  proposedByUserId: string;
  status: ProposalStatus;
  correlationId: string;
  resolvedByUserId: string | null;
  resolvedAt: string | null;
  /** Set when the proposal answers a review campaign item. */
  reviewItemId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Mirrors src/proposals/proposalService.ts's ProposalComment. */
export interface ProposalComment {
  id: string;
  userId: string;
  userName: string;
  body: string;
  createdAt: string;
}

export type ReviewDecision = 'pending' | 'approved' | 'changes_requested';

/** Mirrors src/proposals/proposalService.ts's ProposalReviewer. */
export interface ProposalReviewer {
  userId: string;
  userName: string;
  requestedByUserId: string;
  decision: ReviewDecision;
  comment: string | null;
  requestedAt: string;
  decidedAt: string | null;
}

/** Mirrors src/mcp/proposalQueue.ts's ReviewCandidate. */
export interface ReviewCandidate {
  userId: string;
  name: string;
  email: string;
  role: MembershipRole;
}

/** Mirrors src/ptv/domain.ts's CodeListEntry. */
export interface CodeListEntry {
  code?: string;
  uri?: string;
  names: Record<string, string>;
}

/**
 * The parts of a proposed service or channel (src/ptv/domain.ts) the
 * review page previews; channels have no summaries or classifications.
 */
export interface PreviewEntity {
  names?: Record<string, string>;
  summaries?: Record<string, string>;
  descriptions?: Record<string, string>;
  languages?: string[];
  serviceClasses?: CodeListEntry[];
  ontologyTerms?: CodeListEntry[];
  targetGroups?: CodeListEntry[];
  lifeEvents?: CodeListEntry[];
  industrialClasses?: CodeListEntry[];
  /** Channels (mirrors src/ptv/domain.ts's ServiceChannel). */
  channelType?: string;
  urls?: Record<string, string>;
  webPages?: { language: string; url: string; name?: string }[];
  phoneNumbers?: PreviewPhone[];
  supportPhones?: PreviewPhone[];
  emails?: { language: string; value: string }[];
  supportEmails?: { language: string; value: string }[];
  serviceHours?: PreviewServiceHour[];
  addresses?: PreviewAddress[];
  deliveryAddresses?: PreviewAddress[];
  formIdentifiers?: Record<string, string>;
  formFiles?: { language: string; format: string; url: string }[];
  requiresAuthentication?: boolean;
  requiresSignature?: boolean;
  signatureQuantity?: number;
  accessibility?: string;
  isVisibleForAll?: boolean;
}

export interface PreviewPhone {
  language: string;
  type?: string;
  prefixNumber?: string;
  number: string;
  isFinnishServiceNumber?: boolean;
  additionalInformation?: string;
  chargeType?: string;
  chargeDescription?: string;
}

export interface PreviewServiceHour {
  type: string;
  validFrom?: string;
  validTo?: string;
  isClosed?: boolean;
  isAlwaysOpen?: boolean;
  isReservation?: boolean;
  additionalInformation?: Record<string, string>;
  openingTimes?: { dayFrom: string; dayTo?: string; from: string; to: string }[];
}

export interface PreviewAddress {
  kind: string;
  purpose?: string;
  street?: Record<string, string>;
  streetNumber?: string;
  postalCode?: string;
  postOfficeBox?: Record<string, string>;
  latitude?: string;
  longitude?: string;
  additionalInformation?: Record<string, string>;
  text?: Record<string, string>;
  receiver?: Record<string, string>;
}

export interface ProposalDetails extends ProposalSummary {
  /** Merged result after approval; null when it can no longer be read. */
  proposed: PreviewEntity | null;
  diff: ServiceDiffEntry[];
  queuedDiff: ServiceDiffEntry[];
  /** Oldest first. */
  comments: ProposalComment[];
  /** Required reviewers; approving waits until all have approved. */
  reviewers: ProposalReviewer[];
  /** Automated content checks on `proposed`; null without it. */
  quality: QualityReport | null;
  /** Approved (exported) proposals: what to enter in PTV's own UI. */
  manualPublish: ManualPublishSheet | null;
  /** Approved updates: true once PTV already holds the whole change. */
  publishedInPtv: boolean | null;
}

/** Mirrors src/mcp/manualPublish.ts. */
export interface ManualPublishSheet {
  action: 'update' | 'create';
  target: string;
  ptvId: string | null;
  name: string | null;
  languages: string[];
  steps: string[];
  fields: ManualPublishField[];
}

export interface ManualPublishField {
  field: string;
  label: string;
  language?: string;
  before?: string;
  after: string;
}

/** Mirrors src/quality/contentChecks.ts. */
export interface QualityFinding {
  checkId: string;
  severity: 'error' | 'warning';
  field: string;
  language?: string;
  message: string;
  excerpt?: string;
}

export interface QualityReport {
  findings: QualityFinding[];
  errors: number;
  warnings: number;
}

/** Mirrors src/reviews/reviewService.ts. */
export type ReviewItemStatus = 'open' | 'confirmed' | 'changes_proposed';
export type ReviewTargetKind = 'organisation' | 'service' | 'channel';

export interface CampaignProgress {
  total: number;
  open: number;
  confirmed: number;
  changesProposed: number;
  unassigned: number;
}

/** Mirrors src/reviews/reviewCampaigns.ts's ReviewCampaignSummary. */
export interface ReviewCampaignSummary {
  id: string;
  environment: PtvEnvironment;
  name: string;
  organizationId: string;
  status: 'open' | 'closed';
  dueDate: string | null;
  createdByUserId: string;
  createdByName: string | null;
  correlationId: string;
  createdAt: string;
  closedAt: string | null;
  progress: CampaignProgress;
}

export interface LinkedProposal {
  id: string;
  reviewItemId: string;
  kind: ProposalKind;
  status: ProposalStatus;
  createdAt: string;
}

export interface ReviewItem {
  id: string;
  campaignId: string;
  targetKind: ReviewTargetKind;
  targetId: string;
  targetName: string;
  channelType: string | null;
  organizationId: string;
  assigneeUserId: string | null;
  assigneeName: string | null;
  status: ReviewItemStatus;
  findings: QualityFinding[];
  note: string | null;
  reviewedByUserId: string | null;
  reviewedByName: string | null;
  reviewedAt: string | null;
  proposals: LinkedProposal[];
}

export interface ReviewCampaignDetails extends ReviewCampaignSummary {
  items: ReviewItem[];
}

/** Tenant's PTV v11 organisation API user (IN-API write credential); the password is never returned. */
export interface PtvV11ApiUserStatus {
  environment: PtvEnvironment;
  username: string | null;
  apiUserOrganisation: string | null;
  /** PTV organisation the API user writes to, when chosen (test environment). */
  organisationId: string | null;
  supportsRead: boolean;
  supportsWrite: boolean;
}

export interface TenantSettings {
  requireFourEyes: boolean;
}

/** Mirrors src/mcp/myTasks.ts. */
export type ChangeReadiness =
  | 'waiting_for_reviewers'
  | 'ready_to_resolve'
  | 'needs_another_resolver'
  | 'approved_for_manual_publish';

export interface ChangeToHandle extends ProposalSummary {
  readiness: ChangeReadiness;
  reviewers: { userName: string; decision: ReviewDecision }[];
}

export interface MyTasks {
  reviewItems: ReviewItem[];
  proposalsAwaitingMySignOff: ProposalSummary[];
  changesToHandle: ChangeToHandle[];
  openCampaigns: ReviewCampaignSummary[];
  summary: string[];
}
