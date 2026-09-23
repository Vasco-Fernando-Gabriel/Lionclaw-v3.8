import fs from 'fs';
import path from 'path';
import {
  getDb,
  getSessionMessages,
  getSession,
  getSetting,
  insertChunkWithEmbedding,
  searchBM25,
  searchVector,
  setLastGateRunAt,
} from './db';
import { acquireDreamingMutex } from './dreaming-mutex';
import { createLogger } from './logger';
import { getLionClawHome } from './paths';
import { extractBalancedJsonObjectCandidates } from './json-extractor';
import type { GateOutputApplyItem, MemorySection, DreamingGateResult } from './dreaming-gate';
import { runDreamingGate, saveDreamingReport } from './dreaming-gate';
import { generateEmbedding as generateEmbeddingProvider } from './embedding-provider';
import {
  executeVaultOperation,
  regenerateVaultIndex,
  updateVaultHot,
  appendVaultLog,
  getExistingVaultFilesList,
} from './mgraph-engine';
import { BrowserWindow } from 'electron';
import type { ChatMessage, OrchestratorProvider, OrchestratorRuntime, VaultOperation } from '../../src/types';
import { attachToolsBlocks, buildToolsBlocksByAnchor } from './session-timeline';
import { isChatTimelineReinjectEnabled } from './chat-compaction-trigger';
import {
  resolveOrchestratorSelection,
  resolveSubscriptionSelectionFor,
  InvalidOrchestratorSelectionError,
} from './orchestrator-selection';
import type { OrchestratorSelection } from './orchestrator-selection';
import { runSubscriptionPromptWithFallback } from './memory-pipeline/oneshot-subscription';
import { EmptyProviderResponseError } from './agent-runtime/llm-error';
import { smokeAudit } from './smoke-audit';
import { estimateTokens, excerptStartEnd } from './token-estimator';
import {
  buildBudgetedMessageText,
  resolveCompactionInputBudget,
  resolveLocalInputWarnTokens,
  summarizePlainBlock,
} from './memory-pipeline/budgeted-input';
import type { PlainPromptInvoker } from './memory-pipeline/budgeted-input';
import { splitIntoSections, joinSections, countNonEmptyLines } from './memory-pipeline/md-sections';
import {
  updateUserProfileSectionAware,
  applyUserProfileUpdates,
  maybeSanitizeUserProfile,
} from './memory-pipeline/user-profile';
import type { LionAdapter, LionChatMessage } from './lion-sdk/adapters/types';
import { createLmStudioAdapter } from './lion-sdk/adapters/lmstudio';
import { createOllamaAdapter } from './lion-sdk/adapters/ollama';
import { createOpenAiCompatibleAdapter } from './lion-sdk/adapters/openai-compatible';
import { createGoogleGenAiAdapter } from './lion-sdk/adapters/google-genai';

const logger = createLogger('memory');

export type CompactionErrorCode = 'compaction_provider_unavailable';

export class CompactionProviderUnavailableError extends Error {
  readonly code: CompactionErrorCode;

  constructor(message: string, code: CompactionErrorCode = 'compaction_provider_unavailable') {
    super(message);
    this.name = 'CompactionProviderUnavailableError';
    this.code = code;
  }
}

let memoryGateMutex: Promise<void> = Promise.resolve();

let memoryGateActive = false;

let memoryGateReserved = false;

export async function withMemoryGateLock<T>(fn: () => Promise<T>): Promise<T> {
  const prev = memoryGateMutex;
  let release!: () => void;
  memoryGateMutex = new Promise<void>((resolve) => {
    release = resolve;
  });
  await prev;
  memoryGateActive = true;
  try {
    return await fn();
  } finally {
    memoryGateActive = false;
    release();
  }
}

export async function tryWithMemoryGateLock<T>(fn: () => Promise<T>): Promise<T | null> {
  if (memoryGateActive || memoryGateReserved) {
    return null;
  }
  memoryGateReserved = true;
  try {
    return await withMemoryGateLock(fn);
  } finally {
    memoryGateReserved = false;
  }
}

function getLionClawPath(): string {
  return getLionClawHome();
}

