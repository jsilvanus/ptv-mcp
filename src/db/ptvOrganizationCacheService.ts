import { and, asc, eq, exists, gt, lte, not, notExists, or, sql, type SQL } from 'drizzle-orm';
import type { Database } from './client.js';
import { withContext } from './context.js';
import { ptvOrganizationCache } from './schema/ptvOrganizationCache.js';
import type { PtvEnvironment } from '../ptv/adapter.js';
import type { Organization } from '../ptv/domain.js';

const DEFAULT_TTL_MS = 60 * 60 * 1000;

/** A row from before the cache stored domain objects (a v11 wire object has no `names`). */
const notDomainShaped = sql`(${ptvOrganizationCache.organization} -> 'names') IS NULL`;

export interface PtvOrganizationCacheKey {
  tenantId: string;
  environment: PtvEnvironment;
  apiVersion: string;
}

/**
 * A tenant's copy of PTV's organisation catalogue, per environment and API
 * version, as domain `Organization`s so any adapter can use it. Rows
 * written before the cache stored domain objects hold v11 wire objects
 * (no `names`); they count as stale, so the next search refreshes them.
 */
export class PtvOrganizationCacheService {
  constructor(
    private readonly db: Database,
    private readonly ttlMs = DEFAULT_TTL_MS,
  ) {}

  /** Whether a catalogue is cached for `key` and none of its rows is stale or in the old shape. */
  async hasFreshCatalogue(key: PtvOrganizationCacheKey): Promise<boolean> {
    const now = new Date();
    return withContext(this.db, { tenantId: key.tenantId }, async (tx) => {
      const forKey = (extra?: SQL) =>
        tx
          .select({ one: sql`1` })
          .from(ptvOrganizationCache)
          .where(
            and(
              eq(ptvOrganizationCache.tenantId, key.tenantId),
              eq(ptvOrganizationCache.environment, key.environment),
              eq(ptvOrganizationCache.apiVersion, key.apiVersion),
              extra,
            ),
          );
      const [row] = await tx.execute<{ fresh: boolean }>(
        sql`SELECT (${exists(forKey())} AND ${notExists(
          forKey(or(lte(ptvOrganizationCache.staleAt, now), notDomainShaped)),
        )}) AS fresh`,
      );
      return row?.fresh === true;
    });
  }

  /** Matches `query` against every official and alternative name, in any language. */
  async search(key: PtvOrganizationCacheKey, query?: string): Promise<Organization[]> {
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
            not(notDomainShaped),
          ),
        )
        .orderBy(asc(ptvOrganizationCache.catalogOrder));

      const normalizedQuery = query?.trim().toLocaleLowerCase('fi-FI');
      return rows
        .filter((row) => !normalizedQuery || row.normalizedName.includes(normalizedQuery))
        .map((row) => row.organization as Organization);
    });
  }

  async replaceCatalogue(
    key: PtvOrganizationCacheKey,
    organizations: Organization[],
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
          batch.map((organization, index) => ({
            tenantId: key.tenantId,
            environment: key.environment,
            apiVersion: key.apiVersion,
            organizationId: organization.id,
            catalogOrder: i + index,
            name: organization.names.fi ?? Object.values(organization.names)[0] ?? organization.id,
            normalizedName: [
              ...Object.values(organization.names),
              ...Object.values(organization.alternativeNames ?? {}),
            ]
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
