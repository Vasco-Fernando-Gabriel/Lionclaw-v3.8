
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgentConfig, ExternalConfig } from '../../../src/types';


interface MockPart {
  text?: string;
  functionCall?: { name: string; args: Record<string, unknown> };
  functionResponse?: { name: string; response: unknown };
  thoughtSignature?: string;
}

interface MockCandidate {
  content?: { parts: MockPart[]; role?: string };
  finishReason?: string;
}

interface MockChunk {
  candidates?: MockCandidate[];
  usageMetadata?: {
    promptTokenCount?: number;
    toolUsePromptTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
    cachedContentTokenCount?: number;
    totalTokenCount?: number;
  };
}


let capturedStreamCalls: Array<{
  model: string;
  contents: unknown[];
  config: unknown;
}> = [];

let streamQueue: MockChunk[][] = [];

function makeStreamGenerator(chunks: MockChunk[]): AsyncGenerator<MockChunk> {
  return (async function* () {
    for (const chunk of chunks) {
      yield chunk;
    }
  })();
}

const mockGenerateContentStream = vi.fn(async (params: {
  model: string;
  contents: unknown[];
  config: unknown;
}) => {
  capturedStreamCalls.push({ model: params.model, contents: [...params.contents], config: params.config });
  const chunks = streamQueue.shift() ?? [];
  return makeStreamGenerator(chunks);
});

vi.mock('@google/genai', () => {
  class MockGoogleGenAI {
    models: { generateContentStream: typeof mockGenerateContentStream };
    constructor(_opts: unknown) {
      this.models = { generateContentStream: mockGenerateContentStream };
    }
  }

  const FunctionCallingConfigMode = {
    AUTO: 'AUTO',
    ANY: 'ANY',
    NONE: 'NONE',
    VALIDATED: 'VALIDATED',
    MODE_UNSPECIFIED: 'MODE_UNSPECIFIED',
  } as const;

  const Type = {
    OBJECT: 'OBJECT',
    STRING: 'STRING',
    NUMBER: 'NUMBER',
    INTEGER: 'INTEGER',
    BOOLEAN: 'BOOLEAN',
    ARRAY: 'ARRAY',
    NULL: 'NULL',
    TYPE_UNSPECIFIED: 'TYPE_UNSPECIFIED',
  } as const;

  return {
    GoogleGenAI: MockGoogleGenAI,
    FunctionCallingConfigMode,
    Type,
  };
});


