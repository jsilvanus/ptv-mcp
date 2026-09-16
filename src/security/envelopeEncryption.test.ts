import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  deserializeBlob,
  envelopeDecrypt,
  envelopeEncrypt,
  serializeBlob,
} from './envelopeEncryption.js';

const masterKey = randomBytes(32).toString('base64');

describe('envelope encryption', () => {
  it('round-trips a secret through encrypt/decrypt', () => {
    const { encrypted, encryptedDataKey } = envelopeEncrypt(masterKey, 'super-secret-api-key');
    const plaintext = envelopeDecrypt(masterKey, encrypted, encryptedDataKey);
    expect(plaintext).toBe('super-secret-api-key');
  });

  it('uses a distinct data key per call, so ciphertext differs even for the same plaintext', () => {
    const a = envelopeEncrypt(masterKey, 'same-plaintext');
    const b = envelopeEncrypt(masterKey, 'same-plaintext');
    expect(a.encrypted.ciphertext).not.toBe(b.encrypted.ciphertext);
    expect(a.encryptedDataKey.ciphertext).not.toBe(b.encryptedDataKey.ciphertext);
  });

  it('fails to decrypt with the wrong master key', () => {
    const { encrypted, encryptedDataKey } = envelopeEncrypt(masterKey, 'secret');
    const wrongKey = randomBytes(32).toString('base64');
    expect(() => envelopeDecrypt(wrongKey, encrypted, encryptedDataKey)).toThrow();
  });

  it('fails to decrypt if the ciphertext is tampered with (GCM auth tag)', () => {
    const { encrypted, encryptedDataKey } = envelopeEncrypt(masterKey, 'secret');
    const tampered = { ...encrypted, ciphertext: Buffer.from('tampered').toString('base64') };
    expect(() => envelopeDecrypt(masterKey, tampered, encryptedDataKey)).toThrow();
  });

  it('rejects a master key of the wrong length', () => {
    expect(() => envelopeEncrypt(Buffer.from('too-short').toString('base64'), 'secret')).toThrow(
      /MASTER_ENCRYPTION_KEY/,
    );
  });

  it('round-trips a blob through serialize/deserialize for text columns', () => {
    const { encrypted } = envelopeEncrypt(masterKey, 'secret');
    expect(deserializeBlob(serializeBlob(encrypted))).toEqual(encrypted);
  });
});
