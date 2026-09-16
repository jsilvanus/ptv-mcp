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
