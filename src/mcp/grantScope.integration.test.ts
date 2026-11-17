import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';
import { createDatabase, type Database } from '../db/client.js';
import { inMemoryV11Factory, validService } from '../ptv/testing/fixtures.js';
import { IntegrationFixtures } from '../testing/integrationFixtures.js';
import { injectToolCall } from '../testing/mcpClient.js';

const SCOPED_SERVICE = validService({
  id: 'grant-scope-service',
  organizationId: 'grant-org',
  names: { fi: 'Grant scope service' },
  modifiedAt: '2026-09-16T00:00:00Z',
});

const CLIENT_ID = 'urn:ptv-mcp:test-client';

/**
 * An MCP connection's environment is a boundary: a token for one environment
 * may not act on a proposal from the other (ptv_resolve_proposal and
 * ptv_confirm_manual_publish), while the web UI (REST, login session) still
 * resolves a proposal in its own environment.
 */
describe('MCP grant scope for proposals', () => {
  const config = loadConfig();
  const db: Database = createDatabase(config.databaseUrl);
  const fixtures = new IntegrationFixtures(db, config);
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({
      config: { ...config, logLevel: 'silent' },
      db,
      adapterFactories: {
        v11: inMemoryV11Factory(() => ({ services: [{ ...SCOPED_SERVICE }] })),
      },
    });
  });

  afterAll(async () => {
    await app.close();
  });

  afterEach(() => fixtures.cleanup());

  /**
   * A tenant with v11 configured in both environments, a contributor who
   * proposes and an approver who resolves, and one production proposal.
   */
  async function setUp() {
    const proposerId = await fixtures.user('Proposer');
    const approverId = await fixtures.user('Approver');
    const approverWebToken = await fixtures.webToken(approverId);
    const tenantId = await fixtures.tenant({ name: 'Grant scope tenant', slugPrefix: 'gs' });
    await fixtures.configureV11(tenantId, false);
    await fixtures.adapterConfigs.upsert(tenantId, 'production', 'v11', {
      authMode: 'oauth2',
      credentialScope: 'user',
      supportsRead: true,
      supportsWrite: false,
      supportsDraftRead: false,
    });
    await fixtures.addMembership(tenantId, proposerId, 'contributor');
    await fixtures.addMembership(tenantId, approverId, 'approver');

    const productionProposer = await oauthToken(proposerId, tenantId, 'production');
    const proposed = await injectToolCall(app, productionProposer, 'ptv_propose_changes', {
      serviceId: SCOPED_SERVICE.id,
      changes: { names: { fi: 'Tuotannon nimi' } },
    });
    expect(proposed.statusCode).toBe(200);

    const list = await app.inject({
      method: 'GET',
      url: `/tenants/${tenantId}/proposals?status=pending`,
      headers: { authorization: 'Bearer ' + approverWebToken },
    });
    const [proposal] = list.json() as Array<{ id: string; environment: string }>;
    expect(proposal?.environment).toBe('production');
    return {
      tenantId,
      approverId,
      approverWebToken,
      proposalId: proposal!.id,
    };
  }

  const oauthToken = (userId: string, tenantId: string, environment: 'test' | 'production') =>
    fixtures.oauth.issueAccessToken(userId, CLIENT_ID, 'mcp', tenantId, environment, 'v11', 'v11');

  const proposalStatus = async (
    tenantId: string,
    proposalId: string,
    webToken: string,
  ): Promise<string> => {
    const res = await app.inject({
      method: 'GET',
      url: `/tenants/${tenantId}/proposals/${proposalId}`,
      headers: { authorization: 'Bearer ' + webToken },
    });
    return (res.json() as { status: string }).status;
  };

  it('refuses MCP resolve and confirm from a test connection, and accepts them from a production one', async () => {
    const { tenantId, approverId, approverWebToken, proposalId } = await setUp();
    const testApprover = await oauthToken(approverId, tenantId, 'test');
    const productionApprover = await oauthToken(approverId, tenantId, 'production');

    const refusedResolve = await injectToolCall(app, testApprover, 'ptv_resolve_proposal', {
      proposalId,
      action: 'approve_and_export',
    });
    expect(refusedResolve.result.isError).toBe(true);
    expect(refusedResolve.result.content[0]?.text).toBe(
      'This connection is authorised for test; the proposal belongs to production. Reconnect for that environment.',
    );
    expect(await proposalStatus(tenantId, proposalId, approverWebToken)).toBe('pending');

    const resolved = await injectToolCall(app, productionApprover, 'ptv_resolve_proposal', {
      proposalId,
      action: 'approve_and_export',
    });
    expect(resolved.result.isError).not.toBe(true);
    expect(resolved.data).toMatchObject({ id: proposalId, status: 'approved' });

    const refusedConfirm = await injectToolCall(app, testApprover, 'ptv_confirm_manual_publish', {
      proposalId,
    });
    expect(refusedConfirm.result.isError).toBe(true);
    expect(refusedConfirm.result.content[0]?.text).toContain(
      'This connection is authorised for test; the proposal belongs to production.',
    );
    expect(await proposalStatus(tenantId, proposalId, approverWebToken)).toBe('approved');
  });

  it('still lets the web UI resolve a production proposal from its default (test) query context', async () => {
    const { tenantId, approverWebToken, proposalId } = await setUp();

    const resolved = await app.inject({
      method: 'POST',
      url: `/tenants/${tenantId}/proposals/${proposalId}/resolve`,
      headers: { authorization: 'Bearer ' + approverWebToken },
      payload: { action: 'approve_and_export' },
    });

    expect(resolved.statusCode).toBe(200);
    expect(resolved.json()).toMatchObject({
      id: proposalId,
      status: 'approved',
      environment: 'production',
    });
  });
});