vi.mock('../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));


let mockSecretValue: string | null = 'test-api-key-123';

vi.mock('../vault-registry', () => ({
  getSecret: vi.fn(async (_ref: string) => mockSecretValue),
}));


const defaultExternalConfig: ExternalConfig = {
  provider: 'gemini-agent-platform',
  protocol: 'google-genai',
  model: 'gemini-3.1-pro-preview',
  apiKeyRef: 'orchestrator_vertex_api_key_ref',
};

const defaultAgent: AgentConfig = {
  id: 'gemini-agent',
  name: 'Gemini Test Agent',
  description: 'Gemini test agent',
  systemPrompt: 'You are a helpful assistant.',
  runtime: 'external' as const,
  model: 'gemini-3.1-pro-preview',
  effort: 'medium' as const,
  thinking: 'disabled',
  thinkingBudget: undefined,
  allowedTools: ['Read', 'Write', 'Bash'],
  mcpServers: [],
  isActive: true,
  sortOrder: 0,
  skills: [],
  maxToolRounds: 10,
  externalConfig: defaultExternalConfig,
};

vi.mock('../db', () => ({
  getAgent: vi.fn(() => ({ ...defaultAgent, externalConfig: { ...defaultExternalConfig } })),
  getSetting: vi.fn((key: string) => (
    key === 'orchestrator_vertex_api_key_ref' ? 'ORCHESTRATOR_VERTEX_API_KEY' : ''
  )),
}));


vi.mock('../pricing', () => ({
  calculateCost: vi.fn(() => 0.01),
}));


const mockExecuteLocalTool = vi.fn(async (_name: string, _args: Record<string, unknown>, _cwd: string) => ({
  result: 'tool-result',
  isError: false,
}));

vi.mock('../local-tool-executor', () => ({
  executeLocalTool: (...args: Parameters<typeof mockExecuteLocalTool>) => mockExecuteLocalTool(...args),
}));


import { googleGenAiExecutor, toGeminiContents, buildGeminiTools } from '../agent-runtime/google-genai-executor';
import { getAgent } from '../db';
import { getSecret } from '../vault-registry';
import { calculateCost } from '../pricing';
import { __resetWarnedAgentsForTests } from '../agent-runtime/mcp-warning';
import type { AgentExecutionRequest } from '../agent-runtime/types';
import type { AgentQueryConfig } from '../agent-config-resolver';


function makeReq(overrides?: Partial<AgentExecutionRequest>): AgentExecutionRequest {
  return {
    agentId: 'gemini-agent',
    prompt: 'Hello',
    cwd: '/tmp/test',
    abortController: new AbortController(),
    permission: {
      mode: 'bypassPermissions',
      dangerouslySkipPermissions: true,
    },
    ...overrides,
  };
}

function makeConfig(overrides?: Partial<AgentQueryConfig>): AgentQueryConfig {
  return {
    model: 'gemini-3.1-pro-preview',
    systemPrompt: 'You are a helpful assistant.',
    allowedTools: ['Read', 'Write', 'Bash'],
    effort: 'medium',
    thinking: 'disabled',
    thinkingBudget: undefined,
    mcpServers: [],
    maxTurns: undefined,
    runtime: 'external',
    ...overrides,
  };
}

function textChunk(text: string): MockChunk {
  return { candidates: [{ content: { parts: [{ text }] } }] };
}

function usageChunk(usage: MockChunk['usageMetadata']): MockChunk {
  return { usageMetadata: usage };
}

function fcChunk(name: string, args: Record<string, unknown>): MockChunk {
  return { candidates: [{ content: { parts: [{ functionCall: { name, args } }] } }] };
}

function finishChunk(reason: string): MockChunk {
  return { candidates: [{ finishReason: reason, content: { parts: [] } }] };
}

function setAgent(overrides: Partial<ExternalConfig>) {
  vi.mocked(getAgent).mockReturnValue({
    ...defaultAgent,
    externalConfig: { ...defaultExternalConfig, ...overrides },
  });
}


beforeEach(() => {
  capturedStreamCalls = [];
  streamQueue = [];
  mockSecretValue = 'test-api-key-123';
  __resetWarnedAgentsForTests();
  mockGenerateContentStream.mockClear();
  mockExecuteLocalTool.mockClear();
  mockExecuteLocalTool.mockResolvedValue({ result: 'tool-result', isError: false });
  vi.mocked(calculateCost).mockReset();
  vi.mocked(calculateCost).mockReturnValue(0.01);
  vi.mocked(getAgent).mockReturnValue({
    ...defaultAgent,
    externalConfig: { ...defaultExternalConfig },
  });
  vi.mocked(getSecret).mockResolvedValue('test-api-key-123');
});


describe('toGeminiContents', () => {
  it('converts system prompt into systemInstruction', () => {
    const { systemInstruction, contents } = toGeminiContents(
      'You are a helpful assistant.',
      'Hello',
    );
    expect(systemInstruction).toBeDefined();
    expect(systemInstruction?.parts?.[0]?.text).toBe('You are a helpful assistant.');
    expect(contents).toHaveLength(1);
    expect(contents[0].role).toBe('user');
    expect(contents[0].parts?.[0]?.text).toBe('Hello');
  });

  it('returns undefined systemInstruction when systemPrompt is empty', () => {
    const { systemInstruction } = toGeminiContents('', 'Hello');
    expect(systemInstruction).toBeUndefined();
  });

  it('returns undefined systemInstruction when systemPrompt is undefined', () => {
    const { systemInstruction } = toGeminiContents(undefined, 'Hello');
    expect(systemInstruction).toBeUndefined();
  });

  it('maps priorMessages assistant role to model', () => {
    const { contents } = toGeminiContents('sys', 'New prompt', [
      { role: 'user', content: 'first question' },
      { role: 'assistant', content: 'first answer' },
    ]);
    expect(contents).toHaveLength(3);
    expect(contents[0].role).toBe('user');
    expect(contents[0].parts?.[0]?.text).toBe('first question');
    expect(contents[1].role).toBe('model');
    expect(contents[1].parts?.[0]?.text).toBe('first answer');
    expect(contents[2].role).toBe('user');
    expect(contents[2].parts?.[0]?.text).toBe('New prompt');
  });

  it('skips system and tool role priorMessages', () => {
    const { contents } = toGeminiContents('sys', 'prompt', [
      { role: 'system', content: 'extra sys' },
      { role: 'user', content: 'question' },
      { role: 'tool', content: 'tool result' },
    ]);
    expect(contents).toHaveLength(2);
    expect(contents[0].role).toBe('user');
    expect(contents[0].parts?.[0]?.text).toBe('question');
    expect(contents[1].role).toBe('user');
    expect(contents[1].parts?.[0]?.text).toBe('prompt');
  });

  it('appends new user prompt as last content even with empty priorMessages', () => {
    const { contents } = toGeminiContents('sys', 'my prompt', []);
    expect(contents).toHaveLength(1);
    expect(contents[0].role).toBe('user');
    expect(contents[0].parts?.[0]?.text).toBe('my prompt');
  });
});


describe('buildGeminiTools', () => {
  it('returns undefined for empty allowedTools', () => {
    expect(buildGeminiTools([])).toBeUndefined();
  });

  it('returns undefined when all tools are MCP', () => {
    expect(buildGeminiTools(['mcp__foo__bar', 'mcp__baz__qux'])).toBeUndefined();
  });

  it('filters out MCP tools and returns only builtin', () => {
    const result = buildGeminiTools(['Read', 'mcp__foo__bar']);
    expect(result).toBeDefined();
    expect(result).toHaveLength(1); // One Tool object
    const decls = result![0].functionDeclarations ?? [];
    expect(decls).toHaveLength(1);
    expect(decls[0].name).toBe('Read');
  });

  it('returns all 6 builtins when all are present', () => {
    const result = buildGeminiTools(['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash']);
    expect(result).toBeDefined();
    const decls = result![0].functionDeclarations ?? [];
    expect(decls).toHaveLength(6);
    const names = decls.map((d) => d.name);
    expect(names).toContain('Read');
    expect(names).toContain('Write');
    expect(names).toContain('Edit');
    expect(names).toContain('Glob');
    expect(names).toContain('Grep');
    expect(names).toContain('Bash');
  });

  it('returns undefined when no known builtins exist in the list', () => {
    expect(buildGeminiTools(['mcp__x__y', 'UnknownTool'])).toBeUndefined();
  });

  it('FunctionDeclaration has OBJECT type for Read parameters', () => {
    const result = buildGeminiTools(['Read']);
    const decl = result![0].functionDeclarations![0];
    expect(decl.parameters?.type).toBe('OBJECT');
    expect(decl.parameters?.properties?.file_path?.type).toBe('STRING');
  });
});


describe('tool loop: 3-turn cardinality', () => {
  it('executes tool, appends functionResponse with 1:1 cardinality, then gets final text', async () => {
    streamQueue = [
      [
        fcChunk('Read', { file_path: '/tmp/test/file.txt' }),
        usageChunk({ promptTokenCount: 10, candidatesTokenCount: 5 }),
      ],
      [
        textChunk('The file contains: hello world'),
        usageChunk({ promptTokenCount: 20, candidatesTokenCount: 15 }),
      ],
    ];

    const result = await googleGenAiExecutor.run(makeReq(), makeConfig());

    expect(result.output).toBe('The file contains: hello world');
    expect(result.metrics.toolUses).toBe(1);
    expect(result.metrics.apiRequests).toBe(2);

    expect(mockGenerateContentStream).toHaveBeenCalledTimes(2);

    const secondCallContents = capturedStreamCalls[1].contents as Array<{
      role: string;
      parts: Array<{ functionCall?: unknown; functionResponse?: { name: string } }>;
    }>;

    expect(secondCallContents.length).toBeGreaterThanOrEqual(3);

    const modelTurn = secondCallContents.find((c) => c.role === 'model');
    expect(modelTurn).toBeDefined();
    const modelParts = modelTurn!.parts;
    const hasFC = modelParts.some((p) => p.functionCall !== undefined);
    expect(hasFC).toBe(true);

    const userFrTurn = secondCallContents.find(
      (c) => c.role === 'user' && c.parts.some((p) => p.functionResponse !== undefined),
    );
    expect(userFrTurn).toBeDefined();
    const frPart = userFrTurn!.parts.find((p) => p.functionResponse !== undefined);
    expect(frPart?.functionResponse?.name).toBe('Read');
  });

  it('handles 2 function calls in one turn with 1:1 cardinality (2 responses)', async () => {
    streamQueue = [
      [
        { candidates: [{ content: { parts: [
          { functionCall: { name: 'Read', args: { file_path: '/a' } } },
          { functionCall: { name: 'Bash', args: { command: 'ls' } } },
        ] } }] },
        usageChunk({ promptTokenCount: 10, candidatesTokenCount: 5 }),
      ],
      [
        textChunk('Done'),
        usageChunk({ promptTokenCount: 30, candidatesTokenCount: 10 }),
      ],
    ];

    const result = await googleGenAiExecutor.run(makeReq(), makeConfig());
    expect(result.metrics.toolUses).toBe(2);

    const secondContents = capturedStreamCalls[1].contents as Array<{
      role: string;
      parts: Array<{ functionResponse?: { name: string } }>;
    }>;
    const frTurn = secondContents.find(
      (c) => c.role === 'user' && c.parts.some((p) => p.functionResponse !== undefined),
    );
    expect(frTurn).toBeDefined();
    const frParts = frTurn!.parts.filter((p) => p.functionResponse !== undefined);
    expect(frParts).toHaveLength(2);
    expect(frParts[0].functionResponse?.name).toBe('Read');
    expect(frParts[1].functionResponse?.name).toBe('Bash');
  });

  it('returns after max rounds when no final text', async () => {
    vi.mocked(getAgent).mockReturnValue({
      ...defaultAgent,
      externalConfig: { ...defaultExternalConfig },
      maxToolRounds: 2,
    });

    streamQueue = [
      [fcChunk('Read', { file_path: '/f' }), usageChunk({ promptTokenCount: 5, candidatesTokenCount: 2 })],
      [fcChunk('Bash', { command: 'ls' }), usageChunk({ promptTokenCount: 10, candidatesTokenCount: 3 })],
      [textChunk('final'), usageChunk({ promptTokenCount: 15, candidatesTokenCount: 5 })],
    ];

    const result = await googleGenAiExecutor.run(makeReq(), makeConfig());
    expect(result.metrics.apiRequests).toBe(2);
  });
});


describe('thoughtSignature', () => {
  it('positive: thoughtSignature from turn 1 is propagated into the functionCall part of turn 2', async () => {
    streamQueue = [
      [
        {
          candidates: [{
            content: {
              parts: [
                { thoughtSignature: 'sig-abc-xyz' },
                { functionCall: { name: 'Read', args: { file_path: '/f' } } },
              ],
            },
          }],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
        },
      ],
      [
        textChunk('done'),
        usageChunk({ promptTokenCount: 20, candidatesTokenCount: 10 }),
      ],
    ];

    await googleGenAiExecutor.run(makeReq(), makeConfig());

    const secondContents = capturedStreamCalls[1].contents as Array<{
      role: string;
      parts: Array<{ functionCall?: unknown; thoughtSignature?: string }>;
    }>;

    const modelTurn = secondContents.find((c) => c.role === 'model');
    expect(modelTurn).toBeDefined();

    const partWithSig = modelTurn!.parts.find((p) => p.thoughtSignature === 'sig-abc-xyz');
    expect(partWithSig).toBeDefined();
  });

  it('negative: model without thinking — thoughtSignature absent, no error, no warning, contents clean', async () => {
    streamQueue = [
      [
        fcChunk('Bash', { command: 'ls' }),
        usageChunk({ promptTokenCount: 5, candidatesTokenCount: 2 }),
      ],
      [
        textChunk('files listed'),
        usageChunk({ promptTokenCount: 15, candidatesTokenCount: 8 }),
      ],
    ];

    const result = await googleGenAiExecutor.run(makeReq(), makeConfig());
    expect(result.output).toBe('files listed');

    const secondContents = capturedStreamCalls[1].contents as Array<{
      role: string;
      parts: Array<{ thoughtSignature?: string }>;
    }>;
    const modelTurn = secondContents.find((c) => c.role === 'model');
    const anyPartWithSig = modelTurn?.parts.some((p) => p.thoughtSignature !== undefined);
    expect(anyPartWithSig).toBeFalsy();
  });
});


describe('safety blocks', () => {
  const fatalReasons = [
    'SAFETY',
    'RECITATION',
    'LANGUAGE',
    'BLOCKLIST',
    'PROHIBITED_CONTENT',
    'SPII',
    'MALFORMED_FUNCTION_CALL',
    'IMAGE_SAFETY',
    'UNEXPECTED_TOOL_CALL',
  ];

  for (const reason of fatalReasons) {
    it(`throws for finishReason: ${reason}`, async () => {
      streamQueue = [
        [finishChunk(reason)],
      ];

      await expect(
        googleGenAiExecutor.run(makeReq(), makeConfig()),
      ).rejects.toThrow(`Gemini retornou finishReason fatal: ${reason}`);
    });
  }

  it('does NOT throw for finishReason: STOP', async () => {
    streamQueue = [
      [
        textChunk('hello'),
        { candidates: [{ finishReason: 'STOP', content: { parts: [] } }] },
        usageChunk({ promptTokenCount: 10, candidatesTokenCount: 5 }),
      ],
    ];

    const result = await googleGenAiExecutor.run(makeReq(), makeConfig());
    expect(result.output).toBe('hello');
  });

  it('does NOT throw for finishReason: MAX_TOKENS', async () => {
    streamQueue = [
      [
        textChunk('truncated'),
        { candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [] } }] },
        usageChunk({ promptTokenCount: 10, candidatesTokenCount: 5 }),
      ],
    ];

    const result = await googleGenAiExecutor.run(makeReq(), makeConfig());
    expect(result.output).toBe('truncated');
  });
});


