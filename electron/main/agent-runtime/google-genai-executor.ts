
import {
  GoogleGenAI,
  FunctionCallingConfigMode,
  Type,
  type Content,
  type Part,
  type FunctionDeclaration,
  type Tool,
  type ToolConfig,
  type GenerateContentResponse,
} from '@google/genai';
import { createLogger } from '../logger';
import { getAgent, getSetting } from '../db';
import { getSecret } from '../vault-registry';
import { calculateCost } from '../pricing';
import { resolveExternalPricing } from './external-http';
import { warnMcpToolsDroppedOnce, warnOncePerAgent } from './mcp-warning';
import { executeLocalTool } from '../local-tool-executor';
import type { AgentQueryConfig } from '../agent-config-resolver';
import type { OllamaChatMessage } from '../ollama-client';
import type { RuntimeExecutor, AgentExecutionRequest, AgentExecutionResult } from './types';
import { emptyResponseExecutionError } from './llm-error';

const logger = createLogger('google-genai-executor');

function resolveGeminiApiKeyRef(apiKeyRef: string): string {
  const trimmed = apiKeyRef.trim();
  if (trimmed === 'orchestrator_vertex_api_key_ref') {
    return getSetting('orchestrator_vertex_api_key_ref') || trimmed;
  }
  return trimmed;
}

const FATAL_FINISH_REASONS = new Set<string>([
  'SAFETY',
  'RECITATION',
  'LANGUAGE',
  'BLOCKLIST',
  'PROHIBITED_CONTENT',
  'SPII',
  'MALFORMED_FUNCTION_CALL',
  'IMAGE_SAFETY',
  'UNEXPECTED_TOOL_CALL',
]);


const BUILTIN_GEMINI_SCHEMAS: Record<string, FunctionDeclaration> = {
  Read: {
    name: 'Read',
    description: 'Read the contents of a file at the given path. Returns the file contents as text.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        file_path: {
          type: Type.STRING,
          description: 'Absolute path to the file to read.',
        },
        limit: {
          type: Type.NUMBER,
          description: 'Maximum number of lines to read (optional).',
        },
        offset: {
          type: Type.NUMBER,
          description: 'Line number to start reading from (optional).',
        },
      },
      required: ['file_path'],
    },
  },

  Write: {
    name: 'Write',
    description: 'Write content to a file at the given path, creating or overwriting it.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        file_path: {
          type: Type.STRING,
          description: 'Absolute path to the file to write.',
        },
        content: {
          type: Type.STRING,
          description: 'The content to write to the file.',
        },
      },
      required: ['file_path', 'content'],
    },
  },

  Edit: {
    name: 'Edit',
    description: 'Perform an exact string replacement in a file.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        file_path: {
          type: Type.STRING,
          description: 'Absolute path to the file to edit.',
        },
        old_string: {
          type: Type.STRING,
          description: 'The exact text to replace (must be unique in the file).',
        },
        new_string: {
          type: Type.STRING,
          description: 'The replacement text.',
        },
        replace_all: {
          type: Type.BOOLEAN,
          description: 'If true, replace all occurrences of old_string (default false).',
        },
      },
      required: ['file_path', 'old_string', 'new_string'],
    },
  },

  Glob: {
    name: 'Glob',
    description: 'Find files matching a glob pattern within a directory.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        pattern: {
          type: Type.STRING,
          description: 'Glob pattern to match (e.g. "**/*.ts").',
        },
        path: {
          type: Type.STRING,
          description: 'Directory to search within (optional, defaults to cwd).',
        },
      },
      required: ['pattern'],
    },
  },

  Grep: {
    name: 'Grep',
    description: 'Search for a text pattern within files.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        pattern: {
          type: Type.STRING,
          description: 'Text or regex pattern to search for.',
        },
        path: {
          type: Type.STRING,
          description: 'Directory or file to search within (optional).',
        },
        include: {
          type: Type.STRING,
          description: 'File glob to include (e.g. "*.ts") (optional).',
        },
      },
      required: ['pattern'],
    },
  },

  Bash: {
    name: 'Bash',
    description: 'Execute a shell command and return its output.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        command: {
          type: Type.STRING,
          description: 'The shell command to execute.',
        },
        description: {
          type: Type.STRING,
          description: 'A human-readable description of what the command does (optional).',
        },
        timeout: {
          type: Type.NUMBER,
          description: 'Timeout in milliseconds (optional).',
        },
      },
      required: ['command'],
    },
  },
};


