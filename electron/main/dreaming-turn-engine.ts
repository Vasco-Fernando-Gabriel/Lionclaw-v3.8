
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { BrowserWindow } from 'electron';
import { getLionClawHome } from './paths';
import { createLogger } from './logger';
import { excerptStartEnd } from './token-estimator';
import {
  runStructuredMemoryLlm,
  tryWithMemoryGateLock,
  applyMemoryUpdates,
  applyUserProfileUpdates,
} from './memory-pipeline';
import { VALID_USER_SECTIONS } from './memory-pipeline/user-profile';
import type { UserSection } from './memory-pipeline/user-profile';
import {
  getDb,
  getSession,
  getSetting,
  getDreamingState,
  getDreamingTurnInterval,
  incrementTurnCount,
  resetTurnCount,
  setLastTurnRunAt,
  incrementTotalTurnRuns,
  incrementTotalTurnFailsafes,
} from './db';
import type {
  MemorySection,
  GateOutputQuarantineItem,
  GateOutputDiscardedItem,
  LlmInvoker,
} from './dreaming-gate';
import { resolveDreamingTimeoutMs } from './dreaming-gate';

const logger = createLogger('dreaming-turn-engine');


export interface TurnUpdateItem {
  oldText: string;      // texto exato a substituir (line-match)
  newText: string;      // texto novo (com [YYYY-MM-DD] atualizado)
  section: MemorySection;
}

export interface UserTurnUpdateItem {
  oldText: string;      // linha EXATA do USER.md (line-match obrigatorio)
  newText: string;      // texto novo
  section: UserSection;
}

export interface TurnDreamingResult {
  apply: {
    remove: string[];
    update: TurnUpdateItem[];
    userRemove?: string[];
    userUpdate?: UserTurnUpdateItem[];
  }; // SEM add
  quarantine: GateOutputQuarantineItem[];
  discarded: GateOutputDiscardedItem[];
  report: string;
  failSafeTriggered: boolean;
  failSafeReason?: 'timeout' | 'json_parse_error' | 'llm_error' | 'skill_md_missing';
  skipped?: 'memory_too_small' | 'cooldown' | 'lock_busy' | 'disabled';
}

export interface TurnDreamingInput {
  recentTurns: Array<{ role: 'user' | 'assistant'; content: string }>;
  currentMemoryMd: string;
  currentUserMd: string;
}

export interface RunTurnDreamingOptions {
  invoker?: LlmInvoker;
  timeoutMs?: number; // default 30000
}


interface LlmTurnOutput {
  apply: {
    remove: string[];
    update: Array<{ oldText: string; newText: string; section: string }>;
    add?: unknown[]; // presente quando modelo ignora instrucao — descartado
    userRemove?: string[];
    userUpdate?: Array<{ oldText: string; newText: string; section: string }>;
    userAdd?: unknown[]; // turn-based NUNCA adiciona — descartado com warn
  };
  quarantine: GateOutputQuarantineItem[];
  discarded: GateOutputDiscardedItem[];
}


const VALID_SECTIONS: ReadonlySet<MemorySection> = new Set<MemorySection>([
  'decisoes_ativas',
  'workarounds',
  'estado_de_projetos',
  'referencias_externas',
]);

function buildFailSafeResult(
  reason: 'timeout' | 'json_parse_error' | 'llm_error' | 'skill_md_missing',
  extraInfo?: string,
): TurnDreamingResult {
  const extra = extraInfo ? `\n\nDetalhe: ${extraInfo}` : '';
  const report = [
    `# Turn-Based Dreaming - Fail-Safe Acionado`,
    ``,
    `**Motivo:** \`${reason}\`${extra}`,
    ``,
    `Nenhuma alteracao foi aplicada ao MEMORY.md.`,
  ].join('\n');

  return {
    apply: { remove: [], update: [] },
    quarantine: [],
    discarded: [],
    report,
    failSafeTriggered: true,
    failSafeReason: reason,
  };
}

