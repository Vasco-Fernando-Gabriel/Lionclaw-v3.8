
import { createLogger } from '../logger';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { OrchestratorSelection } from '../orchestrator-selection';
import type { OrchestratorRuntime } from '../../../src/types';
import {
  RUNTIME_CAPABILITIES,
  runtimeLabel,
} from '../agent-runtime/runtime-capabilities';
import { resolveCompactionSelection } from '../memory-pipeline';

const logger = createLogger('oneshot-vision');

export const VISION_IMAGE_MEDIA_TYPES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
] as const;
export type VisionImageMediaType = (typeof VISION_IMAGE_MEDIA_TYPES)[number];

export type VisionContentBlock =
  | { type: 'text'; text: string }
  | {
      type: 'image';
      source: { type: 'base64'; media_type: VisionImageMediaType; data: string };
    };

export class VisionUnsupportedError extends Error {
  readonly runtime: OrchestratorRuntime;
  constructor(runtime: OrchestratorRuntime) {
    super(
      `O runtime "${runtimeLabel(runtime)}" nao processa imagens. ` +
        'Configure um runtime com visao (Claude SDK ou Claude-compat) no seletor de ' +
        'compactacao/utilitarios, ou defina o modelo de visao nas configuracoes de ingest.',
    );
    this.name = 'VisionUnsupportedError';
    this.runtime = runtime;
  }
}

export function normalizeVisionMediaType(mimeType: string): VisionImageMediaType {
  return (VISION_IMAGE_MEDIA_TYPES as readonly string[]).includes(mimeType)
    ? (mimeType as VisionImageMediaType)
    : 'image/png';
}

export interface RunVisionPromptOptions {
  modelOverride?: string;
  maxTokens?: number;
}

async function resolveVisionSelection(
  modelOverride?: string,
): Promise<OrchestratorSelection> {
  const selection = await resolveCompactionSelection();

  if (selection.kind === 'subscription') {
    const runtime = selection.selection.runtime;
    if (!RUNTIME_CAPABILITIES[runtime]?.supportsImageInput) {
      throw new VisionUnsupportedError(runtime);
    }
    const model = modelOverride?.trim() || selection.selection.model;
    return { ...selection.selection, model };
  }

  if (selection.kind === 'claude') {
    const model = modelOverride?.trim() || selection.model;
    return {
      runtime: 'claude-sdk',
      provider: 'anthropic',
      model,
      source: 'settings',
    };
  }

  throw new VisionUnsupportedError('lion-sdk');
}

export async function runVisionPrompt(
  blocks: VisionContentBlock[],
  options?: RunVisionPromptOptions,
): Promise<string> {
  const selection = await resolveVisionSelection(options?.modelOverride);
  const runtime = selection.runtime;

  if (!RUNTIME_CAPABILITIES[runtime]?.supportsImageInput) {
    throw new VisionUnsupportedError(runtime);
  }

  logger.info(
    { runtime, provider: selection.provider, model: selection.model },
    'runVisionPrompt: turno de visao one-shot',
  );

  switch (runtime) {
    case 'claude-sdk':
      return runClaudeSdkVision(selection, blocks);
    case 'claude-compat-sdk':
      return runClaudeCompatVision(selection, blocks);
    default:
      throw new VisionUnsupportedError(runtime);
  }
}

const VISION_SYSTEM_PROMPT =
  'You are a vision OCR and extraction assistant. Respond only with the requested output.';

async function drainAgentSdkQuery(q: AsyncIterable<unknown>): Promise<string> {
  let text = '';
  for await (const sdkMessage of q as AsyncIterable<Record<string, unknown>>) {
    if (sdkMessage.type === 'assistant') {
      const message = sdkMessage.message as { content?: Array<Record<string, unknown>> } | undefined;
      for (const block of message?.content ?? []) {
        if (block.type === 'text' && typeof block.text === 'string') {
          text += block.text;
        }
      }
    } else if (sdkMessage.type === 'result') {
      break;
    }
  }
  return text;
}

function visionPromptIterable(blocks: VisionContentBlock[]): AsyncIterable<SDKUserMessage> {
  return (async function* () {
    yield {
      type: 'user' as const,
      session_id: 'lionclaw-vision-oneshot',
      parent_tool_use_id: null,
      message: { role: 'user' as const, content: blocks },
    } as unknown as SDKUserMessage;
  })();
}

async function runClaudeSdkVision(
  selection: OrchestratorSelection,
  blocks: VisionContentBlock[],
): Promise<string> {
  const { ensureAuthForSDK, ensureNodeInPath, getClaudeSdkProcessOptions } = await import(
    '../pipeline-shared/sdk-bootstrap'
  );
  const { getBackgroundCwd } = await import('../paths');
  await ensureAuthForSDK();
  ensureNodeInPath();
  const { query } = await import('@anthropic-ai/claude-agent-sdk');

  const q = query({
    prompt: visionPromptIterable(blocks),
    options: {
      model: selection.model,
      maxTurns: 1,
      tools: [],
      allowedTools: [],
      mcpServers: {},
      strictMcpConfig: true,
      settingSources: [],
      includePartialMessages: false,
      systemPrompt: VISION_SYSTEM_PROMPT,
      cwd: getBackgroundCwd(),
      ...getClaudeSdkProcessOptions(),
    } as Record<string, unknown>,
  });

  return drainAgentSdkQuery(q);
}

async function runClaudeCompatVision(
  selection: OrchestratorSelection,
  blocks: VisionContentBlock[],
): Promise<string> {
  const { ensureNodeInPath, getClaudeSdkProcessOptions } = await import(
    '../pipeline-shared/sdk-bootstrap'
  );
  const { getBackgroundCwd } = await import('../paths');
  const { buildCompatEnv } = await import('../claude-compat-sdk');
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  ensureNodeInPath();
  const compatEnv = buildCompatEnv(selection);

  const q = query({
    prompt: visionPromptIterable(blocks),
    options: {
      model: selection.model,
      maxTurns: 1,
      tools: [],
      allowedTools: [],
      mcpServers: {},
      strictMcpConfig: true,
      settingSources: [],
      includePartialMessages: false,
      systemPrompt: VISION_SYSTEM_PROMPT,
      cwd: getBackgroundCwd(),
      ...getClaudeSdkProcessOptions(),
      env: compatEnv,
    } as Record<string, unknown>,
  });

  return drainAgentSdkQuery(q);
}
