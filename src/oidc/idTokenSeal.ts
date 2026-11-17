import {
  envelopeDecrypt,
  envelopeEncrypt,
  type EnvelopeEncrypted,
} from '../security/envelopeEncryption.js';

/**
 * The IdP's ID token, sealed for storage: envelope-encrypted under the
 * platform master key (src/security/envelopeEncryption.ts), serialized as
 * JSON text. Only sign-out needs the plain token again, as `id_token_hint`.
 */
export function sealIdToken(masterEncryptionKey: string, idToken: string): string {
  return JSON.stringify(envelopeEncrypt(masterEncryptionKey, idToken));
}

/** Reverses sealIdToken. Throws when the value was sealed under another key or was altered. */
export function openIdToken(masterEncryptionKey: string, sealed: string): string {
  const { encrypted, encryptedDataKey } = JSON.parse(sealed) as EnvelopeEncrypted;
  return envelopeDecrypt(masterEncryptionKey, encrypted, encryptedDataKey);
}
