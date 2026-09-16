import { randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { InvalidAccessTokenError, signAccessToken, verifyAccessToken } from './jwt.js';

const secret = randomBytes(32).toString('base64');

describe('access tokens', () => {
  it('round-trips a valid token', async () => {
    const userId = randomUUID();
    const token = await signAccessToken({ sub: userId }, secret);
    const payload = await verifyAccessToken(token, secret);
    expect(payload.sub).toBe(userId);
  });

  it('rejects a token signed with a different secret', async () => {
    const token = await signAccessToken({ sub: randomUUID() }, secret);
    const otherSecret = randomBytes(32).toString('base64');
    await expect(verifyAccessToken(token, otherSecret)).rejects.toThrow(InvalidAccessTokenError);
  });

  it('rejects a malformed token', async () => {
    await expect(verifyAccessToken('not-a-jwt', secret)).rejects.toThrow(InvalidAccessTokenError);
  });
});
