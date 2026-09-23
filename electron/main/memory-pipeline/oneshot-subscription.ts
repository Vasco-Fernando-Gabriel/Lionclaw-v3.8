import { createLogger } from '../logger';
import { smokeAudit } from '../smoke-audit';
import type { OrchestratorSelection } from '../orchestrator-selection';
import { CLAUDE_MODELS } from '../../../src/constants/claude-models';
import { CODEX_MODELS } from '../../../src/constants/codex-models';
import { CLAUDE_COMPAT_PRESETS } from '../../../src/constants/claude-compat-presets';
import { KIMI_MODELS } from '../../../src/constants/kimi-models';
import { GROK_MODELS } from '../../../src/constants/grok-models';
import { CURSOR_MODELS } from '../../../src/constants/cursor-models';
import { randomUUID } from 'node:crypto';

const logger = createLogger('oneshot-subscription');

const MINIMAL_SYSTEM_PROMPT = 'You are a JSON summarizer. Respond only with the requested output.';

function stripFence(raw: string): string {
  let text = raw.trim();
  if (text.startsWith('```')) {
    text = text.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }
  return text;
}

async function drainAgentSdkQuery(q: AsyncIterable<unknown>): Promise<string> {
  let text = '';
  for await (const sdkMessage of q as AsyncIterable<Record<string, unknown>>) {
    if (sdkMessage.type === 'assistant') {
      const message = sdkMessage.message as { content?: Array<Record<string, unknown>> } | undefined;
      const blocks = message?.content ?? [];
      for (const block of blocks) {
        if (block.type === 'text' && typeof block.text === 'string') {
          text += block.text;
        }
      }
    } else if (sdkMessage.type === 'result') {
      if (sdkMessage.is_error === true) {
        const subtype = typeof sdkMessage.subtype === 'string' ? sdkMessage.subtype : 'unknown';
        const detail =
          typeof sdkMessage.result === 'string' && sdkMessage.result.trim().length > 0
            ? sdkMessage.result
            : 'sem detalhe';
        throw new Error(`one-shot Agent SDK terminou com erro (subtype=${subtype}): ${detail}`);
      }
      break;
    }
  }
  return text;
}

export async function runSubscriptionPrompt(
  selection: OrchestratorSelection,
  prompt: string,
  _opts?: { maxTokens?: number },
): Promise<string> {
  switch (selection.runtime) {
    case 'claude-sdk':
      return runClaudeSdkOneShot(selection, prompt);
    case 'claude-compat-sdk':
      return runClaudeCompatOneShot(selection, prompt);
    case 'codex-sdk':
      return runCodexOneShot(selection, prompt);
    case 'kimi-sdk':
      return runKimiSdkOneShot(selection, prompt);
    case 'grok-sdk':
      return runGrokSdkOneShot(selection, prompt);
    case 'cursor-sdk':
      return runCursorSdkOneShot(selection, prompt);
    case 'lion-sdk':
      throw new Error(
        'runSubscriptionPrompt: lion-sdk must not reach the subscription invoker ' +
          '(resolveCompactionSelection returns kind:"lion-sdk" for Lion providers).',
      );
    default: {
      const _exhaustive: never = selection.runtime;
      throw new Error(`runSubscriptionPrompt: unhandled runtime ${JSON.stringify(_exhaustive)}`);
    }
  }
}

async function runClaudeSdkOneShot(selection: OrchestratorSelection, prompt: string): Promise<string> {
  const { ensureAuthForSDK, ensureNodeInPath, getClaudeSdkProcessOptions } =
    await import('../pipeline-shared/sdk-bootstrap');
  const { getBackgroundCwd } = await import('../paths');
  await ensureAuthForSDK();
  ensureNodeInPath();
  const { query } = await import('@anthropic-ai/claude-agent-sdk');

  logger.info({ runtime: 'claude-sdk', model: selection.model }, 'runSubscriptionPrompt: claude-sdk one-shot');

  const q = query({
    prompt,
    options: {
      model: selection.model,
      maxTurns: 1,
      tools: [],
      allowedTools: [],
      settingSources: [],
      mcpServers: {},
      strictMcpConfig: true,
      includePartialMessages: false,
      systemPrompt: MINIMAL_SYSTEM_PROMPT,
      cwd: getBackgroundCwd(),
      ...getClaudeSdkProcessOptions(),
    } as Record<string, unknown>,
  });

  return stripFence(await drainAgentSdkQuery(q));
}

