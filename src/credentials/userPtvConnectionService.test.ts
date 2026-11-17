import { randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '../db/client.js';
import { envelopeEncrypt, serializeBlob } from '../security/envelopeEncryption.js';
import { ConnectionNotFoundError, UserPtvConnectionService } from './userPtvConnectionService.js';

const fake = vi.hoisted(() => ({
  row: undefined as Record<string, unknown> | undefined,
}));

// Stands in for the RLS-scoped transaction: the lookup returns the fake row.
vi.mock('../db/context.js', () => ({
  withContext: async (_db: unknown, _ctx: unknown, fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      query: {
        userPtvConnections: {
          findFirst: async () => fake.row,
        },
      },
    }),
}));

const MASTER_KEY = randomBytes(32).toString('base64');
const USER_ID = '22222222-2222-4222-8222-222222222222';
const TOKEN = 'access-token-value';

function rowWith(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  const { encrypted, encryptedDataKey } = envelopeEncrypt(MASTER_KEY, TOKEN);
  return {
    userId: USER_ID,
    apiVersion: 'v11',
    environment: 'test',
    encryptedAccessToken: serializeBlob(encrypted),
    encryptedDataKey: serializeBlob(encryptedDataKey),
    tokenExpiresAt: new Date(Date.now() + 3600_000),
    revokedAt: null,
    ...overrides,
  };
}

describe('UserPtvConnectionService.getDecryptedConnection', () => {
  let service: UserPtvConnectionService;

  beforeEach(() => {
    service = new UserPtvConnectionService({} as Database, MASTER_KEY);
  });

  it('returns the decrypted token while it is unexpired', async () => {
    fake.row = rowWith();
    await expect(service.getDecryptedConnection(USER_ID, 'v11', 'test')).resolves.toMatchObject({
      accessToken: TOKEN,
    });
  });

  it('treats an expired token as no connection', async () => {
    fake.row = rowWith({ tokenExpiresAt: new Date(Date.now() - 60_000) });
    await expect(service.getDecryptedConnection(USER_ID, 'v11', 'test')).rejects.toBeInstanceOf(
      ConnectionNotFoundError,
    );
  });

  it('treats a revoked token as no connection', async () => {
    fake.row = rowWith({ revokedAt: new Date() });
    await expect(service.getDecryptedConnection(USER_ID, 'v11', 'test')).rejects.toBeInstanceOf(
      ConnectionNotFoundError,
    );
  });

  it('treats a missing row as no connection', async () => {
    fake.row = undefined;
    await expect(service.getDecryptedConnection(USER_ID, 'v11', 'test')).rejects.toBeInstanceOf(
      ConnectionNotFoundError,
    );
  });

  it('does not treat a connection without a reported expiry as expired', async () => {
    fake.row = rowWith({ tokenExpiresAt: null });
    await expect(service.getDecryptedConnection(USER_ID, 'v11', 'test')).resolves.toMatchObject({
      accessToken: TOKEN,
      tokenExpiresAt: null,
    });
  });
});
