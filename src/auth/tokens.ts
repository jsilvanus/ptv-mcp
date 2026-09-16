import { createHash, randomBytes } from 'node:crypto';

/**
 * Opaque, high-entropy tokens for refresh/email-verification/password-reset
 * flows. Only the SHA-256 hash is ever persisted (see refreshToken.ts and
 * siblings) — a stolen DB backup doesn't hand out usable tokens. Unlike
 * password hashing, a fast hash is correct here: the token already carries
 * 256 bits of entropy, so there's nothing for a slow hash to protect
 * against that the token's own randomness doesn't already cover, and a
 * lookup-by-hash needs to be cheap.
 */
export function generateOpaqueToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
}
