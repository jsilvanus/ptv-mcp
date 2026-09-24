import { describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  GUIDE_TOPICS,
  guideUri,
  isGuideTopic,
  readGuide,
  registerGuides,
  SERVER_INSTRUCTIONS,
} from './guides.js';

async function connectedClient(): Promise<Client> {
  const server = new McpServer(
    { name: 'ptv-mcp', version: '0.1.0' },
    { instructions: SERVER_INSTRUCTIONS },
  );
  registerGuides(server);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

describe('guides', () => {
  it('loads every guide from disk without YAML frontmatter', () => {
    for (const topic of GUIDE_TOPICS) {
      const text = readGuide(topic);
      expect(text.length).toBeGreaterThan(500);
      expect(text.startsWith('---')).toBe(false);
      expect(text.startsWith('# ')).toBe(true);
    }
  });

  it('recognises only known topics', () => {
    expect(isGuideTopic('content-quality')).toBe(true);
    expect(isGuideTopic('../package.json')).toBe(false);
  });

  it('keeps the review checklist ids the prompts and instructions rely on', () => {
    const quality = readGuide('content-quality');
    for (const id of ['Q-STRUCT-1', 'Q-SUM-1', 'Q-CLASS-1', 'Q-STYLE-4', 'Q-FACT-1']) {
      expect(quality).toContain(id);
    }
  });

  it('sends instructions that forbid unapproved writes', async () => {
    const client = await connectedClient();
    const instructions = client.getInstructions() ?? '';
    expect(instructions).toContain('ptv_resolve_proposal');
    expect(instructions).toContain('ptv_get_guide');
    await client.close();
  });

  it('serves guides through the ptv_get_guide tool', async () => {
    const client = await connectedClient();
    const result = await client.callTool({
      name: 'ptv_get_guide',
      arguments: { topic: 'ai-compliance' },
    });
    const content = result.content as { type: string; text: string }[];
    expect(content[0]?.text).toContain('Art. 50(4)');

    const invalid = await client.callTool({
      name: 'ptv_get_guide',
      arguments: { topic: 'nope' },
    });
    expect(invalid.isError).toBe(true);
    await client.close();
  });

  it('lists and reads every guide as a resource', async () => {
    const client = await connectedClient();
    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri)).toEqual(
      expect.arrayContaining(GUIDE_TOPICS.map((t) => guideUri(t))),
    );
    const read = await client.readResource({ uri: guideUri('ptv-mcp-admin') });
    const first = read.contents[0] as { mimeType?: string; text: string };
    expect(first.mimeType).toBe('text/markdown');
    expect(first.text).toContain('Tenant Admin');
    await client.close();
  });

  it('builds the review prompt around the target and the checklist', async () => {
    const client = await connectedClient();
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name)).toEqual(
      expect.arrayContaining(['ptv_review_content', 'ptv_content_workflow', 'ptv_admin_setup']),
    );
    const prompt = await client.getPrompt({
      name: 'ptv_review_content',
      arguments: { target: 'af60add0-c3be-40f6-9c22-3e29c2b8da0a' },
    });
    const message = prompt.messages[0]?.content as { type: string; text: string };
    expect(message.text).toContain('af60add0-c3be-40f6-9c22-3e29c2b8da0a');
    expect(message.text).toContain('Q-STYLE-1');
    await client.close();
  });
});