function buildSuccessReport(output: LlmTurnOutput): string {
  const removeLines =
    output.apply.remove.length > 0
      ? output.apply.remove.map((l) => `- ${l}`).join('\n')
      : '_nenhuma_';

  const updateLines =
    output.apply.update.length > 0
      ? output.apply.update
          .map((u) => `- [${u.section}] "${u.oldText}" -> "${u.newText}"`)
          .join('\n')
      : '_nenhuma_';

  const quarantineLines =
    output.quarantine.length > 0
      ? output.quarantine.map((q) => `- ${q.text} _(${q.reason})_`).join('\n')
      : '_nenhuma_';

  const discardedLines =
    output.discarded.length > 0
      ? output.discarded.map((d) => `- ${d.text} _(${d.reason})_`).join('\n')
      : '_nenhuma_';

  const parts = [
    `# Turn-Based Dreaming - Relatorio de Auditoria`,
    ``,
    `## Aplicado`,
    `### Remover`,
    removeLines,
    `### Atualizar`,
    updateLines,
  ];

  const userRemove = output.apply.userRemove ?? [];
  const userUpdate = output.apply.userUpdate ?? [];
  if (userRemove.length > 0 || userUpdate.length > 0) {
    parts.push(
      `### Remover (USER.md)`,
      userRemove.length > 0 ? userRemove.map((l) => `- ${l}`).join('\n') : '_nenhuma_',
      `### Atualizar (USER.md)`,
      userUpdate.length > 0
        ? userUpdate.map((u) => `- [${u.section}] "${u.oldText}" -> "${u.newText}"`).join('\n')
        : '_nenhuma_',
    );
  }

  parts.push(
    ``,
    `## Quarentena`,
    quarantineLines,
    ``,
    `## Descartados`,
    discardedLines,
  );
  return parts.join('\n');
}

