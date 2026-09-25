import { and, eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { withContext } from '../db/context.js';
import { userPtvConnections } from '../db/schema/index.js';
import {
  deserializeBlob,
  envelopeDecrypt,
  envelopeEncrypt,
  serializeBlob,
} from '../security/envelopeEncryption.js';

export type PtvEnvironment = 'test' | 'production';

export interface ConnectionStatus {
  apiVersion: string;
  environment: PtvEnvironment;
  connectedAt: Date;
  tokenExpiresAt: Date | null;
  lastValidatedAt: Date | null;
  revokedAt: Date | null;
}

export interface DecryptedConnection {
  accessToken: string;
  tokenExpiresAt: Date | null;
}

export class ConnectionNotFoundError extends Error {
  constructor() {
    super('No PTV connection found for this user/version/environment');
    this.name = 'ConnectionNotFoundError';
  }
}

/**
 * Envelope-encrypted storage for `UserPtvConnection` (Phase 3 Stream B) —
 * v11's per-user OAuth access token (docs/ptv-v11-notes.md). RLS-scoped by
 * `app.current_user_id`, not tenant: the same connection is reusable
 * across every tenant the user is a Publisher for.
 */
export class UserPtvConnectionService {
  constructor(
    private readonly db: Database,
    private readonly masterEncryptionKey: string,
  ) {}

  async storeConnection(
    userId: string,
    apiVersion: string,
    environment: PtvEnvironment,
    accessToken: string,
    tokenExpiresAt: Date | null,
  ): Promise<void> {
    const { encrypted, encryptedDataKey } = envelopeEncrypt(this.masterEncryptionKey, accessToken);
    await withContext(this.db, { userId }, async (tx) => {
      await tx
        .insert(userPtvConnections)
        .values({
          userId,
          apiVersion,
          environment,
          encryptedAccessToken: serializeBlob(encrypted),
          encryptedDataKey: serializeBlob(encryptedDataKey),
          tokenExpiresAt,
          revokedAt: null,
        })
        .onConflictDoUpdate({
          target: [
            userPtvConnections.userId,
            userPtvConnections.apiVersion,
            userPtvConnections.environment,
          ],
          set: {
            encryptedAccessToken: serializeBlob(encrypted),
            encryptedDataKey: serializeBlob(encryptedDataKey),
            tokenExpiresAt,
            connectedAt: new Date(),
            revokedAt: null,
            lastValidatedAt: null,
          },
        });
    });
  }

  async getDecryptedConnection(
    userId: string,
    apiVersion: string,
    environment: PtvEnvironment,
  ): Promise<DecryptedConnection> {
    const record = await withContext(this.db, { userId }, async (tx) =>
      tx.query.userPtvConnections.findFirst({
        where: and(
          eq(userPtvConnections.userId, userId),
          eq(userPtvConnections.apiVersion, apiVersion),
          eq(userPtvConnections.environment, environment),
        ),
      }),
    );
    if (!record || record.revokedAt !== null) {
      throw new ConnectionNotFoundError();
    }

    const accessToken = envelopeDecrypt(
      this.masterEncryptionKey,
      deserializeBlob(record.encryptedAccessToken),
      deserializeBlob(record.encryptedDataKey),
    );
    return { accessToken, tokenExpiresAt: record.tokenExpiresAt };
  }

  async listConnections(userId: string): Promise<ConnectionStatus[]> {
    const rows = await withContext(this.db, { userId }, async (tx) =>
      tx.query.userPtvConnections.findMany({ where: eq(userPtvConnections.userId, userId) }),
    );
    return rows.map((row) => ({
      apiVersion: row.apiVersion,
      environment: row.environment,
      connectedAt: row.connectedAt,
      tokenExpiresAt: row.tokenExpiresAt,
      lastValidatedAt: row.lastValidatedAt,
      revokedAt: row.revokedAt,
    }));
  }

  async revokeConnection(
    userId: string,
    apiVersion: string,
    environment: PtvEnvironment,
  ): Promise<void> {
    await withContext(this.db, { userId }, async (tx) => {
      await tx
        .update(userPtvConnections)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(userPtvConnections.userId, userId),
            eq(userPtvConnections.apiVersion, apiVersion),
            eq(userPtvConnections.environment, environment),
          ),
        );
    });
  }
}
