
import { getSetting } from '../db';
import { createLogger } from '../logger';
import { estimateTokens, excerptStartEnd } from '../token-estimator';

const logger = createLogger('memory');


export type CompactionSelectionKind = 'lion-sdk' | 'subscription' | 'claude';

export type PlainPromptInvoker = (
  prompt: string,
  opts: { maxTokens: number },
) => Promise<string>;

const DEFAULT_BUDGET_TOKENS: Record<CompactionSelectionKind, number> = {
  subscription: 48000,
  claude: 48000,
  'lion-sdk': 12000,
};

export const MAP_TIMEOUT_MS = 120_000;
export const DEFAULT_MAP_CALL_LIMIT = 12;
export const DEFAULT_MAP_TIME_BUDGET_MS = 300_000;
export const DEFAULT_LOCAL_INPUT_WARN_TOKENS = 8000;

function readPositiveIntSetting(key: string): number | undefined {
  const raw = (getSetting(key) || '').trim();
  if (!raw) return undefined;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return n;
}

export function resolveCompactionInputBudget(kind: CompactionSelectionKind): number {
  return readPositiveIntSetting('compaction_input_budget_tokens') ?? DEFAULT_BUDGET_TOKENS[kind];
}

export function resolveMapCallLimit(): number {
  return readPositiveIntSetting('compaction_map_call_limit') ?? DEFAULT_MAP_CALL_LIMIT;
}

export function resolveMapTimeBudgetMs(): number {
  return readPositiveIntSetting('compaction_map_time_budget_ms') ?? DEFAULT_MAP_TIME_BUDGET_MS;
}

export function resolveLocalInputWarnTokens(): number {
  return readPositiveIntSetting('compaction_local_input_warn_tokens') ?? DEFAULT_LOCAL_INPUT_WARN_TOKENS;
}


export function legacyCompactionAssembly(
  messages: Array<{ role: string; content: string }>,
): string {
  return messages
    .map((m) => `[${String(m.role)}] ${String(m.content ?? '').substring(0, 2000)}`)
    .join('\n\n')
    .substring(0, 50000);
}


export interface SummarizePlainBlockOptions {
  invoker: PlainPromptInvoker;
  kind: CompactionSelectionKind;
  text: string;
  targetTokens: number;
  timeoutMs?: number;
  localInputWarnTokens?: number;
  onInputTokens?: (tokens: number) => void;
}

function buildPlainMapPrompt(text: string, targetTokens: number): string {
  return [
    'Voce e um sumarizador EXTRATIVO de logs de conversa.',
    `Resuma o TEXTO abaixo em no maximo ~${targetTokens} tokens (~${targetTokens * 4} caracteres), em portugues do Brasil (PT-BR).`,
    'PRESERVE literalmente: decisoes, fatos, numeros, paths de arquivo, identificadores, comandos executados e seus resultados.',
    'PROIBIDO opinar, generalizar ou inventar conteudo. Responda APENAS com o resumo, sem preambulo e sem markdown.',
    '',
    'TEXTO:',
    text,
  ].join('\n');
}

function buildReducePrompt(parts: string[], targetTokens: number): string {
  return [
    'Voce e um sumarizador EXTRATIVO. Funda os RESUMOS PARCIAIS abaixo (ja em ordem cronologica) em UM unico bloco coeso,',
    `em no maximo ~${targetTokens} tokens, em portugues do Brasil (PT-BR).`,
    'PRESERVE decisoes, fatos, numeros, paths de arquivo, identificadores, comandos e resultados. PROIBIDO opinar, generalizar ou inventar.',
    'Responda APENAS com o texto fundido, sem preambulo e sem markdown.',
    '',
    'RESUMOS PARCIAIS:',
    parts.map((p, i) => `--- parte ${i + 1} ---\n${p}`).join('\n\n'),
  ].join('\n');
}