export function buildGeminiTools(allowedTools: string[]): Tool[] | undefined {
  const builtinNames = allowedTools.filter((t) => !t.startsWith('mcp__'));
  if (builtinNames.length === 0) return undefined;

  const functionDeclarations = builtinNames
    .map((name) => BUILTIN_GEMINI_SCHEMAS[name])
    .filter((s): s is FunctionDeclaration => s !== undefined);

  if (functionDeclarations.length === 0) return undefined;

  return [{ functionDeclarations }];
}


export function toGeminiContents(
  systemPrompt: string | undefined,
  userPrompt: string,
  priorMessages?: OllamaChatMessage[],
): {
  systemInstruction: Content | undefined;
  contents: Content[];
} {
  const systemInstruction: Content | undefined = systemPrompt && systemPrompt.trim().length > 0
    ? { parts: [{ text: systemPrompt }] }
    : undefined;

  const contents: Content[] = [];

  if (priorMessages && priorMessages.length > 0) {
    for (const msg of priorMessages) {
      if (msg.role === 'system' || msg.role === 'tool') continue;

      const geminiRole: 'user' | 'model' = msg.role === 'assistant' ? 'model' : 'user';
      const text = msg.content ?? '';
      contents.push({
        role: geminiRole,
        parts: [{ text }],
      });
    }
  }

  contents.push({
    role: 'user',
    parts: [{ text: userPrompt }],
  });

  return { systemInstruction, contents };
}


