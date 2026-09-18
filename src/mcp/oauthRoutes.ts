import type { FastifyInstance } from 'fastify';
import type { OAuthService } from './oauthService.js';
import type { AuthService } from '../auth/authService.js';
import { verifyAccessToken } from '../auth/jwt.js';

export interface McpOAuthRouteOptions {
  oauthService: OAuthService;
  authService: AuthService;
  publicUrl: string;
  jwtSecret: string;
}

function html(body: string) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>ptv-mcp login</title>
<style>body{font-family:system-ui;max-width:420px;margin:8rem auto;padding:2rem}input{display:block;width:100%;box-sizing:border-box;margin:.5rem 0 1rem;padding:.7rem}button{padding:.7rem 1.2rem}p.error{color:#b00020}</style>
</head><body>${body}</body></html>`;
}

export async function mcpOAuthRoutes(app: FastifyInstance, options: McpOAuthRouteOptions): Promise<void> {
  app.get('/.well-known/oauth-protected-resource', async (_req, reply) => reply.send({
    resource: options.publicUrl + '/mcp',
    authorization_servers: [options.publicUrl],
    scopes_supported: ['mcp'],
    bearer_methods_supported: ['header'],
  }));

  app.get('/.well-known/oauth-authorization-server', async (_req, reply) => reply.send({
    issuer: options.publicUrl,
    authorization_endpoint: options.publicUrl + '/oauth/authorize',
    token_endpoint: options.publicUrl + '/oauth/token',
    registration_endpoint: options.publicUrl + '/oauth/register',
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: ['mcp'],
    client_id_metadata_document_supported: false,
  }));

  app.post<{ Body: Record<string, unknown> }>('/oauth/register', async (request, reply) => {
    try {
      const result = await options.oauthService.registerClient({
        client_id: typeof request.body.client_id === 'string' ? request.body.client_id : undefined,
        client_name: typeof request.body.client_name === 'string' ? request.body.client_name : undefined,
        redirect_uris: Array.isArray(request.body.redirect_uris) ? request.body.redirect_uris.filter((v): v is string => typeof v === 'string') : [],
        grant_types: Array.isArray(request.body.grant_types) ? request.body.grant_types.filter((v): v is string => typeof v === 'string') : undefined,
        response_types: Array.isArray(request.body.response_types) ? request.body.response_types.filter((v): v is string => typeof v === 'string') : undefined,
        token_endpoint_auth_method: typeof request.body.token_endpoint_auth_method === 'string' ? request.body.token_endpoint_auth_method : undefined,
        application_type: typeof request.body.application_type === 'string' ? request.body.application_type : undefined,
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

  app.post<{ Body: { oauth?: string; email?: string; password?: string } }>('/oauth/authorize', async (request, reply) => {
    if (!request.body.oauth || !request.body.email || !request.body.password) return reply.badRequest('Login required');
    let q: Record<string, string>;
    try { q = Object.fromEntries(new URLSearchParams(Buffer.from(request.body.oauth, 'base64url').toString('utf8'))); }
    catch { return reply.badRequest('Invalid authorization request'); }
    try {
      const session = await options.authService.login(request.body.email, request.body.password);
      const userId = (await verifyAccessToken(session.accessToken, options.jwtSecret)).sub;
      const code = await options.oauthService.createAuthorizationCode(userId, {
        clientId: q.client_id, redirectUri: q.redirect_uri, codeChallenge: q.code_challenge, state: q.state, scope: q.scope ?? 'mcp',
      });
      const redirect = new URL(q.redirect_uri);
      redirect.searchParams.set('code', code);
      if (q.state) redirect.searchParams.set('state', q.state);
      return reply.redirect(redirect.toString());
    } catch (err) {
      return reply.type('text/html').send(html('<h1>Sign-in failed</h1><p class="error">Invalid email or password.</p><p><a href="javascript:history.back()">Try again</a></p>'));
    }
  });

  app.post<{ Body: Record<string, string | undefined> }>('/oauth/token', async (request, reply) => {
    const b = request.body;
    if (b.grant_type === 'authorization_code' && b.code && b.client_id && b.redirect_uri && b.code_verifier) {
      try { return reply.send(await options.oauthService.exchangeCode(b.code, b.client_id, b.redirect_uri, b.code_verifier)); }
      catch { return reply.code(400).send({ error: 'invalid_grant' }); }
    }
    if (b.grant_type === 'refresh_token' && b.refresh_token && b.client_id) {
      try { return reply.send(await options.oauthService.refresh(b.refresh_token, b.client_id)); }
      catch { return reply.code(400).send({ error: 'invalid_grant' }); }
    }
    return reply.code(400).send({ error: 'invalid_request' });
  });
}
