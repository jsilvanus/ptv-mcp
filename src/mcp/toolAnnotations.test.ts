import { describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';
import { createMcpServer, type McpServerDeps } from './mcpServer.js';
import { MissingToolMetadataError, TOOL_METADATA, useToolMetadata } from './toolAnnotations.js';

async function listTools() {
  // Listing tools runs no handler, so the dependencies are never touched.
  const server = createMcpServer({} as McpServerDeps);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientTransport);
  const { tools } = await client.listTools();
  await client.close();
  return tools;
}

describe('tool annotations', () => {
  it('gives every tool a title and annotations, with no stale entries', async () => {
    const tools = await listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(Object.keys(TOOL_METADATA).sort());
    for (const tool of tools) {
      expect(tool.title, tool.name).toBe(TOOL_METADATA[tool.name]?.title);
      expect(tool.annotations?.readOnlyHint, tool.name).toBeTypeOf('boolean');
      expect(tool.annotations?.openWorldHint, tool.name).toBeTypeOf('boolean');
    }
  });

  it('marks only the tools that can write to PTV as destructive', async () => {
    const tools = await listTools();
    const destructive = tools
      .filter((tool) => tool.annotations?.destructiveHint)
      .map((t) => t.name);
    expect(destructive.sort()).toEqual(['ptv_apply_changes', 'ptv_resolve_proposal']);
    for (const tool of tools.filter((t) => !t.annotations?.readOnlyHint)) {
      expect(tool.annotations?.destructiveHint, tool.name).toBeTypeOf('boolean');
    }
  });

  it('marks search, get, list and check tools read-only', async () => {
    const tools = await listTools();
    for (const tool of tools) {
      if (/^ptv_(search|get|list|check|find)_|_(list|get)_|_my_/.test(tool.name)) {
        expect(tool.annotations?.readOnlyHint, tool.name).toBe(true);
      }
    }
  });

  it('refuses a tool without metadata', () => {
    const server = new McpServer({ name: 'test', version: '0.0.0' });
    useToolMetadata(server);
    expect(() =>
      server.registerTool('ptv_unknown', { inputSchema: { x: z.string() } }, async () => ({
        content: [],
      })),
    ).toThrow(MissingToolMetadataError);
  });
});