async function run(
  req: AgentExecutionRequest,
  config: AgentQueryConfig,
): Promise<AgentExecutionResult> {
  const agent = getAgent(req.agentId);
  if (!agent?.externalConfig) {
    throw new Error(`Agent ${req.agentId} has runtime=external but no externalConfig`);
  }
  const extCfg = agent.externalConfig;

  if (extCfg.protocol !== 'google-genai') {
    throw new Error(
      `google-genai-executor invocado com protocol incorreto: "${extCfg.protocol}". ` +
      `Esperado: "google-genai".`,
    );
  }

  warnMcpToolsDroppedOnce({
    agentId: req.agentId,
    runtime: 'external',
    provider: extCfg.provider,
    allowedTools: config.allowedTools,
  });

  if (!extCfg.apiKeyRef || extCfg.apiKeyRef.trim().length === 0) {
    throw new Error(
      `Agent ${req.agentId} (provider ${extCfg.provider}) sem apiKeyRef configurado. ` +
      `Edite o agente em Settings > SubAgents e selecione uma chave do Vault.`,
    );
  }

  const resolvedApiKeyRef = resolveGeminiApiKeyRef(extCfg.apiKeyRef);
  const apiKey = await getSecret(resolvedApiKeyRef);
  if (!apiKey) {
    const refLabel = resolvedApiKeyRef === extCfg.apiKeyRef
      ? `"${extCfg.apiKeyRef}"`
      : `"${extCfg.apiKeyRef}" (resolvido para "${resolvedApiKeyRef}")`;
    throw new Error(
      `Agent ${req.agentId}: secret apontado por apiKeyRef ${refLabel} foi removido do Vault. ` +
      `Reconfigure a credencial em Settings > Vault ou no card de provider correspondente.`,
    );
  }

  const ai = new GoogleGenAI({ vertexai: true, apiKey });

  const { systemInstruction, contents } = toGeminiContents(
    config.systemPrompt,
    req.prompt,
    req.priorMessages,
  );

  const tools = buildGeminiTools(config.allowedTools);
  const toolConfig: ToolConfig | undefined = tools
    ? { functionCallingConfig: { mode: FunctionCallingConfigMode.AUTO } }
    : undefined;

  let toolCallsTotal = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let lastThoughtSignature: string | undefined;
  let usageReported = false;
  let finalText = '';
  let apiRequests = 0;

  const maxRounds = agent.maxToolRounds ?? 50;
  const startedAt = Date.now();

  for (let round = 0; round < maxRounds; round++) {
    req.onActivity?.();
    apiRequests += 1;

    const stream = await ai.models.generateContentStream({
      model: extCfg.model,
      contents,
      config: {
        ...(systemInstruction ? { systemInstruction } : {}),
        ...(tools ? { tools, toolConfig } : {}),
        ...(extCfg.maxTokens ? { maxOutputTokens: extCfg.maxTokens } : {}),
        ...(extCfg.temperature !== undefined ? { temperature: extCfg.temperature } : {}),
        abortSignal: req.abortController.signal,
      },
    });

    let roundText = '';
    const pendingFunctionCalls: Array<{
      name: string;
      args: Record<string, unknown>;
    }> = [];
    let turnThoughtSignature: string | undefined;

    for await (const chunk of stream as AsyncGenerator<GenerateContentResponse>) {
      for (const part of chunk.candidates?.[0]?.content?.parts ?? []) {
        if (part.text) {
          roundText += part.text;
          req.onText?.(part.text);
        }

        if (part.functionCall) {
          const fcName = part.functionCall.name ?? '';
          const fcArgs = (part.functionCall.args ?? {}) as Record<string, unknown>;
          pendingFunctionCalls.push({ name: fcName, args: fcArgs });
          req.onToolUse?.(fcName);
          toolCallsTotal += 1;
        }

        if (part.thoughtSignature) {
          turnThoughtSignature = part.thoughtSignature;
        }
      }

      const um = chunk.usageMetadata;
      if (um) {
        usageReported = true;
        inputTokens = (um.promptTokenCount ?? 0) + (um.toolUsePromptTokenCount ?? 0);
        outputTokens = (um.candidatesTokenCount ?? 0) + (um.thoughtsTokenCount ?? 0);
      }

      const finishReason = chunk.candidates?.[0]?.finishReason;
      if (finishReason && FATAL_FINISH_REASONS.has(String(finishReason))) {
        throw new Error(`Gemini retornou finishReason fatal: ${String(finishReason)}`);
      }
    }

    lastThoughtSignature = turnThoughtSignature;

    if (pendingFunctionCalls.length === 0) {
      finalText = roundText;
      break;
    }

    const modelParts: Part[] = [];
    if (roundText) {
      modelParts.push({ text: roundText });
    }
    for (const fc of pendingFunctionCalls) {
      const fcPart: Part = {
        functionCall: { name: fc.name, args: fc.args },
      };
      if (lastThoughtSignature) {
        (fcPart as Part & { thoughtSignature?: string }).thoughtSignature = lastThoughtSignature;
      }
      modelParts.push(fcPart);
    }
    contents.push({ role: 'model', parts: modelParts });

    const responseParts: Part[] = [];
    for (const fc of pendingFunctionCalls) {
      const toolResult = await executeLocalTool(fc.name, fc.args, req.cwd);

      req.onToolUseComplete?.(fc.name, fc.args);

      responseParts.push({
        functionResponse: {
          name: fc.name,
          response: { result: toolResult.result, isError: toolResult.isError },
        },
      });
    }

    contents.push({ role: 'user', parts: responseParts });
  }

  const durationMs = Date.now() - startedAt;
  const pricing = resolveExternalPricing(extCfg);

  let costUsd: number;
  let costStatus: 'known' | 'unknown' | undefined;
  let tokenStatus: 'reported' | 'not_reported' | undefined;
  let costUnknownReason: 'unknown-pricing' | 'no-usage-reported' | undefined;

  if (!usageReported) {
    tokenStatus = 'not_reported';
    costStatus = 'unknown';
    costUnknownReason = 'no-usage-reported';
    costUsd = 0;
    warnOncePerAgent(req.agentId, 'no-usage-reported', {
      agentId: req.agentId,
      provider: extCfg.provider,
      model: extCfg.model,
      reason: 'no-usage-reported',
    });
  } else if (pricing.status === 'unknown') {
    tokenStatus = 'reported';
    costStatus = 'unknown';
    costUnknownReason = 'unknown-pricing';
    costUsd = 0;
  } else {
    tokenStatus = 'reported';
    costStatus = 'known';
    costUnknownReason = undefined;
    costUsd = calculateCost(pricing.pricingKey, inputTokens, outputTokens, 0, 0);
  }

  logger.info(
    {
      agentId: req.agentId,
      provider: extCfg.provider,
      model: extCfg.model,
      inputTokens,
      outputTokens,
      costUsd,
      costStatus,
      tokenStatus,
      durationMs,
      apiRequests,
      toolCallsTotal,
    },
    'google-genai-executor: completed',
  );

  const resultError = emptyResponseExecutionError({
    content: finalText,
    toolUses: toolCallsTotal,
    aborted: req.abortController.signal.aborted,
    provider: extCfg.provider ?? 'unknown',
    model: extCfg.model,
  });

  return {
    output: finalText,
    metrics: {
      inputTokens,
      outputTokens,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      toolUses: toolCallsTotal,
      apiRequests,
      costUsd,
      durationMs,
      costStatus,
      tokenStatus,
      costUnknownReason,
    },
    model: extCfg.model,
    runtime: 'external',
    provider: extCfg.provider ?? 'unknown',
    ...(resultError !== undefined ? { error: resultError } : {}),
  };
}

export const googleGenAiExecutor: RuntimeExecutor = { run };
