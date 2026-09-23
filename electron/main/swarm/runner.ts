import { randomBytes } from 'node:crypto';
import path from 'node:path';
import type { AgentExecutionResult } from '../agent-runtime/types';
import type { SwarmAttemptExecution, SwarmResolvedMember } from '../agent-runtime/swarm-adapter';
import type {
  SwarmAttempt,
  SwarmCatalog,
  SwarmError,
  SwarmItem,
  SwarmMetrics,
  SwarmOutcome,
  SwarmRun,
  SwarmRunSummary,
  SwarmSettings,
} from '../../../src/types/swarm';
import { SwarmArtifacts, parseSwarmTrailer } from './artifacts';
import { SwarmDomainError, inputHash, normalizedItems, parseSwarmInput, validateSwarmSettings } from './validation';

const terminal = (status: string) => ['done', 'partial', 'failed', 'aborted'].includes(status);
const itemTerminal = (status: string) => ['ok', 'failed', 'cancelled'].includes(status);
const stamp = (time: number) => new Date(time).toISOString();
export interface SwarmStartContext {
  sessionId: string;
  swarmEnabled: boolean;
  readRoots: readonly string[];
}
export interface SwarmRunnerDependencies {
  artifacts: SwarmArtifacts;
  resolve: (member: SwarmItem['member'], cwd: string) => Promise<SwarmResolvedMember>;
  execute: (request: SwarmAttemptExecution) => Promise<AgentExecutionResult>;
  catalog: () => Promise<SwarmCatalog>;
  readSettings: () => SwarmSettings;
  beginAdmission?: () => { assertActive: () => void; release: () => void };
  writeSettings: (settings: SwarmSettings) => void;
  project: (summary: SwarmRunSummary) => void;
  audit?: (event: { sessionId: string; runId: string; action: 'start' | 'abort'; itemCount: number }) => void;
  deliver: (run: SwarmRun, envelope: string) => void;
  deliveryState?: (
    run: SwarmRun,
  ) => { state: 'pending' | 'claimed' | 'delivered' | 'undeliverable'; error: string | null } | undefined;
  recoverAttempt?: (run: SwarmRun, item: SwarmItem, attempt: SwarmAttempt) => Promise<boolean>;
  now?: () => number;
  random?: () => number;
  reportError: (error: unknown, context: string) => void;
}
interface ActiveAttempt {
  controller: AbortController;
  reason: SwarmOutcome | null;
  completion: Promise<void>;
}
export function summarizeSwarm(run: SwarmRun): SwarmRunSummary {
  const metrics = run.items.flatMap((i) => i.attempts.map((a) => a.metrics));
  const known = metrics.filter((m) => m.costUsd !== null);
  return {
    runId: run.runId,
    chatSessionId: run.chatSessionId,
    revision: run.revision,
    mode: run.mode,
    status: run.status,
    itemCount: run.items.length,
    createdAt: run.createdAt,
    finishedAt: run.finishedAt,
    costUsd: known.length ? known.reduce((n, m) => n + (m.costUsd ?? 0), 0) : null,
  };
}
export function swarmEnvelope(run: SwarmRun): string {
  const safe = (s: string) =>
    s
      .replace(/[\r\n|]/g, ' ')
      .replace(/\[/g, '\\[')
      .replace(/\]/g, '\\]');
  const metrics = run.items.flatMap((i) => i.attempts.map((a) => a.metrics));
  const knownCost = metrics.reduce((n, m) => n + (m.costUsd ?? 0), 0);
  const incomplete = metrics.some((m) => m.costUsd === null || m.costStatus !== 'known');
  return [
    `SWARM RUN ${run.runId}`,
    `status: ${run.status} | items: ${run.items.length} | ok: ${run.items.filter((i) => i.status === 'ok').length} | failed: ${run.items.filter((i) => i.status === 'failed').length} | cancelled: ${run.items.filter((i) => i.status === 'cancelled').length}`,
    ...run.items.map(
      (i) =>
        `[${i.status}] ${i.slug} | ${safe(i.summary ?? i.error?.message ?? 'Sem resultado')} | ${i.findingsFile ?? '(sem findings completo)'} | ${i.attempts.length} tent`,
    ),
    `Custo ${incomplete ? 'conhecido parcial/estimado' : 'estimado'}: US$ ${knownCost.toFixed(6)}${incomplete ? ' (há uso desconhecido ou estimativas parciais)' : ''}`,
    'Relatórios e retornos integrais preservados nos artifacts da run. Falhas/cancelamentos não significam ausência de problemas no alvo.',
  ].join('\n');
}

