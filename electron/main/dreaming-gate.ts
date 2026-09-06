
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { getLionClawHome } from './paths';
import { createLogger } from './logger';
import { getSetting } from './db';
import { runStructuredMemoryLlm } from './memory-pipeline';
import { VALID_USER_SECTIONS } from './memory-pipeline/user-profile';
import type { UserSection } from './memory-pipeline/user-profile';

const logger = createLogger('dreaming-gate');


export type MemorySection =
  | 'decisoes_ativas'
  | 'workarounds'
  | 'estado_de_projetos'
  | 'referencias_externas';

export interface GateInputItem {
  kind: 'add' | 'remove';
  text: string;
}

export interface GateOutputApplyItem {
  section: MemorySection;
  text: string; // texto final (gate pode reformatar para incluir [YYYY-MM-DD])
}

export interface UserCandidateItem {
  action: 'add' | 'remove';
  section: string; // dica (texto livre do summarizer)
  fact: string;
}

export interface GateOutputUserAddItem {
  section: UserSection;
  text: string;
}

export interface GateOutputQuarantineItem {
  text: string;
  reason: string; // por que ficou em quarentena (regra violada)
  proposed_section?: MemorySection;
}

export interface GateOutputDiscardedItem {
  text: string;
  reason: string;
}

export interface DreamingGateResult {
  apply: {
    add: GateOutputApplyItem[];
    remove: string[];
    userAdd?: GateOutputUserAddItem[];
    userRemove?: string[];
  };
  quarantine: GateOutputQuarantineItem[];
  discarded: GateOutputDiscardedItem[];
  report: string; // markdown pronto para escrever no dreaming-report
  failSafeTriggered: boolean; // true se gate caiu no fail-safe
  failSafeReason?: 'timeout' | 'json_parse_error' | 'llm_error' | 'skill_md_missing';
}

export interface DreamingGateInput {
  candidates: GateInputItem[];
  userCandidates?: UserCandidateItem[];
  currentMemoryMd: string;
  currentUserMd: string; // leitura anti-duplicata; AUDITAVEL quando ha userCandidates (12.2)
  conversationExcerpt: string; // trecho do que foi compactado, para contexto
}

export type LlmInvoker = (prompt: string) => Promise<string>;

export interface RunDreamingGateOptions {
  invoker?: LlmInvoker;
  timeoutMs?: number;
}

const DREAMING_TIMEOUT_MS = 300_000;

