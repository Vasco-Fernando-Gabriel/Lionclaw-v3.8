import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Mock } from 'vitest';

vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../memory-pipeline', () => ({
  resolveCompactionSelection: vi.fn(),
}));

vi.mock('../pipeline-shared/sdk-bootstrap', () => ({
  ensureAuthForSDK: vi.fn(async () => undefined),
  ensureNodeInPath: vi.fn(),
  getClaudeCodeExecutablePath: vi.fn(() => '/fake/cli.js'),
  getClaudeSdkProcessOptions: vi.fn(() => ({
    pathToClaudeCodeExecutable: '/fake/cli.js',
    executable: 'node',
  })),
}));
vi.mock('../paths', () => ({
  getBackgroundCwd: vi.fn(() => '/tmp/bg'),
}));
vi.mock('../claude-compat-sdk', () => ({
  buildCompatEnv: vi.fn(() => ({ ANTHROPIC_AUTH_TOKEN: 'x' })),
}));

const queryMock = vi.fn();
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (args: unknown) => queryMock(args),
}));

import { resolveCompactionSelection } from '../memory-pipeline';
import { runVisionPrompt, VisionUnsupportedError, normalizeVisionMediaType } from '../memory-pipeline/oneshot-vision';

const resolveMock = resolveCompactionSelection as unknown as Mock;

function fakeAgentSdkStream(text: string): AsyncIterable<unknown> {
  return (async function* () {
    yield { type: 'assistant', message: { content: [{ type: 'text', text }] } };
    yield { type: 'result' };
  })();
}

const IMAGE_BLOCK = {
  type: 'image' as const,
  source: { type: 'base64' as const, media_type: 'image/png' as const, data: 'AAAA' },
};
const TEXT_BLOCK = { type: 'text' as const, text: 'Extraia o texto' };

beforeEach(() => {
  vi.clearAllMocks();
  queryMock.mockReturnValue(fakeAgentSdkStream('resultado ocr'));
});

describe('runVisionPrompt (SPEC 4.3, item 4)', () => {
  it('capability FALSE (codex-sdk via subscription) -> VisionUnsupportedError, nunca chama query()', async () => {
    resolveMock.mockResolvedValue({
      kind: 'subscription',
      selection: { runtime: 'codex-sdk', provider: 'codex', model: 'gpt-x', source: 'settings' },
    });

    await expect(runVisionPrompt([IMAGE_BLOCK, TEXT_BLOCK])).rejects.toBeInstanceOf(VisionUnsupportedError);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('capability FALSE (lion-sdk) -> VisionUnsupportedError', async () => {
    resolveMock.mockResolvedValue({
      kind: 'lion-sdk',
      provider: 'ollama',
      model: 'llava',
      source: 'chat',
    });

    await expect(runVisionPrompt([IMAGE_BLOCK])).rejects.toBeInstanceOf(VisionUnsupportedError);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('capability TRUE (claude-sdk subscription) -> blocos passam ao query() e o texto volta', async () => {
    resolveMock.mockResolvedValue({
      kind: 'subscription',
      selection: {
        runtime: 'claude-sdk',
        provider: 'anthropic',
        model: 'claude-model-x',
        source: 'settings',
      },
    });

    const out = await runVisionPrompt([IMAGE_BLOCK, TEXT_BLOCK]);
    expect(out).toBe('resultado ocr');
    expect(queryMock).toHaveBeenCalledTimes(1);

    const arg = queryMock.mock.calls[0][0] as {
      prompt: AsyncIterable<{ message: { content: unknown[] } }>;
      options: { model: string; mcpServers?: unknown; strictMcpConfig?: unknown };
    };
    expect(arg.options.model).toBe('claude-model-x');
    expect(arg.options.mcpServers).toEqual({});
    expect(arg.options.strictMcpConfig).toBe(true);
    const first = (await arg.prompt[Symbol.asyncIterator]().next()).value as {
      message: { content: unknown[] };
    };
    expect(first.message.content).toEqual([IMAGE_BLOCK, TEXT_BLOCK]);
  });

  it('modelOverride (setting ingest_vision_model) vence o modelo da selecao, runtime mantido', async () => {
    resolveMock.mockResolvedValue({
      kind: 'subscription',
      selection: {
        runtime: 'claude-sdk',
        provider: 'anthropic',
        model: 'modelo-da-selecao',
        source: 'settings',
      },
    });

    await runVisionPrompt([IMAGE_BLOCK], { modelOverride: 'modelo-override' });
    const arg = queryMock.mock.calls[0][0] as { options: { model: string } };
    expect(arg.options.model).toBe('modelo-override');
  });

  it('kind:claude (API key Anthropic explicita) roda no caminho claude-sdk (visao ok)', async () => {
    resolveMock.mockResolvedValue({ kind: 'claude', model: 'claude-api-model' });

    const out = await runVisionPrompt([IMAGE_BLOCK]);
    expect(out).toBe('resultado ocr');
    expect(queryMock).toHaveBeenCalledTimes(1);
    const arg = queryMock.mock.calls[0][0] as { options: { model: string } };
    expect(arg.options.model).toBe('claude-api-model');
  });

  it('capability TRUE (claude-compat-sdk) -> passa pelo caminho compat com env', async () => {
    resolveMock.mockResolvedValue({
      kind: 'subscription',
      selection: {
        runtime: 'claude-compat-sdk',
        provider: 'zai',
        model: 'glm-x',
        source: 'settings',
      },
    });

    const out = await runVisionPrompt([IMAGE_BLOCK]);
    expect(out).toBe('resultado ocr');
    const arg = queryMock.mock.calls[0][0] as {
      options: { env?: unknown; mcpServers?: unknown; strictMcpConfig?: unknown };
    };
    expect(arg.options.env).toBeDefined();
    expect(arg.options.mcpServers).toEqual({});
    expect(arg.options.strictMcpConfig).toBe(true);
  });
});

describe('normalizeVisionMediaType', () => {
  it('mantem media types validos e normaliza o resto para image/png', () => {
    expect(normalizeVisionMediaType('image/jpeg')).toBe('image/jpeg');
    expect(normalizeVisionMediaType('image/webp')).toBe('image/webp');
    expect(normalizeVisionMediaType('image/tiff')).toBe('image/png');
    expect(normalizeVisionMediaType('application/pdf')).toBe('image/png');
  });
});
