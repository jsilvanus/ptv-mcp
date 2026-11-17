import { describe, expect, it, vi } from 'vitest';
import type { Database } from '../db/client.js';
import { OAuthService, redirectUriError } from './oauthService.js';

function serviceWithFakeDb() {
  const execute = vi.fn<(statement: unknown) => Promise<unknown[]>>(async () => []);
  const service = new OAuthService(
    { execute } as unknown as Database,
    Buffer.alloc(32, 1).toString('base64'),
    'https://ptv.example.test',
    'https://ptv.example.test',
  );
  return { service, execute };
}

describe('redirectUriError', () => {
  it.each([
    'https://app.example.test/cb',
    'http://localhost:3000/cb',
    'http://127.0.0.1/cb',
    'http://[::1]:8080/cb',
    'cursor://anysphere.cursor/callback',
    'vscode://ext/callback',
  ])('accepts %s', (uri) => {
    expect(redirectUriError(uri)).toBeNull();
  });

  it.each([
    ['javascript:alert(1)', 'scheme'],
    ['data:text/html,hi', 'scheme'],
    ['file:///etc/passwd', 'scheme'],
    ['vbscript:msgbox', 'scheme'],
    ['blob:https://x.test/id', 'scheme'],
    ['http://example.test/cb', 'localhost'],
    ['https://app.example.test/cb#frag', 'fragment'],
    ['not a url', 'absolute'],
    [42, 'strings'],
    [`https://x.test/${'a'.repeat(2000)}`, 'at most'],
  ])('refuses %s', (uri, reason) => {
    const error = redirectUriError(uri);
    expect(error).toEqual(expect.any(String));
    expect(error).toContain(reason);
  });
});

describe('OAuthService.registerClient', () => {
  it('mints its own client id, ignoring a client_id in the metadata', async () => {
    const { service, execute } = serviceWithFakeDb();
    const result = await service.registerClient({
      client_id: 'urn:ptv-mcp:existing-client',
      client_name: '  Editor  ',
      redirect_uris: ['https://app.example.test/cb'],
    });
    expect(result.client_id).toMatch(/^urn:ptv-mcp:client:[0-9a-f-]{36}$/);
    expect(result.client_id).not.toBe('urn:ptv-mcp:existing-client');
    expect(result.client_name).toBe('Editor');
    expect(execute).toHaveBeenCalledTimes(1);
    const statement = JSON.stringify(execute.mock.calls[0]?.[0]);
    expect(statement).toContain('INSERT INTO oauth_clients');
    expect(statement).not.toContain('ON CONFLICT');
  });

  it('cuts client_name to 200 characters', async () => {
    const { service } = serviceWithFakeDb();
    const result = await service.registerClient({
      client_name: 'x'.repeat(300),
      redirect_uris: ['https://app.example.test/cb'],
    });
    expect(result.client_name).toHaveLength(200);
  });

  it('rejects empty, over-long and unsafe redirect_uris before touching the database', async () => {
    const { service, execute } = serviceWithFakeDb();
    await expect(service.registerClient({ redirect_uris: [] })).rejects.toThrow(
      'redirect_uris is required',
    );
    await expect(
      service.registerClient({
        redirect_uris: Array.from({ length: 11 }, (_, i) => `https://a${i}.test/cb`),
      }),
    ).rejects.toThrow('at most 10 entries');
    await expect(
      service.registerClient({ redirect_uris: ['javascript:alert(1)'] }),
    ).rejects.toThrow('javascript');
    expect(execute).not.toHaveBeenCalled();
  });
});
