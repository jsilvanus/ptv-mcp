import type { PtvEnvironment } from '../adapter.js';
import type { LocalizedText } from '../domain.js';

/**
 * v12 services and general descriptions reference classification codes
 * (service classes, target groups, life events, industrial classes,
 * ontology terms) by code or URI only, without names. Names live in the
 * reference-data endpoints, which change rarely, so resolved names are
 * cached process-wide with a long TTL. Adapter instances are created per
 * request, hence module-level storage rather than per-instance.
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

interface CacheEntry {
  names: LocalizedText;
  expiresAt: number;
}

export class CodeNameCache {
  private readonly entries = new Map<string, CacheEntry>();

  constructor(
    private readonly ttlMs = DEFAULT_CODE_NAME_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  get(environment: PtvEnvironment, kind: CodeListKind, key: string): LocalizedText | undefined {
    const cacheKey = keyOf(environment, kind, key);
    const entry = this.entries.get(cacheKey);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(cacheKey);
      return undefined;
    }
    return entry.names;
  }

  set(
    environment: PtvEnvironment,
    kind: CodeListKind,
    key: string,
    names: LocalizedText,
    ttlMs = this.ttlMs,
  ): void {
    this.entries.set(keyOf(environment, kind, key), {
      names,
      expiresAt: this.now() + ttlMs,
    });
  }

  clear(): void {
    this.entries.clear();
  }
}

function keyOf(environment: PtvEnvironment, kind: CodeListKind, key: string): string {
  return `${environment}\u0000${kind}\u0000${key}`;
}

/** Shared by every v12 adapter instance in this process. */
export const sharedCodeNameCache = new CodeNameCache();
