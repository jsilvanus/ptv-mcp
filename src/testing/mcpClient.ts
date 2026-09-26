import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { FastifyInstance } from 'fastify';

/**
 * A real `@modelcontextprotocol/sdk` client over Streamable HTTP, talking
 * to `/mcp` on a listening app (see `listenLocally`) with an MCP OAuth
 * access token (`IntegrationFixtures.mcpToken`).
 */
export async function connectMcpClient(
  baseUrl: string,
  token: string,
  clientName = 'test-client',
): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL('/mcp', baseUrl), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: clientName, version: '1.0.0' });
  // See src/mcp/httpTransport.ts's identical cast note: the SDK's own
  // optional-property declarations don't satisfy exactOptionalPropertyTypes
  // here, though the class does implement Transport structurally.
  await client.connect(transport as unknown as Transport);
  return client;
}

/** The first text content of a tool result (a tool error's message, or its JSON). */
export function toolText(result: unknown): string | undefined {
  const content = (result as { content?: Array<{ type?: string; text?: string }> }).content ?? [];
  return content[0]?.text;
}

/** A successful tool result's JSON payload. */
export function toolJson<T>(result: unknown): T {
  const content = (result as { content?: Array<{ type?: string; text?: string }> }).content ?? [];
  const [first] = content;
  if (!first || first.type !== 'text' || typeof first.text !== 'string') {
    throw new Error('Expected text tool content');
  }
  return JSON.parse(first.text) as T;
}

export interface InjectedToolResult {
  isError?: boolean;
  content: { type: string; text: string }[];
}

/**
 * Calls an MCP tool through `app.inject` (no listening socket) as a single
 * JSON-RPC `tools/call`. `data` is the parsed JSON text, or the plain text
 * of an error message.
 */
export async function injectToolCall(
  app: FastifyInstance,
  mcpToken: string,
  name: string,
  args: Record<string, unknown>,
): Promise<{ statusCode: number; result: InjectedToolResult; data: unknown }> {
  const res = await app.inject({
    method: 'POST',
    url: '/mcp',
    headers: {
      authorization: `Bearer ${mcpToken}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } },
  });
  const raw = res.body.trim().startsWith('{')
    ? res.body
    : res.body
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5))
        .join('');
  const result = (JSON.parse(raw) as { result: InjectedToolResult }).result;
  const text = result.content[0]?.text ?? '';
  let data: unknown = text;
  try {
    data = JSON.parse(text);
  } catch {
    // plain-text error message
  }
  return { statusCode: res.statusCode, result, data };
}
