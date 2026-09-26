import type { IncomingMessage } from 'node:http';
import type { FastifyInstance } from 'fastify';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
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
 * Mounts the MCP tool surface at `POST /mcp`. Bearer tokens are verified
 * when present, but authentication is intentionally enforced by the tool
 * layer so unauthenticated tool calls can return the MCP OAuth challenge
 * required by ChatGPT — tenant/environment for each call is a tool argument
 * instead (see
 * toolContext.ts), since this transport is deliberately stateless: a
 * fresh `McpServer` + `StreamableHTTPServerTransport` per request, exactly
 * the pattern the SDK's own stateless example uses
 * (`examples/server/simpleStatelessStreamableHttp`), rather than tracking
 * a session across calls.
 */
export async function mcpRoutes(app: FastifyInstance, options: McpRouteOptions): Promise<void> {
  app.post('/mcp', async (request, reply) => {
    const header = request.headers.authorization;
    let authInfo: AuthInfo | undefined;

    // Authentication is deliberately deferred to the tool layer. ChatGPT's
    // tool-level OAuth flow needs to receive an MCP tool error containing
    // `_meta["mcp/www_authenticate"]`; rejecting POST /mcp with HTTP 401 here
    // would prevent the tool handler from ever producing that challenge.
    if (header?.startsWith('Bearer ')) {
      try {
        const payload = await options.oauthService.verifyAccessToken(
          header.slice('Bearer '.length),
        );
        authInfo = {
          token: header,
          clientId: payload.clientId ?? 'oauth-client',
          scopes: payload.scope ? payload.scope.split(' ') : [],
          extra: {
            userId: payload.sub,
            ...(payload.tenantId ? { tenantId: payload.tenantId } : {}),
            ...(payload.environment ? { environment: payload.environment } : {}),
            ...(payload.readApiVersion ? { readApiVersion: payload.readApiVersion } : {}),
            ...(payload.writeApiVersion ? { writeApiVersion: payload.writeApiVersion } : {}),
          },
        };
      } catch (err) {
        // verifyAccessToken() turns every Error into Error('invalid_token').
        if (!(err instanceof Error && err.message === 'invalid_token')) throw err;
        // Invalid bearer tokens are treated like missing credentials below;
        // the tool handler will return the OAuth challenge.
      }
    }

    const server = createMcpServer({ ...options.serverDeps, publicUrl: options.publicUrl });
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
    if (authInfo) {
      rawRequest.auth = authInfo;
    }
    await transport.handleRequest(rawRequest, reply.raw, request.body);
  });

  // ChatGPT's connector probing may issue HEAD before attempting Streamable
  // HTTP POST. HEAD is not an MCP message and must not require authentication.
  app.head('/mcp', async (_request, reply) => {
    return reply.code(200).send();
  });

  app.get('/mcp', async (_request, reply) => {
    reply.code(405).send(methodNotAllowed());
  });

  app.delete('/mcp', async (_request, reply) => {
    reply.code(405).send(methodNotAllowed());
  });
}
