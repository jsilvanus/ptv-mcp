/** Mirrors src/auth/rbac.ts's MembershipRole — kept in sync by hand since the web app has no shared package with the backend. */
export type MembershipRole = 'reader' | 'editor' | 'publisher' | 'tenant_admin';

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
export type ProposalKind = 'service_update' | 'service_create' | 'channel_update';

export interface ProposalSummary {
  id: string;
  kind: ProposalKind;
  /** Target service or channel; empty for a service_create proposal until applied. */
  serviceId: string;
  environment: PtvEnvironment;
  proposedByUserId: string;
  status: ProposalStatus;
  correlationId: string;
  resolvedByUserId: string | null;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProposalDetails extends ProposalSummary {
  diff: ServiceDiffEntry[];
  queuedDiff: ServiceDiffEntry[];
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
