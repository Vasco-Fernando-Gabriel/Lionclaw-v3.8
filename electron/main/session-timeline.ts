import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { InsertTimelineEventInput } from './db';
import {
  deleteSessionsByIds,
  getTimelineTurnsAfterFence,
  insertTimelineEvent,
  insertTimelineTurn,
  setTimelineTurnAssistantMessageId,
  setTimelineTurnMetrics,
  setTimelineTurnStatus,
} from './db';
import { createLogger } from './logger';
import { getLionClawHome } from './paths';
import { estimateTokens } from './lion-sdk/compaction/token-estimate';
import type { NativeToolCall } from './lion-sdk/tool-parser';
import type {
  ChatMessage,
  TimelineEvent,
  TimelineFidelity,
  TimelineRuntime,
  TimelineTurn,
  TimelineTurnOrigin,
  TimelineTurnStatus,
  TimelineTurnWithEvents,
} from '../../src/types';

const logger = createLogger('session-timeline');

export const SPILL_BASH_THRESHOLD_BYTES = 30_000;
export const SPILL_GREP_THRESHOLD_BYTES = 20_000;
export const SPILL_PREVIEW_BYTES = 2048;

export function buildPersistedOutputBlock(originalBytes: number, spillPath: string, previewSource: string): string {
  const bytes = Buffer.from(previewSource, 'utf8');
  let end = Math.min(bytes.length, SPILL_PREVIEW_BYTES);
  while (end < bytes.length && end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  const preview = bytes.subarray(0, end).toString('utf8');
  return `<persisted-output>\nOutput too large (${(originalBytes / 1024).toFixed(1)}KB). Full output saved to: ${spillPath}\n\nPreview (first 2KB):\n${preview}\n...\n</persisted-output>`;
}

export function getTimelineRuns(sessionId: string, fenceMessageId: number | null): TimelineTurnWithEvents[] {
  return getTimelineTurnsAfterFence(sessionId, fenceMessageId);
}

export interface BeginTimelineTurnArgs {
  sessionId: string;
  turnIndex: number;
  anchorMessageId: number | null;
  currentUserMessageId: number | null;
  origin: TimelineTurnOrigin;
  runtime: TimelineRuntime;
  fidelity: TimelineFidelity;
  cwd: string | null;
}

export interface TimelineTurnHandle {
  runId: string;
  persistFailed: boolean;
  degraded: boolean;
  user(content: string): void;
  assistantStep(ev: { content: string; toolCallsJson: string; reasoningContent: string | null }): void;
  toolCall(ev: { toolUseId: string | null; toolName: string; content: string }): void;
  toolCallArgs(ev: { toolUseId: string; toolName: string; content: string }): void;
  toolResult(ev: {
    toolUseId: string | null;
    toolName: string;
    content: string;
    isError: boolean;
    originalBytes?: number | null;
    spillPath?: string | null;
  }): void;
  assistantFinal(ev: { content: string; reasoningContent: string | null }): void;
  metrics(counters: { textTokensEst: number | null; toolTokensEst: number }): void;
  assistantMessage(messageId: number): void;
  complete(): void;
}

function degradedHandle(runId: string): TimelineTurnHandle {
  return {
    runId,
    persistFailed: true,
    degraded: true,
    user: () => {},
    assistantStep: () => {},
    toolCall: () => {},
    toolCallArgs: () => {},
    toolResult: () => {},
    assistantFinal: () => {},
    metrics: () => {},
    assistantMessage: () => {},
    complete: () => {},
  };
}

export function beginTimelineTurn(args: BeginTimelineTurnArgs): TimelineTurnHandle {
  const runId = crypto.randomUUID();

  try {
    insertTimelineTurn({
      runId,
      sessionId: args.sessionId,
      turnIndex: args.turnIndex,
      anchorMessageId: args.anchorMessageId,
      currentUserMessageId: args.currentUserMessageId,
      origin: args.origin,
      runtime: args.runtime,
      fidelity: args.fidelity,
      cwd: args.cwd,
    });
  } catch (error) {
    logger.error(
      { error, runId, sessionId: args.sessionId, turnIndex: args.turnIndex, runtime: args.runtime },
      'beginTimelineTurn falhou: handle degradado (nada e gravado neste run)',
    );
    return degradedHandle(runId);
  }

  let seq = 0;

  const guard = (operation: string, run: () => void): void => {
    try {
      run();
    } catch (error) {
      handle.persistFailed = true;
      logger.error(
        { error, runId, sessionId: args.sessionId, operation },
        'session-timeline: gravacao falhou (stream nao afetado)',
      );
    }
  };

  const writeEvent = (
    operation: string,
    event: Omit<InsertTimelineEventInput, 'runId' | 'sessionId' | 'seq'>,
  ): void => {
    guard(operation, () => {
      insertTimelineEvent({ runId, sessionId: args.sessionId, seq: seq++, ...event });
    });
  };

  const handle: TimelineTurnHandle = {
    runId,
    persistFailed: false,
    degraded: false,
    user: (content) => {
      writeEvent('user', { kind: 'user', content });
    },
    assistantStep: (ev) => {
      writeEvent('assistantStep', {
        kind: 'assistant_step',
        content: ev.content,
        toolCallsJson: ev.toolCallsJson,
        reasoningContent: ev.reasoningContent,
      });
    },
    toolCall: (ev) => {
      writeEvent('toolCall', {
        kind: 'tool_call',
        toolUseId: ev.toolUseId,
        toolName: ev.toolName,
        content: ev.content,
      });
    },
    toolCallArgs: (ev) => {
      writeEvent('toolCallArgs', {
        kind: 'tool_call_args',
        toolUseId: ev.toolUseId,
        toolName: ev.toolName,
        content: ev.content,
      });
    },
    toolResult: (ev) => {
      writeEvent('toolResult', {
        kind: 'tool_result',
        toolUseId: ev.toolUseId,
        toolName: ev.toolName,
        content: ev.content,
        isError: ev.isError,
        originalBytes: ev.originalBytes ?? null,
        spillPath: ev.spillPath ?? null,
      });
    },
    assistantFinal: (ev) => {
      writeEvent('assistantFinal', {
        kind: 'assistant_final',
        content: ev.content,
        reasoningContent: ev.reasoningContent,
      });
    },
    metrics: (counters) => {
      guard('metrics', () => {
        setTimelineTurnMetrics(runId, counters.textTokensEst, counters.toolTokensEst);
      });
    },
    assistantMessage: (messageId) => {
      guard('assistantMessage', () => {
        setTimelineTurnAssistantMessageId(runId, messageId);
      });
    },
    complete: () => {
      if (handle.persistFailed) {
        logger.warn(
          { runId, sessionId: args.sessionId },
          'session-timeline: run com falha de persistencia permanece interrupted',
        );
        return;
      }
      guard('complete', () => {
        setTimelineTurnStatus(runId, 'complete');
      });
    },
  };

  return handle;
}

const closedSessions = new Set<string>();
const deletedSessions = new Set<string>();
const inFlightSpills = new Map<string, Set<Promise<unknown>>>();

export const __timelineInternals = { closedSessions, deletedSessions, inFlightSpills };

const SPILL_DRAIN_TIMEOUT_MS = 5000;

function sessionDirectory(sessionId: string): string {
  return path.join(getLionClawHome(), 'data', 'sessions', sessionId);
}

async function removeQuietly(target: string, sessionId: string, what: string): Promise<void> {
  try {
    await fs.promises.rm(target, { recursive: true, force: true });
  } catch (error) {
    logger.warn({ error, sessionId, target }, `session-timeline: remocao de ${what} falhou`);
  }
}

async function runSpill(sessionId: string, content: string): Promise<string | null> {
  const dir = path.join(sessionDirectory(sessionId), 'tool-results');
  const target = path.join(dir, `${crypto.randomUUID()}.txt`);
  const tmp = `${target}.tmp`;

  try {
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(tmp, content, { flag: 'wx', encoding: 'utf8' });
  } catch (error) {
    logger.warn({ error, sessionId, target }, 'session-timeline: escrita do spill falhou');
    return null;
  }

  if (closedSessions.has(sessionId)) {
    await removeQuietly(tmp, sessionId, 'spill temporario de sessao fechada');
    return null;
  }

  try {
    await fs.promises.rename(tmp, target);
  } catch (error) {
    logger.warn({ error, sessionId, target }, 'session-timeline: publicacao do spill falhou');
    await removeQuietly(tmp, sessionId, 'spill temporario apos rename falho');
    return null;
  }

  return target;
}

async function finalizeDeletedSession(sessionId: string): Promise<void> {
  if (!deletedSessions.has(sessionId)) return;
  const writers = inFlightSpills.get(sessionId);
  if (writers !== undefined && writers.size > 0) return;
  await removeQuietly(sessionDirectory(sessionId), sessionId, 'data/sessions apos o ultimo escritor');
  closedSessions.delete(sessionId);
  deletedSessions.delete(sessionId);
}

export async function writeSpillFile(sessionId: string, content: string): Promise<string | null> {
  if (closedSessions.has(sessionId)) return null;

  let writers = inFlightSpills.get(sessionId);
  if (writers === undefined) {
    writers = new Set<Promise<unknown>>();
    inFlightSpills.set(sessionId, writers);
  }

  const registered = writers;
  const writer = runSpill(sessionId, content);
  registered.add(writer);

  return writer.finally(() => {
    registered.delete(writer);
    if (registered.size === 0 && inFlightSpills.get(sessionId) === registered) {
      inFlightSpills.delete(sessionId);
    }
    void finalizeDeletedSession(sessionId);
  });
}

function raceWithTimeout(promise: Promise<unknown>, ms: number): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
  return Promise.race([promise, expiry]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

export async function deleteSessionsWithTimeline(sessionIds: string[]): Promise<void> {
  const ids = [...new Set(sessionIds)];
  if (ids.length === 0) return;

  for (const id of ids) closedSessions.add(id);

  const pending: Promise<unknown>[] = [];
  for (const id of ids) {
    const writers = inFlightSpills.get(id);
    if (writers !== undefined) pending.push(...writers);
  }
  if (pending.length > 0) {
    await raceWithTimeout(Promise.allSettled(pending), SPILL_DRAIN_TIMEOUT_MS);
  }

  try {
    deleteSessionsByIds(ids);
  } catch (error) {
    logger.error(
      { error, sessionIds: ids },
      'deleteSessionsWithTimeline: DELETE falhou; ids permanecem fechados e as pastas intocadas',
    );
    throw error;
  }

  for (const id of ids) deletedSessions.add(id);

  for (const id of ids) {
    await removeQuietly(sessionDirectory(id), id, 'data/sessions apos o DELETE');
    const writers = inFlightSpills.get(id);
    if (writers === undefined || writers.size === 0) {
      closedSessions.delete(id);
      deletedSessions.delete(id);
    }
  }
}

export interface MessageInterval {
  user: ChatMessage | null;
  messages: ChatMessage[];
}

export function groupRunsByAnchor(runs: TimelineTurnWithEvents[]): Map<number, TimelineTurnWithEvents[]> {
  const grouped = new Map<number, TimelineTurnWithEvents[]>();
  for (const run of runs) {
    if (run.anchorMessageId === null) continue;
    const entries = grouped.get(run.anchorMessageId) ?? [];
    entries.push(run);
    grouped.set(run.anchorMessageId, entries);
  }
  return grouped;
}

export function groupMessageIntervals(messages: ChatMessage[]): MessageInterval[] {
  const ordered = messages
    .filter((message) => message.role !== 'system')
    .slice()
    .sort((a, b) => {
      if (a.createdAt < b.createdAt) return -1;
      if (a.createdAt > b.createdAt) return 1;
      return a.id - b.id;
    });

  const intervals: MessageInterval[] = [];
  let current: MessageInterval | null = null;

  for (const message of ordered) {
    if (message.role === 'user') {
      current = { user: message, messages: [message] };
      intervals.push(current);
      continue;
    }
    if (current === null) {
      current = { user: null, messages: [] };
      intervals.push(current);
    }
    current.messages.push(message);
  }

  return intervals;
}

function parseNativeToolCalls(toolCallsJson: string | null): NativeToolCall[] | null {
  if (toolCallsJson === null || toolCallsJson.trim() === '') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(toolCallsJson);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  return parsed as NativeToolCall[];
}

export function isCoveredByTimeline(run: TimelineTurnWithEvents): boolean {
  const resultIds = new Set<string>();
  for (const event of run.events) {
    if (event.kind === 'tool_result' && event.toolUseId !== null) resultIds.add(event.toolUseId);
  }

  for (const event of run.events) {
    if (event.kind !== 'assistant_step') continue;
    const calls = parseNativeToolCalls(event.toolCallsJson);
    if (calls === null) return false;
    for (const call of calls) {
      const id = typeof call?.id === 'string' ? call.id : null;
      if (id === null || !resultIds.has(id)) return false;
    }
  }

  return true;
}

export function selectExactCompleteRun(runs: TimelineTurnWithEvents[]): TimelineTurnWithEvents | null {
  let best: TimelineTurnWithEvents | null = null;
  for (const run of runs) {
    if (run.status !== 'complete' || run.fidelity !== 'exact') continue;
    if (!isCoveredByTimeline(run)) continue;
    if (best === null || run.seqId > best.seqId) best = run;
  }
  return best;
}

export function selectLatestRun(runs: TimelineTurnWithEvents[]): TimelineTurnWithEvents | null {
  let best: TimelineTurnWithEvents | null = null;
  for (const run of runs) {
    if (best === null || run.seqId > best.seqId) best = run;
  }
  return best;
}

export const TOOLS_BLOCK_MAX_CHARS = 1500;
const TOOLS_BLOCK_ARGS_MAX_CHARS = 200;
const TOOLS_BLOCK_RESULT_MAX_CHARS = 300;
const TOOLS_BLOCK_HEADER = 'Tools:';
const TOOLS_BLOCK_INTERRUPTED_SUFFIX = '\n(interrompido)';

interface PairedTool {
  toolUseId: string | null;
  toolName: string;
  args: string | null;
  result: TimelineEvent | null;
}

function stringifyToolArguments(args: string | Record<string, unknown> | undefined): string {
  if (args === undefined || args === null) return '';
  if (typeof args === 'string') return args;
  try {
    return JSON.stringify(args);
  } catch {
    return '';
  }
}

function pairToolEvents(run: TimelineTurnWithEvents): PairedTool[] {
  const paired: PairedTool[] = [];
  const byToolUseId = new Map<string, PairedTool>();

  const register = (entry: PairedTool): void => {
    paired.push(entry);
    if (entry.toolUseId !== null && !byToolUseId.has(entry.toolUseId)) {
      byToolUseId.set(entry.toolUseId, entry);
    }
  };

  for (const event of run.events) {
    if (event.kind === 'assistant_step') {
      for (const call of parseNativeToolCalls(event.toolCallsJson) ?? []) {
        register({
          toolUseId: typeof call?.id === 'string' ? call.id : null,
          toolName: call?.function?.name ?? '',
          args: stringifyToolArguments(call?.function?.arguments),
          result: null,
        });
      }
      continue;
    }

    if (event.kind === 'tool_call') {
      register({
        toolUseId: event.toolUseId,
        toolName: event.toolName ?? '',
        args: event.content,
        result: null,
      });
      continue;
    }

    if (event.kind === 'tool_call_args') {
      const existing = event.toolUseId === null ? undefined : byToolUseId.get(event.toolUseId);
      if (existing !== undefined) {
        existing.args = event.content;
        if (event.toolName !== null && event.toolName !== '') existing.toolName = event.toolName;
        continue;
      }
      register({
        toolUseId: event.toolUseId,
        toolName: event.toolName ?? '',
        args: event.content,
        result: null,
      });
      continue;
    }

    if (event.kind === 'tool_result') {
      const existing = event.toolUseId === null ? undefined : byToolUseId.get(event.toolUseId);
      if (existing !== undefined) {
        if (existing.result === null) existing.result = event;
        continue;
      }
      register({
        toolUseId: event.toolUseId,
        toolName: event.toolName ?? '',
        args: null,
        result: event,
      });
    }
  }

  return paired;
}

function formatToolResultText(result: TimelineEvent | null): string {
  if (result === null) return '(sem resultado)';

  let text: string;
  if (result.content.includes('<persisted-output>')) {
    text = `[persisted ${((result.originalBytes ?? 0) / 1024).toFixed(1)}KB]`;
  } else {
    text = result.content.replace(/\r\n|\r|\n/g, ' ').slice(0, TOOLS_BLOCK_RESULT_MAX_CHARS);
  }

  return result.isError ? `ERRO: ${text}` : text;
}

function formatToolLine(entry: PairedTool): string {
  const args = entry.args === null ? '?' : entry.args.slice(0, TOOLS_BLOCK_ARGS_MAX_CHARS);
  return `- ${entry.toolName}(${args}) -> ${formatToolResultText(entry.result)}`;
}

export function formatToolsBlock(run: TimelineTurnWithEvents): string {
  const lines = pairToolEvents(run).map(formatToolLine);
  if (lines.length === 0) return '';

  const suffix = run.status === 'interrupted' ? TOOLS_BLOCK_INTERRUPTED_SUFFIX : '';
  const budget = TOOLS_BLOCK_MAX_CHARS - TOOLS_BLOCK_HEADER.length - suffix.length;

  let used = 0;
  let first = lines.length;
  for (let index = lines.length - 1; index >= 0; index--) {
    const cost = 1 + lines[index].length;
    if (used + cost > budget) break;
    used += cost;
    first = index;
  }

  let selected = lines.slice(first);
  if (first > 0) {
    let marker = `- [... ${first} tools omitidas ...]`;
    while (first < lines.length && used + 1 + marker.length > budget) {
      used -= 1 + lines[first].length;
      first += 1;
      marker = `- [... ${first} tools omitidas ...]`;
    }
    selected = used + 1 + marker.length <= budget ? [marker, ...lines.slice(first)] : lines.slice(first);
  }

  return TOOLS_BLOCK_HEADER + selected.map((line) => `\n${line}`).join('') + suffix;
}

export function buildToolsBlocksByAnchor(
  sessionId: string,
  messages: ChatMessage[],
  fence: number | null,
): Map<number, string> {
  const blocks = new Map<number, string>();
  const runs = getTimelineRuns(sessionId, fence);
  if (runs.length === 0) return blocks;

  const runsByAnchor = groupRunsByAnchor(runs);
  for (const interval of groupMessageIntervals(messages)) {
    if (interval.user === null) continue;
    const run = selectLatestRun(runsByAnchor.get(interval.user.id) ?? []);
    if (run === null) continue;
    const block = formatToolsBlock(run);
    if (block !== '') blocks.set(interval.user.id, block);
  }
  return blocks;
}

export interface MessageWithToolsBlock {
  message: ChatMessage;
  toolsBlock?: string;
}

export function attachToolsBlocks(
  messages: ChatMessage[],
  toolsByAnchor: ReadonlyMap<number, string>,
): MessageWithToolsBlock[] {
  if (toolsByAnchor.size === 0) return messages.map((message) => ({ message }));

  const blockByCarrierId = new Map<number, string>();
  for (const interval of groupMessageIntervals(messages)) {
    if (interval.user === null) continue;
    const block = toolsByAnchor.get(interval.user.id);
    if (block === undefined) continue;
    const assistants = interval.messages.filter((message) => message.role === 'assistant');
    const carrier = assistants.length > 0 ? assistants[assistants.length - 1] : interval.user;
    blockByCarrierId.set(carrier.id, block);
  }

  return messages.map((message) => {
    const toolsBlock = blockByCarrierId.get(message.id);
    return toolsBlock === undefined ? { message } : { message, toolsBlock };
  });
}

const TOUCHED_FILE_TOOLS: ReadonlySet<string> = new Set(['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const MAX_TOUCHED_FILES = 20;

function readPathFromToolArgs(toolName: string, args: string): string | null {
  if (args.trim() === '') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(args);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  const input = parsed as Record<string, unknown>;
  const value = toolName === 'NotebookEdit' ? (input['notebook_path'] ?? input['file_path']) : input['file_path'];
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function toPosixPath(filePath: string): string {
  return filePath.split(path.sep).join('/');
}

function relativizeToCwd(filePath: string, cwd: string | null): string {
  if (cwd === null || cwd.trim() === '' || !path.isAbsolute(filePath)) return toPosixPath(filePath);
  const relative = path.relative(cwd, filePath);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    return toPosixPath(filePath);
  }
  return toPosixPath(relative);
}

export function extractTouchedFiles(run: TimelineTurnWithEvents): string[] {
  const files: string[] = [];
  const seen = new Set<string>();

  for (const entry of pairToolEvents(run)) {
    if (!TOUCHED_FILE_TOOLS.has(entry.toolName)) continue;
    if (entry.result === null || entry.result.isError) continue;
    if (entry.args === null) continue;

    const raw = readPathFromToolArgs(entry.toolName, entry.args);
    if (raw === null) continue;

    const normalized = relativizeToCwd(raw, run.cwd);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    files.push(normalized);
  }

  if (files.length <= MAX_TOUCHED_FILES) return files;
  return [...files.slice(0, MAX_TOUCHED_FILES), `+${files.length - MAX_TOUCHED_FILES}`];
}

export function formatTouchedFilesLine(files: string[]): string {
  if (files.length === 0) return '';
  return `[arquivos tocados: ${files.join(', ')}]`;
}

export interface TimelineAnchorInput {
  origin: TimelineTurn['origin'];
  persistedUserMessageId: number | null;
  answeredUserMessageId: number | null;
}

export interface TimelineAnchorResolution {
  anchorMessageId: number | null;
  currentUserMessageId: number | null;
  excludeUserMessageId: number | null;
}

export function resolveTimelineAnchor(input: TimelineAnchorInput): TimelineAnchorResolution {
  if (input.origin === 'turn') {
    const id = input.persistedUserMessageId;
    return { anchorMessageId: id, currentUserMessageId: id, excludeUserMessageId: id };
  }
  if (input.origin === 'retry') {
    const id = input.answeredUserMessageId;
    return { anchorMessageId: id, currentUserMessageId: null, excludeUserMessageId: id };
  }
  return { anchorMessageId: null, currentUserMessageId: null, excludeUserMessageId: null };
}

export interface CliTimelineOriginInput {
  laneKind: 'desktop' | 'telegram' | 'cron';
  origin: 'user' | 'system-event' | undefined;
  swarmDelivery: boolean;
  forceNewSession: boolean;
  persistedUserMessageId: number | null;
}

export function resolveCliTimelineOrigin(input: CliTimelineOriginInput): TimelineTurnOrigin {
  if (input.swarmDelivery) return 'swarm';
  if (input.origin === 'system-event') return 'system-event';
  if (input.forceNewSession) return 'retry';
  if (input.persistedUserMessageId !== null) return 'turn';
  if (input.laneKind === 'telegram') return 'telegram';
  if (input.laneKind === 'cron') return 'cron';
  return 'turn';
}

export type TimelineMetricsEvent = Pick<
  TimelineEvent,
  'kind' | 'toolUseId' | 'content' | 'toolCallsJson' | 'reasoningContent'
>;

export interface ObservedTimelineRecorder {
  toolCall(ev: { toolUseId: string | null; toolName: string; content: string }): void;
  toolCallArgs(ev: { toolUseId: string; toolName: string; content: string }): void;
  toolResult(ev: { toolUseId: string | null; toolName: string; content: string; isError: boolean }): void;
  events(): TimelineMetricsEvent[];
}

export function createObservedTimelineRecorder(handle: TimelineTurnHandle | undefined): ObservedTimelineRecorder {
  const events: TimelineMetricsEvent[] = [];
  const record = (
    kind: TimelineMetricsEvent['kind'],
    toolUseId: string | null,
    content: string,
    write: () => void,
  ): void => {
    try {
      events.push({ kind, toolUseId, content, toolCallsJson: null, reasoningContent: null });
      write();
    } catch (error) {
      logger.debug({ error, kind }, 'session-timeline: gravacao observada falhou (stream nao afetado)');
    }
  };
  return {
    toolCall: (ev) => record('tool_call', ev.toolUseId, ev.content, () => handle?.toolCall(ev)),
    toolCallArgs: (ev) => record('tool_call_args', ev.toolUseId, ev.content, () => handle?.toolCallArgs(ev)),
    toolResult: (ev) => record('tool_result', ev.toolUseId, ev.content, () => handle?.toolResult(ev)),
    events: () => events,
  };
}

export function computeTimelineMetrics(
  runtime: TimelineRuntime,
  events: TimelineMetricsEvent[],
): { textTokensEst: number | null; toolTokensEst: number } {
  if (runtime === 'lion-sdk') {
    let textTokensEst = 0;
    let toolTokensEst = 0;
    for (const event of events) {
      if (event.kind === 'user' || event.kind === 'assistant_step' || event.kind === 'assistant_final') {
        textTokensEst += estimateTokens(event.content);
      }
      if (event.reasoningContent) textTokensEst += estimateTokens(event.reasoningContent);
      if (event.toolCallsJson) toolTokensEst += estimateTokens(event.toolCallsJson);
      if (event.kind === 'tool_result') toolTokensEst += estimateTokens(event.content);
    }
    return { textTokensEst, toolTokensEst };
  }

  let toolTokensEst = 0;
  const argsByToolUseId = new Map<string, string>();
  for (const event of events) {
    if (event.kind === 'tool_call' || event.kind === 'tool_call_args') {
      if (event.toolUseId === null) {
        toolTokensEst += estimateTokens(event.content);
        continue;
      }
      const previous = argsByToolUseId.get(event.toolUseId);
      if (previous === undefined || event.kind === 'tool_call_args') {
        argsByToolUseId.set(event.toolUseId, event.content);
      }
      continue;
    }
    if (event.kind === 'tool_result') toolTokensEst += estimateTokens(event.content);
  }
  for (const content of argsByToolUseId.values()) {
    toolTokensEst += estimateTokens(content);
  }
  return { textTokensEst: null, toolTokensEst };
}

export function logTimelineMetrics(input: {
  runId: string;
  runtime: TimelineRuntime;
  status: TimelineTurnStatus;
  textTokensEst: number | null;
  toolTokensEst: number;
}): void {
  const ratio =
    input.textTokensEst === null || input.textTokensEst === 0 ? null : input.toolTokensEst / input.textTokensEst;
  logger.info(
    {
      runId: input.runId,
      runtime: input.runtime,
      status: input.status,
      textTokensEst: input.textTokensEst,
      toolTokensEst: input.toolTokensEst,
      ratio,
    },
    'session-timeline: metricas do run (D2)',
  );
}
