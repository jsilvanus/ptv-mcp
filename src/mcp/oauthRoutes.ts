import type { FastifyInstance } from 'fastify';
import type { OAuthService } from './oauthService.js';
import type { AuthService } from '../auth/authService.js';
import type { TenantService } from '../tenants/tenantService.js';
import { verifyAccessToken } from '../auth/jwt.js';

const LEGACY_RESOURCE_SUFFIX = '/mcp';

function isSupportedResource(resource: string | undefined, publicUrl: string): boolean {
  return resource === undefined || resource === publicUrl || resource === publicUrl + LEGACY_RESOURCE_SUFFIX;
}

export interface McpOAuthRouteOptions {
  oauthService: OAuthService;
  authService: AuthService;
  publicUrl: string;
  jwtSecret: string;
  tenantService: TenantService;
}

function html(body: string) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>ptv-mcp login</title>
<style>body{font-family:system-ui;max-width:420px;margin:8rem auto;padding:2rem}input{display:block;width:100%;box-sizing:border-box;margin:.5rem 0 1rem;padding:.7rem}button{padding:.7rem 1.2rem}p.error{color:#b00020}</style>
</head><body>${body}</body></html>`;
}

export async function mcpOAuthRoutes(app: FastifyInstance, options: McpOAuthRouteOptions): Promise<void> {
  app.get('/.well-known/oauth-protected-resource', async (_req, reply) => reply.send({
    resource: options.publicUrl,
    authorization_servers: [options.publicUrl],
    scopes_supported: ['mcp'],
    bearer_methods_supported: ['header'],
  }));

  const authorizationServerMetadata = {
    issuer: options.publicUrl,
    authorization_endpoint: options.publicUrl + '/oauth/authorize',
    token_endpoint: options.publicUrl + '/oauth/token',
    registration_endpoint: options.publicUrl + '/oauth/register',
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: ['mcp'],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
  };

  app.get('/.well-known/oauth-authorization-server', async (_req, reply) =>
    reply.send(authorizationServerMetadata),
  );

  // Some OAuth clients probe OIDC discovery even when the server implements
  // OAuth 2.0 rather than OpenID Connect. Expose the same authorization-server
  // metadata there for compatibility; this endpoint does not imply OIDC userinfo
  // or ID-token support.
  app.get('/.well-known/openid-configuration', async (_req, reply) =>
    reply.send(authorizationServerMetadata),
  );

  app.post<{ Body: Record<string, unknown> }>('/oauth/register', async (request, reply) => {
    try {
      const result = await options.oauthService.registerClient({
        ...(typeof request.body.client_id === 'string' ? { client_id: request.body.client_id } : {}),
        ...(typeof request.body.client_name === 'string' ? { client_name: request.body.client_name } : {}),
        redirect_uris: Array.isArray(request.body.redirect_uris)
          ? request.body.redirect_uris.filter((v): v is string => typeof v === 'string')
          : [],
        ...(Array.isArray(request.body.grant_types)
          ? { grant_types: request.body.grant_types.filter((v): v is string => typeof v === 'string') }
          : {}),
        ...(Array.isArray(request.body.response_types)
          ? { response_types: request.body.response_types.filter((v): v is string => typeof v === 'string') }
          : {}),
        ...(typeof request.body.token_endpoint_auth_method === 'string'
          ? { token_endpoint_auth_method: request.body.token_endpoint_auth_method }
          : {}),
        ...(typeof request.body.application_type === 'string'
          ? { application_type: request.body.application_type }
          : {}),
      });
      return reply.code(201).send(result);
    } catch (err) {
      return reply.badRequest(err instanceof Error ? err.message : 'Invalid client metadata');
    }
  });

  app.get<{ Querystring: Record<string, string | undefined> }>('/oauth/authorize', async (request, reply) => {
    const q = request.query;
    if (q.response_type !== 'code' || !q.client_id || !q.redirect_uri || !q.code_challenge) {
      return reply.badRequest('response_type=code, client_id, redirect_uri and code_challenge are required');
    }
    if (!isSupportedResource(q.resource, options.publicUrl)) {
      return reply.badRequest('Unsupported resource');
    }
    if (!(await options.oauthService.validateClient(q.client_id, q.redirect_uri))) {
      return reply.badRequest('Unknown client or redirect_uri');
    }
    if (q.code_challenge_method !== 'S256') return reply.badRequest('Only S256 PKCE is supported');

    const params = new URLSearchParams({
      client_id: q.client_id,
      redirect_uri: q.redirect_uri,
      code_challenge: q.code_challenge,
      code_challenge_method: 'S256',
      scope: q.scope ?? 'mcp',
      ...(q.resource ? { resource: q.resource } : {}),
      ...(q.state ? { state: q.state } : {}),
    });

    return reply.type('text/html').send(html(`
      <h1>Sign in to ptv-mcp</h1>
      <p>This authorizes the MCP client to use your ptv-mcp account.</p>
      <form method="post" action="/oauth/authorize">
        <input type="hidden" name="oauth" value="${Buffer.from(params.toString()).toString('base64url')}">
        <label>Email</label><input name="email" type="email" autocomplete="username" required>
        <label>Password</label><input name="password" type="password" autocomplete="current-password" required>
        <button type="submit">Sign in and authorize</button>
      </form>
    `));
  });

  app.post<{
    Body: { oauth?: string; email?: string; password?: string; tenant_id?: string; selection_token?: string }
  }>('/oauth/authorize', async (request, reply) => {
    // Step 1: authenticate the human, then ask which tenant this OAuth
    // connection should represent. The tenant choice belongs to the OAuth
    // grant, not to the user's identity, so one user can authorize multiple
    // independent ChatGPT/Claude connections for different tenants.
    if (request.body.selection_token && request.body.tenant_id) {
      try {
        const selection = await options.oauthService.verifyTenantSelectionToken(request.body.selection_token);
        const memberships = await options.tenantService.listTenantsForUser(selection.userId);
        const membership = memberships.find((item) => item.tenantId === request.body.tenant_id);
        if (!membership) return reply.badRequest('You are not a member of that organisation');

        const code = await options.oauthService.createAuthorizationCode(selection.userId, {
          clientId: selection.clientId,
          redirectUri: selection.redirectUri,
          codeChallenge: selection.codeChallenge,
          scope: selection.scope,
          tenantId: membership.tenantId,
        });
        const redirect = new URL(selection.redirectUri);
        redirect.searchParams.set('code', code);
        const original = await options.oauthService.verifyTenantSelectionToken(request.body.selection_token);
        // state is intentionally carried inside the selection token in the
        // next iteration of this flow; keep it in the OAuth request itself.
        // For compatibility, state is recovered from the signed token below.
        if (original.state) redirect.searchParams.set('state', original.state);
        redirect.searchParams.set('iss', options.publicUrl);
        return reply.redirect(redirect.toString());
      } catch (err) {
        request.log.error({ err }, 'OAuth tenant selection failed');
        return reply.type('text/html').send(html('<h1>Authorization failed</h1><p class="error">The tenant selection is no longer valid. Please restart the connection.</p>'));
      }
    }

    if (!request.body.oauth || !request.body.email || !request.body.password) return reply.badRequest('Login required');
    let q: Record<string, string>;
    try { q = Object.fromEntries(new URLSearchParams(Buffer.from(request.body.oauth, 'base64url').toString('utf8'))); }
    catch { return reply.badRequest('Invalid authorization request'); }

    try {
      const clientId = q.client_id;
      const redirectUri = q.redirect_uri;
      const codeChallenge = q.code_challenge;
      if (!clientId || !redirectUri || !codeChallenge) return reply.badRequest('Invalid authorization request');
      if (!isSupportedResource(q.resource, options.publicUrl)) return reply.badRequest('Unsupported resource');

      const session = await options.authService.login(request.body.email, request.body.password);
      const userId = (await verifyAccessToken(session.accessToken, options.jwtSecret)).sub;
      const memberships = await options.tenantService.listTenantsForUser(userId);
      if (memberships.length === 0) {
        return reply.type('text/html').send(html('<h1>No organisation access</h1><p class="error">Your account is not a member of any PTV organisation.</p>'));
      }

      const selectionToken = await options.oauthService.createTenantSelectionToken(userId, {
        clientId,
        redirectUri,
        codeChallenge,
        ...(q.state ? { state: q.state } : {}),
        scope: q.scope ?? 'mcp',
        tenantId: memberships[0].tenantId,
      });

      const optionsHtml = memberships.map((membership) =>
        `<option value="${membership.tenantId}">${membership.tenantName} (${membership.tenantSlug}) — ${membership.role}</option>`,
      ).join('');

      return reply.type('text/html').send(html(`
        <h1>Choose organisation</h1>
        <p>This MCP connection will act on behalf of the organisation you select. You can create separate connections for your other organisations.</p>
        <form method="post" action="/oauth/authorize">
          <input type="hidden" name="selection_token" value="${selectionToken}">
          <label>Organisation</label>
          <select name="tenant_id" required>${optionsHtml}</select>
          <button type="submit">Continue</button>
        </form>
      `));
    } catch (err) {
      request.log.error({ err }, 'OAuth authorization failed');
      return reply.type('text/html').send(html('<h1>Sign-in failed</h1><p class="error">Invalid email or password.</p><p><a href="javascript:history.back()">Try again</a></p>'));
    }
  });

  app.post<{ Body: Record<string, string | undefined> }>('/oauth/token', async (request, reply) => {
    const b = request.body;
    if (b.grant_type === 'authorization_code' && b.code && b.client_id && b.redirect_uri && b.code_verifier) {
      if (!isSupportedResource(b.resource, options.publicUrl)) {
        return reply.code(400).send({ error: 'invalid_target' });
      }
      try { return reply.send(await options.oauthService.exchangeCode(b.code, b.client_id, b.redirect_uri, b.code_verifier)); }
      catch { return reply.code(400).send({ error: 'invalid_grant' }); }
    }
    if (b.grant_type === 'refresh_token' && b.refresh_token && b.client_id) {
      if (!isSupportedResource(b.resource, options.publicUrl)) {
        return reply.code(400).send({ error: 'invalid_target' });
      }
      try { return reply.send(await options.oauthService.refresh(b.refresh_token, b.client_id)); }
      catch { return reply.code(400).send({ error: 'invalid_grant' }); }
    }
    return reply.code(400).send({ error: 'invalid_request' });
  });
}
