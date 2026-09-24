import { randomUUID } from 'node:crypto';
import { like } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { createDatabase } from './client.js';
import { PtvCodeNameCacheService } from './ptvCodeNameCacheService.js';
import { ptvCodeNameCache } from './schema/index.js';

/**
 * Runs as the runtime app role (`ptv_mcp_app`) to prove the migration's
 * explicit GRANT is enough — the table has no RLS and no tenant context.
 */
describe('PtvCodeNameCacheService', () => {
  const config = loadConfig();
  const asApp = createDatabase(
    config.databaseUrl.replace(/:\/\/[^:]+:[^@]+@/, '://ptv_mcp_app:ptv_mcp_app_dev@'),
  );
  const service = new PtvCodeNameCacheService(asApp);
  const prefix = `test-${randomUUID()}-`;

  afterAll(async () => {
    await asApp.delete(ptvCodeNameCache).where(like(ptvCodeNameCache.key, `${prefix}%`));
  });

  it('saves, upserts and loads unexpired rows only', async () => {
    const future = Date.now() + 60_000;
    await service.save([
      {
        environment: 'test',
        kind: 'ontologyTerms',
        key: `${prefix}a`,
        entry: { names: {} },
        expiresAt: future,
      },
      {
        environment: 'test',
        kind: 'ontologyTerms',
        key: `${prefix}expired`,
        entry: { names: {} },
        expiresAt: Date.now() - 1_000,
      },
    ]);
    // Same key twice in one save, and again later: last write wins.
    await service.save([
      {
        environment: 'test',
        kind: 'ontologyTerms',
        key: `${prefix}a`,
        entry: { names: { fi: 'vanha' } },
        expiresAt: future,
      },
      {
        environment: 'test',
        kind: 'ontologyTerms',
        key: `${prefix}a`,
        entry: { uri: `${prefix}a`, names: { fi: 'kaste' } },
        expiresAt: future,
      },
    ]);

    const rows = await service.load('test', 'ontologyTerms', [
      `${prefix}a`,
      `${prefix}expired`,
      `${prefix}missing`,
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      key: `${prefix}a`,
      entry: { uri: `${prefix}a`, names: { fi: 'kaste' } },
    });
    expect(Math.abs(rows[0]!.expiresAt - future)).toBeLessThan(1_000);

    // Keyed by environment and kind as well.
    expect(await service.load('production', 'ontologyTerms', [`${prefix}a`])).toEqual([]);
    expect(await service.load('test', 'serviceClasses', [`${prefix}a`])).toEqual([]);
  });
});
