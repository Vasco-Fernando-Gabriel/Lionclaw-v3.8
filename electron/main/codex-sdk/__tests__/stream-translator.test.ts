import { beforeEach, describe, it, expect, vi } from 'vitest';
import type { CodexResponse } from '../../codex-runtime/types';
import type { ArtifactData, StreamChunk } from '../../../../src/types';

vi.mock('../../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../../db', () => ({
  insertAuditEntry: vi.fn(),
  upsertActivityLog: vi.fn(),
}));

vi.mock('../../artifact-detector', () => ({
  captureToolUse: vi.fn(() => null),
  captureToolResult: vi.fn(() => null),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

const ALLOWED_STREAM_CHUNK_TYPES: ReadonlyArray<StreamChunk['type']> = [
  'text',
  'tool_call',
  'tool_result',
  'error',
  'done',
  'confirm_request',
  'ask_question',
  'usage',
  'session',
  'onboarding_completed',
  'replace_content',
  'artifact',
  'compacting',
  'activity',
];

describe('codex stream-translator (SP-9.10)', () => {
  it('emits only existing StreamChunk types and drops onReasoning', async () => {
    const { createCodexStreamTranslator } = await import('../stream-translator');
    const emitted: StreamChunk[] = [];
    const translator = createCodexStreamTranslator({
      sessionId: 'sess-1',
      emit: (chunk) => emitted.push(chunk),
    });

    translator.callbacks.onText?.('hello ');
    translator.callbacks.onText?.('world');
    translator.callbacks.onReasoning?.('thought: should drop');
    translator.callbacks.onToolUse?.('Bash');
    translator.callbacks.onToolUseComplete?.('Bash', {
      command: 'node -v',
      exitCode: 0,
    });

    const response: CodexResponse = {
      threadId: 'thread-1',
      content: 'hello world',
      filesChanged: [],
      commandsRun: [],
      usage: {
        inputTokens: 10,
        cachedInputTokens: 0,
        outputTokens: 5,
        reasoningOutputTokens: 0,
        totalTokens: 15,
      },
      status: 'completed',
      applyPatchFailures: 0,
      applyPatchFailureSamples: [],
    };
    translator.finalize(response);

    for (const chunk of emitted) {
      expect(ALLOWED_STREAM_CHUNK_TYPES).toContain(chunk.type);
    }
    expect(emitted.some((c) => c.type === ('thinking' as unknown as StreamChunk['type']))).toBe(false);
    expect(emitted.some((c) => c.type === ('tool_start' as unknown as StreamChunk['type']))).toBe(false);

    expect(emitted).toHaveLength(8);

    expect(emitted[0]).toEqual({ type: 'text', content: 'hello ' });
    expect(emitted[1]).toEqual({ type: 'text', content: 'world' });
    expect(emitted[2]).toEqual({
      type: 'tool_call',
      tool: 'Bash',
      toolCallId: expect.any(String),
      input: {},
    });
    expect(emitted[3].type).toBe('activity');
    expect(emitted[3].activity?.kind).toBe('tool');
    expect(emitted[3].activity?.phase).toBe('start');
    expect(emitted[3].activity?.label).toBe('Bash');
    expect(emitted[4].type).toBe('tool_result');
    expect(emitted[4].tool).toBe('Bash');
    expect(typeof emitted[4].result).toBe('string');
    expect(emitted[5].type).toBe('activity');
    expect(emitted[5].activity?.phase).toBe('end');
    expect(emitted[5].activity?.status).toBe('done');
    expect(emitted[5].activity?.command).toBe('node -v');
    expect(emitted[5].activity?.exitCode).toBe(0);
    expect(emitted[6].type).toBe('usage');
    expect(emitted[6].usage?.inputTokens).toBe(10);
    expect(emitted[6].usage?.outputTokens).toBe(5);
    expect(emitted[7]).toEqual({ type: 'done', content: 'sess-1' });
  });

  it('fail() emits a single error chunk with the message', async () => {
    const { createCodexStreamTranslator } = await import('../stream-translator');
    const emitted: StreamChunk[] = [];
    const translator = createCodexStreamTranslator({
      sessionId: 'sess-2',
      emit: (chunk) => emitted.push(chunk),
    });

    translator.fail(new Error('boom'));

    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toEqual({ type: 'error', error: 'boom' });
  });

  it('does not emit any chunk for onReasoning calls regardless of count', async () => {
    const { createCodexStreamTranslator } = await import('../stream-translator');
    const emitted: StreamChunk[] = [];
    const translator = createCodexStreamTranslator({
      sessionId: 'sess-3',
      emit: (chunk) => emitted.push(chunk),
    });

    translator.callbacks.onReasoning?.('thought A');
    translator.callbacks.onReasoning?.('thought B');
    translator.callbacks.onReasoning?.('thought C');

    expect(emitted).toHaveLength(0);
  });

  it('streams audit entries through onAuditEntry when Codex emits reasoning and tools', async () => {
    const db = await import('../../db');
    const { createCodexStreamTranslator } = await import('../stream-translator');
    const emitted: StreamChunk[] = [];
    const auditEntries: Array<Record<string, unknown>> = [];
    const translator = createCodexStreamTranslator({
      sessionId: 'sess-audit',
      subagent: 'codex-agent',
      emit: (chunk) => emitted.push(chunk),
      onAuditEntry: (entry) => auditEntries.push(entry),
    });

    translator.callbacks.onReasoning?.('reasoning text');
    translator.callbacks.onToolUse?.('Bash');
    translator.callbacks.onToolUseComplete?.('Bash', 'ok');

    expect(db.insertAuditEntry).toHaveBeenCalledTimes(3);
    expect(auditEntries).toEqual([
      {
        sessionId: 'sess-audit',
        subagent: 'codex-agent',
        eventType: 'tool_call',
        toolName: 'codex.reasoning',
        input: 'reasoning text',
      },
      {
        sessionId: 'sess-audit',
        subagent: 'codex-agent',
        eventType: 'tool_call',
        toolName: 'Bash',
      },
      {
        sessionId: 'sess-audit',
        subagent: 'codex-agent',
        eventType: 'tool_result',
        toolName: 'Bash',
        output: 'ok',
      },
    ]);
    expect(emitted).toHaveLength(4);
    expect(emitted[0]).toEqual({
      type: 'tool_call',
      tool: 'Bash',
      toolCallId: expect.any(String),
      input: {},
    });
    expect(emitted[1].type).toBe('activity');
    expect(emitted[1].activity?.phase).toBe('start');
    expect(emitted[1].activity?.label).toBe('Bash');
    expect(emitted[2]).toEqual({
      type: 'tool_result',
      tool: 'Bash',
      toolCallId: expect.any(String),
      result: 'ok',
    });
    expect(emitted[3].type).toBe('activity');
    expect(emitted[3].activity?.phase).toBe('end');
  });

  it('emits final response artifacts and exposes them for persistence', async () => {
    const artifactDetector = await import('../../artifact-detector');
    const artifact: ArtifactData = {
      id: 'artifact-1',
      type: 'image',
      title: 'Imagem: Codex feliz',
      toolName: 'nano-banana',
      data: {
        filePath: '/tmp/codex-feliz.png',
        imageBase64: 'abc',
        mimeType: 'image/png',
      },
    };
    vi.mocked(artifactDetector.captureToolResult).mockReturnValueOnce(artifact);

    const { createCodexStreamTranslator } = await import('../stream-translator');
    const emitted: StreamChunk[] = [];
    const persistedArtifacts: ArtifactData[] = [];
    const translator = createCodexStreamTranslator({
      sessionId: 'sess-4',
      emit: (chunk) => emitted.push(chunk),
      onArtifact: (found) => persistedArtifacts.push(found),
    });

    const response: CodexResponse = {
      threadId: 'thread-4',
      content: 'Imagem pronta: ![Codex feliz](/tmp/codex-feliz.png)',
      filesChanged: [],
      commandsRun: [],
      usage: {
        inputTokens: 1,
        cachedInputTokens: 0,
        outputTokens: 1,
        reasoningOutputTokens: 0,
        totalTokens: 2,
      },
      status: 'completed',
      applyPatchFailures: 0,
      applyPatchFailureSamples: [],
    };

    translator.finalize(response);

    expect(artifactDetector.captureToolResult).toHaveBeenCalledWith('codex-final-response', response.content, false);
    expect(emitted[0]).toEqual({ type: 'artifact', artifact });
    expect(persistedArtifacts).toEqual([artifact]);
    expect(emitted.at(-1)).toEqual({ type: 'done', content: 'sess-4' });
  });

  it('turns inline image generation results into artifacts without exposing base64 as tool text', async () => {
    const artifactDetector = await import('../../artifact-detector');
    const artifact: ArtifactData = {
      id: 'artifact-inline',
      type: 'image',
      title: 'Imagem: Codex feliz',
      toolName: 'codex.image_generation',
      data: {
        imageBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ',
        mimeType: 'image/png',
      },
    };
    vi.mocked(artifactDetector.captureToolResult).mockReturnValueOnce(artifact);

    const { createCodexStreamTranslator } = await import('../stream-translator');
    const emitted: StreamChunk[] = [];
    const translator = createCodexStreamTranslator({
      sessionId: 'sess-5',
      emit: (chunk) => emitted.push(chunk),
    });

    translator.callbacks.onToolUseComplete?.('ImageGeneration', {
      type: 'image_generation_result',
      imageBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ',
      mimeType: 'image/png',
      prompt: 'Codex feliz',
      toolName: 'codex.image_generation',
    });

    expect(emitted[0]).toEqual({ type: 'artifact', artifact });
    expect(emitted[1]).toEqual({
      type: 'tool_result',
      tool: 'ImageGeneration',
      toolCallId: expect.any(String),
      result: 'Imagem gerada: Codex feliz',
    });
    expect(emitted[1].result).not.toContain('iVBORw0KGgo');
  });
});

describe('codex stream-translator: atividade de tools MCP (BUG 1)', () => {
  it('start/end de mcp:<server>.<tool> registram e fecham a MESMA entrada (persistida)', async () => {
    const db = await import('../../db');
    const { createCodexStreamTranslator } = await import('../stream-translator');
    const emitted: StreamChunk[] = [];
    const translator = createCodexStreamTranslator({
      sessionId: 'sess-mcp',
      turnIndex: 3,
      emit: (chunk) => emitted.push(chunk),
    });

    const label = 'mcp:lionclaw-pipeline-control.pipeline_reply';
    translator.callbacks.onToolUse?.(label, { callId: 'call-1', kind: 'mcp' });
    translator.callbacks.onToolUseComplete?.(label, { ok: true }, { callId: 'call-1' });

    const activityChunks = emitted.filter((c) => c.type === 'activity');
    expect(activityChunks).toHaveLength(2);
    const [start, end] = activityChunks;
    expect(start.activity?.kind).toBe('tool');
    expect(start.activity?.phase).toBe('start');
    expect(start.activity?.label).toBe(label);
    expect(start.activity?.status).toBe('running');
    expect(end.activity?.phase).toBe('end');
    expect(end.activity?.label).toBe(label);
    expect(end.activity?.status).toBe('done');
    expect(end.activity?.id).toBe(start.activity?.id);

    expect(db.upsertActivityLog).toHaveBeenCalledTimes(2);
    const calls = vi.mocked(db.upsertActivityLog).mock.calls;
    expect(calls[0][0]).toBe('sess-mcp');
    expect(calls[0][1]).toBe(3);
    expect(calls[1][0]).toBe('sess-mcp');
    expect(calls[1][1]).toBe(3);
    expect(calls[0][2].id).toBe(calls[1][2].id);
    expect(calls[0][2].id).toBe(start.activity?.id);
  });

  it('duas chamadas MCP concorrentes concluidas em ordem INVERSA fecham cada uma a sua entrada', async () => {
    const { createCodexStreamTranslator } = await import('../stream-translator');
    const emitted: StreamChunk[] = [];
    const translator = createCodexStreamTranslator({
      sessionId: 'sess-mcp-conc',
      emit: (chunk) => emitted.push(chunk),
    });

    translator.callbacks.onToolUse?.('mcp:x.a', { callId: 'call-a', kind: 'mcp' });
    translator.callbacks.onToolUse?.('mcp:x.b', { callId: 'call-b', kind: 'mcp' });
    translator.callbacks.onToolUseComplete?.('mcp:x.b', 'ok-b', { callId: 'call-b' });
    translator.callbacks.onToolUseComplete?.('mcp:x.a', 'ok-a', { callId: 'call-a' });

    const activityChunks = emitted.filter((c) => c.type === 'activity');
    expect(activityChunks).toHaveLength(4);
    const startA = activityChunks.find((c) => c.activity?.phase === 'start' && c.activity?.label === 'mcp:x.a');
    const startB = activityChunks.find((c) => c.activity?.phase === 'start' && c.activity?.label === 'mcp:x.b');
    const endA = activityChunks.find((c) => c.activity?.phase === 'end' && c.activity?.label === 'mcp:x.a');
    const endB = activityChunks.find((c) => c.activity?.phase === 'end' && c.activity?.label === 'mcp:x.b');
    expect(endA?.activity?.id).toBe(startA?.activity?.id);
    expect(endB?.activity?.id).toBe(startB?.activity?.id);
    expect(startA?.activity?.id).not.toBe(startB?.activity?.id);
    expect(endA?.activity?.status).toBe('done');
    expect(endB?.activity?.status).toBe('done');

    const callA = emitted.find((c) => c.type === 'tool_call' && c.tool === 'mcp:x.a');
    const callB = emitted.find((c) => c.type === 'tool_call' && c.tool === 'mcp:x.b');
    const resultA = emitted.find((c) => c.type === 'tool_result' && c.tool === 'mcp:x.a');
    const resultB = emitted.find((c) => c.type === 'tool_result' && c.tool === 'mcp:x.b');
    expect(resultA?.toolCallId).toBe(callA?.toolCallId);
    expect(resultB?.toolCallId).toBe(callB?.toolCallId);
    expect(callA?.toolCallId).not.toBe(callB?.toolCallId);
  });

  it('par start/complete de mcp:lionclaw-agents.call_agent NAO registra atividade', async () => {
    const db = await import('../../db');
    const { createCodexStreamTranslator } = await import('../stream-translator');
    const emitted: StreamChunk[] = [];
    const translator = createCodexStreamTranslator({
      sessionId: 'sess-call-agent',
      emit: (chunk) => emitted.push(chunk),
    });

    const label = 'mcp:lionclaw-agents.call_agent';
    translator.callbacks.onToolUse?.(label, { callId: 'call-ca', kind: 'mcp' });
    translator.callbacks.onToolUseComplete?.(label, 'ok', { callId: 'call-ca' });

    expect(emitted.filter((c) => c.type === 'activity')).toHaveLength(0);
    expect(db.upsertActivityLog).not.toHaveBeenCalled();
    expect(emitted.filter((c) => c.type === 'tool_call')).toHaveLength(1);
    expect(emitted.filter((c) => c.type === 'tool_result')).toHaveLength(1);
  });
});