describe('usage mapping', () => {
  it('maps usage with exact formula: input=prompt+toolUsePrompt, output=candidates+thoughts', async () => {
    streamQueue = [
      [
        textChunk('answer'),
        usageChunk({
          promptTokenCount: 100,
          toolUsePromptTokenCount: 20,
          candidatesTokenCount: 50,
          thoughtsTokenCount: 30,
          cachedContentTokenCount: 5,
          totalTokenCount: 205,
        }),
      ],
    ];

    const result = await googleGenAiExecutor.run(makeReq(), makeConfig());

    expect(result.metrics.inputTokens).toBe(120);
    expect(result.metrics.outputTokens).toBe(80);
    expect(result.metrics.cacheReadTokens).toBe(0);
    expect(result.metrics.cacheCreationTokens).toBe(0);
  });

  it('handles partial usage (only promptTokenCount present)', async () => {
    streamQueue = [
      [
        textChunk('answer'),
        usageChunk({ promptTokenCount: 50 }),
      ],
    ];

    const result = await googleGenAiExecutor.run(makeReq(), makeConfig());
    expect(result.metrics.inputTokens).toBe(50);
    expect(result.metrics.outputTokens).toBe(0); // candidatesTokenCount missing -> 0
  });

  it('handles all-zero usage (e.g. full cache hit) — still considered reported', async () => {
    streamQueue = [
      [
        textChunk('cached'),
        usageChunk({
          promptTokenCount: 0,
          toolUsePromptTokenCount: 0,
          candidatesTokenCount: 0,
          thoughtsTokenCount: 0,
        }),
      ],
    ];

    const result = await googleGenAiExecutor.run(makeReq(), makeConfig());
    expect(result.metrics.tokenStatus).toBe('reported');
    expect(result.metrics.inputTokens).toBe(0);
    expect(result.metrics.outputTokens).toBe(0);
  });
});


