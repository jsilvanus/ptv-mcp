import type { PtvAdapter } from '../ptv/adapter.js';
import type { GeneralDescription, PtvContentId } from '../ptv/domain.js';

/**
 * The general description a service links to, for the Q-GD-1 copy check.
 * A failed or unsupported read leaves the check out rather than failing
 * the caller. Pass `cache` when checking many services: they often share
 * a general description.
 */
export async function loadGeneralDescription(
  adapter: Pick<PtvAdapter, 'getGeneralDescription'>,
  id: PtvContentId | undefined,
  cache?: Map<PtvContentId, Promise<GeneralDescription | null>>,
): Promise<GeneralDescription | undefined> {
  if (!id) return undefined;
  let pending = cache?.get(id);
  if (!pending) {
    pending = adapter.getGeneralDescription(id).catch(() => null);
    cache?.set(id, pending);
  }
  return (await pending) ?? undefined;
}
