import { readFileSync } from 'node:fs';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, GetPromptResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

/**
 * Human-written guidance served over MCP: PTV content-production rules
 * (condensed from DVV's kehittajille.suomi.fi guidelines), onboarding,
 * API credentials, AI-compliance rules and the two ptv-mcp skills. The
 * Markdown lives outside `src/` (`guides/`, `skills/`) so it stays
 * readable and editable on its own; paths resolve from the repo root,
 * which is two levels up from both `src/mcp/` and `dist/mcp/`.
 */
export const GUIDE_TOPICS = [
  'getting-started',
  'content-quality',
  'api-credentials',
  'ai-compliance',
  'ptv-mcp-admin',
  'ptv-mcp-workflow',
] as const;

export type GuideTopic = (typeof GUIDE_TOPICS)[number];

interface GuideDefinition {
  file: string;
  title: string;
  description: string;
}

const GUIDES: Record<GuideTopic, GuideDefinition> = {
  'getting-started': {
    file: 'guides/getting-started-with-ptv.md',
    title: 'Getting started with PTV',
    description:
      'How an organisation (e.g. a parish) starts using PTV: DVV permit, PTV roles, training, and the order to describe content in. Prerequisite for using this MCP.',
  },
  'content-quality': {
    file: 'guides/content-quality.md',
    title: 'Writing good PTV content',
    description:
      "DVV's rules for writing PTV services, channels, organisations, connections and classifications, plus a review checklist with check IDs for quality-checking drafts and published content.",
  },
  'api-credentials': {
    file: 'guides/api-credentials.md',
    title: 'PTV API credentials',
    description:
      'How PTV API credentials are obtained and entered in this MCP. v12 instructions are pending from DVV; v11 is intentionally not documented.',
  },
  'ai-compliance': {
    file: 'guides/ai-compliance.md',
    title: 'AI compliance and editorial responsibility',
    description:
      'Binding rules for AI-assisted PTV content (EU AI Act Art. 50(4) human-review exception, Art. 4 AI literacy, personal data): the human sees and approves every change.',
  },
  'ptv-mcp-admin': {
    file: 'skills/ptv-mcp-admin/SKILL.md',
    title: 'ptv-mcp administration',
    description:
      'Set up ptv-mcp for an organisation: server settings, users, tenants, roles, PTV connections, connecting an AI client, troubleshooting.',
  },
  'ptv-mcp-workflow': {
    file: 'skills/ptv-mcp-workflow/SKILL.md',
    title: 'PTV content workflow',
    description:
      'Day-to-day workflow: look up current data, draft proposals, quality review, human approval, apply or export, follow-up.',
  },
};

const repoRoot = new URL('../../', import.meta.url);
const cache = new Map<GuideTopic, string>();

export function isGuideTopic(value: string): value is GuideTopic {
  return (GUIDE_TOPICS as readonly string[]).includes(value);
}

/** Guide text without any YAML frontmatter (skills carry one for skill loaders). */
export function readGuide(topic: GuideTopic): string {
  const cached = cache.get(topic);
  if (cached !== undefined) return cached;
  const raw = readFileSync(new URL(GUIDES[topic].file, repoRoot), 'utf8');
  const text = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n+/, '');
  cache.set(topic, text);
  return text;
}

export function guideUri(topic: GuideTopic): string {
  return `ptv-guide://${topic}`;
}

/**
 * Server-level instructions sent at MCP initialization. Kept short: the
 * non-negotiables plus where to find the detail.
 */
