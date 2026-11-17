import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { loadConfig } from '../config.js';
import { createDatabase, type Database } from '../db/client.js';

/**
 * Dynamic client registration: every client id is server-minted, and a
 * registration can never replace an existing client's redirect URIs.
 * Needs a live PostgreSQL (npm run test:integration).
 */
describe('OAuth dynamic client registration', () => {
  const config = loadConfig();
  const db: Database = createDatabase(config.databaseUrl);
  const createdIds: string[] = [];
  let app: FastifyInstance;

  const REDIRECT = 'https://registration-test.example.test/callback';

  beforeAll(async () => {
    app = await buildApp({ config: { ...config, logLevel: 'silent' }, db });
  });

  afterAll(async () => {
    for (const clientId of createdIds) {
      await db.execute(sql`DELETE FROM oauth_clients WHERE client_id = ${clientId}`);
    }
    await app.close();
  });

  function register(payload: Record<string, unknown>) {
    return app.inject({ method: 'POST', url: '/oauth/register', payload });
  }

  async function registerOk(payload: Record<string, unknown>): Promise<string> {
    const response = await register(payload);
    expect(response.statusCode).toBe(201);
    const clientId = (response.json() as { client_id: string }).client_id;
    createdIds.push(clientId);
    return clientId;
  }

  function authorize(clientId: string, redirectUri: string) {
    return app.inject({
      method: 'GET',
      url: `/oauth/authorize?${new URLSearchParams({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: redirectUri,
        code_challenge: 'x',
        code_challenge_method: 'S256',
      }).toString()}`,
    });
  }

  it('ignores a client_id in the body and returns a server-minted id', async () => {
    const requested = 'urn:ptv-mcp:chosen-by-attacker';
    const clientId = await registerOk({
      client_id: requested,
      client_name: 'Requested Id Client',
      redirect_uris: [REDIRECT],
    });
    expect(clientId).toMatch(/^urn:ptv-mcp:client:[0-9a-f-]{36}$/);
    expect(clientId).not.toBe(requested);
  });

  it('never updates an existing client: a second registration gets a new id and the first keeps its redirect URIs', async () => {
    const first = await registerOk({ client_name: 'First Client', redirect_uris: [REDIRECT] });
    const second = await registerOk({
      client_name: 'Second Client',
      redirect_uris: ['https://attacker.example.test/steal'],
    });
    expect(second).not.toBe(first);

    const stillOk = await authorize(first, REDIRECT);
    expect(stillOk.statusCode).toBe(200);
    expect(stillOk.body).toContain('First Client');

    const hijacked = await authorize(first, 'https://attacker.example.test/steal');
    expect(hijacked.statusCode).toBe(400);
  });

  it('refuses a javascript: redirect URI with 400', async () => {
    const response = await register({ redirect_uris: ['javascript:alert(1)'] });
    expect(response.statusCode).toBe(400);
  });

  it('accepts a custom app scheme redirect URI', async () => {
    const clientId = await registerOk({
      client_name: 'Custom Scheme Client',
      redirect_uris: ['cursor://anysphere.cursor/callback'],
    });
    const page = await authorize(clientId, 'cursor://anysphere.cursor/callback');
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('Custom Scheme Client');
    expect(page.body).toContain('anysphere.cursor');
  });

  it('shows the client name on the sign-in page, escaped', async () => {
    const clientId = await registerOk({
      client_name: '<b>Notes</b> & Co',
      redirect_uris: [REDIRECT],
    });
    const page = await authorize(clientId, REDIRECT);
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('Application: <strong>&lt;b&gt;Notes&lt;/b&gt; &amp; Co</strong>');
    expect(page.body).toContain('registration-test.example.test');
  });
});
