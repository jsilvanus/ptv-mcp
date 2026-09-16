import { SignJWT, jwtVerify, errors } from 'jose';

/** Short-lived — refresh tokens (see tokens.ts) carry the long-lived session, not this. */
export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;

export interface AccessTokenPayload {
  sub: string;
}

function toSecretKey(masterEncryptionKeyBase64: string): Uint8Array {
  return Buffer.from(masterEncryptionKeyBase64, 'base64');
}

export async function signAccessToken(
  payload: AccessTokenPayload,
  masterEncryptionKeyBase64: string,
): Promise<string> {
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${ACCESS_TOKEN_TTL_SECONDS}s`)
    .sign(toSecretKey(masterEncryptionKeyBase64));
}

export class InvalidAccessTokenError extends Error {
  constructor(cause: unknown) {
    super('Invalid or expired access token');
    this.name = 'InvalidAccessTokenError';
    this.cause = cause;
  }
}

export async function verifyAccessToken(
  token: string,
  masterEncryptionKeyBase64: string,
): Promise<AccessTokenPayload> {
  try {
    const { payload } = await jwtVerify(token, toSecretKey(masterEncryptionKeyBase64), {
      algorithms: ['HS256'],
    });
    if (typeof payload.sub !== 'string') {
      throw new Error('Access token payload missing sub');
    }
    return { sub: payload.sub };
  } catch (err) {
    if (err instanceof errors.JOSEError || err instanceof Error) {
      throw new InvalidAccessTokenError(err);
    }
    throw err;
  }
}
