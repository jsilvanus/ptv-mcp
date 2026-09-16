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
 * a tenant-scoped credential (e.g. v12's future API key). Storage and
 * encryption only: **no route wires into this yet, deliberately** — there
 * is nothing to configure until Phase 7's `PtvV12Adapter` exists, per
 * docs/phase-plan.md's Phase 3 scope note. Exercised by tests only.
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
