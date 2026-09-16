import { describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';

describe('GET /health', () => {
  it('returns ok status', async () => {
    const app = await buildApp({
      config: {
        logLevel: 'silent',
        nodeEnv: 'test',
        databaseUrl: 'postgres://ptv_mcp:ptv_mcp_dev@localhost:5432/ptv_mcp_dev',
        jwtSecret: 'test-jwt-secret-not-used-by-this-test',
        masterEncryptionKey: 'dGVzdC1tYXN0ZXIta2V5LTMyLWJ5dGVzLWxvbmchISE=',
        ptvV11OAuthClientId: '',
        ptvV11OAuthClientSecret: '',
        ptvV11OAuthRedirectUri: '',
      },
    });

    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });

    await app.close();
  });
});
