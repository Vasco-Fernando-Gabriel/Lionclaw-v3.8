
import { describe, it, expect } from 'vitest';
import { buildLionMcpCatalogPrompt, parsePrefixedMcpName } from '../prompt';
import type { LionMcpToolEntry } from '../prompt';
import type { OllamaToolSchema } from '../../ollama-client';

function toolsToEntries(tools: OllamaToolSchema[]): LionMcpToolEntry[] {
  const entries: LionMcpToolEntry[] = [];
  for (const t of tools) {
    const parsed = parsePrefixedMcpName(t.function.name);
    if (!parsed) continue;
    const required = (t.function.parameters?.required ?? []) as string[];
    const props = (t.function.parameters?.properties ?? {}) as Record<
      string,
      { type?: string; description?: string }
    >;
    entries.push({
      serverId: parsed.serverId,
      toolName: parsed.toolName,
      description: t.function.description,
      args: Object.entries(props).map(([name, prop]) => ({
        name,
        type: prop?.type,
        description: prop?.description,
        required: required.includes(name),
      })),
      requiredArgs: required.map((name) => ({
        name,
        type: props[name]?.type,
        description: props[name]?.description,
      })),
    });
  }
  return entries;
}

const MOCK_TOOLS: OllamaToolSchema[] = [
  {
    type: 'function',
    function: {
      name: 'mcp__google-gmail__send_message',
      description: 'Send an email via Gmail.',
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'Recipient email' },
          subject: { type: 'string', description: 'Email subject' },
          body: { type: 'string', description: 'Email body' },
        },
        required: ['to', 'subject', 'body'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'mcp__google-gmail__list_messages',
      description: 'List recent Gmail messages.',
      parameters: {
        type: 'object',
        properties: {
          maxResults: { type: 'number', description: 'Max messages to return' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'mcp__knowledge-base__search',
      description: 'Search the knowledge base for relevant documents.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
          limit: { type: 'number', description: 'Max results' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'mcp__lionclaw-agents__call_agent',
      description: 'Dispatch a LionClaw subagent by id.',
      parameters: {
        type: 'object',
        properties: {
          agent_id: { type: 'string', description: 'Agent identifier' },
          task: { type: 'string', description: 'Task description' },
        },
        required: ['agent_id', 'task'],
      },
    },
  },
];

describe('buildLionMcpCatalogPrompt', () => {
  it('snapshot - 3 servers with real tool names and args', () => {
    const entries = toolsToEntries(MOCK_TOOLS);
    const output = buildLionMcpCatalogPrompt(entries);
    expect(output).toMatchSnapshot();
  });

  it('groups tools by server', () => {
    const entries = toolsToEntries(MOCK_TOOLS);
    const output = buildLionMcpCatalogPrompt(entries);
    expect(output).toContain('### server: `google-gmail`');
    expect(output).toContain('### server: `knowledge-base`');
    expect(output).toContain('### server: `lionclaw-agents`');
  });

  it('emits real tool names (not placeholder)', () => {
    const entries = toolsToEntries(MOCK_TOOLS);
    const output = buildLionMcpCatalogPrompt(entries);
    expect(output).toContain('`send_message`');
    expect(output).toContain('`list_messages`');
    expect(output).toContain('`search`');
    expect(output).toContain('`call_agent`');
    expect(output).not.toContain('<see mcp_call>');
  });

  it('emits args with types, descriptions and required markers', () => {
    const entries = toolsToEntries(MOCK_TOOLS);
    const output = buildLionMcpCatalogPrompt(entries);
    expect(output).toContain('`to`: string (required) - Recipient email');
    expect(output).toContain('`maxResults`: number (optional) - Max messages to return');
    expect(output).toContain('`query`: string (required) - Search query');
    expect(output).toContain('`agent_id`: string (required) - Agent identifier');
  });

  it('emits optional args for tools with no required args', () => {
    const entries = toolsToEntries(MOCK_TOOLS);
    const output = buildLionMcpCatalogPrompt(entries);
    const lines = output.split('\n');
    const listMsgIdx = lines.findIndex((l) => l.includes('`list_messages`'));
    expect(listMsgIdx).toBeGreaterThan(-1);
    expect(lines[listMsgIdx + 1]).toBe('  args:');
    expect(lines[listMsgIdx + 2]).toContain('`maxResults`: number (optional)');
  });

  it('truncates description to 200 chars', () => {
    const longDesc = 'A'.repeat(250);
    const entries: LionMcpToolEntry[] = [
      {
        serverId: 'test-server',
        toolName: 'test_tool',
        description: longDesc,
        requiredArgs: [],
      },
    ];
    const output = buildLionMcpCatalogPrompt(entries);
    const truncated = 'A'.repeat(200);
    expect(output).toContain(truncated);
    expect(output).not.toContain('A'.repeat(201));
  });

  it('returns (no active MCPs) when empty array', () => {
    expect(buildLionMcpCatalogPrompt([])).toBe('## Available MCP Tools\n\n(no active MCPs)');
  });
});
