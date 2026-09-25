import { and, eq } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { withContext } from '../db/context.js';
import { tenantEnvironments } from '../db/schema/index.js';
import {
  type EncryptedBlob,
  deserializeBlob,
  envelopeDecrypt,
  envelopeEncrypt,
  serializeBlob,
} from '../security/envelopeEncryption.js';

export type PtvEnvironment = 'test' | 'production';

export class TenantEnvironmentNotFoundError extends Error {
  constructor() {
    super('No tenant environment credentials found for this tenant/version/environment');
    this.name = 'TenantEnvironmentNotFoundError';
  }
}

/**
 * Envelope-encrypted storage for `TenantEnvironment` (Phase 3 Stream B) —
 * a tenant-scoped credential: v12's API key and v11's IN-API user. Tenant
 * admins set them through routes/ptvV12.ts and routes/ptvV11ApiUser.ts;
 * `DbPtvAdapterRegistry` reads them for adapters whose `credentialScope`
 * is `tenant`.
 */
export class TenantEnvironmentService {
  constructor(
    private readonly db: Database,
    private readonly masterEncryptionKey: string,
  ) {}

  /** `credentials` is adapter-defined shape (e.g. `{ apiKey }` for v12) — stored as an encrypted JSON blob. */
  async storeCredentials(
    tenantId: string,
    environment: PtvEnvironment,
    apiVersion: string,
    credentials: Record<string, unknown>,
  ): Promise<void> {
    const { encrypted, encryptedDataKey } = envelopeEncrypt(
      this.masterEncryptionKey,
      JSON.stringify(credentials),
    );
    await withContext(this.db, { tenantId }, async (tx) => {
      await tx
        .insert(tenantEnvironments)
        .values({
          tenantId,
          environment,
          apiVersion,
          encryptedCredentials: encrypted,
          encryptedDataKey: serializeBlob(encryptedDataKey),
          active: true,
        })
        .onConflictDoUpdate({
          target: [
            tenantEnvironments.tenantId,
            tenantEnvironments.environment,
            tenantEnvironments.apiVersion,
          ],
          set: {
            encryptedCredentials: encrypted,
            encryptedDataKey: serializeBlob(encryptedDataKey),
            active: true,
            updatedAt: new Date(),
          },
        });
    });
  }

  /** Whether active credentials are stored, without decrypting them. */
  async hasCredentials(
    tenantId: string,
    environment: PtvEnvironment,
    apiVersion: string,
  ): Promise<boolean> {
    const record = await withContext(this.db, { tenantId }, async (tx) =>
      tx.query.tenantEnvironments.findFirst({
        where: and(
          eq(tenantEnvironments.tenantId, tenantId),
          eq(tenantEnvironments.environment, environment),
          eq(tenantEnvironments.apiVersion, apiVersion),
          eq(tenantEnvironments.active, true),
        ),
        columns: { id: true },
      }),
    );
    return record !== undefined;
  }

  async getDecryptedCredentials(
    tenantId: string,
    environment: PtvEnvironment,
    apiVersion: string,
  ): Promise<Record<string, unknown>> {
    const record = await withContext(this.db, { tenantId }, async (tx) =>
      tx.query.tenantEnvironments.findFirst({
        where: and(
          eq(tenantEnvironments.tenantId, tenantId),
          eq(tenantEnvironments.environment, environment),
          eq(tenantEnvironments.apiVersion, apiVersion),
        ),
      }),
    );
    if (!record || !record.active) {
      throw new TenantEnvironmentNotFoundError();
    }

    const plaintext = envelopeDecrypt(
      this.masterEncryptionKey,
      record.encryptedCredentials as EncryptedBlob,
      deserializeBlob(record.encryptedDataKey),
    );
    return JSON.parse(plaintext) as Record<string, unknown>;
  }

  async deactivate(
    tenantId: string,
    environment: PtvEnvironment,
    apiVersion: string,
  ): Promise<void> {
    await withContext(this.db, { tenantId }, async (tx) => {
      await tx
        .update(tenantEnvironments)
        .set({ active: false, updatedAt: new Date() })
        .where(
          and(
            eq(tenantEnvironments.tenantId, tenantId),
            eq(tenantEnvironments.environment, environment),
            eq(tenantEnvironments.apiVersion, apiVersion),
          ),
        );
    });
  }
}
