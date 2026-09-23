import { describe, expect, it } from 'vitest';
import { parseContentBlocks, parseFencedBlocks, parseNativeToolCalls, parseToolCallBatch } from '../tool-parser';

describe('Lion-SDK tool-parser', () => {
  describe('native function calls', () => {
    it('parses OpenAI-style function calls with string arguments', () => {
      const out = parseNativeToolCalls([
        {
          id: 'call_1',
          type: 'function',
          function: {
            name: 'Read',
            arguments: JSON.stringify({ file_path: '/tmp/a.txt' }),
          },
        },
      ]);
      expect(out).toHaveLength(1);
      expect(out[0]?.name).toBe('Read');
      expect(out[0]?.input).toEqual({ file_path: '/tmp/a.txt' });
      expect(out[0]?.isError).toBeUndefined();
    });

    it('parses Ollama-style function calls with object arguments', () => {
      const out = parseNativeToolCalls([
        {
          id: 'call_2',
          type: 'function',
          function: {
            name: 'Glob',
            arguments: { pattern: '**/*.ts' },
          },
        },
      ]);
      expect(out).toHaveLength(1);
      expect(out[0]?.input).toEqual({ pattern: '**/*.ts' });
    });

    it('resolves Task alias to Agent', () => {
      const out = parseNativeToolCalls([
        {
          id: 'call_x',
          type: 'function',
          function: { name: 'Task', arguments: JSON.stringify({ agent_id: 'a', task: 't' }) },
        },
      ]);
      expect(out[0]?.name).toBe('Agent');
      expect(out[0]?.isError).toBeUndefined();
    });

    it('marks calls with missing required fields as error', () => {
      const out = parseNativeToolCalls([
        {
          id: 'call_bad',
          type: 'function',
          function: { name: 'Read', arguments: '{}' },
        },
      ]);
      expect(out[0]?.isError).toBe(true);
      expect(out[0]?.errorMessage).toMatch(/file_path/);
    });

    it('marks unknown tool with explicit message', () => {
      const out = parseNativeToolCalls([
        {
          id: 'call_unk',
          type: 'function',
          function: { name: 'NoSuchTool', arguments: '{}' },
        },
      ]);
      expect(out[0]?.isError).toBe(true);
      expect(out[0]?.errorMessage).toMatch(/Unknown tool: NoSuchTool/);
    });

    it('marks malformed JSON arguments as error', () => {
      const out = parseNativeToolCalls([
        {
          id: 'call_bad_args',
          type: 'function',
          function: { name: 'Read', arguments: '{not valid json' },
        },
      ]);
      expect(out[0]?.isError).toBe(true);
      expect(out[0]?.errorMessage).toMatch(/Argumentos invalidos/);
    });
  });

  describe('Anthropic content blocks', () => {
    it('parses tool_use blocks and extracts remaining text', () => {
      const r = parseContentBlocks([
        { type: 'text', text: 'hello world' },
        { type: 'tool_use', id: 'b1', name: 'Read', input: { file_path: '/a' } },
      ]);
      expect(r.calls).toHaveLength(1);
      expect(r.calls[0]?.name).toBe('Read');
      expect(r.remainingText).toBe('hello world');
    });
  });

  describe('fenced fallback parsing', () => {
    it('parses a single fenced lion_tool_use block', () => {
      const text = `Some prose.
\`\`\`lion_tool_use
{ "calls": [{ "id": "x", "name": "Read", "input": { "file_path": "/abs" } }] }
\`\`\`
Trailing.`;
      const r = parseFencedBlocks(text);
      expect(r.calls).toHaveLength(1);
      expect(r.calls[0]?.name).toBe('Read');
      expect(r.remainingText).toMatch(/Some prose\./);
      expect(r.remainingText).toMatch(/Trailing\./);
      expect(r.remainingText).not.toContain('lion_tool_use');
    });

    it('parses uppercase fenced LION_TOOL_USE blocks from OpenAI-compatible fallbacks', () => {
      const text = `\`\`\`LION_TOOL_USE
{ "calls": [{ "id": "x", "name": "memory_search", "input": { "query": "onboarding" } }] }
\`\`\``;
      const r = parseFencedBlocks(text);
      expect(r.calls).toHaveLength(1);
      expect(r.calls[0]?.name).toBe('memory_search');
      expect(r.calls[0]?.input).toEqual({ query: 'onboarding' });
    });

    it('emits an error call when fenced JSON is malformed', () => {
      const text = `\`\`\`lion_tool_use
{ "calls": [ MALFORMED }
\`\`\``;
      const r = parseFencedBlocks(text);
      expect(r.calls).toHaveLength(1);
      expect(r.calls[0]?.isError).toBe(true);
      expect(r.calls[0]?.errorMessage).toMatch(/JSON invalido/);
    });

    it('emits an error call when fenced block is missing calls', () => {
      const text = `\`\`\`lion_tool_use
{ "foo": "bar" }
\`\`\``;
      const r = parseFencedBlocks(text);
      expect(r.calls).toHaveLength(1);
      expect(r.calls[0]?.isError).toBe(true);
    });

    it('returns text untouched when no fenced block is present', () => {
      const r = parseFencedBlocks('plain text');
      expect(r.calls).toHaveLength(0);
      expect(r.remainingText).toBe('plain text');
    });
  });

  describe('combined parseToolCallBatch', () => {
    it('merges native + fenced + content blocks', () => {
      const r = parseToolCallBatch({
        nativeToolCalls: [{ type: 'function', function: { name: 'Read', arguments: '{"file_path":"/a"}' } }],
        contentBlocks: [{ type: 'tool_use', id: 'b', name: 'Glob', input: { pattern: '**/*.ts' } }],
        text: '```lion_tool_use\n{"calls":[{"id":"c","name":"Grep","input":{"pattern":"foo"}}]}\n```',
      });
      const names = r.calls.map((c) => c.name).sort();
      expect(names).toEqual(['Glob', 'Grep', 'Read']);
    });
  });
});