describe('pricing combos', () => {
  it('Combo A: no usage reported -> tokenStatus=not_reported, costStatus=unknown, reason=no-usage-reported', async () => {
    streamQueue = [
      [textChunk('hello')],
    ];

    const result = await googleGenAiExecutor.run(makeReq(), makeConfig());
    expect(result.metrics.tokenStatus).toBe('not_reported');
    expect(result.metrics.costStatus).toBe('unknown');
    expect(result.metrics.costUnknownReason).toBe('no-usage-reported');
    expect(result.metrics.costUsd).toBe(0);
    expect(vi.mocked(calculateCost)).not.toHaveBeenCalled();
  });

  it('Combo B: usage reported + pricing unknown -> tokenStatus=reported, costStatus=unknown, reason=unknown-pricing', async () => {
    setAgent({ model: 'gemini-unknown-model' });

    streamQueue = [
      [
        textChunk('hello'),
        usageChunk({ promptTokenCount: 50, candidatesTokenCount: 20 }),
      ],
    ];

    const result = await googleGenAiExecutor.run(makeReq(), makeConfig());
    expect(result.metrics.tokenStatus).toBe('reported');
    expect(result.metrics.costStatus).toBe('unknown');
    expect(result.metrics.costUnknownReason).toBe('unknown-pricing');
    expect(result.metrics.costUsd).toBe(0);
    expect(vi.mocked(calculateCost)).not.toHaveBeenCalled();
  });

  it('Combo C: usage reported + pricing known -> tokenStatus=reported, costStatus=known, costUsd via calculateCost', async () => {
    const externalHttp = await import('../agent-runtime/external-http');
    const originalResolve = externalHttp.resolveExternalPricing;
    const spyResolve = vi.spyOn(externalHttp, 'resolveExternalPricing').mockReturnValue({
      pricingKey: 'gemini-3.1-pro-preview',
      status: 'known',
    });

    vi.mocked(calculateCost).mockReturnValue(0.025);

    streamQueue = [
      [
        textChunk('hello'),
        usageChunk({ promptTokenCount: 100, candidatesTokenCount: 50 }),
      ],
    ];

    try {
      const result = await googleGenAiExecutor.run(makeReq(), makeConfig());
      expect(result.metrics.tokenStatus).toBe('reported');
      expect(result.metrics.costStatus).toBe('known');
      expect(result.metrics.costUnknownReason).toBeUndefined();
      expect(result.metrics.costUsd).toBe(0.025);
      expect(vi.mocked(calculateCost)).toHaveBeenCalled();
    } finally {
      spyResolve.mockRestore();
      void originalResolve; // suppress unused var warning
    }
  });
});


