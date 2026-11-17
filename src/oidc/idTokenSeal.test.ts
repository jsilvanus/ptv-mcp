import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { openIdToken, sealIdToken } from './idTokenSeal.js';

const KEY_A = randomBytes(32).toString('base64');
const KEY_B = randomBytes(32).toString('base64');
const TOKEN = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJhYmMifQ.c2lnbmF0dXJl';

describe('ID token sealing', () => {
  it('round-trips the token and never stores it in the clear', () => {
    const sealed = sealIdToken(KEY_A, TOKEN);
    expect(sealed).not.toContain(TOKEN);
    expect(sealed).not.toContain('eyJzdWIiOiJhYmMifQ');
    expect(openIdToken(KEY_A, sealed)).toBe(TOKEN);
  });

  it('uses a fresh data key for each seal', () => {
    expect(sealIdToken(KEY_A, TOKEN)).not.toBe(sealIdToken(KEY_A, TOKEN));
  });

  it('refuses to open under another master key', () => {
    expect(() => openIdToken(KEY_B, sealIdToken(KEY_A, TOKEN))).toThrow();
  });
});