export class SwarmRunner {
  private readonly runs = new Map<string, SwarmRun>();
  private readonly resolved = new Map<string, SwarmResolvedMember>();
  private readonly active = new Map<string, ActiveAttempt>();
  private readonly listeners = new Set<(event: { runId: string; chatSessionId: string; revision: number }) => void>();
  private admission: Promise<unknown> = Promise.resolve();
  private ticker: ReturnType<typeof setInterval> | null = null;
  private recovered = false;
  private closing = false;
  private fatal: Error | null = null;
  private cursor = 0;
  private recoveryPromise: Promise<void> | null = null;
  private cancelEpoch = 0;
  private readonly admitting = new Map<string, number>();
  private readonly pendingDeliveries = new Set<string>();
  private readonly now: () => number;
  private readonly random: () => number;
  constructor(private readonly deps: SwarmRunnerDependencies) {
    this.now = deps.now ?? Date.now;
    this.random = deps.random ?? Math.random;
  }
  subscribe(cb: (event: { runId: string; chatSessionId: string; revision: number }) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
  getSettings(): SwarmSettings {
    return validateSwarmSettings(this.deps.readSettings());
  }
  setSettings(settings: SwarmSettings): SwarmSettings {
    const valid = validateSwarmSettings(settings);
    this.deps.writeSettings(valid);
    this.schedule();
    return valid;
  }
  async getCatalog(_sessionId: string, enabled: boolean): Promise<SwarmCatalog> {
    if (!enabled) throw new SwarmDomainError('swarm-disabled', 'Ative o chip Swarm para consultar o catálogo.');
    return this.deps.catalog();
  }
  private audit(run: SwarmRun, action: 'start' | 'abort'): void {
    try {
      this.deps.audit?.({ sessionId: run.chatSessionId, runId: run.runId, action, itemCount: run.items.length });
    } catch (error) {
      this.deps.reportError(error, 'Auditoria Swarm indisponível');
    }
  }
  private emit(run: SwarmRun): void {
    for (const cb of this.listeners) {
      try {
        cb({ runId: run.runId, chatSessionId: run.chatSessionId, revision: run.revision });
      } catch (error) {
        this.deps.reportError(error, 'listener');
      }
    }
  }
  private checkpoint(run: SwarmRun): void {
    run.revision++;
    try {
      this.deps.artifacts.save(run);
    } catch (error) {
      this.fatal = error instanceof Error ? error : new Error(String(error));
      for (const task of this.active.values()) task.controller.abort(this.fatal);
      this.deps.reportError(error, 'persistência Swarm interrompida');
      throw error;
    }
    try {
      this.deps.project(summarizeSwarm(run));
    } catch (error) {
      this.deps.reportError(error, 'índice Swarm será reconstruído');
    }
    this.emit(run);
  }
  private ensureOpen(): void {
    if (this.fatal) throw new SwarmDomainError('swarm-unavailable', `Swarm indisponível: ${this.fatal.message}`);
    if (!this.recovered || this.closing)
      throw new SwarmDomainError('swarm-not-ready', 'Swarm inicializando ou encerrando.');
  }
  private ensureTicker(): void {
    if (this.ticker) return;
    this.ticker = setInterval(() => {
      try {
        this.schedule();
      } catch (error) {
        this.deps.reportError(error, 'fila Swarm');
      }
    }, 1000);
    this.ticker.unref?.();
  }
  async start(context: SwarmStartContext, value: unknown): Promise<{ runId: string; status: SwarmRun['status'] }> {
    const epoch = this.cancelEpoch;
    this.admitting.set(context.sessionId, (this.admitting.get(context.sessionId) ?? 0) + 1);
    const operation = this.admission
      .then(async () => {
        let lease: ReturnType<NonNullable<SwarmRunnerDependencies['beginAdmission']>> | undefined;
        const assertAdmission = () => {
          this.ensureOpen();
          if (epoch !== this.cancelEpoch)
            throw new SwarmDomainError('admission-cancelled', 'Admissão cancelada pelo encerramento de acesso.');
          lease?.assertActive();
        };
        try {
          assertAdmission();
          lease = this.deps.beginAdmission?.();
          assertAdmission();
          if (!context.sessionId || !context.swarmEnabled)
            throw new SwarmDomainError('swarm-disabled', 'Ative o chip Swarm para iniciar.');
          const input = parseSwarmInput(value, context.readRoots);
          const hash = inputHash(input);
          const previous = [...this.runs.values()].find(
            (r) => r.chatSessionId === context.sessionId && r.requestId === input.requestId,
          );
          if (previous) {
            if (previous.requestHash !== hash)
              throw new SwarmDomainError('request-conflict', 'requestId já utilizado com outro plano.');
            return { runId: previous.runId, status: previous.status };
          }
          const current = [...this.runs.values()].find(
            (r) => r.chatSessionId === context.sessionId && !terminal(r.status),
          );
          if (current) throw new SwarmDomainError('swarm_active', `Run ${current.runId} já está ativa neste chat.`);
          const settings = this.getSettings();
          const plan = normalizedItems(input);
          const snapshots: SwarmResolvedMember[] = [];
          for (const item of plan) {
            snapshots.push(await this.deps.resolve(item.member, input.cwd));
            assertAdmission();
          }
          assertAdmission();
          const now = stamp(this.now());
          const runId = `swarm-${now.slice(0, 10).replace(/-/g, '')}_${now.slice(11, 19).replace(/:/g, '')}-${randomBytes(3).toString('hex')}`;
          const run: SwarmRun = {
            schemaVersion: 1,
            revision: 1,
            terminalRevision: null,
            runId,
            chatSessionId: context.sessionId,
            requestId: input.requestId,
            requestHash: hash,
            mode: input.mode,
            cwd: input.cwd,
            objective: input.objective,
            status: 'queued',
            createdAt: now,
            startedAt: null,
            finishedAt: null,
            settings,
            items: plan.map((item, i) => ({
              ...item,
              runtime: snapshots[i].runtime,
              model: snapshots[i].model,
              resolvedConfigFile: `_attempts/${item.slug}/config.json`,
              status: 'pending',
              currentAttemptId: null,
              nextAttemptAt: null,
              attempts: [],
              findingsFile: null,
              summary: null,
              lastSignalAt: null,
              error: null,
            })),
          };
          this.deps.artifacts.create(run);
          this.runs.set(runId, run);
          try {
            for (let i = 0; i < run.items.length; i++) {
              this.deps.artifacts.atomic(
                `${runId}/${run.items[i].resolvedConfigFile}`,
                JSON.stringify(snapshots[i].snapshot, null, 2),
              );
              this.resolved.set(`${runId}/${run.items[i].slug}`, snapshots[i]);
            }
          } catch (error) {
            for (const item of run.items) {
              item.status = 'failed';
              item.error = {
                code: 'snapshot-persistence',
                message: 'Falha ao persistir configuração; nenhum worker iniciado.',
                retryable: false,
              };
            }
            this.finish(run);
            throw new SwarmDomainError(
              'snapshot-persistence',
              `Run ${runId} falhou antes de iniciar: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
          this.audit(run, 'start');
          try {
            this.deps.project(summarizeSwarm(run));
          } catch (error) {
            this.deps.reportError(error, 'índice Swarm');
          }
          this.emit(run);
          this.ensureTicker();
          queueMicrotask(() => {
            try {
              this.schedule();
            } catch (error) {
              this.deps.reportError(error, 'admissão Swarm');
            }
          });
          return { runId, status: 'queued' as const };
        } finally {
          lease?.release();
        }
      })
      .finally(() => {
        const remaining = (this.admitting.get(context.sessionId) ?? 1) - 1;
        if (remaining) this.admitting.set(context.sessionId, remaining);
        else this.admitting.delete(context.sessionId);
      });
    this.admission = operation.catch(() => undefined);
    return operation;
  }
  async getRunState(sessionId: string, runId: string): Promise<SwarmRun> {
    if (this.fatal)
      throw new SwarmDomainError(
        'swarm-unavailable',
        `Persistência Swarm indisponível; execuções interrompidas: ${this.fatal.message}`,
      );
    const run = this.deps.artifacts.load(runId);
    if (run.chatSessionId !== sessionId) throw new SwarmDomainError('run-denied', 'Run não pertence a esta sessão.');
    const delivery = this.deps.deliveryState?.(run);
    if (delivery) run.delivery = { status: delivery.state, error: delivery.error };
    return structuredClone(run);
  }
  async getFindingsPath(sessionId: string, runId: string, slug: string): Promise<string> {
    const run = await this.getRunState(sessionId, runId);
    const item = run.items.find((i) => i.slug === slug);
    const attempt = item?.attempts.find((a) => a.outcome === 'ok' && a.validatedContentHash);
    if (!item?.findingsFile || !attempt?.validatedContentHash)
      throw new SwarmDomainError('findings-unavailable', 'Este item não possui findings completo.');
    return this.deps.artifacts.verifiedFindingsPath(runId, slug, attempt.validatedContentHash);
  }
  async listRuns(
    sessionId: string,
    cursor?: string,
    limit = 20,
  ): Promise<{ runs: SwarmRunSummary[]; nextCursor: string | null }> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 50)
      throw new SwarmDomainError('invalid-limit', 'Limite precisa estar entre 1 e 50.');
    const all = this.deps.artifacts
      .list()
      .map((id) => this.deps.artifacts.load(id))
      .filter((r) => r.chatSessionId === sessionId)
      .sort((a, b) => b.runId.localeCompare(a.runId));
    const after = cursor ? Buffer.from(cursor, 'base64url').toString('utf8') : null;
    if (after && !all.some((r) => r.runId === after)) throw new SwarmDomainError('invalid-cursor', 'Cursor inválido.');
    const start = after ? all.findIndex((r) => r.runId === after) + 1 : 0;
    const page = all.slice(start, start + limit);
    return {
      runs: page.map(summarizeSwarm),
      nextCursor:
        start + page.length < all.length ? Buffer.from(page[page.length - 1].runId).toString('base64url') : null,
    };
  }
  hasActiveSession(sessionId: string): boolean {
    return [...this.runs.values()].some((r) => r.chatSessionId === sessionId && !terminal(r.status));
  }
  hasActiveWork(sessionId?: string): boolean {
    return sessionId
      ? this.hasActiveSession(sessionId) || this.admitting.has(sessionId)
      : this.activeRunCount > 0 || this.admitting.size > 0;
  }
  get activeRunCount(): number {
    return [...this.runs.values()].filter((r) => !terminal(r.status)).length;
  }
  async abort(sessionId: string, runId: string): Promise<SwarmRun> {
    const run = this.runs.get(runId);
    if (!run || run.chatSessionId !== sessionId)
      throw new SwarmDomainError('run-denied', 'Run não encontrada nesta sessão.');
    if (terminal(run.status) || run.status === 'aborting') return structuredClone(run);
    run.status = 'aborting';
    this.audit(run, 'abort');
    for (const item of run.items) {
      if (item.status === 'pending' || item.status === 'retrying') {
        item.status = 'cancelled';
        item.error = { code: 'cancelled', message: 'Cancelado antes de executar.', retryable: false };
      } else if (!itemTerminal(item.status)) item.status = 'stopping';
    }
    this.checkpoint(run);
    for (const item of run.items) {
      const task = this.active.get(`${runId}/${item.slug}`);
      if (task) {
        task.reason = 'cancelled';
        task.controller.abort(new Error('Swarm cancelado'));
      }
    }
    this.finish(run);
    return structuredClone(run);
  }
  private schedule(): void {
    if (!this.recovered || this.closing || this.fatal) return;
    for (const runId of [...this.pendingDeliveries]) {
      const run = this.runs.get(runId);
      if (run) this.deliver(run);
    }
    const globalCap = this.getSettings().concurrencyCap;
    const candidates = [...this.runs.values()].filter((r) => !terminal(r.status) && r.status !== 'aborting');
    let idleVisits = 0;
    while (this.active.size < globalCap && candidates.length && idleVisits < candidates.length) {
      const run = candidates[this.cursor++ % candidates.length];
      const used = run.items.filter((i) => i.status === 'running' || i.status === 'stopping').length;
      const item =
        used < run.settings.concurrencyCap
          ? run.items.find(
              (i) =>
                i.status === 'pending' || (i.status === 'retrying' && Date.parse(i.nextAttemptAt ?? '') <= this.now()),
            )
          : undefined;
      if (!item) {
        idleVisits++;
        continue;
      }
      idleVisits = 0;
      this.launch(run, item);
    }
    if (!this.activeRunCount && !this.pendingDeliveries.size && this.ticker) {
      clearInterval(this.ticker);
      this.ticker = null;
    }
  }
  private launch(run: SwarmRun, item: SwarmItem): void {
    const key = `${run.runId}/${item.slug}`;
    const resolved = this.resolved.get(key);
    if (!resolved) throw new SwarmDomainError('snapshot-missing', 'Snapshot de execução indisponível.');
    const attempt: SwarmAttempt = {
      id: `attempt-${item.attempts.length + 1}-${randomBytes(4).toString('hex')}`,
      n: item.attempts.length + 1,
      startedAt: stamp(this.now()),
      endedAt: null,
      outcome: null,
      error: null,
      terminationConfirmedAt: null,
      outputFile: '',
      findingsFile: '',
      validatedContentHash: null,
      metrics: { costUsd: null, costStatus: 'unknown' },
    };
    const dir = `_attempts/${item.slug}/${attempt.id}`;
    attempt.outputFile = `${dir}/output.txt`;
    attempt.findingsFile = `${dir}/findings.md`;
    item.attempts.push(attempt);
    item.currentAttemptId = attempt.id;
    item.status = 'running';
    item.nextAttemptAt = null;
    item.lastSignalAt = stamp(this.now());
    run.status = 'running';
    run.startedAt ??= stamp(this.now());
    const findingsPath = this.deps.artifacts.attemptPath(run.runId, item.slug, attempt.id);
    this.checkpoint(run);
    const task: ActiveAttempt = { controller: new AbortController(), reason: null, completion: Promise.resolve() };
    this.active.set(key, task);
    const valid = () =>
      this.active.get(key) === task &&
      item.currentAttemptId === attempt.id &&
      item.status === 'running' &&
      !task.controller.signal.aborted &&
      !this.fatal;
    const activity = () => {
      if (valid()) item.lastSignalAt = stamp(this.now());
    };
    const stopping = (reason: 'timeout-idle' | 'timeout-hard') => {
      if (this.active.get(key) !== task || itemTerminal(item.status)) return;
      task.reason ??= reason;
      item.status = 'stopping';
      this.checkpoint(run);
    };
    task.completion = Promise.resolve()
      .then(async () => {
        try {
          const result = await this.deps.execute({
            resolved,
            cwd: run.cwd,
            prompt: `${item.prompt}\n\nGrave relatório com # título, ## Resumo, ## Achados, ## Fora de escopo / não verificado. Cada achado factual exige arquivo:linha ou URL. Termine com:\n---\nSTATUS: ok | failed\nSUMMARY: resumo em uma linha\nFINDINGS: ${item.slug}.md`,
            findingsPath,
            runId: run.runId,
            slug: item.slug,
            attemptId: attempt.id,
            settings: run.settings,
            abortController: task.controller,
            onActivity: activity,
            onStopping: stopping,
            onText: (text) => {
              if (this.active.get(key) === task) {
                this.deps.artifacts.appendOutput(run.runId, item.slug, attempt.id, text);
                activity();
              }
            },
            writeFindings: async (content) => {
              if (!valid()) throw new SwarmDomainError('attempt-revoked', 'Tentativa não aceita mais escrita.');
              this.deps.artifacts.writeAttempt(run.runId, item.slug, attempt.id, content);
            },
            uploadFindings: async (op) => {
              if (!valid()) throw new SwarmDomainError('attempt-revoked', 'Tentativa não aceita mais escrita.');
              return this.deps.artifacts.upload(run.runId, item.slug, attempt.id, op);
            },
          });
          attempt.metrics = this.metrics(result);
          this.deps.artifacts.atomic(`${run.runId}/${dir}/final-output.txt`, result.output);
          if (task.reason || task.controller.signal.aborted)
            throw new SwarmDomainError(task.reason ?? 'cancelled', 'Execução interrompida.');
          if (result.error) throw Object.assign(new Error(result.error.userMessage), { code: result.error.code });
          const trailer = parseSwarmTrailer(result.output, item.slug);
          item.summary = trailer.summary;
          if (trailer.status === 'failed') throw new SwarmDomainError('task-failed', trailer.summary);
          const findings = this.deps.artifacts.validateFindings(run.runId, item.slug, attempt.id);
          attempt.validatedContentHash = findings.sha256;
          this.checkpoint(run);
          this.deps.artifacts.publish(run.runId, item.slug, attempt.id, findings.sha256);
          item.findingsFile = `${item.slug}.md`;
          item.status = 'ok';
          item.error = null;
          attempt.outcome = 'ok';
        } catch (error) {
          const classified = this.classify(error, task.reason);
          attempt.outcome = classified.outcome;
          attempt.error = classified.error;
          item.error = classified.error;
          if (run.status === 'aborting' || task.reason === 'cancelled') item.status = 'cancelled';
          else if (classified.error.retryable && attempt.n < run.settings.maxAttempts && !this.closing && !this.fatal) {
            item.status = 'retrying';
            const delay = 30_000 * 2 ** (attempt.n - 1) + (this.random() * 20_000 - 10_000);
            item.nextAttemptAt = stamp(this.now() + delay);
          } else item.status = 'failed';
        } finally {
          attempt.endedAt = stamp(this.now());
          attempt.terminationConfirmedAt = stamp(this.now());
          this.active.delete(key);
          if (!this.fatal) {
            this.checkpoint(run);
            this.finish(run);
          }
          this.schedule();
        }
      })
      .catch((error) => {
        this.deps.reportError(error, 'finalização de tentativa Swarm');
      });
  }
  private metrics(result: AgentExecutionResult): SwarmMetrics {
    const m = result.metrics;
    return {
      costUsd: m.costStatus === 'unknown' ? null : m.costUsd,
      costStatus: m.costStatus ?? 'known',
      tokenStatus: m.tokenStatus,
      inputTokens: m.inputTokens,
      outputTokens: m.outputTokens,
      durationMs: m.durationMs,
      costStatusReasons: m.costStatusReasons,
    };
  }
  private classify(error: unknown, reason: SwarmOutcome | null): { outcome: SwarmOutcome; error: SwarmError } {
    const value = error as { code?: string; message?: string };
    const code = reason ?? value?.code ?? 'provider-error';
    const message = value?.message ?? String(error);
    const auth = /auth|credential|login|unauthorized|permission.denied|invalid.api.key/i.test(code);
    const outcome: SwarmOutcome = auth
      ? 'auth-required'
      : [
            'timeout-idle',
            'timeout-hard',
            'bad-trailer',
            'invalid-findings',
            'task-failed',
            'cancelled',
            'unsupported-capability',
            'crash',
          ].includes(code)
        ? (code as SwarmOutcome)
        : 'provider-error';
    const retryable =
      ['timeout-idle', 'timeout-hard', 'bad-trailer', 'invalid-findings', 'crash'].includes(outcome) ||
      (outcome === 'provider-error' && !/config|invalid|unsupported|context|400|404/i.test(code));
    return { outcome, error: { code, message, retryable } };
  }
  private finish(run: SwarmRun): void {
    if (terminal(run.status) || !run.items.every((i) => itemTerminal(i.status))) return;
    run.status =
      run.status === 'aborting'
        ? 'aborted'
        : run.items.every((i) => i.status === 'ok')
          ? 'done'
          : run.items.some((i) => i.status === 'ok')
            ? 'partial'
            : 'failed';
    run.finishedAt = stamp(this.now());
    run.terminalRevision = run.revision + 1;
    this.checkpoint(run);
    this.deliver(run);
    for (const item of run.items) this.resolved.delete(`${run.runId}/${item.slug}`);
  }
  private deliver(run: SwarmRun): void {
    this.pendingDeliveries.add(run.runId);
    this.ensureTicker();
    const envelope = `${swarmEnvelope(run)}\nDiretório absoluto dos artifacts: ${path.join(this.deps.artifacts.root, run.runId)}\n`;
    try {
      this.deps.artifacts.atomic(`${run.runId}/_envelope.md`, envelope);
      this.deps.deliver(run, envelope);
      this.pendingDeliveries.delete(run.runId);
    } catch (error) {
      this.deps.reportError(error, 'entrega Swarm pendente de reconciliação');
    }
  }
  recover(): Promise<void> {
    if (this.recoveryPromise) return this.recoveryPromise;
    this.recoveryPromise = this.recoverAll();
    return this.recoveryPromise;
  }
  private async recoverAll(): Promise<void> {
    for (const id of this.deps.artifacts.list()) {
      const run = this.deps.artifacts.load(id);
      this.runs.set(id, run);
      if (!terminal(run.status)) {
        for (const item of run.items) {
          if (itemTerminal(item.status)) continue;
          const attempt = item.attempts.at(-1);
          if (attempt && !attempt.terminationConfirmedAt) {
            const confirmed = (await this.deps.recoverAttempt?.(run, item, attempt)) ?? false;
            if (!confirmed)
              throw new SwarmDomainError(
                'cleanup-required',
                `Encerramento não confirmado: ${id}/${item.slug}/${attempt.id}.`,
              );
            attempt.endedAt = stamp(this.now());
            attempt.terminationConfirmedAt = stamp(this.now());
            attempt.outcome = 'interrupted';
          }
          if (attempt?.validatedContentHash && run.status !== 'aborting') {
            this.deps.artifacts.publish(id, item.slug, attempt.id, attempt.validatedContentHash);
            item.status = 'ok';
            item.findingsFile = `${item.slug}.md`;
            attempt.outcome = 'ok';
          } else {
            item.status = run.status === 'aborting' ? 'cancelled' : 'failed';
            item.error = {
              code: 'interrupted',
              message: 'Run interrompida pelo encerramento do aplicativo.',
              retryable: false,
            };
            if (attempt && attempt.outcome === 'interrupted') attempt.error = item.error;
          }
        }
        this.finish(run);
      } else this.deliver(run);
      this.deps.project(summarizeSwarm(run));
    }
    this.recovered = true;
  }
  async shutdown(): Promise<void> {
    this.cancelEpoch++;
    this.closing = true;
    if (this.ticker) {
      clearInterval(this.ticker);
      this.ticker = null;
    }
    await this.stopAllRuns();
  }
  async abortAll(_reason?: string): Promise<void> {
    this.cancelEpoch++;
    await this.stopAllRuns();
  }
  private async stopAllRuns(): Promise<void> {
    for (const run of this.runs.values())
      if (!terminal(run.status)) {
        try {
          await this.abort(run.chatSessionId, run.runId);
        } catch (error) {
          this.deps.reportError(error, 'Erro de persistência durante encerramento Swarm');
        }
      }
    for (const task of this.active.values()) {
      task.reason ??= 'cancelled';
      task.controller.abort();
    }
    await Promise.allSettled([...this.active.values()].map((task) => task.completion));
  }
}
