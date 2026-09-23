import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { z } from 'zod';
import type { SwarmFindingsAck, SwarmFindingsOperation, SwarmRun } from '../../../src/types/swarm';
import { SwarmDomainError, isWithin, swarmMemberSchema, validateSwarmSettings } from './validation';

const runPattern = /^swarm-\d{8}_\d{6}-[a-f0-9]{6}$/;
const segmentPattern = /^[a-zA-Z0-9_-]{1,128}$/;
const hash = (content: string | Buffer) => createHash('sha256').update(content).digest('hex');
const uploadStateSchema = z
  .object({
    uploadId: z.string().regex(segmentPattern),
    hashes: z.array(z.string().regex(/^[a-f0-9]{64}$/)),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    finalized: z.boolean(),
  })
  .strict();
type UploadState = z.infer<typeof uploadStateSchema>;
function findingField(finding: string, field: string): string {
  const label = new RegExp(`^- \\*\\*${field}(?:\\s*\\([^)]*\\))?\\s*(?::\\*\\*|\\*\\*:)`);
  const lines = finding.split(/\r?\n/);
  const start = lines.findIndex((line) => label.test(line));
  if (start === -1) return '';
  const body = [lines[start].replace(label, '')];
  for (const line of lines.slice(start + 1)) {
    if (/^(- \*\*|#)/.test(line)) break;
    body.push(line);
  }
  return body.join('\n');
}
function fail(message: string): never {
  throw new SwarmDomainError('artifact-error', message);
}
function syncDirectory(dir: string): void {
  if (process.platform === 'win32') return;
  const fd = fs.openSync(dir, fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
const nullableDate = z.string().datetime().nullable();
const errorSchema = z.object({ code: z.string(), message: z.string(), retryable: z.boolean() }).strict().nullable();
const attemptSchema = z
  .object({
    id: z.string().regex(segmentPattern),
    n: z.number().int().positive(),
    startedAt: z.string().datetime(),
    endedAt: nullableDate,
    terminationConfirmedAt: nullableDate,
    outcome: z
      .enum([
        'ok',
        'timeout-idle',
        'timeout-hard',
        'provider-error',
        'crash',
        'bad-trailer',
        'invalid-findings',
        'task-failed',
        'cancelled',
        'interrupted',
        'auth-required',
        'unsupported-capability',
      ])
      .nullable(),
    error: errorSchema,
    outputFile: z.string(),
    findingsFile: z.string(),
    validatedContentHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    metrics: z
      .object({
        costUsd: z.number().finite().nonnegative().nullable(),
        costStatus: z.enum(['known', 'unknown', 'estimated-partial']),
        tokenStatus: z.enum(['reported', 'not_reported']).optional(),
        inputTokens: z.number().nonnegative().optional(),
        outputTokens: z.number().nonnegative().optional(),
        durationMs: z.number().nonnegative().optional(),
        costStatusReasons: z.array(z.string()).optional(),
      })
      .strict(),
  })
  .strict();
const runSchema = z
  .object({
    schemaVersion: z.literal(1),
    revision: z.number().int().positive(),
    terminalRevision: z.number().int().positive().nullable(),
    runId: z.string().regex(runPattern),
    chatSessionId: z.string().min(1),
    requestId: z.string().regex(segmentPattern),
    requestHash: z.string().regex(/^[a-f0-9]{64}$/),
    mode: z.enum(['fanout', 'comite']),
    cwd: z.string().refine(path.isAbsolute),
    objective: z.string().min(1),
    status: z.enum(['queued', 'running', 'aborting', 'done', 'partial', 'failed', 'aborted']),
    createdAt: z.string().datetime(),
    startedAt: nullableDate,
    finishedAt: nullableDate,
    settings: z
      .object({
        concurrencyCap: z.number(),
        maxAttempts: z.number(),
        idleTimeoutMs: z.number(),
        hardTimeoutMs: z.number(),
      })
      .strict(),
    items: z
      .array(
        z
          .object({
            slug: z.string().regex(/^[a-z0-9-]{1,80}$/),
            target: z.string(),
            prompt: z.string(),
            member: swarmMemberSchema,
            runtime: z.enum(['cloud', 'codex', 'zai', 'minimax-tp', 'kimi', 'local', 'external']),
            model: z.string().min(1),
            resolvedConfigFile: z.string(),
            status: z.enum(['pending', 'running', 'stopping', 'retrying', 'ok', 'failed', 'cancelled']),
            currentAttemptId: z.string().nullable(),
            nextAttemptAt: nullableDate,
            attempts: z.array(attemptSchema),
            findingsFile: z.string().nullable(),
            summary: z.string().nullable(),
            lastSignalAt: nullableDate,
            error: errorSchema,
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict();
function validRun(value: unknown, runId: string): value is SwarmRun {
  const parsed = runSchema.safeParse(value);
  if (!parsed.success || parsed.data.runId !== runId) return false;
  const r = parsed.data;
  try {
    validateSwarmSettings(r.settings);
  } catch {
    return false;
  }
  if (new Set(r.items.map((i) => i.slug)).size !== r.items.length) return false;
  const terminal = ['done', 'partial', 'failed', 'aborted'].includes(r.status);
  if (terminal !== (r.terminalRevision !== null && r.finishedAt !== null) || (r.terminalRevision ?? 0) > r.revision)
    return false;
  if (!terminal && (r.terminalRevision !== null || r.finishedAt !== null)) return false;
  return r.items.every((item) => {
    if (item.resolvedConfigFile !== `_attempts/${item.slug}/config.json`) return false;
    if (terminal && !['ok', 'failed', 'cancelled'].includes(item.status)) return false;
    if (item.status === 'retrying' && !item.nextAttemptAt) return false;
    if (
      ['running', 'stopping'].includes(item.status) &&
      (!item.attempts.length || item.currentAttemptId !== item.attempts.at(-1)?.id)
    )
      return false;
    if (item.findingsFile !== null && item.findingsFile !== `${item.slug}.md`) return false;
    if (item.status === 'ok' && !item.findingsFile) return false;
    return item.attempts.every(
      (a, i) =>
        a.n === i + 1 &&
        a.outputFile === `_attempts/${item.slug}/${a.id}/output.txt` &&
        a.findingsFile === `_attempts/${item.slug}/${a.id}/findings.md` &&
        (a.outcome === null || (a.endedAt !== null && a.terminationConfirmedAt !== null)),
    );
  });
}

export class SwarmArtifacts {
  readonly root: string;
  constructor(root: string) {
    if (fs.existsSync(root) && fs.lstatSync(root).isSymbolicLink()) fail('Diretório Swarm não pode ser symlink.');
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    this.root = fs.realpathSync(root);
  }
  private directory(relative: string, create = false): string {
    const parts = relative.split('/').filter(Boolean);
    let current = this.root;
    for (const part of parts) {
      if (!/^[a-zA-Z0-9_.-]+$/.test(part) || part === '.' || part === '..') fail('Path de artifact inválido.');
      current = path.join(current, part);
      if (!fs.existsSync(current)) {
        if (!create) fail('Diretório de artifact ausente.');
        fs.mkdirSync(current, { mode: 0o700 });
        syncDirectory(path.dirname(current));
      }
      const stat = fs.lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink() || !isWithin(this.root, fs.realpathSync(current)))
        fail('Diretório de artifact inválido ou symlink.');
    }
    return current;
  }
  private file(relative: string, createParent = false): string {
    if (relative.includes('\\') || path.isAbsolute(relative)) fail('Path relativo inválido.');
    const parts = relative.split('/');
    const base = parts.pop();
    if (!base || !/^[a-zA-Z0-9_.-]+$/.test(base) || base === '.' || base === '..') fail('Nome de artifact inválido.');
    const parent = this.directory(parts.join('/'), createParent);
    const target = path.join(parent, base);
    if (fs.existsSync(target) && !fs.lstatSync(target).isFile()) fail('Artifact precisa ser arquivo regular.');
    try {
      if (fs.lstatSync(target).isSymbolicLink()) fail('Artifact não pode ser symlink.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return target;
  }
  private assertRun(runId: string): void {
    if (!runPattern.test(runId)) fail('runId inválido.');
  }
  private assertAttempt(slug: string, attemptId: string): void {
    if (!/^[a-z0-9-]{1,80}$/.test(slug) || !segmentPattern.test(attemptId)) fail('Identidade de tentativa inválida.');
  }
  atomic(relative: string, content: string | Buffer): void {
    const target = this.file(relative, true);
    const temporary = `${target}.${randomBytes(8).toString('hex')}.tmp`;
    const fd = fs.openSync(
      temporary,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
      0o600,
    );
    try {
      fs.writeFileSync(fd, content);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    try {
      fs.renameSync(temporary, target);
      syncDirectory(path.dirname(target));
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
  }
  read(relative: string): string {
    const file = this.file(relative);
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      if (!fs.fstatSync(fd).isFile()) fail('Artifact precisa ser arquivo regular.');
      return new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(fd));
    } finally {
      fs.closeSync(fd);
    }
  }
  create(run: SwarmRun): void {
    this.assertRun(run.runId);
    const dir = path.join(this.root, run.runId);
    fs.mkdirSync(dir, { mode: 0o700 });
    this.save(run);
  }
  save(run: SwarmRun): void {
    this.assertRun(run.runId);
    this.atomic(`${run.runId}/_run.json`, JSON.stringify(run, null, 2));
  }
  load(runId: string): SwarmRun {
    this.assertRun(runId);
    let value: unknown;
    try {
      value = JSON.parse(this.read(`${runId}/_run.json`));
    } catch (error) {
      throw new SwarmDomainError(
        'manifest-unavailable',
        `Manifest indisponível: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!validRun(value, runId))
      throw new SwarmDomainError('invalid-manifest', `Manifest inválido/incompatível: ${runId}`);
    return value;
  }
  list(): string[] {
    return fs
      .readdirSync(this.root)
      .filter((id) => runPattern.test(id))
      .sort();
  }
  attemptPath(runId: string, slug: string, attemptId: string): string {
    this.assertRun(runId);
    this.assertAttempt(slug, attemptId);
    return path.join(this.directory(`${runId}/_attempts/${slug}/${attemptId}`, true), 'findings.md');
  }
  appendOutput(runId: string, slug: string, attemptId: string, content: string): void {
    this.assertRun(runId);
    this.assertAttempt(slug, attemptId);
    const file = this.file(`${runId}/_attempts/${slug}/${attemptId}/output.txt`, true);
    const fd = fs.openSync(
      file,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW,
      0o600,
    );
    try {
      fs.writeFileSync(fd, content);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }
  writeAttempt(runId: string, slug: string, attemptId: string, content: string): void {
    this.assertRun(runId);
    this.assertAttempt(slug, attemptId);
    this.atomic(`${runId}/_attempts/${slug}/${attemptId}/findings.md`, content);
  }
  validateFindings(runId: string, slug: string, attemptId: string): { content: string; sha256: string } {
    this.assertRun(runId);
    this.assertAttempt(slug, attemptId);
    let content: string;
    try {
      content = this.read(`${runId}/_attempts/${slug}/${attemptId}/findings.md`);
    } catch {
      throw new SwarmDomainError('invalid-findings', 'Findings ausente, ilegível ou path inválido.');
    }
    if (
      !content.trim() ||
      !/^#\s+\S/m.test(content) ||
      !/^## Resumo\s*$/m.test(content) ||
      !/^## Achados\s*$/m.test(content) ||
      !/^## Fora de escopo \/ não verificado\s*$/m.test(content)
    )
      throw new SwarmDomainError('invalid-findings', 'Findings não segue a estrutura obrigatória.');
    for (const heading of ['Resumo', 'Achados', 'Fora de escopo / não verificado']) {
      const body = content.split(`## ${heading}`)[1]?.split(/\n## /)[0]?.trim();
      if (!body) throw new SwarmDomainError('invalid-findings', `Seção ${heading} sem conteúdo.`);
      if (
        heading === 'Achados' &&
        !/^###\s+\[(ALTA|MEDIA|BAIXA|INFO)\]/m.test(body) &&
        !/nenhum(?:a)?\s+(?:achado|problema|falha|divergência)|não\s+(?:foram?\s+)?(?:encontrad[oa]s?|identificad[oa]s?)\s+achados|sem\s+achados/i.test(
          body,
        )
      )
        throw new SwarmDomainError('invalid-findings', 'Declare os achados ou sua ausência explicitamente.');
    }
    const findingsBody = content.split('## Achados')[1]?.split(/\n## /)[0] ?? '';
    const findings = findingsBody.split(/\n(?=### )/).filter((block) => /^### /m.test(block));
    for (const finding of findings) {
      const severity = /^###\s+\[(ALTA|MEDIA|BAIXA|INFO)\]\s+\S/m.exec(finding)?.[1];
      if (!severity) throw new SwarmDomainError('invalid-findings', 'Achado sem severidade ou título válido.');
      if (severity === 'INFO') {
        if (!finding.split(/\r?\n/).slice(1).join('\n').trim())
          throw new SwarmDomainError('invalid-findings', 'Achado INFO sem conteúdo.');
        continue;
      }
      for (const field of ['Evidência', 'Por que importa', 'Recomendação']) {
        if (!findingField(finding, field).trim())
          throw new SwarmDomainError('invalid-findings', `Achado sem ${field} preenchida.`);
      }
    }
    return { content, sha256: hash(content) };
  }
  publish(runId: string, slug: string, attemptId: string, expectedHash: string): void {
    const { content, sha256 } = this.validateFindings(runId, slug, attemptId);
    if (sha256 !== expectedHash) throw new SwarmDomainError('invalid-findings', 'Findings mudou após validação.');
    this.atomic(`${runId}/${slug}.md`, content);
  }
  verifiedFindingsPath(runId: string, slug: string, expectedHash: string): string {
    this.assertRun(runId);
    if (!/^[a-z0-9-]{1,80}$/.test(slug)) fail('Slug inválido.');
    const relative = `${runId}/${slug}.md`;
    if (hash(this.read(relative)) !== expectedHash)
      throw new SwarmDomainError('findings-changed', 'Relatório foi alterado depois da publicação.');
    return this.file(relative);
  }
  upload(runId: string, slug: string, attemptId: string, op: SwarmFindingsOperation): SwarmFindingsAck {
    this.assertRun(runId);
    this.assertAttempt(slug, attemptId);
    if (!op || !segmentPattern.test(op.uploadId)) fail('uploadId inválido.');
    const prefix = `${runId}/_attempts/${slug}/${attemptId}`;
    const manifestPath = `${prefix}/upload.json`;
    let state: UploadState | null = null;
    try {
      state = uploadStateSchema.parse(JSON.parse(this.read(manifestPath)));
    } catch (error) {
      if (fs.existsSync(path.join(this.root, manifestPath))) throw error;
    }
    if (state && state.uploadId !== op.uploadId)
      throw new SwarmDomainError('upload-conflict', 'Tentativa já possui outro upload.');
    if (op.operation === 'begin') {
      if (!state) {
        state = { uploadId: op.uploadId, hashes: [], sha256: hash(''), finalized: false };
        this.atomic(manifestPath, JSON.stringify(state));
      }
    } else {
      if (!state) throw new SwarmDomainError('upload-not-started', 'Envie begin antes de gravar.');
      if (op.operation === 'chunk') {
        if (
          !Number.isSafeInteger(op.seq) ||
          op.seq < 0 ||
          typeof op.content !== 'string' ||
          Buffer.byteLength(op.content) > 32 * 1024
        )
          fail('Parte inválida; limite por chamada 32 KiB.');
        const digest = hash(op.content);
        if (op.seq < state.hashes.length) {
          if (state.hashes[op.seq] !== digest)
            throw new SwarmDomainError('upload-conflict', 'Conteúdo diferente para sequência já recebida.');
        } else {
          if (state.finalized || op.seq !== state.hashes.length)
            throw new SwarmDomainError('upload-conflict', 'Sequência inválida ou upload finalizado.');
          this.atomic(`${prefix}/chunk-${op.seq}.txt`, op.content);
          state.hashes.push(digest);
          const aggregate = createHash('sha256');
          for (let i = 0; i < state.hashes.length; i++) aggregate.update(this.read(`${prefix}/chunk-${i}.txt`));
          state.sha256 = aggregate.digest('hex');
          this.atomic(manifestPath, JSON.stringify(state));
        }
      } else if (op.operation === 'finalize') {
        if (op.chunkCount !== state.hashes.length || op.sha256 !== state.sha256)
          throw new SwarmDomainError('upload-conflict', 'Contagem/hash de finalize diverge do conteúdo persistido.');
        if (!state.finalized) {
          const parts = state.hashes.map((digest, i) => {
            const content = this.read(`${prefix}/chunk-${i}.txt`);
            if (hash(content) !== digest) fail('Parte de upload alterada no disco.');
            return content;
          });
          this.writeAttempt(runId, slug, attemptId, parts.join(''));
          state.finalized = true;
          this.atomic(manifestPath, JSON.stringify(state));
        }
      } else fail('Operação de upload inválida.');
    }
    return {
      uploadId: state.uploadId,
      nextSeq: state.hashes.length,
      sha256: state.sha256,
      ...(state.finalized ? { findingsFile: `${slug}.md` } : {}),
    };
  }
}

export function parseSwarmTrailer(output: string, slug: string): { status: 'ok' | 'failed'; summary: string } {
  const normalized = output.replace(/\r\n/g, '\n').trimEnd();
  const match = /(?:^|\n)---\nSTATUS: (ok|failed)\nSUMMARY: ([^\n]+)\nFINDINGS: ([^\n]+)$/.exec(normalized);
  if (!match || match[3].trim() !== `${slug}.md` || !match[2].trim())
    throw new SwarmDomainError('bad-trailer', 'Trailer STATUS/SUMMARY/FINDINGS ausente ou inválido.');
  return { status: match[1] as 'ok' | 'failed', summary: match[2].trim() };
}
