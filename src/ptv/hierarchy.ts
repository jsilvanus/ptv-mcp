import type { Organization, PtvContentId } from './domain.js';

/**
 * An organisation followed by its ancestors, nearest first, as
 * `PtvAdapter.getOrganisationHierarchy` returns them. Stops at the first
 * parent that can't be read; `[]` when `id` itself can't.
 */
export async function walkOrganisationHierarchy(
  getOrganisation: (id: PtvContentId) => Promise<Organization | null>,
  id: PtvContentId,
): Promise<Organization[]> {
  const root = await getOrganisation(id);
  if (!root) return [];
  const hierarchy: Organization[] = [root];
  let current = root;
  while (current.parentOrganizationId) {
    const parent = await getOrganisation(current.parentOrganizationId);
    if (!parent) break;
    hierarchy.push(parent);
    current = parent;
  }
  return hierarchy;
}
