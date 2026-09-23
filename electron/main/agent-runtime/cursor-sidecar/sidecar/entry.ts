import fs from 'node:fs';
import process from 'node:process';
import { Agent, Cursor, JsonlLocalAgentStore } from '@cursor/sdk';
import type {
  AgentOptions,
  Run,
  SDKAgent,
  SDKCustomTool,
  SDKCustomToolResult,
  SDKJsonValue,
  SDKMessage,
  SettingSource,
  ToolName,
} from '@cursor/sdk';
import {
  createSidecarLineDecoder,
  encodeSidecarLine,
  type CursorSidecarExecuteConfig,
  type CursorSidecarMessage,
} from '../protocol';

function logToStderr(...args: unknown[]): void {
  process.stderr.write(
    '[cursor-sidecar] ' + args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ') + '\n',
  );
}
console.log = logToStderr;
console.info = logToStderr;
console.warn = logToStderr;
console.error = logToStderr;

function send(msg: CursorSidecarMessage): void {
  process.stdout.write(encodeSidecarLine(msg));
}

let currentRun: Run | null = null;
let currentAgent: SDKAgent | null = null;
let executeReceived = false;

const pendingToolCalls = new Map<string, { resolve: (r: { ok?: string; error?: string }) => void }>();
let toolCallSeq = 0;

function rpcToolInvoke(
  executionId: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<{ ok?: string; error?: string }> {
  toolCallSeq += 1;
  const id = `tool-${toolCallSeq}`;
  return new Promise((resolve) => {
    pendingToolCalls.set(id, { resolve });
    send({ type: 'tool-invoke', executionId, id, toolName, args });
  });
}

function buildCustomTools(config: CursorSidecarExecuteConfig): Record<string, SDKCustomTool> {
  const tools: Record<string, SDKCustomTool> = {};
  for (const decl of config.customTools) {
    tools[decl.name] = {
      description: decl.description,
      inputSchema: decl.inputSchema as Record<string, SDKJsonValue>,
      execute: async (args): Promise<SDKCustomToolResult> => {
        const result = await rpcToolInvoke(config.executionId, decl.name, args as Record<string, unknown>);
        if (result.error !== undefined) {
          return { content: [{ type: 'text', text: result.error }], isError: true };
        }
        return result.ok ?? '';
      },
    };
  }
  return tools;
}

function buildAgentOptions(config: CursorSidecarExecuteConfig): AgentOptions {
  if (config.guarded && config.allowedTools === undefined) {
    throw new Error(
      'execucao guardada sem allowedTools: a policy de tools nao persiste no SDK ' +
        'e DEVE ser reaplicada em todo execute/resume (fail-closed)',
    );
  }
  fs.mkdirSync(config.storeDir, { recursive: true });
  const store = new JsonlLocalAgentStore(config.storeDir);
  return {
    model: { id: config.model },
    apiKey: config.apiKey,
    ...(config.allowedTools !== undefined ? { tools: config.allowedTools as ToolName[] } : {}),
    local: {
      cwd: config.cwd,
      store,
      settingSources: config.settingSources as SettingSource[],
      ...(config.sandbox === true ? { sandboxOptions: { enabled: true } } : {}),
      customTools: buildCustomTools(config),
    },
  };
}

async function runExecution(config: CursorSidecarExecuteConfig): Promise<void> {
  const options = buildAgentOptions(config);
  const agent = config.resumeAgentId ? await Agent.resume(config.resumeAgentId, options) : await Agent.create(options);
  currentAgent = agent;

  const run = await agent.send(config.prompt);
  currentRun = run;
  send({
    type: 'execute-started',
    executionId: config.executionId,
    runId: run.id,
    agentId: run.agentId,
  });

  let finalText = '';
  try {
    for await (const evt of run.stream() as AsyncGenerator<SDKMessage, void>) {
      send({ type: 'stream-event', executionId: config.executionId, event: evt });
      if (evt.type === 'assistant') {
        for (const block of evt.message.content) {
          if (block.type === 'text') finalText += block.text;
        }
      }
    }
  } catch (err) {
    logToStderr('stream interrompido:', err instanceof Error ? err.message : String(err));
  }

  const result = await run.wait();
  currentRun = null;
  agent.close();
  currentAgent = null;

  send({
    type: 'execute-result',
    executionId: config.executionId,
    status: result.status,
    finalText,
    ...(result.result !== undefined ? { resultText: result.result } : {}),
    ...(result.usage !== undefined ? { usage: result.usage } : {}),
    ...(result.error?.message !== undefined ? { errorMessage: result.error.message } : {}),
    ...(result.error?.code !== undefined ? { errorCode: result.error.code } : {}),
    agentId: run.agentId,
    runId: run.id,
    ...(result.model?.id !== undefined ? { model: result.model.id } : {}),
    ...(result.durationMs !== undefined ? { durationMs: result.durationMs } : {}),
  });

  const exitTimer = setTimeout(() => process.exit(0), 1_000);
  exitTimer.unref();
}

function handleExecute(config: CursorSidecarExecuteConfig): void {
  if (executeReceived) {
    send({ type: 'fatal', error: 'segundo execute recebido: o sidecar roda UMA execucao por processo' });
    process.exit(1);
    return;
  }
  executeReceived = true;
  runExecution(config).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error && err.stack ? err.stack : undefined;
    send({
      type: 'execute-error',
      executionId: config.executionId,
      message,
      ...(stack !== undefined ? { stack } : {}),
    });
    const exitTimer = setTimeout(() => process.exit(1), 500);
    exitTimer.unref();
  });
}

