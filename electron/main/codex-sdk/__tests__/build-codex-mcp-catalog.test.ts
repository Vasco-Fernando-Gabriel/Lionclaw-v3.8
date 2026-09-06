
import { describe, it, expect } from 'vitest';
import { buildCodexMcpCatalogPrompt } from '../prompt';

describe('buildCodexMcpCatalogPrompt', () => {
  it('returns no-active-MCPs fallback when list is empty', () => {
    const result = buildCodexMcpCatalogPrompt([]);
    expect(result).toMatchInlineSnapshot(`"## Available MCP Servers\n\n(no active MCPs)"`);
  });

  it('returns single server entry with description', () => {
    const result = buildCodexMcpCatalogPrompt([
      { id: 'google-gmail', description: 'Gmail integration' },
    ]);
    expect(result).toMatchInlineSnapshot(`
      "## Available MCP Servers

      - \`google-gmail\` - Gmail integration"
    `);
  });

  it('returns single server entry without description', () => {
    const result = buildCodexMcpCatalogPrompt([
      { id: 'knowledge-base' },
    ]);
    expect(result).toMatchInlineSnapshot(`
      "## Available MCP Servers

      - \`knowledge-base\`"
    `);
  });

  it('returns three server entries with mixed description presence', () => {
    const result = buildCodexMcpCatalogPrompt([
      { id: 'google-gmail', description: 'Gmail integration' },
      { id: 'knowledge-base' },
      { id: 'elevenlabs', description: 'Text to speech via ElevenLabs' },
    ]);
    expect(result).toMatchInlineSnapshot(`
      "## Available MCP Servers

      - \`google-gmail\` - Gmail integration
      - \`knowledge-base\`
      - \`elevenlabs\` - Text to speech via ElevenLabs"
    `);
  });

  it('snapshot: 0 servers', () => {
    expect(buildCodexMcpCatalogPrompt([])).toMatchSnapshot();
  });

  it('snapshot: 1 server', () => {
    expect(
      buildCodexMcpCatalogPrompt([{ id: 'excalidraw', description: 'Diagram tool' }]),
    ).toMatchSnapshot();
  });

  it('snapshot: 3 servers', () => {
    expect(
      buildCodexMcpCatalogPrompt([
        { id: 'google-calendar', description: 'Google Calendar' },
        { id: 'memory-search', description: 'Semantic memory search' },
        { id: 'custom-mcp' },
      ]),
    ).toMatchSnapshot();
  });
});
