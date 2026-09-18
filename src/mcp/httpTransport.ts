import type { IncomingMessage } from 'node:http';
import type { FastifyInstance } from 'fastify';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { InvalidAccessTokenError, verifyAccessToken } from '../auth/jwt.js';
import { createMcpServer, type McpServerDeps } from './mcpServer.js';
import type { OAuthService } from './oauthService.js';

export interface McpRouteOptions {
  jwtSecret: string;
  serverDeps: McpServerDeps;
  oauthService: OAuthService;
  publicUrl: string;
}

function methodNotAllowed(): {
  jsonrpc: '2.0';
  error: { code: number; message: string };
  id: null;
} {
  return { jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null };
}

/**
 * Mounts the MCP tool surface at `POST /mcp`, JWT-authenticated the same
 * way as every other route (Bearer token, verified with `verifyAccessToken`)
 * — tenant/environment for each call is a tool argument instead (see
 * toolContext.ts), since this transport is deliberately stateless: a
 * fresh `McpServer` + `StreamableHTTPServerTransport` per request, exactly
 * the pattern the SDK's own stateless example uses
 * (`examples/server/simpleStatelessStreamableHttp`), rather than tracking
 * a session across calls.
 */
export async function mcpRoutes(app: FastifyInstance, options: McpRouteOptions): Promise<void> {
  app.post('/mcp', async (request, reply) => {
    const header = request.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      reply.header('WWW-Authenticate', `Bearer resource_metadata="${options.publicUrl}/.well-known/oauth-protected-resource", scope="mcp"`);
      return reply.code(401).send({ error: 'unauthorized', error_description: 'Bearer token required' });
    }

    let authInfo: AuthInfo;
    try {
      const payload = await options.oauthService.verifyAccessToken(header.slice('Bearer '.length));
      authInfo = {
        token: header,
        clientId: payload.clientId ?? 'oauth-client',
        scopes: payload.scope ? payload.scope.split(' ') : [],
        extra: { userId: payload.sub },
      };
    } catch (err) {
      if (err instanceof Error && err.message === 'invalid_token') {
        reply.header('WWW-Authenticate', `Bearer resource_metadata="${options.publicUrl}/.well-known/oauth-protected-resource", error="invalid_token", scope="mcp"`);
        return reply.code(401).send({ error: 'invalid_token' });
      }
      if (err instanceof InvalidAccessTokenError) {
        return reply.unauthorized(err.message);
      }
      throw err;
    }

    const server = createMcpServer(options.serverDeps);
    // Omitting `sessionIdGenerator` (rather than setting it to `undefined`,
    // which `exactOptionalPropertyTypes` rejects here) already means
    // stateless mode per the SDK's own docs — no session tracking, matching
    // this route's fresh-server-per-request design.
    const transport = new StreamableHTTPServerTransport({});
    // The SDK's own optional-property declarations (e.g. `onclose?: () =>
    // void`) don't satisfy this repo's `exactOptionalPropertyTypes` when
    // structurally checked against `Transport` — `transport` does
    // implement it (the class declares `implements Transport`), so this
    // is a type-declaration mismatch between libraries, not a real
    // incompatibility.
    await server.connect(transport as unknown as Transport);

    reply.hijack();
    reply.raw.on('close', () => {
      transport.close().catch(() => undefined);
      server.close().catch(() => undefined);
    });

    const rawRequest = request.raw as IncomingMessage & { auth?: AuthInfo };
    rawRequest.auth = authInfo;
    await transport.handleRequest(rawRequest, reply.raw, request.body);
  });

  app.get('/mcp', async (_request, reply) => {
    reply.code(405).send(methodNotAllowed());
  });

  app.delete('/mcp', async (_request, reply) => {
    reply.code(405).send(methodNotAllowed());
  });
}