async function invokeWithTimeout(
  invoker: PlainPromptInvoker,
  prompt: string,
  maxTokens: number,
  timeoutMs: number,
): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      invoker(prompt, { maxTokens }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`map do summarizer estourou o timeout de ${timeoutMs}ms (resposta tardia descartada)`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function summarizePlainBlock(o: SummarizePlainBlockOptions): Promise<string> {
  const prompt = buildPlainMapPrompt(o.text, o.targetTokens);
  const promptTokens = estimateTokens(prompt);
  o.onInputTokens?.(promptTokens);

  if (o.kind === 'lion-sdk') {
    const warnLimit = o.localInputWarnTokens ?? resolveLocalInputWarnTokens();
    if (promptTokens > warnLimit) {
      logger.warn(
        { promptTokens, warnLimit },
        'compaction map (lion-sdk): input excede compaction_local_input_warn_tokens — modelo local pode truncar contexto (num_ctx nao setado pelo adapter)',
      );
    }
  }

  let out = await invokeWithTimeout(
    o.invoker,
    prompt,
    Math.max(256, o.targetTokens * 2),
    o.timeoutMs ?? MAP_TIMEOUT_MS,
  );
  out = (out ?? '').trim();
  if (out.length === 0) {
    throw new Error('map do summarizer retornou resposta vazia');
  }

  if (o.kind === 'subscription' && estimateTokens(out) > o.targetTokens * 2) {
    logger.warn(
      { outputTokensEst: estimateTokens(out), targetTokens: o.targetTokens },
      'compaction map: output acima de 2x o alvo — enforcement pos-hoc reduziu ao excerpt deterministico do proprio output (kind subscription)',
    );
    out = excerptStartEnd(out, o.targetTokens * 4);
  }
  return out;
}


export interface BudgetedInputStats {
  rawChars: number;
  rawTokensEst: number;
  verbatimCount: number;
  presummarizedCount: number;
  mapCalls: number;
  mapInputTokensEst: number;
  finalInputTokensEst: number;
  deterministicFallbacks: number;
  durationMs: number;
  usedLegacyAssembly: boolean;
}

export interface BudgetedBuildOptions {
  kind: CompactionSelectionKind;
  invoker: PlainPromptInvoker;
  clampBudgetTokens: number;
  mapCallLimit?: number;
  mapTimeBudgetMs?: number;
  mapTimeoutMs?: number;
  localInputWarnTokens?: number;
}

export interface BudgetedBuildResult {
  messageText: string;
  stats: BudgetedInputStats;
}

interface BuildState {
  startedAt: number;
  mapCalls: number;
  mapInputTokensEst: number;
  deterministicFallbacks: number;
  capBlown: boolean;
}

interface ResolvedLimits {
  mapCallLimit: number;
  mapTimeBudgetMs: number;
  mapTimeoutMs: number;
  localInputWarnTokens: number;
}

function chunkString(text: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) {
    out.push(text.slice(i, i + size));
  }
  return out;
}

async function mapWithCaps(
  state: BuildState,
  o: BudgetedBuildOptions,
  limits: ResolvedLimits,
  args: { prompt: 'map' | 'reduce'; text: string; parts?: string[]; targetTokens: number; excerptChars: number },
): Promise<string> {
  const elapsedMs = Date.now() - state.startedAt;
  if (state.capBlown || state.mapCalls >= limits.mapCallLimit || elapsedMs >= limits.mapTimeBudgetMs) {
    if (!state.capBlown) {
      state.capBlown = true;
      logger.error(
        {
          mapCalls: state.mapCalls,
          mapCallLimit: limits.mapCallLimit,
          elapsedMs,
          mapTimeBudgetMs: limits.mapTimeBudgetMs,
        },
        'buildBudgetedMessageText: caps de map estourados — segmentos restantes degradam para excerpt deterministico (fallback nivel 2)',
      );
    }
    state.deterministicFallbacks += 1;
    return excerptStartEnd(args.text, args.excerptChars);
  }

  state.mapCalls += 1;
  try {
    if (args.prompt === 'reduce') {
      const prompt = buildReducePrompt(args.parts ?? [args.text], args.targetTokens);
      const promptTokens = estimateTokens(prompt);
      state.mapInputTokensEst += promptTokens;
      if (o.kind === 'lion-sdk' && promptTokens > limits.localInputWarnTokens) {
        logger.warn(
          { promptTokens, warnLimit: limits.localInputWarnTokens },
          'compaction reduce (lion-sdk): input excede compaction_local_input_warn_tokens',
        );
      }
      let out = await invokeWithTimeout(
        o.invoker,
        prompt,
        Math.max(256, args.targetTokens * 2),
        limits.mapTimeoutMs,
      );
      out = (out ?? '').trim();
      if (out.length === 0) throw new Error('reduce do summarizer retornou resposta vazia');
      if (o.kind === 'subscription' && estimateTokens(out) > args.targetTokens * 2) {
        logger.warn(
          { outputTokensEst: estimateTokens(out), targetTokens: args.targetTokens },
          'compaction reduce: output acima de 2x o alvo — enforcement pos-hoc (kind subscription)',
        );
        out = excerptStartEnd(out, args.targetTokens * 4);
      }
      return out;
    }
    return await summarizePlainBlock({
      invoker: o.invoker,
      kind: o.kind,
      text: args.text,
      targetTokens: args.targetTokens,
      timeoutMs: limits.mapTimeoutMs,
      localInputWarnTokens: limits.localInputWarnTokens,
      onInputTokens: (t) => {
        state.mapInputTokensEst += t;
      },
    });
  } catch (err) {
    state.deterministicFallbacks += 1;
    logger.warn(
      {
        err: err instanceof Error ? err.message : String(err),
        blockChars: args.text.length,
        targetTokens: args.targetTokens,
        excerptChars: args.excerptChars,
      },
      'buildBudgetedMessageText: map/reduce falhou — bloco degradado para excerpt deterministico inicio+fim (fallback nivel 1)',
    );
    return excerptStartEnd(args.text, args.excerptChars);
  }
}

