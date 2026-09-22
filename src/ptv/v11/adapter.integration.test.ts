import { runPtvAdapterContractTests } from '../testing/contractTests.js';
import { PtvV11Adapter } from './adapter.js';

/**
 * Runs the Phase 1 contract test suite against a real PtvV11Adapter
 * hitting PTV's live v11 **test** environment — this is Phase 2's stated
 * sync point ("the Phase 1 contract test suite passes against
 * PtvV11Adapter for all read operations"), not a mock.
 *
 * Fixture ids below were fetched directly from
 * https://api.palvelutietovaranto.trn.suomi.fi on 2026-09-16 and are real
 * published records in PTV's test environment. If PTV's test data is ever
 * reset/changed, this test's fixtures may need updating — that's an
 * accepted trade-off of testing against a live third-party environment
 * rather than a mock, in exchange for actually proving the wire mapping
 * works against real responses, not just our own assumptions about them.
 *
 * Write is not exercised here — that requires a real per-user OAuth
 * token, which isn't available in an automated test run (see
 * docs/ptv-v11-notes.md's consent-flow design). This adapter instance is
 * therefore read-only (`canWrite: false`), matching how it would behave
 * for a tenant that hasn't connected a PTV account yet.
 */
runPtvAdapterContractTests(
  'PtvV11Adapter (live test environment, read-only)',
  () => new PtvV11Adapter({ environment: 'test' }),
  {
    knownServiceId: 'af60add0-c3be-40f6-9c22-3e29c2b8da0a',
    knownChannelId: 'd753f50d-8d75-47c2-aa65-bff4c662744d',
    knownOrganizationId: '011154df-3726-461e-ae9c-a1182d1746de',
    // Not the all-zero GUID: PTV v11 treats that as invalid input and
    // returns 500, not 404 (confirmed live) — a genuinely random,
    // well-formed, nonexistent id is what correctly gets a clean 404.
    unknownId: '11111111-2222-3333-4444-555555555555',
    knownCodeListName: 'languages',
  },
);

describe('PTV v11 organization service regression', () => {
  it('returns Riihimäen kaupungin services without an oversized Service/list URL', async () => {
    const organizationId = '47e05190-11d1-435d-a657-c7dccbd91603';
    const adapter = new PtvV11Adapter({ environment: 'production' });

    const organization = await adapter.getOrganisation(organizationId);
    expect(
      Object.values(organization?.names ?? {}).some((name) =>
        name?.includes('Riihimäen kaupunki'),
      ),
    ).toBe(true);

    const result = await adapter.searchServices({
      organizationId,
      page: 1,
      pageSize: 1000,
    });

    expect(result.items.length).toBeGreaterThan(0);
    expect(result.items.every((service) => service.organizationId === organizationId)).toBe(true);
  });
});