function formatToday(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function readMemoryMd(): string {
  const memoryPath = path.join(getLionClawPath(), 'MEMORY.md');
  try {
    return fs.readFileSync(memoryPath, 'utf-8');
  } catch {
    return '';
  }
}

function readUserMd(): string {
  const userPath = path.join(getLionClawPath(), 'USER.md');
  try {
    return fs.readFileSync(userPath, 'utf-8');
  } catch {
    return '';
  }
}

export type CompactionStepErrorCode = 'COMPACT-SUMMARY-FAILED' | 'COMPACT-MEMORY-FAILED';

export class CompactionStepError extends Error {
  readonly code: CompactionStepErrorCode;
  readonly cause: unknown;

  constructor(code: CompactionStepErrorCode, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(
      code === 'COMPACT-SUMMARY-FAILED'
        ? `Sumarizador falhou: ${detail}`
        : `Gate de memoria / MEMORY.md / USER.md falhou: ${detail}`,
    );
    this.name = 'CompactionStepError';
    this.code = code;
    this.cause = cause;
  }
}

export function isCompactionStepError(err: unknown): err is CompactionStepError {
  return err instanceof CompactionStepError;
}

export interface CompactionWarning {
  step: 'embeddings' | 'graph' | 'transcript' | 'report' | 'compaction_log';
  detail: string;
}

export const EMBEDDINGS_PROVIDER_MISSING_WARNING = 'configure um provedor de embeddings em Settings';

export interface RunCompactionOptions {
  onModelLabel?: (label: string) => void;
  sinceMessageId?: number;
  priorSummary?: string;
  skipDailySummary?: boolean;
  transcriptName?: string;
  dreamingMutex?: 'acquire' | 'held';
}

export interface RunCompactionResult {
  executiveSummary: string;
  warnings: CompactionWarning[];
}

export async function runCompaction(
  periodStart: Date,
  periodEnd: Date,
  sessionId?: string,
  opts?: RunCompactionOptions,
): Promise<RunCompactionResult | undefined> {
  if (opts?.dreamingMutex === 'held') {
    return runCompactionUnderMutex(periodStart, periodEnd, sessionId, opts);
  }
  const release = await acquireDreamingMutex();
  try {
    return await runCompactionUnderMutex(periodStart, periodEnd, sessionId, opts);
  } finally {
    release();
  }
}

async function runCompactionUnderMutex(
  periodStart: Date,
  periodEnd: Date,
  sessionId?: string,
  opts?: RunCompactionOptions,
): Promise<RunCompactionResult | undefined> {
  const db = getDb();
  const warnings: CompactionWarning[] = [];

  let messages: Array<Record<string, unknown>>;
  if (sessionId) {
    if (opts?.sinceMessageId !== undefined) {
      messages = db
        .prepare(
          `
        SELECT m.*, s.title as session_title
        FROM messages m
        JOIN sessions s ON m.session_id = s.id
        WHERE m.session_id = ? AND m.id > ?
        ORDER BY m.created_at ASC
      `,
        )
        .all(sessionId, opts.sinceMessageId) as Array<Record<string, unknown>>;
    } else {
      messages = db
        .prepare(
          `
        SELECT m.*, s.title as session_title
        FROM messages m
        JOIN sessions s ON m.session_id = s.id
        WHERE m.session_id = ?
        ORDER BY m.created_at ASC
      `,
        )
        .all(sessionId) as Array<Record<string, unknown>>;
    }
  } else {
    const formatForSQLite = (d: Date) => d.toISOString().replace('T', ' ').replace('Z', '');
    messages = db
      .prepare(
        `
      SELECT m.*, s.title as session_title
      FROM messages m
      JOIN sessions s ON m.session_id = s.id
      WHERE m.created_at >= ? AND m.created_at <= ?
      ORDER BY m.created_at ASC
    `,
      )
      .all(formatForSQLite(periodStart), formatForSQLite(periodEnd)) as Array<Record<string, unknown>>;
  }

  if (messages.length === 0) {
    logger.info('No messages to compact');
    return undefined;
  }

  logger.info({ count: messages.length }, 'Compacting messages');

  let selection: CompactionSelection;
  try {
    selection = await resolveCompactionSelection();
  } catch (error) {
    logger.error({ error }, 'Compaction selection failed');
    throw new CompactionStepError('COMPACT-SUMMARY-FAILED', error);
  }
  const plainInvoker = makePlainCompactionInvoker(selection);

  const budget = resolveCompactionInputBudget(selection.kind);
  let priorSummary = opts?.priorSummary && opts.priorSummary.trim().length > 0 ? opts.priorSummary : undefined;
  const budgetFloor = Math.ceil(budget * 0.5);
  let budgetMsgs = budget - estimateTokens(buildCompactionBasePrompt('', priorSummary));
  if (budgetMsgs < budgetFloor && priorSummary && estimateTokens(priorSummary) > 1500) {
    try {
      priorSummary = await summarizePlainBlock({
        invoker: plainInvoker,
        kind: selection.kind,
        text: priorSummary,
        targetTokens: 1500,
      });
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'pre-compressao do priorSummary falhou — excerpt deterministico (fallback nivel 1)',
      );
      priorSummary = excerptStartEnd(priorSummary, 1500 * 4);
    }
    budgetMsgs = budget - estimateTokens(buildCompactionBasePrompt('', priorSummary));
  }
  if (budgetMsgs < budgetFloor) budgetMsgs = budgetFloor;

  const built = await buildBudgetedMessageText(
    messages.map((m) => ({ role: m['role'] as string, content: m['content'] as string })),
    budgetMsgs,
    { kind: selection.kind, invoker: plainInvoker, clampBudgetTokens: budget },
  );
  const messageText = built.messageText;

  logger.info(
    {
      sessionId: sessionId ?? null,
      deltaMessages: messages.length,
      rawChars: built.stats.rawChars,
      rawTokensEst: built.stats.rawTokensEst,
      budget,
      verbatimCount: built.stats.verbatimCount,
      presummarizedCount: built.stats.presummarizedCount,
      mapCalls: built.stats.mapCalls,
      mapInputTokensEst: built.stats.mapInputTokensEst,
      finalInputTokensEst: built.stats.finalInputTokensEst,
      deterministicFallbacks: built.stats.deterministicFallbacks,
      durationMs: built.stats.durationMs,
    },
    'compaction input budget',
  );

  let summary: CompactionResult;
  try {
    summary = await summarizeMessages(messageText, selection, opts?.onModelLabel, priorSummary);
  } catch (error) {
    logger.error({ error }, 'Summarization failed');
    throw new CompactionStepError('COMPACT-SUMMARY-FAILED', error);
  }

  let gateResult: DreamingGateResult | undefined;
  try {
    await withMemoryGateLock(async () => {
      await maybeSanitizeUserProfile({ kind: selection.kind, invoker: plainInvoker });

      const memoryMd = readMemoryMd();
      const userMd = readUserMd();
      const wmu = summary.working_memory_updates;
      const candidateAdds = Array.isArray(wmu?.add) ? wmu.add : [];
      const candidateRemoves = Array.isArray(wmu?.remove) ? wmu.remove : [];
      const upu = summary.user_profile_updates;
      const userCandidates =
        Array.isArray(upu) && upu.length > 0
          ? upu.map((u) => ({ action: u.action, section: u.section, fact: u.fact }))
          : undefined;
      gateResult = await runDreamingGate({
        candidates: [
          ...candidateAdds.map((text) => ({ kind: 'add' as const, text })),
          ...candidateRemoves.map((text) => ({ kind: 'remove' as const, text })),
        ],
        ...(userCandidates ? { userCandidates } : {}),
        currentMemoryMd: memoryMd,
        currentUserMd: userMd,
        conversationExcerpt: messageText.slice(-8000),
      });
      await updateWorkingMemory(gateResult.apply);
      await updateUserProfileSectionAware({
        add: gateResult.apply.userAdd ?? [],
        remove: gateResult.apply.userRemove ?? [],
      });
    });
  } catch (err) {
    logger.error({ err }, 'Dreaming gate / MEMORY.md / USER.md apply failed (Clear recusado, D3 passo 2)');
    throw new CompactionStepError('COMPACT-MEMORY-FAILED', err);
  }

  if (gateResult) {
    try {
      await saveDreamingReport(gateResult);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      logger.warn({ err }, 'saveDreamingReport failed (aviso, ciclo segue)');
      warnings.push({ step: 'report', detail });
    }
  }
  setLastGateRunAt(Date.now());

  const totalChunks = summary.semantic_chunks.length;
  let chunksSkipped = 0;
  let lastEmbeddingFailure = '';
  let embeddingsProviderMissing = false;
  for (const chunk of summary.semantic_chunks) {
    if (embeddingsProviderMissing) {
      chunksSkipped++;
      continue;
    }
    try {
      const result = await generateEmbeddingProvider(chunk.content);
      if (result.ok) {
        insertChunkWithEmbedding(chunk.content, chunk.topic, result.embedding);
        logger.debug({ provider: result.provider, model: result.model, dims: result.dimensions }, 'Chunk embedded');
        continue;
      }
      chunksSkipped++;
      if (result.provider === 'none') {
        embeddingsProviderMissing = true;
        logger.warn({ reason: result.reason }, 'Embeddings sem provedor: nenhum chunk gravado');
        continue;
      }
      lastEmbeddingFailure = result.reason;
      logger.warn(
        { code: result.code, provider: result.provider, status: result.status, reason: result.reason },
        'Embedding generation failed: chunk NAO gravado (nunca texto sem vetor)',
      );
    } catch (err) {
      chunksSkipped++;
      lastEmbeddingFailure = err instanceof Error ? err.message : String(err);
      logger.warn({ err }, 'Embedding generation threw: chunk NAO gravado (nunca texto sem vetor)');
    }
  }
  if (embeddingsProviderMissing) {
    warnings.push({
      step: 'embeddings',
      detail: `${EMBEDDINGS_PROVIDER_MISSING_WARNING} (${chunksSkipped} de ${totalChunks} chunks nao gravados)`,
    });
  } else if (chunksSkipped > 0) {
    warnings.push({
      step: 'embeddings',
      detail: `${chunksSkipped} de ${totalChunks} chunks nao gravados por falha de embedding: ${lastEmbeddingFailure}`,
    });
  }

  try {
    if (getSetting('mgraph_mode') === 'true' && summary.vault_operations && summary.vault_operations.length > 0) {
      let opsProcessed = 0;
      let opsFailed = 0;
      let lastOpError = '';
      for (const op of summary.vault_operations) {
        try {
          const result = executeVaultOperation(op);
          if (result.success) {
            opsProcessed++;
            appendVaultLog(
              `[${new Date().toISOString()}] ${op.action.toUpperCase()} ${op.path} "${op.title}" (source:compaction)`,
            );
          } else {
            opsFailed++;
            lastOpError = result.error ?? 'erro desconhecido';
            logger.warn({ path: op.path, error: result.error }, 'Vault operation failed');
            appendVaultLog(`[${new Date().toISOString()}] FAILED ${op.path} "${op.title}" error:${result.error}`);
          }
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          opsFailed++;
          lastOpError = errMsg;
          logger.warn({ path: op.path, error: errMsg }, 'Vault operation threw error');
          appendVaultLog(`[${new Date().toISOString()}] ERROR ${op.path} "${op.title}" error:${errMsg}`);
        }
      }
      if (opsFailed > 0) {
        warnings.push({
          step: 'graph',
          detail: `${opsFailed} de ${summary.vault_operations.length} operacoes do graph falharam: ${lastOpError}`,
        });
      }

      regenerateVaultIndex();
      updateVaultHot();

      const mainWindow = BrowserWindow.getAllWindows()[0];
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('mgraph:updated');
      }

      logger.info({ operations: opsProcessed }, 'Memory graph updated');
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.warn({ err }, 'Vault operations block failed (aviso, ciclo segue)');
    warnings.push({ step: 'graph', detail });
  }

  const dateStr = periodStart.toISOString().split('T')[0];
  if (!opts?.skipDailySummary) {
    try {
      db.prepare(
        `
        INSERT OR REPLACE INTO daily_summaries
        (date, summary, decisions, tasks_created, facts_extracted, message_count, subagents_used)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
      ).run(
        dateStr,
        summary.executive_summary,
        JSON.stringify(summary.decisions),
        JSON.stringify(summary.tasks_created),
        JSON.stringify(summary.facts),
        messages.length,
        JSON.stringify([...new Set(messages.map((m) => m['subagent']).filter(Boolean))]),
      );
    } catch (err) {
      logger.warn({ err }, 'Daily summary write failed (catch-and-warn, ciclo segue)');
    }
  }

  try {
    db.prepare(
      `
      INSERT INTO compaction_log (period_start, period_end, messages_processed, chunks_created, facts_updated)
      VALUES (?, ?, ?, ?, ?)
    `,
    ).run(
      periodStart.toISOString(),
      periodEnd.toISOString(),
      messages.length,
      summary.semantic_chunks.length,
      summary.facts.length,
    );
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.warn({ err }, 'compaction_log write failed (aviso, ciclo segue)');
    warnings.push({ step: 'compaction_log', detail });
  }

  try {
    archiveTranscript(messages, dateStr, summary.executive_summary, opts?.transcriptName);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.warn({ err }, 'archiveTranscript failed (aviso, ciclo segue)');
    warnings.push({ step: 'transcript', detail });
  }

  logger.info(
    {
      messages: messages.length,
      chunks: summary.semantic_chunks.length,
      chunksSkipped,
      facts: summary.facts.length,
      warnings: warnings.length,
    },
    'Compaction complete',
  );

  return { executiveSummary: summary.executive_summary, warnings };
}

export interface SummarizeLightweightOptions {
  sinceMessageId?: number;
  priorSummary?: string;
  onModelLabel?: (label: string) => void;
}

function toSummarizerMessages(rows: Array<Record<string, unknown>>): Array<{ role: string; content: string }> {
  return rows.map((row) => ({ role: row['role'] as string, content: row['content'] as string }));
}

function toSummarizerMessagesWithTools(
  sessionId: string,
  rows: Array<Record<string, unknown>>,
  fence: number | null,
): Array<{ role: string; content: string }> {
  const messages: ChatMessage[] = rows.map((row) => ({
    id: row['id'] as number,
    sessionId,
    role: row['role'] as ChatMessage['role'],
    content: row['content'] as string,
    createdAt: row['created_at'] as string,
  }));

  const toolsByAnchor = buildToolsBlocksByAnchor(sessionId, messages, fence);
  return attachToolsBlocks(messages, toolsByAnchor).map(({ message, toolsBlock }) => ({
    role: message.role,
    content: toolsBlock === undefined ? message.content : `${message.content}\n\n${toolsBlock}`,
  }));
}

export async function summarizeLightweight(
  sessionId: string,
  opts?: SummarizeLightweightOptions,
): Promise<RunCompactionResult | undefined> {
  const db = getDb();

  let messages: Array<Record<string, unknown>>;
  if (opts?.sinceMessageId !== undefined) {
    messages = db
      .prepare(
        `
      SELECT m.id, m.role, m.content, m.created_at, s.title as session_title
      FROM messages m
      JOIN sessions s ON m.session_id = s.id
      WHERE m.session_id = ? AND m.id > ?
      ORDER BY m.created_at ASC, m.id ASC
    `,
      )
      .all(sessionId, opts.sinceMessageId) as Array<Record<string, unknown>>;
  } else {
    messages = db
      .prepare(
        `
      SELECT m.id, m.role, m.content, m.created_at, s.title as session_title
      FROM messages m
      JOIN sessions s ON m.session_id = s.id
      WHERE m.session_id = ?
      ORDER BY m.created_at ASC, m.id ASC
    `,
      )
      .all(sessionId) as Array<Record<string, unknown>>;
  }

  if (messages.length === 0) {
    logger.info({ sessionId }, 'summarizeLightweight: delta vazio (no-op, V11)');
    return undefined;
  }

  const selection = await resolveCompactionSelection();
  const plainInvoker = makePlainCompactionInvoker(selection);

  const budget = resolveCompactionInputBudget(selection.kind);
  let priorSummary = opts?.priorSummary && opts.priorSummary.trim().length > 0 ? opts.priorSummary : undefined;
  const budgetFloor = Math.ceil(budget * 0.5);
  let budgetMsgs = budget - estimateTokens(buildCompactionBasePrompt('', priorSummary));
  if (budgetMsgs < budgetFloor && priorSummary && estimateTokens(priorSummary) > 1500) {
    priorSummary = excerptStartEnd(priorSummary, 1500 * 4);
    budgetMsgs = budget - estimateTokens(buildCompactionBasePrompt('', priorSummary));
  }
  if (budgetMsgs < budgetFloor) budgetMsgs = budgetFloor;

  const summarizerMessages = isChatTimelineReinjectEnabled()
    ? toSummarizerMessagesWithTools(sessionId, messages, opts?.sinceMessageId ?? null)
    : toSummarizerMessages(messages);

  const built = await buildBudgetedMessageText(summarizerMessages, budgetMsgs, {
    kind: selection.kind,
    invoker: plainInvoker,
    clampBudgetTokens: budget,
  });

  logger.info(
    {
      sessionId,
      deltaMessages: messages.length,
      budget,
      finalInputTokensEst: built.stats.finalInputTokensEst,
      durationMs: built.stats.durationMs,
    },
    'chat lightweight compaction input budget (SA-4)',
  );

  const summary = await summarizeMessages(built.messageText, selection, opts?.onModelLabel, priorSummary);
  return { executiveSummary: summary.executive_summary, warnings: [] };
}

function parseCompactionResultLenient(text: string): CompactionResult {
  try {
    return JSON.parse(text) as CompactionResult;
  } catch (strictError) {
    for (const candidate of extractBalancedJsonObjectCandidates(text)) {
      try {
        const parsed = JSON.parse(candidate) as CompactionResult;
        if (parsed && typeof parsed === 'object' && 'executive_summary' in parsed) {
          logger.warn(
            { textLength: text.length, candidateLength: candidate.length },
            'compaction: resposta com conteudo extra apos o JSON; primeiro objeto balanceado usado',
          );
          return parsed;
        }
      } catch {}
    }
    throw strictError;
  }
}

interface CompactionResult {
  executive_summary: string;
  decisions: string[];
  tasks_created: string[];
  facts: string[];
  semantic_chunks: Array<{ topic: string; content: string }>;
  user_profile_updates: Array<{ action: 'add' | 'remove'; section: string; fact: string }>;
  working_memory_updates: {
    add: string[];
    remove: string[];
  };
  vault_operations?: VaultOperation[];
}

const COMPACTION_PROMPT = `You are a memory management system. Analyze the following conversation messages and produce a structured summary.

TODAY (use this exact date in any [YYYY-MM-DD] tag you write): {{TODAY}}

MESSAGES:
{{MESSAGES}}

Separe os fatos em duas categorias:

1. **user_profile_updates**: Fatos sobre o USUARIO que devem ir no USER.md
   - Nome, profissao, stack tecnologico, preferencias de trabalho
   - Projetos em que esta trabalhando
   - Habitos e preferencias descobertos
   Formato: { action: 'add' | 'remove', section: string, fact: string }
   section (dica; a secao final e decidida depois) — uma das 6 canonicas do USER.md:
   Identidade | Perfil profissional | Negocios e projetos | Stack e ferramentas | Preferencias | Fatos duraveis
   O USER.md tem cap de ~60 linhas nao-vazias: proponha apenas fatos DURAVEIS.

2. **working_memory_updates**: Fatos sobre o CONTEXTO ATUAL que devem ir no MEMORY.md
   - Decisoes tomadas na conversa
   - Tarefas em andamento
   - Contexto temporario relevante

Produce a JSON response with this exact structure:
{
  "executive_summary": "3-5 sentence summary of the session",
  "decisions": ["Decision 1", "Decision 2"],
  "tasks_created": ["Task 1", "Task 2"],
  "facts": ["Fact about user or project 1", "Fact 2"],
  "semantic_chunks": [
    {
      "topic": "Short topic label",
      "content": "200-500 token summary of this topic with key details"
    }
  ],
  "user_profile_updates": [
    { "action": "add", "section": "Perfil profissional", "fact": "Desenvolve com TypeScript" }
  ],
  "working_memory_updates": {
    "add": ["New fact to add to working memory"],
    "remove": ["Stale fact to remove from working memory"]
  }
}

Rules:
- Facts should be atomic, one concept per fact
- executive_summary: no maximo ~1500 tokens. E um resumo ROLANTE: ao fundir com um resumo anterior, condense — NUNCA cresca alem desse teto ciclo a ciclo
- Semantic chunks should be self-contained
- user_profile_updates: facts about the USER (relatively static info like role, preferences, tools)
- working_memory_updates: facts about CURRENT CONTEXT (temporary, situational)
- Always respond in Brazilian Portuguese
- Output ONLY the JSON, no markdown fences, no explanation`;

function buildVaultInstructionsBlock(): string {
  const existingFiles = getExistingVaultFilesList();
  return `

VAULT INSTRUCTIONS:
Alem do JSON principal, inclua um campo "vault_operations" no JSON de resposta.
Gere operacoes para alimentar o memory graph com informacoes significativas da conversa.

EXISTING_VAULT_FILES:
${existingFiles || '(nenhuma nota existente)'}

Regras para vault_operations:
- Use backlinks com [[filename-sem-extensao]] em kebab-case para conectar notas relacionadas
- Para notas que ja existem em EXISTING_VAULT_FILES, use action "update" com append:true
- Conteudo deve ser conciso, autocontido e em portugues
- Path format: {type}/{slug}.md onde type e: entities, meetings, decisions, projects, references
- Slug: lowercase, apenas a-z 0-9 hyphens, max 50 chars
- Somente crie notas para informacoes SIGNIFICATIVAS (entidades recorrentes, decisoes explicitas, projetos detalhados)
- Se nao houver informacao significativa, retorne "vault_operations": []

Formato de cada operacao:
{
  "action": "create" | "update",
  "path": "type/slug.md",
  "type": "entity" | "meeting" | "decision" | "project" | "reference",
  "title": "Titulo legivel",
  "tags": ["tag1", "tag2"],
  "content": "Conteudo markdown com [[backlinks]]",
  "append": true  // apenas para updates
}`;
}

function buildPriorSummaryBlock(priorSummary: string): string {
  return `

RESUMO ROLANTE ANTERIOR (cobre a conversa ANTES das MESSAGES acima):
${priorSummary}

REGRA DO RESUMO ROLANTE: o campo "executive_summary" do JSON deve ser UM UNICO resumo rolante coeso que FUNDE o RESUMO ROLANTE ANTERIOR com as MESSAGES novas. Em conflito entre informacao antiga e nova, a informacao mais RECENTE (das MESSAGES) PREVALECE. Nao liste versoes antigas de decisoes ja substituidas; descreva o estado atual.`;
}

function buildCompactionBasePrompt(messageText: string, priorSummary?: string): string {
  let basePrompt = COMPACTION_PROMPT.replace('{{TODAY}}', formatToday()).replace('{{MESSAGES}}', () => messageText);
  if (priorSummary && priorSummary.trim().length > 0) {
    basePrompt += buildPriorSummaryBlock(priorSummary);
  }
  if (getSetting('mgraph_mode') === 'true') {
    basePrompt += buildVaultInstructionsBlock();
  }
  return basePrompt;
}

type OnModelLabel = (label: string) => void;

async function summarizeMessages(
  messageText: string,
  selection: CompactionSelection,
  onModelLabel?: OnModelLabel,
  priorSummary?: string,
): Promise<CompactionResult> {
  if (selection.kind === 'lion-sdk') {
    const lionSel: LionCompactionSelection = {
      provider: selection.provider,
      model: selection.model,
      baseUrl: selection.baseUrl,
      apiKey: selection.apiKey,
      source: selection.source,
    };
    return await summarizeWithLionSdk(lionSel, messageText, priorSummary);
  }

  if (selection.kind === 'subscription') {
    return await summarizeWithSubscription(selection.selection, messageText, onModelLabel, priorSummary);
  }

  return await summarizeWithClaude(messageText, selection.model, priorSummary);
}

function makePlainCompactionInvoker(selection: CompactionSelection): PlainPromptInvoker {
  if (selection.kind === 'lion-sdk') {
    const lionSel: LionCompactionSelection = {
      provider: selection.provider,
      model: selection.model,
      baseUrl: selection.baseUrl,
      apiKey: selection.apiKey,
      source: selection.source,
    };
    return (prompt, o) => runLionSdkPrompt(prompt, lionSel, { maxTokens: o.maxTokens });
  }
  if (selection.kind === 'subscription') {
    return async (prompt, o) => {
      const r = await runSubscriptionPromptWithFallback(selection.selection, prompt, {
        maxTokens: o.maxTokens,
      });
      return r.text;
    };
  }
  return (prompt, o) => runClaudePrompt(prompt, { maxTokens: o.maxTokens, model: selection.model });
}

type LionCompactionProvider = Extract<OrchestratorProvider, 'ollama' | 'lmstudio' | 'openai-compatible' | 'vertex-ai'>;

interface LionCompactionSelection {
  provider: LionCompactionProvider;
  model: string;
  baseUrl?: string;
  apiKey?: string;
  source: 'chat' | 'explicit';
}

export type CompactionSelection =
  | {
      kind: 'lion-sdk';
      provider: LionCompactionProvider;
      model: string;
      baseUrl?: string;
      apiKey?: string;
      source: 'chat' | 'explicit';
    }
  | { kind: 'subscription'; selection: OrchestratorSelection }
  | { kind: 'claude'; model: string };

function isLionCompactionProvider(provider: string | undefined): provider is LionCompactionProvider {
  return (
    provider === 'ollama' || provider === 'lmstudio' || provider === 'openai-compatible' || provider === 'vertex-ai'
  );
}

const SUBSCRIPTION_PROVIDER_RUNTIME: Partial<Record<OrchestratorProvider, OrchestratorRuntime>> = {
  anthropic: 'claude-sdk',
  zai: 'claude-compat-sdk',
  minimax: 'claude-compat-sdk',
  codex: 'codex-sdk',
  kimi: 'kimi-sdk',
  grok: 'grok-sdk',
  cursor: 'cursor-sdk',
};

function isSubscriptionCompactionProvider(provider: string | undefined): provider is OrchestratorProvider {
  return provider !== undefined && provider in SUBSCRIPTION_PROVIDER_RUNTIME;
}

function isSubscriptionRuntime(runtime: string): runtime is OrchestratorRuntime {
  return (
    runtime === 'claude-sdk' ||
    runtime === 'claude-compat-sdk' ||
    runtime === 'codex-sdk' ||
    runtime === 'kimi-sdk' ||
    runtime === 'grok-sdk' ||
    runtime === 'cursor-sdk'
  );
}

export async function resolveCompactionSelection(): Promise<CompactionSelection> {
  try {
    const selection = await resolveCompactionSelectionCore();
    const model = selection.kind === 'subscription' ? selection.selection.model : selection.model;
    smokeAudit('compaction_selection', { kind: selection.kind, model });
    return selection;
  } catch (err) {
    if (err instanceof CompactionProviderUnavailableError) {
      smokeAudit('compaction_error', { code: err.code });
    }
    throw err;
  }
}

async function resolveCompactionSelectionCore(): Promise<CompactionSelection> {
  const compactionProvider = (getSetting('orchestrator_compaction_provider') || '').trim();
  const compactionModel = (getSetting('orchestrator_compaction_model') || '').trim();
  const compactionRuntime = (getSetting('orchestrator_compaction_runtime') || '').trim();
  const runtime = (getSetting('orchestrator_runtime') || '').trim();
  const chatProvider = (getSetting('orchestrator_provider') || '').trim();

  if (compactionProvider && compactionModel) {
    if (isLionCompactionProvider(compactionProvider)) {
      const lionSel = await resolveLionSdkBaseUrl(compactionProvider, compactionModel, 'explicit');
      return { kind: 'lion-sdk', ...lionSel };
    }
    if (isSubscriptionCompactionProvider(compactionProvider)) {
      const subRuntime: OrchestratorRuntime = isSubscriptionRuntime(compactionRuntime)
        ? compactionRuntime
        : SUBSCRIPTION_PROVIDER_RUNTIME[compactionProvider]!;
      try {
        const selection = await resolveSubscriptionSelectionFor(subRuntime, compactionProvider, compactionModel);
        return { kind: 'subscription', selection };
      } catch (err) {
        if (err instanceof InvalidOrchestratorSelectionError) {
          throw new CompactionProviderUnavailableError(
            `Compaction provider "${compactionProvider}" nao resolveu: ${err.message}`,
          );
        }
        throw err;
      }
    }
  }

  if (runtime === 'lion-sdk') {
    const chatModel = (getSetting('orchestrator_model') || '').trim();
    if (!isLionCompactionProvider(chatProvider) || !chatModel) {
      throw new Error('Lion-SDK compaction Auto(chat) nao conseguiu resolver o provider/modelo atual do chat.');
    }
    await assertAutoCompactionProviderAvailable('lion-sdk', chatProvider);
    const lionSel = await resolveLionSdkBaseUrl(chatProvider, chatModel, 'chat');
    return { kind: 'lion-sdk', ...lionSel };
  }

  if (
    runtime === 'claude-sdk' ||
    runtime === 'claude-compat-sdk' ||
    runtime === 'codex-sdk' ||
    runtime === 'kimi-sdk' ||
    runtime === 'grok-sdk' ||
    runtime === 'cursor-sdk'
  ) {
    try {
      const selection = await resolveOrchestratorSelection({ surface: 'compaction' });
      await assertAutoCompactionProviderAvailable(selection.runtime, selection.provider);
      return { kind: 'subscription', selection };
    } catch (err) {
      if (err instanceof InvalidOrchestratorSelectionError) {
        throw new CompactionProviderUnavailableError(
          `Compaction Auto(chat) nao resolveu o orquestrador atual: ${err.message}`,
        );
      }
      throw err;
    }
  }

  throw new CompactionProviderUnavailableError(
    `Compaction sem provider resolvido (runtime="${runtime || '(vazio)'}").`,
  );
}

export const COMPACTION_PROVIDER_OFF_HINT = 'configure o Modelo de compactacao em Settings';

async function assertAutoCompactionProviderAvailable(
  runtime: OrchestratorRuntime,
  provider: OrchestratorProvider,
): Promise<void> {
  const { listProviderStatuses } = await import('./provider-availability');
  const statuses = await listProviderStatuses();
  const status = statuses.find((entry) => entry.runtime === runtime && entry.provider === provider);
  if (!status || status.available) return;
  throw new CompactionProviderUnavailableError(
    `Compaction Auto: o provider "${provider}" do orquestrador esta indisponivel` +
      `${status.reason ? ` (${status.reason})` : ''}; ${COMPACTION_PROVIDER_OFF_HINT}.`,
  );
}

async function resolveLionSdkBaseUrl(
  provider: LionCompactionProvider,
  model: string,
  source: 'chat' | 'explicit',
): Promise<LionCompactionSelection> {
  let baseUrl = '';
  let apiKey: string | undefined;

  if (provider === 'ollama') {
    baseUrl = getSetting('orchestrator_ollama_base_url') || 'http://localhost:11434';
  } else if (provider === 'lmstudio') {
    baseUrl = getSetting('orchestrator_lmstudio_base_url') || 'http://localhost:1234';
  } else if (provider === 'openai-compatible') {
    baseUrl = getSetting('orchestrator_openai_compat_base_url') || '';
    if (!baseUrl.trim()) {
      throw new Error('Lion-SDK OpenAI-compatible compaction requer orchestrator_openai_compat_base_url.');
    }
    const apiKeyRef = getSetting('orchestrator_openai_compat_api_key_ref') || '';
    if (!apiKeyRef.trim()) {
      throw new Error('Lion-SDK OpenAI-compatible compaction requer orchestrator_openai_compat_api_key_ref.');
    }
    const { getSecret } = await import('./secrets-vault');
    apiKey = (await getSecret(apiKeyRef)) ?? undefined;
    if (!apiKey) {
      throw new Error(`Lion-SDK OpenAI-compatible compaction nao encontrou API key no vault (${apiKeyRef}).`);
    }
  } else {
    const apiKeyRef = getSetting('orchestrator_vertex_api_key_ref') || '';
    if (!apiKeyRef.trim()) {
      throw new Error('Lion-SDK Vertex Gemini compaction requer orchestrator_vertex_api_key_ref.');
    }
    const { getSecret } = await import('./secrets-vault');
    apiKey = (await getSecret(apiKeyRef)) ?? undefined;
    if (!apiKey) {
      throw new Error(`Lion-SDK Vertex Gemini compaction nao encontrou API key no vault (${apiKeyRef}).`);
    }
  }

  return { provider, model, baseUrl, apiKey, source };
}

function createLionCompactionAdapter(selection: LionCompactionSelection): LionAdapter {
  if (selection.provider === 'ollama') {
    return createOllamaAdapter({ baseUrl: selection.baseUrl || 'http://localhost:11434' });
  }
  if (selection.provider === 'lmstudio') {
    return createLmStudioAdapter({ baseUrl: selection.baseUrl || 'http://localhost:1234' });
  }
  if (selection.provider === 'openai-compatible') {
    return createOpenAiCompatibleAdapter({
      baseUrl: selection.baseUrl || '',
      apiKey: selection.apiKey,
    });
  }
  if (!selection.apiKey) {
    throw new Error('Vertex Gemini compaction sem apiKey resolvido.');
  }
  return createGoogleGenAiAdapter({
    apiKey: selection.apiKey,
  });
}

function lionCompactionExtraFor(adapter: LionAdapter): Record<string, unknown> {
  if (adapter.name === 'ollama') {
    return { num_predict: 8192, temperature: 0.1 };
  }
  return { max_tokens: 20000, temperature: 0.1 };
}

export async function runClaudePrompt(prompt: string, opts: { model: string; maxTokens?: number }): Promise<string> {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const { getApiKey } = await import('./secrets-vault');
  const apiKey = await getApiKey();
  if (!apiKey) throw new Error('API key not configured');

  const model = opts.model;
  const maxTokens = opts.maxTokens ?? 20000;
  const client = new Anthropic({ apiKey });

  logger.info({ model, promptLength: prompt.length }, 'runClaudePrompt: calling Anthropic');

  const response = await client.messages.create({
    model,
    max_tokens: maxTokens,
    messages: [{ role: 'user', content: prompt }],
  });

  let text = response.content
    .filter((b) => b.type === 'text')
    .map((b) => ('text' in b ? (b as { text: string }).text : ''))
    .join('');

  text = text.trim();
  if (text.startsWith('```')) {
    text = text.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }

  logger.info({ responseLength: text.length }, 'runClaudePrompt: response received');
  return text;
}

export async function runLionSdkPrompt(
  prompt: string,
  selection: LionCompactionSelection,
  opts?: { maxTokens?: number },
): Promise<string> {
  const adapter = createLionCompactionAdapter(selection);
  const messages: LionChatMessage[] = [{ role: 'user', content: prompt }];
  let text = '';

  const extra = lionCompactionExtraFor(adapter);
  if (opts?.maxTokens !== undefined && adapter.name !== 'ollama') {
    (extra as Record<string, unknown>)['max_tokens'] = opts.maxTokens;
  }

  logger.info(
    { provider: selection.provider, model: selection.model, source: selection.source, promptLength: prompt.length },
    'runLionSdkPrompt: calling Lion-SDK provider',
  );

  for await (const ev of adapter.streamCompletion({
    model: selection.model,
    messages,
    tools: [],
    extra,
  })) {
    if (ev.type === 'text') {
      text += ev.delta;
    } else if (ev.type === 'error') {
      throw new Error(`Lion-SDK compaction adapter error: ${ev.error}`);
    } else if (ev.type === 'done') {
      break;
    }
  }

  text = text.trim();
  if (text.startsWith('```')) {
    text = text.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }

  logger.info({ responseLength: text.length }, 'runLionSdkPrompt: response received');
  return text;
}

export interface RunStructuredMemoryLlmOptions {
  modelOverride?: string;
  providerOverride?: 'claude';
  maxTokens?: number;
}

export async function runStructuredMemoryLlm(prompt: string, options?: RunStructuredMemoryLlmOptions): Promise<string> {
  let selection = await resolveCompactionSelection();

  if (options?.providerOverride === 'claude') {
    if (!options.modelOverride) {
      throw new CompactionProviderUnavailableError(
        'runStructuredMemoryLlm: providerOverride="claude" exige modelOverride explicito (SPEC 4.2).',
      );
    }
    selection = { kind: 'claude', model: options.modelOverride };
  } else if (options?.modelOverride) {
    if (selection.kind === 'claude') {
      selection = { kind: 'claude', model: options.modelOverride };
    } else if (selection.kind === 'lion-sdk') {
      selection = { ...selection, model: options.modelOverride };
    } else if (selection.kind === 'subscription') {
      selection = { kind: 'subscription', selection: { ...selection.selection, model: options.modelOverride } };
    }
  }

  switch (selection.kind) {
    case 'lion-sdk': {
      const lionSel: LionCompactionSelection = {
        provider: selection.provider,
        model: selection.model,
        baseUrl: selection.baseUrl,
        apiKey: selection.apiKey,
        source: selection.source,
      };
      return runLionSdkPrompt(prompt, lionSel, { maxTokens: options?.maxTokens });
    }
    case 'subscription': {
      const r = await runSubscriptionPromptWithFallback(selection.selection, prompt, { maxTokens: options?.maxTokens });
      return r.text;
    }
    case 'claude':
      return runClaudePrompt(prompt, { maxTokens: options?.maxTokens, model: selection.model });
    default: {
      const _exhaustive: never = selection;
      throw new Error(`runStructuredMemoryLlm: unhandled CompactionSelection kind — ${JSON.stringify(_exhaustive)}`);
    }
  }
}

async function summarizeWithLionSdk(
  selection: LionCompactionSelection,
  messageText: string,
  priorSummary?: string,
): Promise<CompactionResult> {
  const basePrompt = buildCompactionBasePrompt(messageText, priorSummary);
  const prompt = 'CRITICAL: respond ONLY with valid JSON, no markdown, no explanation.\n\n' + basePrompt;

  const localWarnLimit = resolveLocalInputWarnTokens();
  const promptTokens = estimateTokens(prompt);
  if (promptTokens > localWarnLimit) {
    logger.warn(
      { promptTokens, warnLimit: localWarnLimit, provider: selection.provider, model: selection.model },
      'compaction summarize (lion-sdk): input excede compaction_local_input_warn_tokens — modelo local pode truncar contexto',
    );
  }

  logger.info(
    {
      provider: selection.provider,
      model: selection.model,
      source: selection.source,
      messageLength: messageText.length,
    },
    'Calling Lion-SDK provider for memory summarization',
  );

  const text = await runLionSdkPrompt(prompt, selection);

  if (!text || text.trim().length === 0) {
    logger.error(
      { provider: selection.provider, model: selection.model, source: selection.source },
      'Lion-SDK summarizer returned empty response',
    );
    throw new EmptyProviderResponseError(selection.provider, selection.model, 'lion-sdk');
  }

  try {
    return parseCompactionResultLenient(text);
  } catch (parseError) {
    const debugPath = path.join(getLionClawPath(), 'data', 'last-compaction-response-lion-sdk.txt');
    fs.mkdirSync(path.dirname(debugPath), { recursive: true });
    fs.writeFileSync(debugPath, text, 'utf-8');
    logger.error(
      {
        parseError: (parseError as Error).message,
        debugPath,
        provider: selection.provider,
        model: selection.model,
        first200: text.substring(0, 200),
      },
      'JSON parse failed on Lion-SDK compaction response',
    );
    throw parseError;
  }
}

async function summarizeWithSubscription(
  selection: OrchestratorSelection,
  messageText: string,
  onModelLabel?: OnModelLabel,
  priorSummary?: string,
): Promise<CompactionResult> {
  const basePrompt = buildCompactionBasePrompt(messageText, priorSummary);
  const prompt = 'CRITICAL: respond ONLY with valid JSON, no markdown, no explanation.\n\n' + basePrompt;

  logger.info(
    {
      runtime: selection.runtime,
      provider: selection.provider,
      model: selection.model,
      messageLength: messageText.length,
    },
    'Calling orchestrator subscription for memory summarization',
  );

  const r = await runSubscriptionPromptWithFallback(selection, prompt);
  onModelLabel?.(r.actualModelLabel);

  if (!r.text || r.text.trim().length === 0) {
    logger.error(
      { runtime: selection.runtime, provider: selection.provider, model: selection.model },
      'Subscription summarizer returned empty response',
    );
    throw new EmptyProviderResponseError(selection.provider, selection.model, selection.runtime);
  }

  try {
    return parseCompactionResultLenient(r.text);
  } catch (parseError) {
    const debugPath = path.join(getLionClawPath(), 'data', 'last-compaction-response-subscription.txt');
    fs.mkdirSync(path.dirname(debugPath), { recursive: true });
    fs.writeFileSync(debugPath, r.text, 'utf-8');
    logger.error(
      {
        parseError: (parseError as Error).message,
        debugPath,
        runtime: selection.runtime,
        provider: selection.provider,
        model: selection.model,
        first200: r.text.substring(0, 200),
      },
      'JSON parse failed on subscription compaction response',
    );
    throw parseError;
  }
}

async function summarizeWithClaude(
  messageText: string,
  model: string,
  priorSummary?: string,
): Promise<CompactionResult> {
  try {
    const prompt = buildCompactionBasePrompt(messageText, priorSummary);

    logger.info(
      { messageLength: messageText.length, promptLength: prompt.length, model },
      'Calling Anthropic for summarization',
    );

    const text = await runClaudePrompt(prompt, { model });

    logger.info({ responseLength: text.length }, 'Summarization response received');

    if (!text || text.trim().length === 0) {
      logger.error('Claude summarizer returned empty response');
      throw new EmptyProviderResponseError('anthropic', model, 'anthropic-api');
    }

    try {
      return JSON.parse(text) as CompactionResult;
    } catch (parseError) {
      const debugPath = path.join(getLionClawPath(), 'data', 'last-compaction-response.txt');
      fs.writeFileSync(debugPath, text, 'utf-8');
      logger.error(
        { parseError: (parseError as Error).message, debugPath, first200: text.substring(0, 200) },
        'JSON parse failed on summarization response',
      );
      throw parseError;
    }
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    logger.error(
      { error: errMsg, stack: error instanceof Error ? error.stack : undefined },
      'Anthropic summarization call failed',
    );
    throw error;
  }
}

const MEMORY_SKELETON = [
  '## Decisoes ativas',
  '',
  '## Workarounds e bugs conhecidos',
  '',
  '## Estado de projetos',
  '',
  '## Referencias externas',
].join('\n');

const SECTION_HEADERS: Record<MemorySection, string> = {
  decisoes_ativas: '## Decisoes ativas',
  workarounds: '## Workarounds e bugs conhecidos',
  estado_de_projetos: '## Estado de projetos',
  referencias_externas: '## Referencias externas',
};

const SECTION_ORDER: MemorySection[] = ['decisoes_ativas', 'workarounds', 'estado_de_projetos', 'referencias_externas'];

async function updateWorkingMemory(input: { add: GateOutputApplyItem[]; remove: string[] }): Promise<void> {
  if (input.add.length === 0 && input.remove.length === 0) {
    return;
  }

  const memoryPath = path.join(getLionClawPath(), 'MEMORY.md');
  const readRaw = (): string => {
    try {
      return fs.readFileSync(memoryPath, 'utf-8');
    } catch {
      return '';
    }
  };

  let base = readRaw();
  let result = transformWorkingMemory(base, input);

  const fresh = readRaw();
  if (fresh !== base) {
    logger.warn(
      'updateWorkingMemory: MEMORY.md mudou entre a leitura e o write (lost-update guard) — transform re-aplicado sobre o conteudo fresco',
    );
    base = fresh;
    result = transformWorkingMemory(base, input);
  }

  fs.writeFileSync(memoryPath, result.content, 'utf-8');
  logger.info(
    { added: input.add.length, removed: input.remove.length, nonEmptyCount: result.nonEmptyCount },
    'Working memory updated (section-aware)',
  );
}

function transformWorkingMemory(
  rawInput: string,
  input: { add: GateOutputApplyItem[]; remove: string[] },
): { content: string; nonEmptyCount: number } {
  let rawContent = rawInput;
  if (rawContent.trim().length === 0) {
    rawContent = MEMORY_SKELETON;
  }

  if (input.remove.length > 0) {
    const fileLines = rawContent.split('\n');
    const removedSet = new Set(input.remove);
    const filtered = fileLines.filter((line) => !removedSet.has(line));
    rawContent = filtered.join('\n');
  }

  let blocks = splitIntoSections(rawContent);

  const CANONICAL_HEADERS = new Set<string>(SECTION_ORDER.map((s) => SECTION_HEADERS[s]));
  const beforeFilter = blocks.length;
  blocks = blocks.filter((block) => {
    if (block.header === null) {
      const hasContent = block.lines.some((l) => l.trim().length > 0);
      if (hasContent) {
        logger.warn(
          { lineCount: block.lines.filter((l) => l.trim().length > 0).length },
          'updateWorkingMemory: descartado conteudo orfao antes do primeiro header',
        );
        return false;
      }
      return true;
    }
    if (!CANONICAL_HEADERS.has(block.header)) {
      logger.warn(
        { header: block.header, lineCount: block.lines.filter((l) => l.trim().length > 0).length },
        'updateWorkingMemory: descartado header desconhecido (apenas 4 secoes canonicas sao permitidas)',
      );
      return false;
    }
    return true;
  });
  if (blocks.length !== beforeFilter) {
    logger.warn(
      { discarded: beforeFilter - blocks.length, remaining: blocks.length },
      'updateWorkingMemory: limpou MEMORY.md para conter apenas as 4 secoes canonicas',
    );
  }

  const findBlock = (header: string): number => blocks.findIndex((b) => b.header === header);

  for (const section of SECTION_ORDER) {
    const header = SECTION_HEADERS[section];
    if (findBlock(header) === -1) {
      blocks.push({ header, lines: [] });
    }
  }

  const grouped = new Map<MemorySection, string[]>();
  for (const item of input.add) {
    const existing = grouped.get(item.section) ?? [];
    existing.push(item.text);
    grouped.set(item.section, existing);
  }

  for (const [section, texts] of grouped) {
    const header = SECTION_HEADERS[section];
    let idx = findBlock(header);
    if (idx === -1) {
      blocks.push({ header, lines: [] });
      idx = blocks.length - 1;
    }
    const block = blocks[idx];
    while (block.lines.length > 0 && block.lines[block.lines.length - 1].trim() === '') {
      block.lines.pop();
    }
    for (const text of texts) {
      block.lines.push(text);
    }
  }

  const PRUNE_SECTION: MemorySection = 'estado_de_projetos';
  const pruneHeader = SECTION_HEADERS[PRUNE_SECTION];

  let content = joinSections(blocks);
  let nonEmptyCount = countNonEmptyLines(content);

  if (nonEmptyCount > 50) {
    const pruneIdx = blocks.findIndex((b) => b.header === pruneHeader);
    if (pruneIdx === -1 || blocks[pruneIdx].lines.filter((l) => l.trim().length > 0).length === 0) {
      logger.warn(
        { nonEmptyCount, limit: 50 },
        'updateWorkingMemory: MEMORY.md over 50 non-empty lines but "Estado de projetos" is empty — cannot prune other sections',
      );
    } else {
      const pruneBlock = blocks[pruneIdx];
      while (nonEmptyCount > 50) {
        const firstNonEmpty = pruneBlock.lines.findIndex((l) => l.trim().length > 0);
        if (firstNonEmpty === -1) {
          logger.warn(
            { nonEmptyCount, limit: 50 },
            'updateWorkingMemory: "Estado de projetos" exhausted but still over 50 non-empty lines — stopping prune',
          );
          break;
        }
        const removed = pruneBlock.lines.splice(firstNonEmpty, 1)[0];
        logger.warn(
          { prunedLine: removed, remaining: nonEmptyCount - 1 },
          'updateWorkingMemory: pruned oldest entry from "Estado de projetos"',
        );
        content = joinSections(blocks);
        nonEmptyCount = countNonEmptyLines(content);
      }
    }
  }

  return { content, nonEmptyCount };
}

export async function applyMemoryUpdates(input: { add: GateOutputApplyItem[]; remove: string[] }): Promise<void> {
  return updateWorkingMemory(input);
}

export { updateUserProfileSectionAware, applyUserProfileUpdates, maybeSanitizeUserProfile };
export type { UserProfileUpdateInput } from './memory-pipeline/user-profile';

function archiveTranscript(
  messages: Array<Record<string, unknown>>,
  dateStr: string,
  summary: string,
  transcriptName?: string,
): void {
  const archiveDir = path.join(getLionClawPath(), 'conversations');
  fs.mkdirSync(archiveDir, { recursive: true });

  const lines = [`# Conversa ${dateStr}`, '', `## Resumo`, summary, '', `## Mensagens`, ''];

  for (const msg of messages) {
    const role = msg['role'] as string;
    const content = (msg['content'] as string).substring(0, 5000);
    const time = (msg['created_at'] as string).split('T')[1]?.substring(0, 5) || '';
    lines.push(`### [${time}] ${role}`);
    lines.push(content);
    lines.push('');
  }

  const filename = `${transcriptName ?? dateStr}.md`;
  fs.writeFileSync(path.join(archiveDir, filename), lines.join('\n'), 'utf-8');
  logger.info({ filename }, 'Transcript archived');
}

function reciprocalRankFusion(
  rankedLists: Array<Array<{ id: number; content: string; topic: string; created_at: string }>>,
  k: number = 60,
): Array<{ id: number; content: string; topic: string; created_at: string; rrf_score: number }> {
  const scores = new Map<
    number,
    { score: number; item: { id: number; content: string; topic: string; created_at: string } }
  >();

  for (const list of rankedLists) {
    for (let rank = 0; rank < list.length; rank++) {
      const item = list[rank];
      const rrfContribution = 1.0 / (k + rank + 1);
      const existing = scores.get(item.id);
      if (existing) {
        existing.score += rrfContribution;
      } else {
        scores.set(item.id, { score: rrfContribution, item });
      }
    }
  }

  return Array.from(scores.values())
    .sort((a, b) => b.score - a.score)
    .map(({ score, item }) => ({ ...item, rrf_score: score }));
}

export interface HybridSearchResult {
  id: number;
  content: string;
  topic: string;
  created_at: string;
  rrf_score: number;
  sources: string[];
}

export async function hybridMemorySearch(query: string, limit: number = 10): Promise<HybridSearchResult[]> {
  const candidateLimit = Math.max(limit * 3, 30);
  const rankedLists: Array<Array<{ id: number; content: string; topic: string; created_at: string }>> = [];
  const sourceMap = new Map<number, Set<string>>();

  try {
    const bm25Results = searchBM25(query, candidateLimit);
    if (bm25Results.length > 0) {
      rankedLists.push(bm25Results);
      for (const r of bm25Results) {
        const s = sourceMap.get(r.id) || new Set();
        s.add('bm25');
        sourceMap.set(r.id, s);
      }
      logger.info({ count: bm25Results.length }, 'BM25 search returned results');
    }
  } catch (err) {
    logger.warn({ err }, 'BM25 search failed');
  }

  try {
    const embResult = await generateEmbeddingProvider(query);
    if (embResult.ok) {
      const queryBuf = Buffer.from(new Float32Array(embResult.embedding).buffer);
      const vecResults = searchVector(queryBuf, candidateLimit);
      if (vecResults.length > 0) {
        rankedLists.push(vecResults);
        for (const r of vecResults) {
          const s = sourceMap.get(r.id) || new Set();
          s.add(`vector:${embResult.provider}`);
          sourceMap.set(r.id, s);
        }
        logger.info({ count: vecResults.length, provider: embResult.provider }, 'Vector search returned results');
      }
    } else {
      logger.warn(
        { code: embResult.code, provider: embResult.provider, status: embResult.status, reason: embResult.reason },
        'Vector search degraded: embedding provider failed',
      );
    }
  } catch (err) {
    logger.warn({ err }, 'Vector search failed');
  }

  if (rankedLists.length === 0) {
    logger.info('No BM25 or vector results, falling back to LIKE search');
    const db = getDb();
    const rows = db
      .prepare(
        `
      SELECT id, content, topic, created_at
      FROM semantic_memories
      WHERE content LIKE ?
      ORDER BY created_at DESC
      LIMIT ?
    `,
      )
      .all(`%${query}%`, limit) as Array<{ id: number; content: string; topic: string; created_at: string }>;

    return rows.map((r) => ({ ...r, rrf_score: 0, sources: ['like'] }));
  }

  const fused = reciprocalRankFusion(rankedLists);

  return fused.slice(0, limit).map((r) => ({
    ...r,
    sources: Array.from(sourceMap.get(r.id) || []),
  }));
}

export async function searchSemanticMemories(query: string, limit: number = 10) {
  return hybridMemorySearch(query, limit);
}

export function cleanOldMessages(retentionDays: number): void {
  const db = getDb();
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();

  const result = db
    .prepare(
      `
    DELETE FROM messages WHERE created_at < ? AND session_id IN (
      SELECT id FROM sessions WHERE updated_at < ?
    )
  `,
    )
    .run(cutoff, cutoff);

  if ((result.changes as number) > 0) {
    logger.info({ deleted: result.changes, cutoff }, 'Old messages cleaned');
  }
}

export function archiveConversation(sessionId: string): string {
  const session = getSession(sessionId);
  const messages = getSessionMessages(sessionId);

  const dateStr = session ? session.createdAt.split('T')[0] : new Date().toISOString().split('T')[0];

  const rawTitle = session?.title || sessionId;
  const titleSlug = rawTitle
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, 60);

  const frontmatter = [
    '---',
    `date: ${dateStr}`,
    `session_id: ${sessionId}`,
    `message_count: ${messages.length}`,
    `title: "${rawTitle.replace(/"/g, '\\"')}"`,
    '---',
    '',
  ].join('\n');

  const lines: string[] = [frontmatter, `# ${rawTitle}`, ''];

  for (const msg of messages) {
    const time = msg.createdAt.split('T')[1]?.substring(0, 5) || '';
    const label = msg.subagent ? `${msg.role} (${msg.subagent})` : msg.role;
    lines.push(`### [${time}] ${label}`);
    lines.push('');
    lines.push(msg.content.substring(0, 5000));
    lines.push('');
  }

  const archiveDir = path.join(getLionClawPath(), 'conversations');
  fs.mkdirSync(archiveDir, { recursive: true });

  const filename = `${dateStr}-${titleSlug}.md`;
  const filePath = path.join(archiveDir, filename);
  fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');

  logger.info({ sessionId, filename, messageCount: messages.length }, 'Conversation archived');
  return filePath;
}