export function resolveDreamingTimeoutMs(): number {
  const raw = Number.parseInt(getSetting('dreaming_timeout_ms') || '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DREAMING_TIMEOUT_MS;
}


interface LlmGateOutput {
  apply: {
    add: GateOutputApplyItem[];
    remove: string[];
    userAdd?: GateOutputUserAddItem[];
    userRemove?: string[];
    userAccounting?: Array<{ candidateId?: unknown; destination?: unknown }>;
  };
  quarantine: GateOutputQuarantineItem[];
  discarded: GateOutputDiscardedItem[];
}

const VALID_ACCOUNTING_DESTINATIONS: ReadonlySet<string> = new Set([
  'userAdd',
  'userRemove',
  'quarantine',
  'discarded',
]);

function jaccardTokenSimilarity(a: string, b: string): number {
  const tokensA = new Set(a.split(' ').filter((t) => t.length > 0));
  const tokensB = new Set(b.split(' ').filter((t) => t.length > 0));
  if (tokensA.size === 0 || tokensB.size === 0) return 0;
  let intersection = 0;
  for (const t of tokensA) if (tokensB.has(t)) intersection++;
  return intersection / (tokensA.size + tokensB.size - intersection);
}

const ACCOUNTING_JACCARD_THRESHOLD = 0.5;


function buildFailSafeResult(
  candidates: GateInputItem[],
  reason: 'timeout' | 'json_parse_error' | 'llm_error' | 'skill_md_missing',
  extraInfo?: string,
  userCandidates?: UserCandidateItem[],
): DreamingGateResult {
  const hasUserCandidates = userCandidates !== undefined && userCandidates.length > 0;
  const quarantine: GateOutputQuarantineItem[] = [
    ...candidates.map((c) => ({
      text: c.text,
      reason: `gate_failed: ${reason}`,
    })),
    ...(hasUserCandidates
      ? userCandidates.map((c) => ({
          text: c.fact,
          reason: `gate_failed: ${reason}`,
        }))
      : []),
  ];

  const totalCandidates = candidates.length + (hasUserCandidates ? userCandidates.length : 0);
  const extra = extraInfo ? `\n\nDetalhe: ${extraInfo}` : '';
  const report = [
    `# Dreaming Gate - Fail-Safe Acionado`,
    ``,
    `**Motivo:** \`${reason}\`${extra}`,
    ``,
    `**${totalCandidates} candidato(s) movidos para quarentena.**`,
    ``,
    `Nenhuma alteracao foi aplicada ao MEMORY.md.`,
  ].join('\n');

  return {
    apply: hasUserCandidates
      ? { add: [], remove: [], userAdd: [], userRemove: [] }
      : { add: [], remove: [] },
    quarantine,
    discarded: [],
    report,
    failSafeTriggered: true,
    failSafeReason: reason,
  };
}

function buildSuccessReport(output: LlmGateOutput): string {
  const addLines = output.apply.add.length > 0
    ? output.apply.add.map((i) => `- [${i.section}] ${i.text}`).join('\n')
    : '_nenhuma_';

  const removeLines = output.apply.remove.length > 0
    ? output.apply.remove.map((l) => `- ${l}`).join('\n')
    : '_nenhuma_';

  const quarantineLines = output.quarantine.length > 0
    ? output.quarantine.map((q) => `- ${q.text} _(${q.reason})_`).join('\n')
    : '_nenhuma_';

  const discardedLines = output.discarded.length > 0
    ? output.discarded.map((d) => `- ${d.text} _(${d.reason})_`).join('\n')
    : '_nenhuma_';

  const parts = [
    `# Dreaming Gate - Relatorio de Compactacao`,
    ``,
    `## Aplicar`,
    `### Adicionar`,
    addLines,
    `### Remover`,
    removeLines,
  ];

  if (output.apply.userAdd !== undefined || output.apply.userRemove !== undefined) {
    const userAddLines = (output.apply.userAdd ?? []).length > 0
      ? (output.apply.userAdd ?? []).map((i) => `- [${i.section}] ${i.text}`).join('\n')
      : '_nenhuma_';
    const userRemoveLines = (output.apply.userRemove ?? []).length > 0
      ? (output.apply.userRemove ?? []).map((l) => `- ${l}`).join('\n')
      : '_nenhuma_';
    parts.push(
      `### Adicionar (USER.md)`,
      userAddLines,
      `### Remover (USER.md)`,
      userRemoveLines,
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

function buildUserRulesBlock(userCandidates: UserCandidateItem[]): string {
  const userCandidatesText = userCandidates
    .map((c, i) => `c${i + 1}. [${c.action.toUpperCase()}] (secao sugerida: ${c.section}) ${c.fact}`)
    .join('\n');

  return `

[USER_RULES]
Alem dos candidatos de memoria acima, o bloco [USER_CANDIDATES] abaixo traz fatos sobre o USUARIO candidatos ao USER.md (mostrado em [CURRENT_USER_MD], que para este bloco e AUDITAVEL). Cada candidato tem um id estavel (c1, c2, ...). Julgue cada candidato EXCLUSIVAMENTE com estas regras:
- ADD apenas para fato genuinamente NOVO e DURAVEL sobre o usuario -> apply.userAdd. Escolha a secao canonica correta ("identidade" | "perfil_profissional" | "negocios_projetos" | "stack_ferramentas" | "preferencias" | "fatos_duraveis"); a "secao sugerida" do candidato e apenas dica.
- Variacao/reformulacao de fato que JA existe no USER.md = UPDATE: apply.userRemove da linha antiga + apply.userAdd da versao nova.
- Fato obsoleto contradito pela conversa = REMOVE: apply.userRemove da linha antiga.
- Efemero/derivavel/sem valor duravel = discarded.
- Em duvida = quarantine.
- FORMATO do apply.userRemove: a linha EXATA como esta no USER.md, com o prefixo "- " e a tag [YYYY-MM-DD] quando presente na linha.
- CONTABILIDADE OBRIGATORIA: TODO candidato de [USER_CANDIDATES] deve aparecer em exatamente um destino: apply.userAdd, apply.userRemove, quarantine ou discarded (use o texto do candidato em "text" ao mover para quarantine/discarded).
- RASTRO POR ID (obrigatorio): preencha apply.userAccounting com UMA entrada por candidato, informando o candidateId (c1, c2, ...) e o destination que voce deu a ele. Este rastro e o que impede o codigo de re-quarentenar candidatos que voce reescreveu ao aplicar.

OVERRIDE EXPLICITO DA SKILL: a regra da skill "NUNCA adicionar entrada nova ao USER.md sem quarentena" vale APENAS para o fluxo standalone da skill; para o bloco [USER_CANDIDATES] valem exclusivamente as [USER_RULES] acima.

[USER_CANDIDATES]
${userCandidatesText}

[USER_JSON_SCHEMA_EXTENSION]
Adicione ao objeto "apply" do JSON de saida os campos:
"userAdd": [ { "section": "identidade" | "perfil_profissional" | "negocios_projetos" | "stack_ferramentas" | "preferencias" | "fatos_duraveis", "text": "string" } ],
"userRemove": ["linha exata do USER.md a remover (com prefixo '- ' e tag [YYYY-MM-DD] quando presente)"],
"userAccounting": [ { "candidateId": "c1", "destination": "userAdd" | "userRemove" | "quarantine" | "discarded" } ]`;
}

function buildPrompt(
  skillMd: string,
  input: DreamingGateInput,
): string {
  const candidatesText = input.candidates
    .map((c, i) => `${i + 1}. [${c.kind.toUpperCase()}] ${c.text}`)
    .join('\n');

  const excerptTruncated = input.conversationExcerpt.slice(0, 8000);
  const today = formatToday();

  const hasUserCandidates =
    input.userCandidates !== undefined && input.userCandidates.length > 0;
  const userBlock = hasUserCandidates ? buildUserRulesBlock(input.userCandidates!) : '';

  return `[GATE_INSTRUCTIONS]
Voce e um filtro de memoria. Recebeu candidatos a entrar no MEMORY.md vindos
de uma compactacao automatica. Aplique os guardrails da skill abaixo.

[TODAY]
A data de hoje e ${today}. SEMPRE use esta data exata em qualquer tag [YYYY-MM-DD]
que voce escreva em apply.add[].text. NAO invente datas baseado no seu conhecimento
pre-treino — use APENAS a data fornecida acima.

USE APENAS estas regras da skill:
  - Regras de Auto-Apply (REMOVE/ADD/UPDATE/QUARENTENA)
  - Regras de Seguranca

IGNORE COMPLETAMENTE estas secoes (sao da skill standalone, nao do gate):
  - "Fase 1: Coleta" (nao le SQLite -- candidatos ja chegam prontos)
  - "Fase 2: Analise" -- substituida pela classificacao por secao
  - "Fase 3: Aplicacao Auto" -- quem aplica e o codigo, nao voce
  - "Fase 4: Validacao pos-aplicacao" -- feita pelo codigo apos receber sua resposta
  - "Fase 5: Relatorio Final" -- gerado pelo codigo
  - "## Modelo" -- modelo ja foi escolhido pelo orchestrator_compaction_*
  - Mencao a cron semanal
  - Mencao a graph_ingest (gate nao toca no graph)

Retorne APENAS JSON valido no schema abaixo. Sem texto adicional, sem markdown code fence.

[SKILL_RULES]
${skillMd}

[CURRENT_MEMORY_MD]
${input.currentMemoryMd}

[CURRENT_USER_MD = so leitura, anti-duplicata]
${input.currentUserMd}

[CONVERSATION_EXCERPT]
${excerptTruncated}

[CANDIDATES]
${candidatesText}

[JSON_SCHEMA_OUTPUT]
Retorne um objeto JSON com esta estrutura exata:
{
  "apply": {
    "add": [
      { "section": "decisoes_ativas" | "workarounds" | "estado_de_projetos" | "referencias_externas", "text": "string" }
    ],
    "remove": ["linha exata do MEMORY.md a remover"]
  },
  "quarantine": [
    { "text": "string", "reason": "string", "proposed_section": "decisoes_ativas" | "workarounds" | "estado_de_projetos" | "referencias_externas" }
  ],
  "discarded": [
    { "text": "string", "reason": "string" }
  ]
}

Regras:
- Candidatos com kind=ADD que passam nos guardrails vao para apply.add com a secao correta.
- Candidatos com kind=REMOVE que passam vao para apply.remove (texto exato da linha).
- Candidatos que violam regras de seguranca vao para quarantine.
- Candidatos sem valor de memoria vao para discarded.
- proposed_section em quarantine e opcional (omita se nao fizer sentido).
- Retorne JSON puro, sem markdown, sem comentarios.${userBlock}`;
}


export async function runDreamingGate(
  input: DreamingGateInput,
  options?: RunDreamingGateOptions,
): Promise<DreamingGateResult> {
  const invoker: LlmInvoker = options?.invoker ?? ((p: string) => runStructuredMemoryLlm(p));
  const timeoutMs = options?.timeoutMs ?? resolveDreamingTimeoutMs();

  const skillPath = path.join(getLionClawHome(), 'skills', 'dreaming', 'SKILL.md');
  let skillMd: string;
  try {
    if (!fs.existsSync(skillPath)) {
      logger.warn(
        { skillPath, candidates: input.candidates.length },
        'dreaming_gate_failed: skill_md_missing',
      );
      return buildFailSafeResult(input.candidates, 'skill_md_missing', `SKILL.md nao encontrado em ${skillPath}`, input.userCandidates);
    }
    skillMd = fs.readFileSync(skillPath, 'utf-8').trim();
    if (!skillMd) {
      logger.warn(
        { skillPath, candidates: input.candidates.length },
        'dreaming_gate_failed: skill_md_missing (vazio)',
      );
      return buildFailSafeResult(input.candidates, 'skill_md_missing', `SKILL.md vazio em ${skillPath}`, input.userCandidates);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(
      { skillPath, err, candidates: input.candidates.length },
      'dreaming_gate_failed: skill_md_missing (erro de IO)',
    );
    return buildFailSafeResult(input.candidates, 'skill_md_missing', `Erro ao ler SKILL.md: ${msg}`, input.userCandidates);
  }

  const prompt = buildPrompt(skillMd, input);

  let rawResponse: string;
  try {
    const timeoutPromise = new Promise<never>((_, reject) => {
      const id = setTimeout(
        () => reject(new Error('dreaming_gate_timeout')),
        timeoutMs,
      );
      if (typeof id === 'object' && 'unref' in id) {
        (id as NodeJS.Timeout).unref();
      }
    });

    rawResponse = await Promise.race([invoker(prompt), timeoutPromise]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === 'dreaming_gate_timeout') {
      logger.warn(
        { timeoutMs, candidates: input.candidates.length },
        'dreaming_gate_failed: timeout',
      );
      return buildFailSafeResult(input.candidates, 'timeout', `timeout apos ${timeoutMs}ms`, input.userCandidates);
    }
    logger.warn(
      { err, candidates: input.candidates.length },
      'dreaming_gate_failed: llm_error',
    );
    return buildFailSafeResult(input.candidates, 'llm_error', msg, input.userCandidates);
  }

  let output: LlmGateOutput;
  try {
    let cleaned = rawResponse.trim();
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
    }
    output = JSON.parse(cleaned) as LlmGateOutput;

    if (
      typeof output !== 'object' ||
      output === null ||
      !output.apply ||
      !Array.isArray(output.apply.add) ||
      !Array.isArray(output.apply.remove) ||
      !Array.isArray(output.quarantine) ||
      !Array.isArray(output.discarded)
    ) {
      throw new Error('Schema invalido: campos obrigatorios ausentes');
    }

    const VALID_SECTIONS: ReadonlySet<MemorySection> = new Set<MemorySection>([
      'decisoes_ativas',
      'workarounds',
      'estado_de_projetos',
      'referencias_externas',
    ]);
    for (let i = 0; i < output.apply.add.length; i++) {
      const item = output.apply.add[i];
      if (
        typeof item !== 'object' ||
        item === null ||
        typeof item.text !== 'string' ||
        !VALID_SECTIONS.has(item.section)
      ) {
        throw new Error(
          `Schema invalido em apply.add[${i}]: section deve ser uma das 4 obrigatorias (recebeu '${String(item?.section)}')`,
        );
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
      if (item.proposed_section !== undefined && !VALID_SECTIONS.has(item.proposed_section)) {
        throw new Error(
          `Schema invalido em quarantine[${i}]: proposed_section invalido ('${String(item.proposed_section)}')`,
        );
      }
    }

    if (input.userCandidates !== undefined && input.userCandidates.length > 0) {
      if (output.apply.userAdd === undefined) output.apply.userAdd = [];
      if (output.apply.userRemove === undefined) output.apply.userRemove = [];
      if (!Array.isArray(output.apply.userAdd) || !Array.isArray(output.apply.userRemove)) {
        throw new Error('Schema invalido: apply.userAdd/apply.userRemove devem ser arrays');
      }
      for (let i = 0; i < output.apply.userAdd.length; i++) {
        const item = output.apply.userAdd[i];
        if (
          typeof item !== 'object' ||
          item === null ||
          typeof item.text !== 'string' ||
          !VALID_USER_SECTIONS.has(item.section as UserSection)
        ) {
          throw new Error(
            `Schema invalido em apply.userAdd[${i}]: section deve ser uma das 6 secoes canonicas do USER.md (recebeu '${String((item as { section?: unknown } | null)?.section)}')`,
          );
        }
      }
      for (let i = 0; i < output.apply.userRemove.length; i++) {
        if (typeof output.apply.userRemove[i] !== 'string') {
          throw new Error(`Schema invalido em apply.userRemove[${i}]: deve ser string`);
        }
      }
    } else {
      delete output.apply.userAdd;
      delete output.apply.userRemove;
      delete output.apply.userAccounting;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(
      { err, rawLength: rawResponse.length, candidates: input.candidates.length },
      'dreaming_gate_failed: json_parse_error',
    );
    return buildFailSafeResult(input.candidates, 'json_parse_error', msg, input.userCandidates);
  }

  if (input.userCandidates !== undefined && input.userCandidates.length > 0) {
    const accountedIds = new Set<string>();
    for (const entry of output.apply.userAccounting ?? []) {
      if (
        typeof entry === 'object' &&
        entry !== null &&
        typeof entry.candidateId === 'string' &&
        typeof entry.destination === 'string' &&
        VALID_ACCOUNTING_DESTINATIONS.has(entry.destination)
      ) {
        accountedIds.add(entry.candidateId.trim().toLowerCase());
      }
    }

    const normalizeForMatch = (s: string): string =>
      s
        .toLowerCase()
        .normalize('NFD')
        .replace(/\p{M}/gu, '')
        .replace(/^-\s+/, '')
        .replace(/\[\d{4}-\d{2}-\d{2}\]/g, '')
        .replace(/\s+/g, ' ')
        .trim();

    const pool = [
      ...(output.apply.userAdd ?? []).map((i) => i.text),
      ...(output.apply.userRemove ?? []),
      ...output.quarantine.map((q) => q.text),
      ...output.discarded.map((d) => d.text),
    ]
      .map(normalizeForMatch)
      .filter((t) => t.length > 0);

    for (let i = 0; i < input.userCandidates.length; i++) {
      const candidate = input.userCandidates[i];
      const candidateId = `c${i + 1}`;
      if (accountedIds.has(candidateId)) continue;

      const norm = normalizeForMatch(candidate.fact);
      const accounted =
        norm.length > 0 &&
        pool.some(
          (t) =>
            t.includes(norm) ||
            norm.includes(t) ||
            jaccardTokenSimilarity(t, norm) >= ACCOUNTING_JACCARD_THRESHOLD,
        );
      if (!accounted) {
        output.quarantine.push({ text: candidate.fact, reason: 'unaccounted_by_gate' });
        logger.warn(
          { fact: candidate.fact, candidateId },
          'dreaming_gate: userCandidate nao contabilizado pelo gate -> quarentena (unaccounted_by_gate)',
        );
      }
    }
  }

  delete output.apply.userAccounting;

  const report = buildSuccessReport(output);
  return {
    apply: output.apply,
    quarantine: output.quarantine,
    discarded: output.discarded,
    report,
    failSafeTriggered: false,
  };
}


export async function saveDreamingReport(result: DreamingGateResult): Promise<string> {
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

  const filename = `${datePart}_${timePart}_${randomSuffix}_compaction-dreaming-report.md`;
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
      `- **Candidatos em quarentena:** ${result.quarantine.length}`,
      `- **MEMORY.md:** nao tocado`,
    ].join('\n');
  }

  const filePath = path.join(dir, filename);
  fs.writeFileSync(filePath, content, 'utf-8');
  logger.info({ filePath }, 'saveDreamingReport: relatorio salvo');
  return filePath;
}
