import { randomBytes, randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import { OAuthService } from '../mcp/oauthService.js';
import { InvalidAccessTokenError, signAccessToken, verifyAccessToken } from './jwt.js';

const secret = Buffer.from('x'.repeat(32)).toString('base64');

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

  it('rejects an MCP OAuth access token signed with the same secret', async () => {
    const oauth = new OAuthService(
      {} as never,
      secret,
      'https://mcp.example',
      'https://mcp.example',
    );
    const token = await oauth.issueAccessToken(
      'user-1',
      'client',
      'mcp',
      null,
      'test',
      'v11',
      null,
    );
    await expect(verifyAccessToken(token, secret)).rejects.toThrow(InvalidAccessTokenError);
  });

  it('rejects a tenant_selection token signed with the same secret', async () => {
    const oauth = new OAuthService(
      {} as never,
      secret,
      'https://mcp.example',
      'https://mcp.example',
    );
    const token = await oauth.createTenantSelectionToken('user-1', {
      clientId: 'c',
      redirectUri: 'https://a.example/cb',
      codeChallenge: 'x',
      scope: 'mcp',
    });
    await expect(verifyAccessToken(token, secret)).rejects.toThrow(InvalidAccessTokenError);
  });

  it('rejects a hand-made HS256 token with sub but no audience', async () => {
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(randomUUID())
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(Buffer.from(secret, 'base64'));
    await expect(verifyAccessToken(token, secret)).rejects.toThrow(InvalidAccessTokenError);
  });
});
