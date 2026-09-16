import { hash, verify } from '@node-rs/argon2';

/**
 * Argon2id per docs/plan.md's "Autentikoinnin täydennykset" section. `2` is
 * `Algorithm.Argon2id` from @node-rs/argon2's own ambient const enum — its
 * value, not the enum import, because `verbatimModuleSyntax` can't access
 * an ambient const enum's members (TS2748) and the crate itself documents
 * Argon2id (value 2) as "the default algorithm for normative
 * recommendations", so this isn't expected to drift across versions.
 */
const ARGON2ID_OPTIONS = { algorithm: 2 };

export function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2ID_OPTIONS);
}

export function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  return verify(passwordHash, password);
}
