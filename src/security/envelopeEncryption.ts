import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Envelope encryption (docs/plan.md's "API-avainten salaus" section): each
 * secret gets its own random data key, which encrypts the secret; the data
 * key itself is encrypted with a per-environment master key. Rotating the
 * master key only requires re-wrapping data keys, not re-encrypting every
 * secret, and a single leaked data key exposes only the one secret it
 * belongs to.
 */

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH_BYTES = 12;
const DATA_KEY_LENGTH_BYTES = 32;

export interface EncryptedBlob {
  ciphertext: string;
  iv: string;
  authTag: string;
}

export interface EnvelopeEncrypted {
  encrypted: EncryptedBlob;
  encryptedDataKey: EncryptedBlob;
}

function loadMasterKey(masterEncryptionKeyBase64: string): Buffer {
  const key = Buffer.from(masterEncryptionKeyBase64, 'base64');
  if (key.length !== DATA_KEY_LENGTH_BYTES) {
    throw new Error(
      `MASTER_ENCRYPTION_KEY must decode to ${DATA_KEY_LENGTH_BYTES} bytes (got ${key.length}) — generate with node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`,
    );
  }
  return key;
}

function encryptBuffer(key: Buffer, plaintext: Buffer): EncryptedBlob {
  const iv = randomBytes(IV_LENGTH_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
  };
}

function decryptBuffer(key: Buffer, blob: EncryptedBlob): Buffer {
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(blob.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(blob.authTag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(blob.ciphertext, 'base64')), decipher.final()]);
}

/** Encrypts `plaintext` under a fresh data key, itself wrapped by the master key. */
export function envelopeEncrypt(
  masterEncryptionKeyBase64: string,
  plaintext: string,
): EnvelopeEncrypted {
  const masterKey = loadMasterKey(masterEncryptionKeyBase64);
  const dataKey = randomBytes(DATA_KEY_LENGTH_BYTES);
  const encrypted = encryptBuffer(dataKey, Buffer.from(plaintext, 'utf8'));
  const encryptedDataKey = encryptBuffer(masterKey, dataKey);
  return { encrypted, encryptedDataKey };
}

/** Unwraps the data key with the master key, then decrypts the secret with it. */
export function envelopeDecrypt(
  masterEncryptionKeyBase64: string,
  encrypted: EncryptedBlob,
  encryptedDataKey: EncryptedBlob,
): string {
  const masterKey = loadMasterKey(masterEncryptionKeyBase64);
  const dataKey = decryptBuffer(masterKey, encryptedDataKey);
  return decryptBuffer(dataKey, encrypted).toString('utf8');
}

/** For `text` columns storing an EncryptedBlob (jsonb columns can store the object directly). */
export function serializeBlob(blob: EncryptedBlob): string {
  return JSON.stringify(blob);
}

export function deserializeBlob(serialized: string): EncryptedBlob {
  return JSON.parse(serialized) as EncryptedBlob;
}
