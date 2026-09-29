import * as client from 'openid-client';
import type { OidcConfig } from '../config.js';

/** What the app needs from a verified sign-in: who the IdP says the user is. */
export interface OidcIdentityClaims {
  /** The ID token's `iss` (already checked against the discovered issuer). */
  issuer: string;
  subject: string;
  email?: string;
  emailVerified: boolean;
  name?: string;
  preferredUsername?: string;
}

export interface OidcAuthorizationStart {
  url: URL;
  state: string;
  nonce: string;
  codeVerifier: string;
}

export interface OidcCallbackChecks {
  state: string;
  nonce: string;
  codeVerifier: string;
}

function stringClaim(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * The Relying Party side of OpenID Connect, on `openid-client`. Discovery
 * runs lazily on first use and its promise is cached; a failed discovery is
 * dropped from the cache so a later request retries (startup never depends
 * on the IdP being reachable).
 */
export class OidcClient {
  private configuration: Promise<client.Configuration> | undefined;

  constructor(
    private readonly config: OidcConfig,
    /** `<public URL>/oidc/callback`. */
    readonly redirectUri: string,
  ) {}

  private discover(): Promise<client.Configuration> {
    if (!this.configuration) {
      const issuer = new URL(this.config.issuer);
      // Config loading refuses http: in production, so this only relaxes
      // the https requirement for local development and tests.
      const allowHttp = issuer.protocol === 'http:';
      const pending = client
        .discovery(
          issuer,
          this.config.clientId,
          undefined,
          this.config.clientSecret
            ? client.ClientSecretBasic(this.config.clientSecret)
            : client.None(),
          allowHttp ? { execute: [client.allowInsecureRequests] } : undefined,
        )
        .catch((err: unknown) => {
          if (this.configuration === pending) this.configuration = undefined;
          throw err;
        });
      this.configuration = pending;
    }
    return this.configuration;
  }

  /** A fresh state, nonce and PKCE verifier, and the IdP authorization URL that carries them. */
  async start(): Promise<OidcAuthorizationStart> {
    const configuration = await this.discover();
    const state = client.randomState();
    const nonce = client.randomNonce();
    const codeVerifier = client.randomPKCECodeVerifier();
    const url = client.buildAuthorizationUrl(configuration, {
      redirect_uri: this.redirectUri,
      scope: this.config.scopes,
      response_type: 'code',
      state,
      nonce,
      code_challenge: await client.calculatePKCECodeChallenge(codeVerifier),
      code_challenge_method: 'S256',
    });
    return { url, state, nonce, codeVerifier };
  }

  /**
   * Redeems the authorization code (state, nonce and PKCE checked by
   * openid-client, ID token required) and returns the identity claims.
   * Falls back to the userinfo endpoint when the ID token has no email.
   */
  async finish(callbackUrl: URL, checks: OidcCallbackChecks): Promise<OidcIdentityClaims> {
    const configuration = await this.discover();
    const tokens = await client.authorizationCodeGrant(configuration, callbackUrl, {
      pkceCodeVerifier: checks.codeVerifier,
      expectedState: checks.state,
      expectedNonce: checks.nonce,
      idTokenExpected: true,
    });
    const claims = tokens.claims();
    if (!claims) throw new Error('The identity provider returned no ID token');

    let source: Record<string, unknown> = claims;
    if (!stringClaim(claims.email) && tokens.access_token) {
      const userInfo = await client.fetchUserInfo(configuration, tokens.access_token, claims.sub);
      source = {
        ...userInfo,
        ...claims,
        email: userInfo.email,
        email_verified: userInfo.email_verified,
      };
    }

    const email = stringClaim(source.email);
    const name = stringClaim(source.name);
    const preferredUsername = stringClaim(source.preferred_username);
    return {
      issuer: claims.iss,
      subject: claims.sub,
      ...(email ? { email } : {}),
      emailVerified: source.email_verified === true,
      ...(name ? { name } : {}),
      ...(preferredUsername ? { preferredUsername } : {}),
    };
  }
}