function formatToday(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function buildPrompt(skillMd: string, input: TurnDreamingInput): string {
  const turnsText = input.recentTurns
    .map((t) => `[${t.role}] ${excerptStartEnd(t.content, 2000)}`)
    .join('\n\n');
  const today = formatToday();

  return `[TURN_DREAMING_INSTRUCTIONS]
Voce e um auditor de memoria. Sua tarefa: identificar entradas OBSOLETAS no
MEMORY.md e no USER.md a luz das conversas recentes. Proponha APENAS REMOVE ou
UPDATE de entradas existentes. NUNCA proponha ADD (em nenhum dos dois arquivos).

[TODAY]
A data de hoje e ${today}. SEMPRE use esta data exata em qualquer tag [YYYY-MM-DD]
que voce escreva em apply.update[].newText ou apply.userUpdate[].newText. NAO
invente datas baseado no seu conhecimento pre-treino — use APENAS a data fornecida acima.

USE APENAS estas regras da skill abaixo:
  - Regras de REMOVE Automatico (REMOVE 1-10)
  - Regras de Seguranca

IGNORE COMPLETAMENTE estas secoes da skill (sao standalone ou do gate):
  - "Fase 1: Coleta" (recentTurns ja chegam prontos)
  - "Fase 2-5"
  - Regras de ADD (turn-based NUNCA adiciona)
  - Mencao a graph_ingest
  - Mencao a cron semanal
  - Secao "## Modelo"

[USER_MD_AUDIT]
O [CURRENT_USER_MD] abaixo e AUDITAVEL (SPEC 12.3): proponha apply.userRemove
para linhas obsoletas/duplicadas e apply.userUpdate para fatos datados
(colapse duplicatas semanticas — ex: o mesmo fato repetido com variacoes — em
UMA linha via userUpdate + userRemove das demais). oldText DEVE ser a linha
EXATA como esta no USER.md (com prefixo "- " e tag [YYYY-MM-DD] quando presente).
NUNCA proponha userAdd.

Retorne APENAS JSON valido no schema abaixo. Sem texto adicional, sem markdown code fence.

[SKILL_RULES]
${skillMd}

[CURRENT_MEMORY_MD]
${input.currentMemoryMd}

[CURRENT_USER_MD]
${input.currentUserMd}

[RECENT_TURNS]
${turnsText}

[JSON_SCHEMA_OUTPUT]
Retorne um objeto JSON com esta estrutura exata:
{
  "apply": {
    "remove": ["linha exata do MEMORY.md a remover"],
    "update": [
      {
        "oldText": "texto exato a substituir (line-match)",
        "newText": "texto novo (com [YYYY-MM-DD] atualizado)",
        "section": "decisoes_ativas" | "workarounds" | "estado_de_projetos" | "referencias_externas"
      }
    ],
    "userRemove": ["linha exata do USER.md a remover"],
    "userUpdate": [
      {
        "oldText": "linha exata do USER.md a substituir (line-match)",
        "newText": "texto novo (com [YYYY-MM-DD] atualizado)",
        "section": "identidade" | "perfil_profissional" | "negocios_projetos" | "stack_ferramentas" | "preferencias" | "fatos_duraveis"
      }
    ]
  },
  "quarantine": [
    { "text": "string", "reason": "string", "proposed_section": "decisoes_ativas" | "workarounds" | "estado_de_projetos" | "referencias_externas" }
  ],
  "discarded": [
    { "text": "string", "reason": "string" }
  ]
}

IMPORTANTE: NUNCA inclua apply.add nem apply.userAdd — turn-based NAO adiciona memoria nova.
Retorne JSON puro, sem markdown, sem comentarios.`;
}


export async function runTurnDreaming(
  input: TurnDreamingInput,
  options?: RunTurnDreamingOptions,
): Promise<TurnDreamingResult> {
  const invoker: LlmInvoker =
    options?.invoker ?? ((p: string) => runStructuredMemoryLlm(p));
  const timeoutMs = options?.timeoutMs ?? resolveDreamingTimeoutMs();

  const skillPath = path.join(getLionClawHome(), 'skills', 'dreaming', 'SKILL.md');
  let skillMd: string;
  try {
    if (!fs.existsSync(skillPath)) {
      logger.warn(
        { skillPath },
        'turn_dreaming_failed: skill_md_missing',
      );
      return buildFailSafeResult('skill_md_missing', `SKILL.md nao encontrado em ${skillPath}`);
    }
    skillMd = fs.readFileSync(skillPath, 'utf-8').trim();
    if (!skillMd) {
      logger.warn(
        { skillPath },
        'turn_dreaming_failed: skill_md_missing (vazio)',
      );
      return buildFailSafeResult('skill_md_missing', `SKILL.md vazio em ${skillPath}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(
      { skillPath, err },
      'turn_dreaming_failed: skill_md_missing (erro de IO)',
    );
    return buildFailSafeResult('skill_md_missing', `Erro ao ler SKILL.md: ${msg}`);
  }

  const prompt = buildPrompt(skillMd, input);

  let rawResponse: string;
  try {
    const timeoutPromise = new Promise<never>((_, reject) => {
      const id = setTimeout(
        () => reject(new Error('dreaming_turn_timeout')),
        timeoutMs,
      );
      if (typeof id === 'object' && 'unref' in id) {
        (id as NodeJS.Timeout).unref();
      }
    });

    rawResponse = await Promise.race([invoker(prompt), timeoutPromise]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === 'dreaming_turn_timeout') {
      logger.warn({ timeoutMs }, 'turn_dreaming_failed: timeout');
      return buildFailSafeResult('timeout', `timeout apos ${timeoutMs}ms`);
    }
    logger.warn({ err }, 'turn_dreaming_failed: llm_error');
    return buildFailSafeResult('llm_error', msg);
  }

  let output: LlmTurnOutput;
  try {
    let cleaned = rawResponse.trim();
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
    }
    output = JSON.parse(cleaned) as LlmTurnOutput;

    if (
      typeof output !== 'object' ||
      output === null ||
      !output.apply ||
      !Array.isArray(output.apply.remove) ||
      !Array.isArray(output.apply.update) ||
      !Array.isArray(output.quarantine) ||
      !Array.isArray(output.discarded)
    ) {
      throw new Error('Schema invalido: campos obrigatorios ausentes');
    }

    for (let i = 0; i < output.apply.remove.length; i++) {
      if (typeof output.apply.remove[i] !== 'string') {
        throw new Error(`Schema invalido em apply.remove[${i}]: deve ser string`);
      }
    }

    for (let i = 0; i < output.apply.update.length; i++) {
      const item = output.apply.update[i];
      if (
        typeof item !== 'object' ||
        item === null ||
        typeof item.oldText !== 'string' ||
        typeof item.newText !== 'string' ||
        !VALID_SECTIONS.has(item.section as MemorySection)
      ) {
        throw new Error(
          `Schema invalido em apply.update[${i}]: oldText/newText/section obrigatorios e section deve ser MemorySection valida (recebeu '${String(item?.section)}')`,
        );
      }
    }

    if (Array.isArray(output.apply.add) && output.apply.add.length > 0) {
      logger.warn(
        { addCount: output.apply.add.length },
        'turn_dreaming: apply.add descartado (turn-based nao aceita ADD)',
      );
    }

    if (Array.isArray(output.apply.userAdd) && output.apply.userAdd.length > 0) {
      logger.warn(
        { userAddCount: output.apply.userAdd.length },
        'turn_dreaming: apply.userAdd descartado (turn-based nao aceita ADD no USER.md)',
      );
    }
    if (output.apply.userRemove !== undefined) {
      if (!Array.isArray(output.apply.userRemove)) {
        throw new Error('Schema invalido: apply.userRemove deve ser array');
      }
      for (let i = 0; i < output.apply.userRemove.length; i++) {
        if (typeof output.apply.userRemove[i] !== 'string') {
          throw new Error(`Schema invalido em apply.userRemove[${i}]: deve ser string`);
        }
      }
    }
    if (output.apply.userUpdate !== undefined) {
      if (!Array.isArray(output.apply.userUpdate)) {
        throw new Error('Schema invalido: apply.userUpdate deve ser array');
      }
      for (let i = 0; i < output.apply.userUpdate.length; i++) {
        const item = output.apply.userUpdate[i];
        if (
          typeof item !== 'object' ||
          item === null ||
          typeof item.oldText !== 'string' ||
          typeof item.newText !== 'string' ||
          !VALID_USER_SECTIONS.has(item.section as UserSection)
        ) {
          throw new Error(
            `Schema invalido em apply.userUpdate[${i}]: oldText/newText/section obrigatorios e section deve ser UserSection valida (recebeu '${String(item?.section)}')`,
          );
        }
      }
    }

    for (let i = 0; i < output.quarantine.length; i++) {
      const item = output.quarantine[i];
      if (
        typeof item !== 'object' ||
        item === null ||
        typeof item.text !== 'string' ||
        typeof item.reason !== 'string'
      ) {
        throw new Error(`Schema invalido em quarantine[${i}]: text/reason obrigatorios`);
      }
      if (
        item.proposed_section !== undefined &&
        !VALID_SECTIONS.has(item.proposed_section)
      ) {
        throw new Error(
          `Schema invalido em quarantine[${i}]: proposed_section invalido ('${String(item.proposed_section)}')`,
        );
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(
      { err, rawLength: rawResponse.length },
      'turn_dreaming_failed: json_parse_error',
    );
    return buildFailSafeResult('json_parse_error', msg);
  }

  const validatedUpdate: TurnUpdateItem[] = output.apply.update.map((u) => ({
    oldText: u.oldText,
    newText: u.newText,
    section: u.section as MemorySection,
  }));

  const validatedUserUpdate: UserTurnUpdateItem[] = (output.apply.userUpdate ?? []).map((u) => ({
    oldText: u.oldText,
    newText: u.newText,
    section: u.section as UserSection,
  }));
  const validatedUserRemove: string[] = output.apply.userRemove ?? [];

  const report = buildSuccessReport(output);
  return {
    apply: {
      remove: output.apply.remove,
      update: validatedUpdate,
      ...(validatedUserRemove.length > 0 ? { userRemove: validatedUserRemove } : {}),
      ...(validatedUserUpdate.length > 0 ? { userUpdate: validatedUserUpdate } : {}),
    },
    quarantine: output.quarantine,
    discarded: output.discarded,
    report,
    failSafeTriggered: false,
  };
}


export async function saveTurnDreamingReport(result: TurnDreamingResult): Promise<string> {
  const now = new Date();
  const pad = (n: number, len = 2) => String(n).padStart(len, '0');
  const datePart = [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
  ].join('-');
  const timePart = [
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
  ].join('');

  const randomSuffix = randomUUID();
  const filename = `${datePart}_${timePart}_${randomSuffix}_turn-dreaming-report.md`;

  const dir = path.join(
    getLionClawHome(),
    'workspaces',
    'lionclaw',
    'dreaming-reports',
  );

  fs.mkdirSync(dir, { recursive: true });

  let content = result.report;

  if (result.failSafeTriggered) {
    content += [
      ``,
      ``,
      `---`,
      ``,
      `## Fail-Safe Details`,
      ``,
      `- **Motivo:** \`${result.failSafeReason ?? 'desconhecido'}\``,
      `- **Quarentena:** ${result.quarantine.length} item(ns)`,
      `- **MEMORY.md:** nao tocado`,
    ].join('\n');
  }

  const filePath = path.join(dir, filename);
  fs.writeFileSync(filePath, content, 'utf-8');
  logger.info({ filePath }, 'saveTurnDreamingReport: relatorio salvo');
  return filePath;
}



function countNonEmptyLines(content: string): number {
  return content.split('\n').filter(l => l.trim().length > 0).length;
}

function readMemoryMd(): string {
  const memoryPath = path.join(getLionClawHome(), 'MEMORY.md');
  try {
    return fs.readFileSync(memoryPath, 'utf-8');
  } catch {
    return '';
  }
}

function readUserMd(): string {
  const userPath = path.join(getLionClawHome(), 'USER.md');
  try {
    return fs.readFileSync(userPath, 'utf-8');
  } catch {
    return '';
  }
}


function emitDreamingStatus(getWindow: () => BrowserWindow | null, isDreaming: boolean): void {
  const win = getWindow();
  if (win && !win.isDestroyed()) {
    win.webContents.send('chat:stream', {
      type: 'dreaming_status',
      isDreaming,
    });
  }
}


function collectRecentTurns(
  sessionId: string,
  turnCount: number,
): Array<{ role: 'user' | 'assistant'; content: string }> {
  const db = getDb();
  const rows = db.prepare(`
    SELECT m.role, m.content
    FROM messages m
    WHERE m.session_id = ?
      AND m.role IN ('user', 'assistant')
    ORDER BY m.created_at DESC
    LIMIT ?
  `).all(sessionId, turnCount * 2) as Array<{ role: string; content: string }>;

  return rows.reverse().map(r => ({
    role: r.role as 'user' | 'assistant',
    content: excerptStartEnd(r.content || '', 2000),
  }));
}


function resolveDefaultInvoker(): LlmInvoker {
  return (p: string) => runStructuredMemoryLlm(p);
}


async function applyTurnDreamingResult(result: TurnDreamingResult): Promise<void> {
  await applyMemoryUpdates({
    add: result.apply.update.map(u => ({ section: u.section, text: u.newText })),
    remove: [
      ...result.apply.remove,
      ...result.apply.update.map(u => u.oldText),
    ],
  });

  const userRemove = result.apply.userRemove ?? [];
  const userUpdate = result.apply.userUpdate ?? [];
  if (userRemove.length === 0 && userUpdate.length === 0) return;

  const userLines = new Set(readUserMd().split('\n'));
  const matchedUpdates = userUpdate.filter(u => {
    if (!userLines.has(u.oldText)) {
      logger.warn(
        { oldText: u.oldText },
        'turn_dreaming: userUpdate sem line-match exato no USER.md — update ignorado (nunca vira ADD)',
      );
      return false;
    }
    return true;
  });

  await applyUserProfileUpdates({
    add: matchedUpdates.map(u => ({ section: u.section, text: u.newText })),
    remove: [
      ...userRemove,
      ...matchedUpdates.map(u => u.oldText),
    ],
  });
}


async function runTurnDreamingAndCommit(
  sessionId: string,
  getWindow: () => BrowserWindow | null,
): Promise<void> {
  const result = await tryWithMemoryGateLock(async () => {
    const memoryMd = readMemoryMd();

    if (countNonEmptyLines(memoryMd) < 10) {
      return { kind: 'skipped_small' as const };
    }

    emitDreamingStatus(getWindow, true);
    try {
      const userMd = readUserMd();
      const recentTurns = collectRecentTurns(sessionId, 20);
      const invoker = resolveDefaultInvoker();
      const turnResult = await runTurnDreaming(
        { recentTurns, currentMemoryMd: memoryMd, currentUserMd: userMd },
        { invoker },
      );

      if (!turnResult.failSafeTriggered) {
        await applyTurnDreamingResult(turnResult);
      }
      return { kind: 'executed' as const, turnResult };
    } finally {
      emitDreamingStatus(getWindow, false);
    }
  });

  if (result === null) {
    logger.debug('turn_dreaming_skip: lock_busy');
    return;
  }
  if (result.kind === 'skipped_small') {
    logger.info('turn_dreaming_skip: memory_too_small');
    resetTurnCount();
    return;
  }

  const { turnResult } = result;
  await saveTurnDreamingReport(turnResult);

  setLastTurnRunAt(Date.now());
  incrementTotalTurnRuns();
  if (turnResult.failSafeTriggered) {
    incrementTotalTurnFailsafes();
  }
  resetTurnCount();
}


export async function maybeRunTurnDreaming(
  sessionId: string,
  getWindow: () => BrowserWindow | null,
): Promise<void> {
  if (getSetting('dreaming_turn_based_enabled') !== 'true') return;

  const state = getDreamingState();
  const now = Date.now();
  const lastEvent = Math.max(state.lastGateRunAt ?? 0, state.lastTurnRunAt ?? 0);
  if (now - lastEvent < 5 * 60 * 1000) {
    logger.debug('turn_dreaming_skip: cooldown');
    return;
  }

  void runTurnDreamingAndCommit(sessionId, getWindow).catch(err => {
    logger.warn({ err }, 'turn_dreaming_failed_outside_failsafe');
  });
}


export function recordCompletedMainChatTurn(
  sessionId: string,
  getWindow: () => BrowserWindow | null,
): void {
  const session = getSession(sessionId);
  if (!session || session.type !== 'chat') return;

  if (getSetting('dreaming_turn_based_enabled') !== 'true') return;

  const newCount = incrementTurnCount();
  const interval = getDreamingTurnInterval();
  if (newCount >= interval) {
    void maybeRunTurnDreaming(sessionId, getWindow).catch(err => {
      logger.warn({ err }, 'turn_dreaming_maybe_failed');
    });
  }
}