async function mapLongText(
  state: BuildState,
  o: BudgetedBuildOptions,
  limits: ResolvedLimits,
  text: string,
  targetTokens: number,
  wTokens: number,
  excerptChars: number,
): Promise<string> {
  const wChars = wTokens * 4;
  if (text.length <= wChars) {
    return mapWithCaps(state, o, limits, { prompt: 'map', text, targetTokens, excerptChars });
  }
  const windows = chunkString(text, wChars);
  const parts: string[] = [];
  for (const w of windows) {
    parts.push(await mapWithCaps(state, o, limits, { prompt: 'map', text: w, targetTokens, excerptChars }));
  }
  if (parts.length === 1) return parts[0];
  return mapWithCaps(state, o, limits, {
    prompt: 'reduce',
    text: parts.join('\n\n'),
    parts,
    targetTokens,
    excerptChars,
  });
}

interface BuildBlock {
  role: string;
  content: string;
  presummarized: boolean;
}

function formatBlock(b: BuildBlock): string {
  return `[${b.role}] ${b.content}`;
}

async function buildInner(
  messages: Array<{ role: string; content: string }>,
  budgetMsgs: number,
  o: BudgetedBuildOptions,
  limits: ResolvedLimits,
  state: BuildState,
): Promise<{ messageText: string; verbatimCount: number; presummarizedCount: number }> {
  const tMsgTokens = Math.max(1, Math.floor(budgetMsgs / 8));
  const wTokens = Math.max(1, Math.min(24000, Math.floor(budgetMsgs / 2)));
  const mapTargetTokens = Math.max(1, Math.min(1500, Math.floor(tMsgTokens / 4)));
  const excerptChars = Math.max(64, tMsgTokens * 4);

  const blocks: BuildBlock[] = messages.map((m) => ({
    role: m.role,
    content: m.content,
    presummarized: false,
  }));

  for (const b of blocks) {
    if (estimateTokens(b.content) > tMsgTokens) {
      const originalChars = b.content.length;
      const summary = await mapLongText(state, o, limits, b.content, mapTargetTokens, wTokens, excerptChars);
      b.content = `[resumo automatico de mensagem longa, ${originalChars} chars originais]\n${summary}`;
      b.presummarized = true;
    }
  }

  const allText = blocks.map(formatBlock).join('\n\n');
  if (estimateTokens(allText) <= budgetMsgs) {
    return {
      messageText: allText,
      verbatimCount: blocks.filter((b) => !b.presummarized).length,
      presummarizedCount: blocks.filter((b) => b.presummarized).length,
    };
  }

  const tailLimit = Math.floor(budgetMsgs * 0.6);
  const headBudget = Math.max(1, Math.floor(budgetMsgs * 0.4));
  let tailTok = 0;
  let tailStart = blocks.length;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const cost = estimateTokens(formatBlock(blocks[i])) + 1; // +1 pela folga do separador
    if (tailTok + cost > tailLimit) break;
    tailTok += cost;
    tailStart = i;
  }
  if (tailStart >= blocks.length) tailStart = blocks.length - 1;

  const headBlocks = blocks.slice(0, tailStart);
  const tailBlocks = blocks.slice(tailStart);

  const headText = headBlocks.map(formatBlock).join('\n\n');
  const segments = chunkString(headText, wTokens * 4);
  const segSummaries: string[] = [];
  for (const seg of segments) {
    segSummaries.push(
      await mapWithCaps(state, o, limits, {
        prompt: 'map',
        text: seg,
        targetTokens: 1000,
        excerptChars,
      }),
    );
  }

  let headParts = segSummaries.map(
    (s, i) => `[resumo automatico de trecho antigo ${i + 1}/${segSummaries.length}]\n${s}`,
  );
  if (estimateTokens(headParts.join('\n\n')) > headBudget) {
    const merged = await mapWithCaps(state, o, limits, {
      prompt: 'reduce',
      text: segSummaries.join('\n\n'),
      parts: segSummaries,
      targetTokens: Math.max(1, Math.min(1500, headBudget)),
      excerptChars: Math.min(excerptChars, headBudget * 4),
    });
    headParts = [`[resumo automatico da conversa antiga]\n${merged}`];
  }

  const messageText = [...headParts, ...tailBlocks.map(formatBlock)].join('\n\n');
  return {
    messageText,
    verbatimCount: tailBlocks.filter((b) => !b.presummarized).length,
    presummarizedCount: headBlocks.length + tailBlocks.filter((b) => b.presummarized).length,
  };
}