async function runClaudeCompatOneShot(selection: OrchestratorSelection, prompt: string): Promise<string> {
  const { ensureNodeInPath, getClaudeSdkProcessOptions } = await import('../pipeline-shared/sdk-bootstrap');
  const { getBackgroundCwd } = await import('../paths');
  const { buildCompatEnv } = await import('../claude-compat-sdk');
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  ensureNodeInPath();
  const compatEnv = buildCompatEnv(selection);

  logger.info(
    { runtime: 'claude-compat-sdk', provider: selection.provider, model: selection.model },
    'runSubscriptionPrompt: claude-compat-sdk one-shot',
  );

  const q = query({
    prompt,
    options: {
      model: selection.model, // verbatim slug — no slug rewrite
      maxTurns: 1,
      tools: [], // disables tools (same as (a))
      allowedTools: [],
      settingSources: [],
      mcpServers: {},
      strictMcpConfig: true,
      includePartialMessages: false,
      systemPrompt: MINIMAL_SYSTEM_PROMPT,
      cwd: getBackgroundCwd(),
      ...getClaudeSdkProcessOptions(),
      env: compatEnv,
    } as Record<string, unknown>,
  });

  return stripFence(await drainAgentSdkQuery(q));
}

async function runCodexOneShot(selection: OrchestratorSelection, prompt: string): Promise<string> {
  const { resolveCodexSessionForRun } = await import('../agent-runtime/codex-session-factory');
  const { getBackgroundCwd } = await import('../paths');

  logger.info({ runtime: 'codex-sdk', model: selection.model }, 'runSubscriptionPrompt: codex one-shot');

  const session = await resolveCodexSessionForRun({
    surface: 'one-shot',
    mcpProfile: 'one-shot',
    sessionOptions: {
      cwd: getBackgroundCwd(),
      model: selection.model,
      systemPrompt: MINIMAL_SYSTEM_PROMPT,
      approvalPolicy: 'never',
      sandbox: 'read-only',
      reasoningEffort: 'low',
      ownerKind: 'chat',
      ownerId: 'lionclaw-compaction',
    },
  });
  try {
    const res = await session.send(prompt);
    if (res.status !== 'completed') {
      const codeSuffix = res.errorCode ? ` (errorCode=${res.errorCode})` : '';
      throw new Error(`codex one-shot terminou com status ${res.status}${codeSuffix}`);
    }
    return stripFence(res.content);
  } finally {
    session.close();
  }
}

async function runKimiSdkOneShot(selection: OrchestratorSelection, prompt: string): Promise<string> {
  const { isKimiAvailable, resolveKimiBinary, KimiUnavailableError } =
    await import('../agent-runtime/kimi-availability');
  const { getKimiAcpDriver } = await import('../kimi-acp/acp-driver');
  const { acquireKimiSlot } = await import('../agent-runtime/kimi-concurrency');
  const { PERM_DEFAULT_NO_BYPASS } = await import('../agent-runtime/permission-profiles');
  const { getBackgroundCwd } = await import('../paths');

  const availability = await isKimiAvailable();
  if (availability.authMode === 'none') {
    throw new KimiUnavailableError(
      'Kimi nao esta autenticado para compactacao one-shot (faca login no CLI por assinatura).',
    );
  }

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (key.startsWith('ANTHROPIC_')) continue;
    env[key] = value;
  }

  const binary = await resolveKimiBinary();

  logger.info({ runtime: 'kimi-sdk', model: selection.model }, 'runSubscriptionPrompt: kimi one-shot');

  const driver = getKimiAcpDriver();
  const releaseSlot = await acquireKimiSlot({ role: 'standalone', toolBearing: false });
  let handle: Awaited<ReturnType<typeof driver.createRun>> | null = null;

  const leadingPrompt = `## Instrucoes\n\n${MINIMAL_SYSTEM_PROMPT}\n\n## Tarefa\n\n${prompt}`;

  try {
    handle = await driver.createRun({
      workDir: getBackgroundCwd(),
      model: selection.model,
      effort: selection.effort,
      thinking: false,
      systemPrompt: '',
      ...(binary ? { executable: binary } : {}),
      env,
      profile: 'one-shot',
      surface: 'oneshot',
      ownerKind: 'oneshot',
      runId: `kimi-oneshot-${randomUUID()}`,
      mcpServers: [],
      permission: PERM_DEFAULT_NO_BYPASS,
    });
    const res = await handle.send(leadingPrompt, {});
    if (res.status !== 'finished') {
      throw new Error(`kimi one-shot terminou com status ${res.status}`);
    }
    return stripFence(res.content);
  } finally {
    if (handle) {
      try {
        await handle.close();
      } catch (err) {
        logger.warn({ err }, 'kimi one-shot handle.close() failed');
      }
    }
    releaseSlot();
  }
}

