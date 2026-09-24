import { describe, expect, it } from 'vitest';
import { CodeNameCache, type CodeNameStore, type StoredCodeName } from './codeNameCache.js';

describe('CodeNameCache with a store', () => {
  function memoryStore(initial: StoredCodeName[] = []) {
    const rows = [...initial];
    const loads: string[][] = [];
    const store: CodeNameStore = {
      load: async (environment, kind, keys) => {
        loads.push(keys);
        return rows.filter(
          (row) => row.environment === environment && row.kind === kind && keys.includes(row.key),
        );
      },
      save: async (saved) => {
        rows.push(...saved);
      },
    };
    return { rows, loads, store };
  }

  it('primes only keys that are not already in memory', async () => {
    const now = 1_000;
    const { loads, store } = memoryStore([
      {
        environment: 'test',
        kind: 'serviceClasses',
        key: 'P1',
        entry: { code: 'P1', names: { fi: 'Yksi' } },
        expiresAt: now + 10,
      },
    ]);
    const cache = new CodeNameCache(100, () => now, store);
    cache.set('test', 'serviceClasses', 'P2', { code: 'P2', names: {} });

    await cache.prime('test', 'serviceClasses', ['P1', 'P2', 'P1']);

    expect(loads).toEqual([['P1']]);
    expect(cache.get('test', 'serviceClasses', 'P1')?.names).toEqual({ fi: 'Yksi' });
  });

  it('keeps the stored expiry and ignores expired rows', async () => {
    let now = 1_000;
    const { store } = memoryStore([
      {
        environment: 'test',
        kind: 'lifeEvents',
        key: 'KE1',
        entry: { code: 'KE1', names: {} },
        expiresAt: 1_050,
      },
      {
        environment: 'test',
        kind: 'lifeEvents',
        key: 'KE2',
        entry: { code: 'KE2', names: {} },
        expiresAt: 900,
      },
    ]);
    const cache = new CodeNameCache(100_000, () => now, store);
    await cache.prime('test', 'lifeEvents', ['KE1', 'KE2']);
    expect(cache.get('test', 'lifeEvents', 'KE1')).toBeDefined();
    expect(cache.get('test', 'lifeEvents', 'KE2')).toBeUndefined();
    now = 1_050;
    expect(cache.get('test', 'lifeEvents', 'KE1')).toBeUndefined();
  });

  it('writes entries through on flush, once', async () => {
    const { rows, store } = memoryStore();
    const cache = new CodeNameCache(100, () => 5, store);
    cache.set('production', 'targetGroups', 'KR1', { code: 'KR1', names: { fi: 'Kansalaiset' } });
    await cache.flush();
    await cache.flush();
    expect(rows).toEqual([
      {
        environment: 'production',
        kind: 'targetGroups',
        key: 'KR1',
        entry: { code: 'KR1', names: { fi: 'Kansalaiset' } },
        expiresAt: 105,
      },
    ]);
  });
});
