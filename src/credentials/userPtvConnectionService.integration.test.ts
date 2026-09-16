import { randomBytes, randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { createDatabase, type Database } from '../db/client.js';
import { withContext } from '../db/context.js';
import { users } from '../db/schema/index.js';
import { ConnectionNotFoundError, UserPtvConnectionService } from './userPtvConnectionService.js';

describe('UserPtvConnectionService', () => {
  const config = loadConfig();
  const db: Database = createDatabase(config.databaseUrl);
  const masterKey = randomBytes(32).toString('base64');
  const service = new UserPtvConnectionService(db, masterKey);
  const createdUserIds: string[] = [];

  afterEach(async () => {
    for (const id of createdUserIds) {
      await db.delete(users).where(eq(users.id, id));
    }
    createdUserIds.length = 0;
  });

  async function createUser(): Promise<string> {
    const id = randomUUID();
    await db
      .insert(users)
      .values({ id, email: `${id}@example.test`, name: 'Test', passwordHash: 'x' });
    createdUserIds.push(id);
    return id;
  }

  it('stores and decrypts an access token', async () => {
    const userId = await createUser();
    const expiresAt = new Date('2026-12-01T00:00:00Z');
    await service.storeConnection(userId, 'v11', 'production', 'real-access-token', expiresAt);

    const decrypted = await service.getDecryptedConnection(userId, 'v11', 'production');
    expect(decrypted.accessToken).toBe('real-access-token');
    expect(decrypted.tokenExpiresAt).toEqual(expiresAt);
  });

  it('does not store the plaintext token anywhere in the row', async () => {
    const userId = await createUser();
    await service.storeConnection(userId, 'v11', 'production', 'super-secret-token', null);

    const rows = await withContext(db, { userId }, async (tx) =>
      tx.execute<{ encrypted_access_token: string }>(
        sql`SELECT encrypted_access_token FROM user_ptv_connections WHERE user_id = ${userId}`,
      ),
    );
    expect(rows[0]?.encrypted_access_token).not.toContain('super-secret-token');
  });

  it('throws for a connection that does not exist', async () => {
    const userId = await createUser();
    await expect(service.getDecryptedConnection(userId, 'v11', 'production')).rejects.toThrow(
      ConnectionNotFoundError,
    );
  });

  it('treats a revoked connection as not found', async () => {
    const userId = await createUser();
    await service.storeConnection(userId, 'v11', 'production', 'token', null);
    await service.revokeConnection(userId, 'v11', 'production');

    await expect(service.getDecryptedConnection(userId, 'v11', 'production')).rejects.toThrow(
      ConnectionNotFoundError,
    );
  });

  it('reconnecting after revocation clears the revoked flag', async () => {
    const userId = await createUser();
    await service.storeConnection(userId, 'v11', 'production', 'first-token', null);
    await service.revokeConnection(userId, 'v11', 'production');
    await service.storeConnection(userId, 'v11', 'production', 'second-token', null);

    const decrypted = await service.getDecryptedConnection(userId, 'v11', 'production');
    expect(decrypted.accessToken).toBe('second-token');
  });

  it('lists connection status without exposing the token', async () => {
    const userId = await createUser();
    await service.storeConnection(userId, 'v11', 'production', 'token', null);

    const statuses = await service.listConnections(userId);
    expect(statuses).toHaveLength(1);
    expect(statuses[0]).not.toHaveProperty('accessToken');
    expect(statuses[0]?.apiVersion).toBe('v11');
  });

  it('is reusable across two different (simulated) tenants for the same user', async () => {
    // UserPtvConnection is user-scoped, not tenant-scoped (docs/ptv-v11-notes.md) —
    // storing once and reading it back doesn't depend on any tenant context at all.
    const userId = await createUser();
    await service.storeConnection(userId, 'v11', 'production', 'shared-token', null);

    const first = await service.getDecryptedConnection(userId, 'v11', 'production');
    const second = await service.getDecryptedConnection(userId, 'v11', 'production');
    expect(first.accessToken).toBe('shared-token');
    expect(second.accessToken).toBe('shared-token');
  });
});
