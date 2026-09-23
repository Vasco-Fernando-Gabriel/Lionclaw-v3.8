import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { getLionClawHome } from '../paths';
import { createLogger } from '../logger';
import { getSetting, setSetting } from '../db';
import { estimateTokens } from '../token-estimator';
import { resolveCompactionInputBudget } from './budgeted-input';
import type { PlainPromptInvoker, CompactionSelectionKind } from './budgeted-input';
import { splitIntoSections, countNonEmptyLines } from './md-sections';

const logger = createLogger('user-profile');

export type UserSection =
  'identidade' | 'perfil_profissional' | 'negocios_projetos' | 'stack_ferramentas' | 'preferencias' | 'fatos_duraveis';

export const USER_SECTION_HEADERS: Record<UserSection, string> = {
  identidade: '## Identidade',
  perfil_profissional: '## Perfil profissional',
  negocios_projetos: '## Negocios e projetos',
  stack_ferramentas: '## Stack e ferramentas',
  preferencias: '## Preferencias',
  fatos_duraveis: '## Fatos duraveis',
};

export const USER_SECTION_ORDER: UserSection[] = [
  'identidade',
  'perfil_profissional',
  'negocios_projetos',
  'stack_ferramentas',
  'preferencias',
  'fatos_duraveis',
];

export const VALID_USER_SECTIONS: ReadonlySet<UserSection> = new Set<UserSection>(USER_SECTION_ORDER);

export const USER_SKELETON = [
  '# Sobre o Usuario',
  '',
  '## Identidade',
  '',
  '## Perfil profissional',
  '',
  '## Negocios e projetos',
  '',
  '## Stack e ferramentas',
  '',
  '## Preferencias',
  '',
  '## Fatos duraveis',
].join('\n');

const DEFAULT_USER_MD_MAX_LINES = 60;

const IDENTITY_MAX_LINES = 10;

const USER_PRUNE_ORDER: UserSection[] = [
  'negocios_projetos',
  'fatos_duraveis',
  'stack_ferramentas',
  'preferencias',
  'perfil_profissional',
];

export function resolveUserMdMaxLines(): number {
  const raw = (getSetting('user_md_max_lines') || '').trim();
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_USER_MD_MAX_LINES;
  return n;
}

function userMdPath(): string {
  return path.join(getLionClawHome(), 'USER.md');
}

function readUserMdRaw(): string {
  try {
    return fs.readFileSync(userMdPath(), 'utf-8');
  } catch {
    return '';
  }
}

