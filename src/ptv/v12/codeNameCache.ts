import type { PtvEnvironment } from '../adapter.js';
import type { CodeListEntry } from '../domain.js';

/**
 * v12 services and general descriptions reference classification codes
 * (service classes, target groups, life events, industrial classes,
 * ontology terms) by code or URI only, without names. Names (and the
 * matching code/URI) live in the reference-data endpoints, which change
 * rarely, so resolved entries are
 * cached with a long TTL. Adapter instances are created per request, so
 * the cache lives outside them: in memory for the process, optionally
 * backed by a `CodeNameStore` (Postgres in production, see
 * src/db/ptvCodeNameCacheService.ts) so it survives restarts and
 * redeploys.
 */

export type CodeListKind =
  'serviceClasses' | 'targetGroups' | 'lifeEvents' | 'industrialClasses' | 'ontologyTerms';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Classification vocabularies (ontology terms included) change very rarely. */
export const DEFAULT_CODE_NAME_TTL_MS = 30 * DAY_MS;

/**
 * Codes PTV didn't recognise are remembered for a shorter time, so a code
 * added to a vocabulary later gets its name within a day.
 */
export const MISSING_CODE_NAME_TTL_MS = DAY_MS;

export interface StoredCodeName {
  environment: PtvEnvironment;
  kind: CodeListKind;
  key: string;
  entry: CodeListEntry;
  /** Epoch milliseconds. */
  expiresAt: number;
}

/** Durable second level behind the in-memory cache. */
export interface CodeNameStore {
  /** Unexpired rows for the given keys; keys with no row are simply absent. */
  load(environment: PtvEnvironment, kind: CodeListKind, keys: string[]): Promise<StoredCodeName[]>;
  save(rows: StoredCodeName[]): Promise<void>;
}

interface CacheEntry {
  entry: CodeListEntry;
  expiresAt: number;
}

export class CodeNameCache {
  private readonly entries = new Map<string, CacheEntry>();
  private pending: StoredCodeName[] = [];

  constructor(
    private readonly ttlMs = DEFAULT_CODE_NAME_TTL_MS,
    private readonly now: () => number = Date.now,
    private readonly store?: CodeNameStore,
  ) {}

  /**
   * Load from the store any of `keys` not already in memory. Store
   * failures are swallowed: the cache is an optimisation, and the caller
   * falls back to fetching from PTV.
   */
  async prime(environment: PtvEnvironment, kind: CodeListKind, keys: string[]): Promise<void> {
    if (!this.store) return;
    const absent = [...new Set(keys)].filter((key) => !this.get(environment, kind, key));
    if (absent.length === 0) return;
    try {
      const rows = await this.store.load(environment, kind, absent);
      const now = this.now();
      for (const row of rows) {
        if (row.expiresAt > now) {
          this.entries.set(keyOf(environment, kind, row.key), {
            entry: row.entry,
            expiresAt: row.expiresAt,
          });
        }
      }
    } catch {
      // Treat as a store miss.
    }
  }

  /** Write entries `set` since the last flush through to the store. */
  async flush(): Promise<void> {
    if (!this.store || this.pending.length === 0) return;
    const rows = this.pending;
    this.pending = [];
    try {
      await this.store.save(rows);
    } catch {
      // Still cached in memory; the next process re-fetches from PTV.
    }
  }

  get(environment: PtvEnvironment, kind: CodeListKind, key: string): CodeListEntry | undefined {
    const cacheKey = keyOf(environment, kind, key);
    const entry = this.entries.get(cacheKey);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(cacheKey);
      return undefined;
    }
    return entry.entry;
  }

  set(
    environment: PtvEnvironment,
    kind: CodeListKind,
    key: string,
    entry: CodeListEntry,
    ttlMs = this.ttlMs,
  ): void {
    const expiresAt = this.now() + ttlMs;
    this.entries.set(keyOf(environment, kind, key), { entry, expiresAt });
    if (this.store) this.pending.push({ environment, kind, key, entry, expiresAt });
  }

  /** Clears the in-memory level only. */
  clear(): void {
    this.entries.clear();
    this.pending = [];
  }
}

function keyOf(environment: PtvEnvironment, kind: CodeListKind, key: string): string {
  return `${environment}\u0000${kind}\u0000${key}`;
}

/**
 * Memory-only default for adapters constructed without a cache (tests,
 * scripts); the app passes a Postgres-backed one through the registry.
 */
export const sharedCodeNameCache = new CodeNameCache();