async function runGrokSdkOneShot(selection: OrchestratorSelection, prompt: string): Promise<string> {
  const {
    buildGrokChildEnv,
    isGrokAvailable,
    prepareGrokWorkspace,
    resolveGrokBinary,
    resolveGrokHome,
    GrokUnavailableError,
  } = await import('../agent-runtime/grok-availability');
  const { acquireGrokSlot, configureGrokConcurrency } = await import('../agent-runtime/grok-concurrency');
  const { getGrokAcpDriver } = await import('../grok-acp/acp-driver');
  const { buildGrokNativeToolPolicy } = await import('../agent-runtime/grok-session-config');
  const { PERM_DEFAULT_NO_BYPASS } = await import('../agent-runtime/permission-profiles');
  const {
    acquireGrokSandboxSpawnLock,
    assertGrokWorkspaceUnchanged,
    attestGrokSession,
    ensureGrokSandboxProfile,
    resolveGrokWorkspaceGrant,
    snapshotGrokSandboxAttestation,
    waitForGrokSandboxApplied,
  } = await import('../grok-sdk/workspace');
  const availability = await isGrokAvailable();
  if (!availability.usable) {
    throw new GrokUnavailableError(availability.reason ?? 'Grok Build indisponivel para compactacao one-shot.');
  }
  const binary = await resolveGrokBinary();
  if (!binary) throw new GrokUnavailableError('Grok Build CLI nao encontrado.');
  const grant = resolveGrokWorkspaceGrant({ lane: 'cron' });
  const env = buildGrokChildEnv();
  const grokHome = resolveGrokHome();
  await prepareGrokWorkspace(grant, binary, env);
  const { getSetting } = await import('../db');
  const configuredConcurrency = Number.parseInt(getSetting('grok_max_concurrency') || '3', 10);
  configureGrokConcurrency(
    Number.isInteger(configuredConcurrency) && configuredConcurrency >= 1 && configuredConcurrency <= 16
      ? configuredConcurrency
      : 3,
  );
  const release = await acquireGrokSlot({ role: 'standalone', toolBearing: false });
  let handle: Awaited<ReturnType<ReturnType<typeof getGrokAcpDriver>['createRun']>> | null = null;
  try {
    const releaseSandboxSpawn = await acquireGrokSandboxSpawnLock();
    try {
      const sandbox = ensureGrokSandboxProfile(grant, grokHome, 'strict');
      const sandboxAttestation = snapshotGrokSandboxAttestation(
        grokHome,
        sandbox,
        grant.processCwd,
        grant.projectSources.map((source) => source.path),
      );
      handle = await getGrokAcpDriver().createRun({
        workDir: grant.sessionCwd,
        processCwd: grant.processCwd,
        model: selection.model,
        effort: (selection.effort ?? 'low') as 'low' | 'medium' | 'high',
        thinking: true,
        systemPrompt: '',
        executable: binary,
        env,
        profile: 'one-shot',
        surface: 'oneshot',
        ownerKind: 'oneshot',
        runId: `grok-oneshot-${Date.now()}`,
        sandbox,
        permission: PERM_DEFAULT_NO_BYPASS,
        nativeToolArgs: buildGrokNativeToolPolicy('one-shot', []).argv,
        mcpServers: [],
        attestSession: (sessionId) => attestGrokSession(grant, grokHome, sessionId),
        assertWorkspaceUnchanged: () => assertGrokWorkspaceUnchanged(grant),
      });
      await waitForGrokSandboxApplied(sandboxAttestation);
    } finally {
      releaseSandboxSpawn();
    }
    const result = await handle.send(`## Instrucoes\n\n${MINIMAL_SYSTEM_PROMPT}\n\n## Tarefa\n\n${prompt}`, {});
    if (result.status !== 'finished') {
      throw new Error(`grok one-shot terminou com status ${result.status}`);
    }
    return stripFence(result.content);
  } finally {
    if (handle) await handle.close().catch((error) => logger.warn({ error }, 'grok one-shot close failed'));
    release();
  }
}