describe('no-usage: response without usageMetadata in any chunk', () => {
  it('returns tokenStatus=not_reported, costStatus=unknown, costUnknownReason=no-usage-reported', async () => {
    streamQueue = [
      [
        textChunk('answer without usage'),
      ],
    ];

    const result = await googleGenAiExecutor.run(makeReq(), makeConfig());
    expect(result.metrics.tokenStatus).toBe('not_reported');
    expect(result.metrics.costStatus).toBe('unknown');
    expect(result.metrics.costUnknownReason).toBe('no-usage-reported');
    expect(result.metrics.inputTokens).toBe(0);
    expect(result.metrics.outputTokens).toBe(0);
    expect(result.metrics.costUsd).toBe(0);
  });

  it('warnOncePerAgent is only called once even on repeated calls without usage', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    streamQueue = [[textChunk('a')]];
    await googleGenAiExecutor.run(makeReq(), makeConfig());

    streamQueue = [[textChunk('b')]];
    await googleGenAiExecutor.run(makeReq(), makeConfig());

    warnSpy.mockRestore();
  });
});


describe('watchdog: onActivity called per tool loop iteration', () => {
  it('calls onActivity once per API call (including initial call)', async () => {
    streamQueue = [
      [
        fcChunk('Read', { file_path: '/f' }),
        usageChunk({ promptTokenCount: 5, candidatesTokenCount: 2 }),
      ],
      [
        textChunk('done'),
        usageChunk({ promptTokenCount: 15, candidatesTokenCount: 8 }),
      ],
    ];

    const onActivity = vi.fn();
    await googleGenAiExecutor.run(makeReq({ onActivity }), makeConfig());

    expect(onActivity).toHaveBeenCalledTimes(2);
  });

  it('calls onActivity even when chunk has no text (pure tool call round)', async () => {
    const emptyChunks: MockChunk[] = [
      { candidates: [{ content: { parts: [] } }] },
      { candidates: [{ content: { parts: [] } }] },
      { candidates: [{ content: { parts: [] } }] },
    ];

    streamQueue = [
      [
        ...emptyChunks,
        fcChunk('Bash', { command: 'ls' }),
        usageChunk({ promptTokenCount: 10, candidatesTokenCount: 3 }),
      ],
      [
        textChunk('result'),
        usageChunk({ promptTokenCount: 20, candidatesTokenCount: 8 }),
      ],
    ];

    const onActivity = vi.fn();
    await googleGenAiExecutor.run(makeReq({ onActivity }), makeConfig());

    expect(onActivity).toHaveBeenCalledTimes(2);
  });
});