function formatToday(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export interface ArchivedUserLine {
  section: string;
  line: string;
}

function archiveUserLines(entries: ArchivedUserLine[]): void {
  if (entries.length === 0) return;
  const archivePath = path.join(getLionClawHome(), 'USER-archive.md');
  const ts = new Date().toISOString();
  const block = entries.map((e) => `- [${ts}] [${e.section}] ${e.line}`).join('\n') + '\n';
  fs.appendFileSync(archivePath, block, 'utf-8');
}

interface UserMdModel {
  titleLines: string[];
  sections: Record<UserSection, string[]>;
}

function emptySections(): Record<UserSection, string[]> {
  return {
    identidade: [],
    perfil_profissional: [],
    negocios_projetos: [],
    stack_ferramentas: [],
    preferencias: [],
    fatos_duraveis: [],
  };
}

function headerToSection(header: string): UserSection | null {
  const normalized = header.trim();
  for (const s of USER_SECTION_ORDER) {
    if (USER_SECTION_HEADERS[s] === normalized) return s;
  }
  return null;
}

function parseUserMd(rawContent: string): { model: UserMdModel; foldedBlocks: string[] } {
  const source = rawContent.trim().length > 0 ? rawContent : USER_SKELETON;
  const blocks = splitIntoSections(source);
  const model: UserMdModel = { titleLines: [], sections: emptySections() };
  const foldedBlocks: string[] = [];
  const folded: string[] = [];

  for (const block of blocks) {
    if (block.header === null) {
      const orphanContent: string[] = [];
      for (const line of block.lines) {
        if (line.startsWith('# ')) {
          model.titleLines.push(line);
        } else if (line.trim().length > 0) {
          orphanContent.push(line);
        }
      }
      if (orphanContent.length > 0) {
        folded.push(...orphanContent);
        foldedBlocks.push('(conteudo orfao antes do primeiro header)');
        logger.warn(
          { lineCount: orphanContent.length },
          'user-profile: conteudo orfao dobrado em Fatos duraveis (nunca descartado)',
        );
      }
      continue;
    }

    const section = headerToSection(block.header);
    if (section) {
      const body = block.lines.filter((l) => l.trim().length > 0);
      model.sections[section].push(...body);
    } else {
      const body = block.lines.filter((l) => l.trim().length > 0);
      if (body.length > 0) {
        folded.push(...body);
      }
      foldedBlocks.push(block.header);
      logger.warn(
        { header: block.header, lineCount: body.length },
        'user-profile: header desconhecido dobrado em Fatos duraveis (nunca descartado)',
      );
    }
  }

  if (model.titleLines.length === 0) {
    model.titleLines.push('# Sobre o Usuario');
  }
  model.sections.fatos_duraveis.push(...folded);
  return { model, foldedBlocks };
}

function renderUserMd(model: UserMdModel): string {
  const parts: string[] = [...model.titleLines, ''];
  for (const s of USER_SECTION_ORDER) {
    parts.push(USER_SECTION_HEADERS[s]);
    const body = model.sections[s].filter((l) => l.trim().length > 0);
    if (body.length > 0) parts.push(...body);
    parts.push('');
  }
  while (parts.length > 0 && parts[parts.length - 1].trim() === '') {
    parts.pop();
  }
  return parts.join('\n') + '\n';
}

function stripDashPrefix(text: string): string {
  return text.replace(/^-\s+/, '').trim();
}

function hasDateTag(text: string): boolean {
  return /\[\d{4}-\d{2}-\d{2}\]\s*$/.test(text);
}

function formatAddLine(section: UserSection, text: string, today: string): string {
  const fact = stripDashPrefix(text);
  if (section === 'identidade') return `- ${fact}`;
  if (hasDateTag(fact)) return `- ${fact}`;
  return `- ${fact} [${today}]`;
}

function identityKey(line: string): string | null {
  const fact = stripDashPrefix(line);
  const idx = fact.indexOf(':');
  if (idx <= 0) return null;
  return fact.slice(0, idx).toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').trim();
}

function pruneToCap(model: UserMdModel, cap: number): ArchivedUserLine[] {
  const archived: ArchivedUserLine[] = [];
  let content = renderUserMd(model);
  let count = countNonEmptyLines(content);

  while (count > cap) {
    let prunedSomething = false;
    for (const s of USER_PRUNE_ORDER) {
      const body = model.sections[s];
      const idx = body.findIndex((l) => l.trim().length > 0);
      if (idx === -1) continue;
      const [removed] = body.splice(idx, 1);
      archived.push({ section: USER_SECTION_HEADERS[s], line: removed });
      prunedSomething = true;
      break;
    }
    if (!prunedSomething) {
      logger.warn(
        { nonEmptyCount: count, cap },
        'user-profile: secoes podaveis exauridas e USER.md ainda acima do cap (Identidade nunca e podada) — parando a poda',
      );
      break;
    }
    content = renderUserMd(model);
    count = countNonEmptyLines(content);
  }
  return archived;
}

export interface UserProfileUpdateInput {
  add: Array<{ section: UserSection; text: string }>;
  remove: string[];
}

interface UserTransformResult {
  content: string;
  archived: ArchivedUserLine[];
}

function applyUserUpdatesTransform(
  rawContent: string,
  input: UserProfileUpdateInput,
  today: string,
): UserTransformResult {
  const { model } = parseUserMd(rawContent);

  for (const removeLine of input.remove) {
    let removed = false;
    for (const s of USER_SECTION_ORDER) {
      const idx = model.sections[s].indexOf(removeLine);
      if (idx !== -1) {
        model.sections[s].splice(idx, 1);
        removed = true;
        break;
      }
    }
    if (!removed) {
      logger.warn({ removeLine }, 'user-profile: userRemove sem line-match exato no USER.md — no-op');
    }
  }

  const identityFold: string[] = [];
  for (const item of input.add) {
    const line = formatAddLine(item.section, item.text, today);
    const allLines = new Set(USER_SECTION_ORDER.flatMap((s) => model.sections[s]));
    if (allLines.has(line)) {
      logger.info({ line }, 'user-profile: add duplicado literal ignorado (guard secundario)');
      continue;
    }
    if (item.section === 'identidade') {
      const key = identityKey(line);
      if (key) {
        model.sections.identidade = model.sections.identidade.filter((existing) => {
          const existingKey = identityKey(existing);
          return existingKey === null || existingKey !== key;
        });
      }
      model.sections.identidade.push(line);
    } else {
      model.sections[item.section].push(line);
    }
  }

  const identityBody = model.sections.identidade.filter((l) => l.trim().length > 0);
  if (identityBody.length > IDENTITY_MAX_LINES) {
    const keep = identityBody.slice(0, IDENTITY_MAX_LINES);
    const overflow = identityBody.slice(IDENTITY_MAX_LINES);
    model.sections.identidade = keep;
    identityFold.push(...overflow);
    logger.warn(
      { overflow: overflow.length },
      'user-profile: Identidade acima do teto local — excedente dobrado em Fatos duraveis',
    );
  }
  model.sections.fatos_duraveis.push(...identityFold);

  const cap = resolveUserMdMaxLines();
  const archived = pruneToCap(model, cap);

  return { content: renderUserMd(model), archived };
}

export async function updateUserProfileSectionAware(input: UserProfileUpdateInput): Promise<void> {
  if (input.add.length === 0 && input.remove.length === 0) return;

  const today = formatToday();
  let base = readUserMdRaw();
  let result = applyUserUpdatesTransform(base, input, today);

  const fresh = readUserMdRaw();
  if (fresh !== base) {
    logger.warn(
      'user-profile: USER.md mudou entre a leitura e o write (lost-update guard) — transform re-aplicado sobre o conteudo fresco',
    );
    base = fresh;
    result = applyUserUpdatesTransform(base, input, today);
  }

  archiveUserLines(result.archived);
  fs.writeFileSync(userMdPath(), result.content, 'utf-8');
  logger.info(
    { added: input.add.length, removed: input.remove.length, archived: result.archived.length },
    'user-profile: USER.md atualizado (section-aware)',
  );
}

export async function applyUserProfileUpdates(input: UserProfileUpdateInput): Promise<void> {
  return updateUserProfileSectionAware(input);
}

const SANITIZED_FLAG_KEY = 'user_md_sanitized_v1';
const SANITIZE_ATTEMPTS_KEY = 'user_md_sanitize_attempts';
const SANITIZE_MAX_ATTEMPTS = 5;
const SANITIZE_TIMEOUT_MS = 300_000;
const SANITIZE_MAX_TOKENS = 8000;

function resolveSanitizeTimeoutMs(): number {
  const raw = Number.parseInt(getSetting('user_md_sanitize_timeout_ms') || '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : SANITIZE_TIMEOUT_MS;
}

export interface SanitizeUserProfileOptions {
  kind: CompactionSelectionKind;
  invoker: PlainPromptInvoker;
  timeoutMs?: number;
}

function buildSanitizePromptTemplate(): string {
  return `Voce e um organizador de perfil de usuario. Reorganize o conteudo do USER.md abaixo nas 6 secoes canonicas.

REGRAS:
- Dedup SEMANTICO: funda variacoes/reformulacoes do mesmo fato em UM unico fato.
- Merge com/sem acento: trate grafias com e sem acento como o mesmo fato.
- Em conflito entre fatos, a informacao mais RECENTE prevalece (tags [YYYY-MM-DD] indicam a data).
- Descarte ruido efemero (contexto momentaneo, pedidos pontuais ja resolvidos).
- NADA inventado: apenas fatos presentes no conteudo original.
- Preserve as tags [YYYY-MM-DD] existentes quando mantiver o fato.
- Linhas de "identidade" no formato "Chave: valor" (ex: "Nome: Fulano").
- Sempre em portugues brasileiro.

CONTEUDO ORIGINAL (USER.md):
<<<
{{CONTENT}}
>>>

Retorne APENAS JSON valido (sem markdown fence, sem explicacao) com esta estrutura exata:
{
  "sections": {
    "identidade": ["Nome: ..."],
    "perfil_profissional": ["..."],
    "negocios_projetos": ["..."],
    "stack_ferramentas": ["..."],
    "preferencias": ["..."],
    "fatos_duraveis": ["..."]
  }
}
Secao sem conteudo = array vazio. As 6 chaves sao OBRIGATORIAS.`;
}

function buildSanitizeBatches(original: string, budgetTokens: number): string[] {
  const overhead = estimateTokens(buildSanitizePromptTemplate());
  const available = Math.max(1000, budgetTokens - overhead);
  if (estimateTokens(original) <= available) return [original];

  const blocks = splitIntoSections(original);
  const batches: string[] = [];
  let current: string[] = [];
  let currentTokens = 0;
  for (const block of blocks) {
    const text = (block.header !== null ? block.header + '\n' : '') + block.lines.join('\n');
    if (text.trim().length === 0) continue;
    const t = estimateTokens(text);
    if (current.length > 0 && currentTokens + t > available) {
      batches.push(current.join('\n'));
      current = [];
      currentTokens = 0;
    }
    current.push(text);
    currentTokens += t;
  }
  if (current.length > 0) batches.push(current.join('\n'));
  return batches.length > 0 ? batches : [original];
}

interface SanitizeSectionsPayload {
  sections: Record<UserSection, string[]>;
}

function parseSanitizeResponse(raw: string): SanitizeSectionsPayload {
  let cleaned = raw.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }
  const parsed = JSON.parse(cleaned) as { sections?: Record<string, unknown> };
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof parsed.sections !== 'object' ||
    parsed.sections === null
  ) {
    throw new Error('sanitizacao: resposta sem objeto "sections"');
  }
  const out = emptySections();
  for (const s of USER_SECTION_ORDER) {
    const value = parsed.sections[s];
    if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
      throw new Error(`sanitizacao: "sections.${s}" deve ser array de strings`);
    }
    out[s] = (value as string[]).map((v) => v.trim()).filter((v) => v.length > 0);
  }
  return { sections: out };
}

