import { SignJWT, jwtVerify } from 'jose';

/** Short-lived — refresh tokens (see tokens.ts) carry the long-lived session, not this. */
export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;

/**
 * Audience claim carried by REST session tokens. MCP OAuth access tokens and
 * the MCP tenant-selection token are signed with the same JWT_SECRET and also
 * carry `sub`, so without a dedicated audience the REST `authenticate` guard
 * would accept them as full sessions. `verifyAccessToken` requires this value,
 * which means an MCP token is refused by the REST API as well.
 */
export const SESSION_TOKEN_AUDIENCE = 'ptv-mcp:session';

export interface AccessTokenPayload {
  sub: string;
}

function toSecretKey(jwtSecretBase64: string): Uint8Array {
  return Buffer.from(jwtSecretBase64, 'base64');
}

/**
 * Signs a REST session access token (audience `ptv-mcp:session`).
 * Only use this for web/REST sessions; MCP tokens are minted by `OAuthService`.
 */
export async function signAccessToken(
  payload: AccessTokenPayload,
  jwtSecretBase64: string,
): Promise<string> {
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: 'HS256' })
    .setAudience(SESSION_TOKEN_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${ACCESS_TOKEN_TTL_SECONDS}s`)
    .sign(toSecretKey(jwtSecretBase64));
}

export class InvalidAccessTokenError extends Error {
  constructor(cause: unknown) {
    super('Invalid or expired access token');
    this.name = 'InvalidAccessTokenError';
    this.cause = cause;
  }
}

/**
 * Verifies a REST session access token. Requires the `ptv-mcp:session` audience
 * (jose rejects tokens without it), so MCP OAuth access tokens and the MCP
 * tenant-selection token, which use a different audience, are refused.
 * As defence in depth, tokens carrying MCP-only claims (`kind`, `client_id`)
 * are also refused even if they somehow carry the session audience.
 */
export async function verifyAccessToken(
  token: string,
  jwtSecretBase64: string,
): Promise<AccessTokenPayload> {
  try {
    const { payload } = await jwtVerify(token, toSecretKey(jwtSecretBase64), {
      algorithms: ['HS256'],
      audience: SESSION_TOKEN_AUDIENCE,
    });
    if (typeof payload.sub !== 'string') {
      throw new Error('Access token payload missing sub');
    }
    if (payload.kind !== undefined || payload.client_id !== undefined) {
      throw new Error('Access token is not a REST session token');
    }
    return { sub: payload.sub };
  } catch (err) {
    if (err instanceof Error) {
      throw new InvalidAccessTokenError(err);
    }
    throw err;
  }
}