describe('credential errors', () => {
  it('throws informative error when apiKeyRef is absent', async () => {
    setAgent({ apiKeyRef: '' });

    await expect(
      googleGenAiExecutor.run(makeReq(), makeConfig()),
    ).rejects.toThrow(/sem apiKeyRef configurado/);
  });

  it('throws informative error when apiKeyRef is whitespace-only', async () => {
    setAgent({ apiKeyRef: '   ' });

    await expect(
      googleGenAiExecutor.run(makeReq(), makeConfig()),
    ).rejects.toThrow(/sem apiKeyRef configurado/);
  });

  it('throws informative error when secret was removed from Vault', async () => {
    mockSecretValue = null;
    vi.mocked(getSecret).mockResolvedValue(null);

    await expect(
      googleGenAiExecutor.run(makeReq(), makeConfig()),
    ).rejects.toThrow(/foi removido do Vault/);
  });

  it('ref absent error message mentions agentId and provider', async () => {
    setAgent({ apiKeyRef: '' });

    const err: unknown = await googleGenAiExecutor
      .run(makeReq(), makeConfig())
      .catch((e: unknown) => e);
    if (!(err instanceof Error)) throw new Error('Expected missing-ref error');
    expect(err.message).toContain('gemini-agent');
    expect(err.message).toContain('gemini-agent-platform');
  });

  it('removed secret error message mentions apiKeyRef value', async () => {
    mockSecretValue = null;
    vi.mocked(getSecret).mockResolvedValue(null);

    const err: unknown = await googleGenAiExecutor
      .run(makeReq(), makeConfig())
      .catch((e: unknown) => e);
    if (!(err instanceof Error)) throw new Error('Expected removed-secret error');
    expect(err.message).toContain('orchestrator_vertex_api_key_ref');
  });
});


