import { beforeAll, describe, expect, it } from 'vitest';
import { OntologySearchUnsupportedError, type PtvAdapter } from '../adapter.js';
import type { PtvContentId } from '../domain.js';

export interface PtvAdapterContractFixtures {
  knownServiceId: PtvContentId;
  knownChannelId: PtvContentId;
  knownOrganizationId: PtvContentId;
  /** An id guaranteed not to exist for this adapter's backing data. */
  unknownId: PtvContentId;
  /** A code list name this adapter is expected to serve at least one entry for. */
  knownCodeListName: string;
}

/**
 * The behavioral contract every PtvAdapter implementation must satisfy,
 * regardless of which PTV API version it wraps. Run against the
 * InMemoryPtvAdapter fake to validate the suite itself (Phase 1), and
 * against each real adapter once built (Phase 2) — a passing run here is
 * what "the adapter is safe to put behind PtvAdapterRegistry" means.
 *
 * Deliberately does not assert exact field values from fixture data
 * (different adapters' fixtures will differ) — only structural and
 * behavioral guarantees that PtvAdapterRegistry's callers (Phase 3+) rely
 * on: correct shapes, correct null/not-found handling, and capabilities
 * being internally consistent.
 */
export function runPtvAdapterContractTests(
  adapterName: string,
  createAdapter: () => PtvAdapter | Promise<PtvAdapter>,
  fixtures: PtvAdapterContractFixtures,
): void {
  describe(`PtvAdapter contract: ${adapterName}`, () => {
    let adapter: PtvAdapter;

    beforeAll(async () => {
      adapter = await createAdapter();
    });

    it('reports capabilities with a non-empty apiVersion and environment', () => {
      const capabilities = adapter.getCapabilities();
      expect(capabilities.apiVersion.length).toBeGreaterThan(0);
      expect(['test', 'production']).toContain(capabilities.environment);
      expect(['tenant', 'user']).toContain(capabilities.credentialScope);
    });

    it('getService returns null for an unknown id', async () => {
      await expect(adapter.getService(fixtures.unknownId)).resolves.toBeNull();
    });

    it('getService returns a service whose id matches the request', async () => {
      const service = await adapter.getService(fixtures.knownServiceId);
      expect(service).not.toBeNull();
      expect(service?.id).toBe(fixtures.knownServiceId);
    });

    it('searchServices returns a well-formed paginated result', async () => {
      const result = await adapter.searchServices({ page: 1, pageSize: 10 });
      expect(result.page).toBe(1);
      expect(result.pageSize).toBe(10);
      expect(Array.isArray(result.items)).toBe(true);
      expect(result.items.length).toBeLessThanOrEqual(result.pageSize);
      expect(result.totalCount).toBeGreaterThanOrEqual(result.items.length);
    });

    it('getChannel returns null for an unknown id and a match for a known one', async () => {
      await expect(adapter.getChannel(fixtures.unknownId)).resolves.toBeNull();
      const channel = await adapter.getChannel(fixtures.knownChannelId);
      expect(channel?.id).toBe(fixtures.knownChannelId);
    });

    it('searchChannels returns a well-formed paginated result', async () => {
      const result = await adapter.searchChannels({ page: 1, pageSize: 10 });
      expect(Array.isArray(result.items)).toBe(true);
      expect(result.items.length).toBeLessThanOrEqual(result.pageSize);
    });

    it('getOrganisation returns null for an unknown id and a match for a known one', async () => {
      await expect(adapter.getOrganisation(fixtures.unknownId)).resolves.toBeNull();
      const org = await adapter.getOrganisation(fixtures.knownOrganizationId);
      expect(org?.id).toBe(fixtures.knownOrganizationId);
    });

    it('getOrganisationHierarchy includes the requested organisation itself', async () => {
      const hierarchy = await adapter.getOrganisationHierarchy(fixtures.knownOrganizationId);
      expect(hierarchy.some((o) => o.id === fixtures.knownOrganizationId)).toBe(true);
    });

    it('searchServiceCollections returns a well-formed paginated result', async () => {
      const result = await adapter.searchServiceCollections({ page: 1, pageSize: 10 });
      expect(Array.isArray(result.items)).toBe(true);
    });

    it('searchGeneralDescriptions returns a well-formed paginated result', async () => {
      const result = await adapter.searchGeneralDescriptions({ page: 1, pageSize: 10 });
      expect(Array.isArray(result.items)).toBe(true);
    });

    it('getConnectionsFor returns an array, even when there are none', async () => {
      const connections = await adapter.getConnectionsFor(fixtures.unknownId);
      expect(Array.isArray(connections)).toBe(true);
    });

    it('listCodes returns at least one entry for a known code list', async () => {
      const codes = await adapter.listCodes(fixtures.knownCodeListName);
      expect(codes.length).toBeGreaterThan(0);
    });

    it('searchOntologyTerms returns a paginated result or reports it is unsupported', async () => {
      try {
        const result = await adapter.searchOntologyTerms({ query: 'a', page: 1, pageSize: 5 });
        expect(Array.isArray(result.items)).toBe(true);
        expect(result.items.length).toBeLessThanOrEqual(5);
        expect(typeof result.totalCount).toBe('number');
      } catch (err) {
        expect(err).toBeInstanceOf(OntologySearchUnsupportedError);
      }
    });

    it('applyServiceChange respects its own declared write capability', async () => {
      const capabilities = adapter.getCapabilities();
      const attempt = adapter.applyServiceChange({
        serviceId: fixtures.knownServiceId,
        changes: {},
      });

      if (capabilities.supportsWrite) {
        await expect(attempt).resolves.toMatchObject({ serviceId: fixtures.knownServiceId });
      } else {
        await expect(attempt).rejects.toThrow();
      }
    });

    it('createService refuses to write when the adapter declares no write capability', async () => {
      if (adapter.getCapabilities().supportsWrite) return;
      await expect(
        adapter.createService({
          organizationId: 'org',
          serviceType: 'Service',
          publishingStatus: 'Draft',
          names: { fi: 'x' },
          summaries: {},
          descriptions: {},
          serviceClasses: [],
          ontologyTerms: [],
          targetGroups: [],
          lifeEvents: [],
          industrialClasses: [],
          languages: ['fi'],
          serviceChannelIds: [],
        }),
      ).rejects.toThrow();
    });
  });
}