export const SERVER_INSTRUCTIONS = [
  "ptv-mcp manages an organisation's content in Suomi.fi Palvelutietovaranto (PTV), Finland's national service catalogue. PTV content is public, openly reused information.",
  'All writes are two-phase: you only draft proposals; a human with the right role reviews and approves them. Never call ptv_resolve_proposal or ptv_apply_changes unless the user has seen the full diff (every field, every language) and explicitly asked to approve or apply that specific proposal. This human review is what makes AI-assisted publishing lawful under EU AI Act Art. 50(4).',
  'Never invent facts (opening hours, prices, phone numbers, eligibility); mark anything unverified. Never ask for or repeat API keys, passwords or tokens. Never put personal names in PTV content.',
  `Before drafting or reviewing content, read the guides with ptv_get_guide (topics: ${GUIDE_TOPICS.join(', ')}) — especially content-quality (writing rules + review checklist), ai-compliance and ptv-mcp-workflow. For setup questions use ptv-mcp-admin, getting-started and api-credentials.`,
].join('\n\n');

function promptText(text: string): GetPromptResult {
  return { messages: [{ role: 'user', content: { type: 'text', text } }] };
}

/**
 * Registers the guides as a read-only tool (most widely supported by MCP
 * clients), as static `ptv-guide://` resources, and as prompts for the
 * common entry points. None of these touch PTV, the DB or tenant data, so
 * they need no tool context.
 */
export function registerGuides(server: McpServer): void {
  server.registerTool(
    'ptv_get_guide',
    {
      description: `Read one of ptv-mcp's guides. Topics: ${GUIDE_TOPICS.map((t) => `${t} (${GUIDES[t].title})`).join('; ')}. Read content-quality before drafting or reviewing PTV content, and ai-compliance before any approval.`,
      inputSchema: { topic: z.enum(GUIDE_TOPICS) },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ topic }): Promise<CallToolResult> => ({
      content: [{ type: 'text', text: readGuide(topic) }],
    }),
  );

  for (const topic of GUIDE_TOPICS) {
    const guide = GUIDES[topic];
    server.registerResource(
      `ptv_guide_${topic.replaceAll('-', '_')}`,
      guideUri(topic),
      { title: guide.title, description: guide.description, mimeType: 'text/markdown' },
      async () => ({
        contents: [{ uri: guideUri(topic), mimeType: 'text/markdown', text: readGuide(topic) }],
      }),
    );
  }

  server.registerPrompt(
    'ptv_review_content',
    {
      title: 'Review PTV content quality',
      description:
        'Check a PTV service, channel or organisation (by id) or a pasted draft against the PTV content-quality checklist.',
      argsSchema: {
        target: z
          .string()
          .describe('A PTV service/channel/organisation id, or the draft text to review'),
      },
    },
    ({ target }) =>
      promptText(
        [
          'Review the following PTV content against the guide below. If the target is an id, fetch it first with ptv_get_service, ptv_get_channel or ptv_get_organisation. Check every language version separately. Report a table of check ID, result (PASS/FAIL/N/A), field and language, and suggested fix, then list facts that need human confirmation. Do not create proposals unless asked.',
          `Target: ${target}`,
          '---',
          readGuide('content-quality'),
        ].join('\n\n'),
      ),
  );

  server.registerPrompt(
    'ptv_content_workflow',
    {
      title: 'Maintain PTV content',
      description:
        'Start a propose → review → approve → publish session for PTV content, following the workflow and AI-compliance rules.',
    },
    () =>
      promptText(
        [
          'Help me maintain our PTV content with ptv-mcp. Follow this workflow and the AI-compliance rules below; read the content-quality guide with ptv_get_guide before drafting. Start by asking what I want to change.',
          readGuide('ptv-mcp-workflow'),
          '---',
          readGuide('ai-compliance'),
        ].join('\n\n'),
      ),
  );

  server.registerPrompt(
    'ptv_admin_setup',
    {
      title: 'Set up ptv-mcp',
      description:
        'Walk a Tenant Admin through PTV onboarding and ptv-mcp setup: users, roles, PTV connections and connecting an AI client.',
    },
    () =>
      promptText(
        [
          'Walk me through setting up ptv-mcp for our organisation, one step at a time, checking prerequisites as we go. Never ask me for passwords, API keys or tokens.',
          readGuide('ptv-mcp-admin'),
          '---',
          readGuide('getting-started'),
          '---',
          readGuide('api-credentials'),
        ].join('\n\n'),
      ),
  );
}