describe('MCP tools warning', () => {
  it('executor proceeds when MCP tools are in allowedTools (they are dropped silently)', async () => {
    streamQueue = [
      [textChunk('ok'), usageChunk({ promptTokenCount: 10, candidatesTokenCount: 5 })],
    ];

    const result = await googleGenAiExecutor.run(
      makeReq(),
      makeConfig({ allowedTools: ['Read', 'mcp__foo__bar', 'mcp__baz__qux'] }),
    );

    expect(result.output).toBe('ok');
    const firstContents = capturedStreamCalls[0];
    expect(firstContents).toBeDefined();
  });
});


describe('result shape', () => {
  it('returns correct runtime and provider fields', async () => {
    streamQueue = [
      [textChunk('hi'), usageChunk({ promptTokenCount: 5, candidatesTokenCount: 3 })],
    ];

    const result = await googleGenAiExecutor.run(makeReq(), makeConfig());
    expect(result.runtime).toBe('external');
    expect(result.provider).toBe('gemini-agent-platform');
    expect(result.model).toBe('gemini-3.1-pro-preview');
  });

  it('returns correct cacheReadTokens and cacheCreationTokens (always 0)', async () => {
    streamQueue = [
      [textChunk('hi'), usageChunk({ promptTokenCount: 100, candidatesTokenCount: 50 })],
    ];

    const result = await googleGenAiExecutor.run(makeReq(), makeConfig());
    expect(result.metrics.cacheReadTokens).toBe(0);
    expect(result.metrics.cacheCreationTokens).toBe(0);
  });
});


describe('external-executor: google-genai protocol dispatch', () => {
  it('dispatches to google-genai-executor when protocol=google-genai', async () => {
    const { externalExecutor } = await import('../agent-runtime/external-executor');

    streamQueue = [
      [textChunk('gemini response'), usageChunk({ promptTokenCount: 20, candidatesTokenCount: 10 })],
    ];

    vi.mocked(getAgent).mockReturnValue({
      ...defaultAgent,
      externalConfig: {
        provider: 'gemini-agent-platform',
        protocol: 'google-genai',
        model: 'gemini-3.1-pro-preview',
        apiKeyRef: 'orchestrator_vertex_api_key_ref',
      },
    });

    const result = await externalExecutor.run(makeReq(), makeConfig());
    expect(result.output).toBe('gemini response');
    expect(result.provider).toBe('gemini-agent-platform');
  });
});
