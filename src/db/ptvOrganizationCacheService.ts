import { and, eq, gt, lte } from 'drizzle-orm';
import type { Database } from './client.js';
import { withContext } from './context.js';
import { ptvOrganizationCache } from './schema/ptvOrganizationCache.js';
import type { PtvEnvironment } from '../ptv/adapter.js';
import type { V11OrganizationWire } from '../ptv/v11/wireModel.js';

const DEFAULT_TTL_MS = 60 * 60 * 1000;

export interface PtvOrganizationCacheKey {
  tenantId: string;
  environment: PtvEnvironment;
  apiVersion: string;
}

export class PtvOrganizationCacheService {
  constructor(
    private readonly db: Database,
    private readonly ttlMs = DEFAULT_TTL_MS,
  ) {}

  async hasFreshCatalogue(key: PtvOrganizationCacheKey): Promise<boolean> {
    const now = new Date();
    return withContext(this.db, { tenantId: key.tenantId }, async (tx) => {
      const rows = await tx
        .select({ id: ptvOrganizationCache.id })
        .from(ptvOrganizationCache)
        .where(
          and(
            eq(ptvOrganizationCache.tenantId, key.tenantId),
            eq(ptvOrganizationCache.environment, key.environment),
            eq(ptvOrganizationCache.apiVersion, key.apiVersion),
            lte(ptvOrganizationCache.staleAt, now),
          ),
        )
        .limit(1);

      if (rows.length > 0) return false;

      const existing = await tx
        .select({ id: ptvOrganizationCache.id })
        .from(ptvOrganizationCache)
        .where(
          and(
            eq(ptvOrganizationCache.tenantId, key.tenantId),
            eq(ptvOrganizationCache.environment, key.environment),
            eq(ptvOrganizationCache.apiVersion, key.apiVersion),
          ),
        )
        .limit(1);

      return existing.length > 0;
    });
  }

  async search(
    key: PtvOrganizationCacheKey,
    query?: string,
  ): Promise<V11OrganizationWire[]> {
    const now = new Date();
    return withContext(this.db, { tenantId: key.tenantId }, async (tx) => {
      const rows = await tx
        .select()
        .from(ptvOrganizationCache)
        .where(
          and(
            eq(ptvOrganizationCache.tenantId, key.tenantId),
            eq(ptvOrganizationCache.environment, key.environment),
            eq(ptvOrganizationCache.apiVersion, key.apiVersion),
            gt(ptvOrganizationCache.staleAt, now),
          ),
        )
        .orderBy(ptvOrganizationCache.name);

      const normalizedQuery = query?.trim().toLocaleLowerCase('fi-FI');
      return rows
        .filter(
          (row) =>
            !normalizedQuery ||
            row.normalizedName.includes(normalizedQuery),
        )
        .map((row) => row.organization as V11OrganizationWire);
    });
  }

  async replaceCatalogue(
    key: PtvOrganizationCacheKey,
    organizations: V11OrganizationWire[],
  ): Promise<void> {
    const now = new Date();
    const staleAt = new Date(now.getTime() + this.ttlMs);

    await withContext(this.db, { tenantId: key.tenantId }, async (tx) => {
      await tx
        .delete(ptvOrganizationCache)
        .where(
          and(
            eq(ptvOrganizationCache.tenantId, key.tenantId),
            eq(ptvOrganizationCache.environment, key.environment),
            eq(ptvOrganizationCache.apiVersion, key.apiVersion),
          ),
        );

      for (let i = 0; i < organizations.length; i += 500) {
        const batch = organizations.slice(i, i + 500);
        if (batch.length === 0) continue;

        await tx.insert(ptvOrganizationCache).values(
          batch.map((organization) => ({
            tenantId: key.tenantId,
            environment: key.environment,
            apiVersion: key.apiVersion,
            organizationId: organization.id,
            name: organization.organizationNames[0]?.value ?? organization.id,
            normalizedName: organization.organizationNames
              .map((name) => name.value)
              .join(' ')
              .toLocaleLowerCase('fi-FI'),
            organization,
            fetchedAt: now,
            staleAt,
          })),
        );
      }
    });
  }
}