const CURSOR_ONE_SHOT_TIMEOUT_MS = 90_000;

async function runCursorSdkOneShot(selection: OrchestratorSelection, prompt: string): Promise<string> {
  const { runCursorSidecarExecution } = await import('../agent-runtime/cursor-sidecar/sidecar-manager');
  const { getSecret } = await import('../secrets-vault');
  const { getBackgroundCwd } = await import('../paths');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const fs = await import('node:fs');

  const apiKey = await getSecret('CURSOR_API_KEY');
  if (!apiKey) {
    throw new Error('Cursor nao conectado para one-shot (CURSOR_API_KEY ausente do Vault).');
  }

  const executionId = `cursor-oneshot-${randomUUID()}`;
  const storeDir = path.join(tmpdir(), 'lionclaw-cursor-oneshot', executionId);
  fs.mkdirSync(storeDir, { recursive: true });

  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), CURSOR_ONE_SHOT_TIMEOUT_MS);
  timeout.unref?.();

  logger.info({ runtime: 'cursor-sdk', model: selection.model }, 'runSubscriptionPrompt: cursor one-shot');

  try {
    const result = await runCursorSidecarExecution({
      config: {
        executionId,
        model: selection.model,
        apiKey,
        cwd: getBackgroundCwd(),
        storeDir,
        prompt: `## Instrucoes\n\n${MINIMAL_SYSTEM_PROMPT}\n\n## Tarefa\n\n${prompt}`,
        settingSources: [],
        allowedTools: ['mcp'],
        guarded: true,
        customTools: [],
      },
      abortController,
      dispatchTool: async (invocation) => {
        throw new Error(`one-shot cursor nao expoe tools (invocacao inesperada de ${invocation.toolName})`);
      },
    });
    if (result.status === 'cancelled') {
      throw new Error(`cursor one-shot abortado por timeout (${CURSOR_ONE_SHOT_TIMEOUT_MS}ms sem resposta)`);
    }
    const text = (result.resultText ?? result.finalText ?? '').trim();
    if (text.length === 0) {
      throw new Error(`cursor one-shot terminou sem texto (status ${result.status})`);
    }
    return stripFence(text);
  } finally {
    clearTimeout(timeout);
    fs.rm(storeDir, { recursive: true, force: true }, () => {});
  }
}

export interface SubscriptionRunResult {
  text: string;
  actualModelLabel: string;
}

export function humanizeModelLabel(selection: OrchestratorSelection): string {
  const slug = selection.model;

  const claude = CLAUDE_MODELS.find((m) => m.id === slug);
  if (claude) return claude.displayName;

  const compat = CLAUDE_COMPAT_PRESETS.flatMap((p) => p.models).find((m) => m.id === slug);
  if (compat) return compat.displayName;

  const codex = CODEX_MODELS.find((m) => m.slug === slug);
  if (codex) return `Codex ${codex.label}`;

  const kimi = KIMI_MODELS.find((m) => m.slug === slug);
  if (kimi) return kimi.label;

  const grok = GROK_MODELS.find((m) => m.slug === slug);
  if (grok) return grok.label;

  const cursor = CURSOR_MODELS.find((m) => m.slug === slug);
  if (cursor) return cursor.label;

  return slug || selection.provider;
}

export async function runSubscriptionPromptWithFallback(
  sel: OrchestratorSelection,
  prompt: string,
  opts?: { maxTokens?: number },
): Promise<SubscriptionRunResult> {
  try {
    const text = await runSubscriptionPrompt(sel, prompt, opts);
    smokeAudit('compaction_run', { runtime: sel.runtime, model: sel.model });
    return { text, actualModelLabel: humanizeModelLabel(sel) };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    smokeAudit('compaction_run_failed', {
      runtime: sel.runtime,
      model: sel.model,
      err: errMsg.length > 80 ? `${errMsg.slice(0, 77)}...` : errMsg,
    });
    throw err;
  }
}