async function invokeWithTimeout(invoker: PlainPromptInvoker, prompt: string, timeoutMs: number): Promise<string> {
  const timeoutPromise = new Promise<never>((_, reject) => {
    const id = setTimeout(() => reject(new Error('user_md_sanitize_timeout')), timeoutMs);
    if (typeof id === 'object' && 'unref' in id) {
      (id as NodeJS.Timeout).unref();
    }
  });
  return Promise.race([invoker(prompt, { maxTokens: SANITIZE_MAX_TOKENS }), timeoutPromise]);
}

function isCanonicalUserMd(content: string): boolean {
  for (const s of USER_SECTION_ORDER) {
    if (!content.includes(USER_SECTION_HEADERS[s])) return false;
  }
  for (const line of content.split('\n')) {
    if (line.startsWith('## ') && headerToSection(line) === null) return false;
  }
  return true;
}

function writeSanitizationReport(data: {
  before: string;
  after: string;
  foldedBlocks: string[];
  backupPath: string;
  batches: number;
}): void {
  try {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const datePart = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    const timePart = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const dir = path.join(getLionClawHome(), 'workspaces', 'lionclaw', 'dreaming-reports');
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `${datePart}_${timePart}_${randomUUID()}_user-sanitization-report.md`);
    const content = [
      '# Sanitizacao one-shot do USER.md',
      '',
      `- Backup: ${data.backupPath}`,
      `- Lotes de LLM: ${data.batches}`,
      `- Secoes dobradas em Fatos duraveis: ${data.foldedBlocks.length > 0 ? data.foldedBlocks.join(', ') : 'nenhuma'}`,
      '',
      '## Antes',
      '```markdown',
      data.before,
      '```',
      '',
      '## Depois',
      '```markdown',
      data.after,
      '```',
    ].join('\n');
    fs.writeFileSync(filePath, content, 'utf-8');
    logger.info({ filePath }, 'user-profile: relatorio de sanitizacao salvo');
  } catch (err) {
    logger.warn({ err }, 'user-profile: falha ao salvar relatorio de sanitizacao (nao-fatal)');
  }
}

