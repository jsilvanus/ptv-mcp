import { and, eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { withContext } from '../db/context.js';
import { ptvAdapterConfigs } from '../db/schema/index.js';

export type PtvEnvironment = 'test' | 'production';
export type CredentialScope = 'tenant' | 'user';

export interface PtvAdapterConfigInput {
  authMode: string;
  credentialScope: CredentialScope;
  supportsRead: boolean;
  supportsWrite: boolean;
  supportsDraftRead: boolean;
}

export interface PtvAdapterConfigRecord extends PtvAdapterConfigInput {
  id: string;
  tenantId: string;
  environment: PtvEnvironment;
  apiVersion: string;
  updatedAt: Date;
}

/**
 * `PtvAdapterConfig` wired to the real DB table (Phase 3 Stream B) — what
 * `PtvAdapterRegistry` (Stream D) reads to decide which adapter and
 * credential scope apply to a given tenant/environment/api_version.
 */
export class PtvAdapterConfigService {
  constructor(private readonly db: Database) {}

  async upsert(
    tenantId: string,
    environment: PtvEnvironment,
    apiVersion: string,
    config: PtvAdapterConfigInput,
  ): Promise<void> {
    await withContext(this.db, { tenantId }, async (tx) => {
      await tx
        .insert(ptvAdapterConfigs)
        .values({ tenantId, environment, apiVersion, ...config })
        .onConflictDoUpdate({
          target: [
            ptvAdapterConfigs.tenantId,
            ptvAdapterConfigs.environment,
            ptvAdapterConfigs.apiVersion,
          ],
          set: { ...config, updatedAt: new Date() },
        });
    });
  }

  async get(
    tenantId: string,
    environment: PtvEnvironment,
    apiVersion: string,
  ): Promise<PtvAdapterConfigRecord | undefined> {
    return withContext(this.db, { tenantId }, async (tx) =>
      tx.query.ptvAdapterConfigs.findFirst({
        where: and(
          eq(ptvAdapterConfigs.tenantId, tenantId),
          eq(ptvAdapterConfigs.environment, environment),
          eq(ptvAdapterConfigs.apiVersion, apiVersion),
        ),
      }),
    );
  }

  async list(tenantId: string): Promise<PtvAdapterConfigRecord[]> {
    return withContext(this.db, { tenantId }, async (tx) =>
      tx.query.ptvAdapterConfigs.findMany({ where: eq(ptvAdapterConfigs.tenantId, tenantId) }),
    );
  }
}