function handleListModels(id: string, apiKey: string): void {
  Cursor.models
    .list({ apiKey })
    .then((models) => {
      send({
        type: 'models-result',
        id,
        models: models.map((model) => ({ id: model.id, displayName: model.displayName })),
      });
    })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      send({ type: 'models-result', id, error: message });
    });
}

function handleAbort(): void {
  if (currentRun) {
    currentRun.cancel().catch((err: unknown) => {
      logToStderr('run.cancel falhou:', err instanceof Error ? err.message : String(err));
    });
  }
}

const decoder = createSidecarLineDecoder(
  (raw) => {
    const type = typeof raw['type'] === 'string' ? (raw['type'] as string) : '';
    switch (type) {
      case 'execute': {
        const config = raw['config'];
        if (!config || typeof config !== 'object') {
          send({ type: 'fatal', error: 'execute sem config' });
          process.exit(1);
          return;
        }
        handleExecute(config as CursorSidecarExecuteConfig);
        break;
      }
      case 'tool-result': {
        const id = typeof raw['id'] === 'string' ? (raw['id'] as string) : '';
        const pending = pendingToolCalls.get(id);
        if (!pending) break;
        pendingToolCalls.delete(id);
        pending.resolve({
          ...(typeof raw['ok'] === 'string' ? { ok: raw['ok'] as string } : {}),
          ...(typeof raw['error'] === 'string' ? { error: raw['error'] as string } : {}),
        });
        break;
      }
      case 'list-models': {
        const id = typeof raw['id'] === 'string' ? (raw['id'] as string) : '';
        const apiKey = typeof raw['apiKey'] === 'string' ? (raw['apiKey'] as string) : '';
        if (!id) break;
        if (!apiKey) {
          send({ type: 'models-result', id, error: 'list-models sem apiKey' });
          break;
        }
        handleListModels(id, apiKey);
        break;
      }
      case 'abort':
        handleAbort();
        break;
      case 'ping': {
        const id = typeof raw['id'] === 'string' ? (raw['id'] as string) : '';
        send({ type: 'pong', id });
        break;
      }
      case 'shutdown':
        try {
          currentAgent?.close();
        } catch {}
        process.exit(0);
        break;
      default:
        logToStderr('mensagem desconhecida do host ignorada:', type);
    }
  },
  (line) => {
    logToStderr('linha nao-RPC no stdin ignorada:', line.slice(0, 200));
  },
);

process.stdin.on('data', decoder);
process.stdin.on('end', () => {
  process.exit(0);
});

send({ type: 'ready', pid: process.pid, nodeVersion: process.version });
