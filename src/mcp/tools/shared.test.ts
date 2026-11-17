import { describe, expect, it } from 'vitest';
import { GrantScopeError } from '../toolContext.js';
import { resourceToolContext, type Extra } from './shared.js';

/** An MCP request's `extra` as httpTransport.ts builds it from a verified token. */
function extraWith(claims: {
  userId?: string;
  tenantId?: string;
  environment?: string;
  readApiVersion?: string;
  writeApiVersion?: string;
}): Extra {
  return {
    authInfo: {
      token: 'token',
      clientId: 'client',
      scopes: ['mcp'],
      extra: { userId: 'user-1', readApiVersion: 'v11', ...claims },
    },
  } as unknown as Extra;
}

const grant = { tenantId: 'tenant-a', environment: 'test' };

describe('resourceToolContext', () => {
  it('builds the context when the URI names the organisation and environment the token grants', () => {
    const ctx = resourceToolContext(
      extraWith({ ...grant, writeApiVersion: 'v11' }),
      'tenant-a',
      'test',
    );

    expect(ctx).toEqual({
      tenantId: 'tenant-a',
      environment: 'test',
      readApiVersion: 'v11',
      writeApiVersion: 'v11',
      actingUserId: 'user-1',
    });
  });

  it('refuses a URI naming another organisation than the token grants', () => {
    expect(() => resourceToolContext(extraWith(grant), 'tenant-b', 'test')).toThrow(
      GrantScopeError,
    );
    expect(() => resourceToolContext(extraWith(grant), 'tenant-b', 'test')).toThrow(
      'This connection is authorised for organisation tenant-a; the resource belongs to tenant-b.',
    );
  });

  it('refuses a URI naming another environment than the token grants', () => {
    expect(() => resourceToolContext(extraWith(grant), 'tenant-a', 'production')).toThrow(
      'This connection is authorised for test; the resource is in production.',
    );
  });

  it('refuses every organisation resource on a connection with no organisation', () => {
    const publicConnection = extraWith({ environment: 'test' });

    expect(() => resourceToolContext(publicConnection, 'tenant-a', 'test')).toThrow(
      GrantScopeError,
    );
    expect(() => resourceToolContext(publicConnection, '', 'test')).toThrow(GrantScopeError);
  });

  it('still rejects a malformed environment in the URI', () => {
    expect(() => resourceToolContext(extraWith(grant), 'tenant-a', 'staging')).toThrow(
      'Invalid PTV environment in resource URI: staging',
    );
  });
});