export async function buildBudgetedMessageText(
  messages: Array<{ role: string; content: string }>,
  budgetMsgs: number,
  o: BudgetedBuildOptions,
): Promise<BudgetedBuildResult> {
  const state: BuildState = {
    startedAt: Date.now(),
    mapCalls: 0,
    mapInputTokensEst: 0,
    deterministicFallbacks: 0,
    capBlown: false,
  };

  let rawChars = 0;
  for (const m of messages) {
    if (typeof m?.content === 'string') rawChars += m.content.length;
  }
  const rawTokensEst = Math.ceil(rawChars / 4);

  const limits: ResolvedLimits = {
    mapCallLimit: o.mapCallLimit ?? resolveMapCallLimit(),
    mapTimeBudgetMs: o.mapTimeBudgetMs ?? resolveMapTimeBudgetMs(),
    mapTimeoutMs: o.mapTimeoutMs ?? MAP_TIMEOUT_MS,
    localInputWarnTokens: o.localInputWarnTokens ?? resolveLocalInputWarnTokens(),
  };

  try {
    const inner = await buildInner(messages, budgetMsgs, o, limits, state);
    let messageText = inner.messageText;

    const clampTokens = Math.floor(o.clampBudgetTokens * 1.05);
    if (estimateTokens(messageText) > clampTokens) {
      logger.error(
        { finalTokensEst: estimateTokens(messageText), clampTokens },
        'buildBudgetedMessageText: clamp final disparou — poda deterministica dos blocos mais antigos (nunca deveria acontecer)',
      );
      state.deterministicFallbacks += 1;
      const parts = messageText.split('\n\n');
      let dropped = 0;
      while (parts.length > 1 && estimateTokens(parts.join('\n\n')) > clampTokens) {
        parts.shift();
        dropped += 1;
      }
      messageText = `[${dropped} blocos antigos removidos pelo clamp de orcamento]\n\n${parts.join('\n\n')}`;
      if (estimateTokens(messageText) > clampTokens) {
        messageText = excerptStartEnd(messageText, clampTokens * 4);
      }
    }

    return {
      messageText,
      stats: {
        rawChars,
        rawTokensEst,
        verbatimCount: inner.verbatimCount,
        presummarizedCount: inner.presummarizedCount,
        mapCalls: state.mapCalls,
        mapInputTokensEst: state.mapInputTokensEst,
        finalInputTokensEst: estimateTokens(messageText),
        deterministicFallbacks: state.deterministicFallbacks,
        durationMs: Date.now() - state.startedAt,
        usedLegacyAssembly: false,
      },
    };
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      'buildBudgetedMessageText: throw inesperado do builder — caindo no assembly legado (fallback nivel 3)',
    );
    const messageText = legacyCompactionAssembly(messages);
    return {
      messageText,
      stats: {
        rawChars,
        rawTokensEst,
        verbatimCount: 0,
        presummarizedCount: 0,
        mapCalls: state.mapCalls,
        mapInputTokensEst: state.mapInputTokensEst,
        finalInputTokensEst: estimateTokens(messageText),
        deterministicFallbacks: state.deterministicFallbacks + 1,
        durationMs: Date.now() - state.startedAt,
        usedLegacyAssembly: true,
      },
    };
  }
}