export async function maybeSanitizeUserProfile(opts: SanitizeUserProfileOptions): Promise<void> {
  try {
    const flag = getSetting(SANITIZED_FLAG_KEY);
    if (flag === 'true' || flag === 'skipped') return;

    const original = readUserMdRaw();

    if (original.trim().length === 0 || original.includes('Nenhuma informacao coletada')) {
      setSetting(SANITIZED_FLAG_KEY, 'true');
      logger.info('user-profile: USER.md ausente/vazio/placeholder — sanitizacao no-op (flag setada sem LLM)');
      return;
    }

    const cap = resolveUserMdMaxLines();
    if (isCanonicalUserMd(original) && countNonEmptyLines(original) <= cap) {
      setSetting(SANITIZED_FLAG_KEY, 'true');
      logger.info('user-profile: USER.md ja canonico e dentro do cap — sanitizacao no-op (flag setada sem LLM)');
      return;
    }

    const attempts = Number.parseInt(getSetting(SANITIZE_ATTEMPTS_KEY) || '0', 10) || 0;
    if (attempts >= SANITIZE_MAX_ATTEMPTS) {
      setSetting(SANITIZED_FLAG_KEY, 'skipped');
      logger.warn(
        { attempts },
        'user-profile: sanitizacao atingiu o teto de tentativas — estado skipped (reversivel apagando user_md_sanitized_v1)',
      );
      return;
    }
    setSetting(SANITIZE_ATTEMPTS_KEY, String(attempts + 1));

    const backupDir = path.join(getLionClawHome(), 'backups');
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const backupPath = path.join(backupDir, `USER-${ts}.md`);
    try {
      fs.mkdirSync(backupDir, { recursive: true });
      fs.writeFileSync(backupPath, original, 'utf-8');
    } catch (err) {
      logger.warn({ err, backupPath }, 'user-profile: backup do USER.md falhou — sanitizacao ABORTADA (fail-safe)');
      return;
    }

    const budget = resolveCompactionInputBudget(opts.kind);
    const batches = buildSanitizeBatches(original, budget);
    const timeoutMs = opts.timeoutMs ?? resolveSanitizeTimeoutMs();
    const merged = emptySections();
    for (const batch of batches) {
      const prompt = buildSanitizePromptTemplate().replace('{{CONTENT}}', () => batch);
      const raw = await invokeWithTimeout(opts.invoker, prompt, timeoutMs);
      const parsed = parseSanitizeResponse(raw);
      for (const s of USER_SECTION_ORDER) {
        merged[s].push(...parsed.sections[s]);
      }
    }

    const originalHadName = /nome\s*:/i.test(original);
    if (originalHadName && merged.identidade.length === 0) {
      throw new Error('sanitizacao: identidade vazia com nome presente no original');
    }

    const model: UserMdModel = { titleLines: ['# Sobre o Usuario'], sections: emptySections() };
    for (const s of USER_SECTION_ORDER) {
      model.sections[s] = merged[s].map((fact) => `- ${stripDashPrefix(fact)}`);
    }
    const archived = pruneToCap(model, cap);
    const finalContent = renderUserMd(model);

    const fresh = readUserMdRaw();
    if (fresh !== original) {
      logger.warn('user-profile: USER.md mudou durante a sanitizacao — abortada (retenta no proximo ciclo)');
      return;
    }

    archiveUserLines(archived);
    fs.writeFileSync(userMdPath(), finalContent, 'utf-8');
    setSetting(SANITIZED_FLAG_KEY, 'true');

    const { foldedBlocks } = parseUserMd(original);
    writeSanitizationReport({
      before: original,
      after: finalContent,
      foldedBlocks,
      backupPath,
      batches: batches.length,
    });
    logger.info(
      { batches: batches.length, archived: archived.length, backupPath },
      'user-profile: sanitizacao one-shot concluida',
    );
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'user-profile: sanitizacao falhou (fail-safe: USER.md intocado, flag ausente, compactacao segue)',
    );
  }
}
