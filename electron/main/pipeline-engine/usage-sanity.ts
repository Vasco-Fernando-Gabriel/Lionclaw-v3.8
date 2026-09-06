
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  getHarnessProject,
  getPipelinePhaseMetricsRows,
  mergePipelinePhaseMetricsMetadata,
} from '../db';
import { createLogger } from '../logger';

const logger = createLogger('usage-sanity');

export const USAGE_SANITY_THRESHOLD = 0.1;

export function slugifyCwd(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

interface UsageEntry {
  input: number;
  cacheRead: number;
  cacheCreation: number;
  output: number;
}

async function collectTranscriptFile(
  file: string,
  byId: Map<string, UsageEntry>,
): Promise<void> {
  let content: string;
  try {
    content = await fs.promises.readFile(file, 'utf-8');
  } catch {
    return;
  }
  let syntheticSeq = 0;
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    let rec: unknown;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (!rec || typeof rec !== 'object') continue;
    const message = (rec as Record<string, unknown>)['message'] as
      | Record<string, unknown>
      | undefined;
    const usage = message?.['usage'] as Record<string, unknown> | undefined;
    if (!usage || typeof usage !== 'object') continue;
    const num = (k: string): number =>
      typeof usage[k] === 'number' && Number.isFinite(usage[k] as number)
        ? (usage[k] as number)
        : 0;
    const rawId = message?.['id'];
    const id =
      typeof rawId === 'string' && rawId.length > 0
        ? rawId
        : `synthetic:${file}:${++syntheticSeq}`;
    const prev = byId.get(id) ?? { input: 0, cacheRead: 0, cacheCreation: 0, output: 0 };
    byId.set(id, {
      input: Math.max(prev.input, num('input_tokens')),
      cacheRead: Math.max(prev.cacheRead, num('cache_read_input_tokens')),
      cacheCreation: Math.max(prev.cacheCreation, num('cache_creation_input_tokens')),
      output: Math.max(prev.output, num('output_tokens')),
    });
  }
}

async function transcriptFilesForSession(
  projectDir: string,
  sessionId: string,
): Promise<string[]> {
  const files: string[] = [];
  const main = path.join(projectDir, `${sessionId}.jsonl`);
  try {
    await fs.promises.access(main);
    files.push(main);
  } catch {
  }
  const subagentsDir = path.join(projectDir, sessionId, 'subagents');
  try {
    for (const entry of await fs.promises.readdir(subagentsDir)) {
      if (entry.endsWith('.jsonl')) files.push(path.join(subagentsDir, entry));
    }
  } catch {
  }
  return files;
}

export interface UsageSanityOptions {
  claudeProjectsRoot?: string;
}

export interface UsageSanityWarning {
  phaseNumber: number;
  sprintIndex: number;
  dbTokens: number;
  transcriptTokens: number;
  divergencePct: number;
}

export async function runUsageSanityCheck(
  projectId: string,
  opts?: UsageSanityOptions,
): Promise<UsageSanityWarning[]> {
  const warnings: UsageSanityWarning[] = [];
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    const project = getHarnessProject(projectId);
    if (!project) return warnings;
    const rows = getPipelinePhaseMetricsRows(projectId);
    const root =
      opts?.claudeProjectsRoot ?? path.join(os.homedir(), '.claude', 'projects');

    for (const row of rows) {
      const meta = (row.metadata ?? {}) as Record<string, unknown>;
      const rawIds = meta['sessionIds'];
      const sessionIds = Array.isArray(rawIds)
        ? rawIds.filter((s): s is string => typeof s === 'string' && s.length > 0)
        : [];
      if (sessionIds.length === 0) continue;

      const cwd =
        typeof meta['cwd'] === 'string' && (meta['cwd'] as string).length > 0
          ? (meta['cwd'] as string)
          : project.projectPath;
      const projectDir = path.join(root, slugifyCwd(cwd));

      const byId = new Map<string, UsageEntry>();
      const missingSessionIds: string[] = [];
      for (const sessionId of sessionIds) {
        const files = await transcriptFilesForSession(projectDir, sessionId);
        if (files.length === 0) {
          missingSessionIds.push(sessionId);
          continue;
        }
        for (const file of files) await collectTranscriptFile(file, byId);
      }
      if (byId.size === 0) continue;

      let transcriptTokens = 0;
      for (const entry of byId.values()) {
        transcriptTokens += entry.input + entry.cacheRead + entry.cacheCreation + entry.output;
      }
      const dbTokens = row.inputTokens + row.outputTokens;

      const divergence =
        dbTokens > 0 ? (transcriptTokens - dbTokens) / dbTokens : transcriptTokens > 0 ? Infinity : 0;
      const overThreshold = Math.abs(divergence) > USAGE_SANITY_THRESHOLD;
      const partialRead = missingSessionIds.length > 0 && divergence < 0;
      if (!overThreshold || partialRead) continue;

      const divergencePct = Number.isFinite(divergence)
        ? Math.round(divergence * 1000) / 10
        : null;
      const warning: UsageSanityWarning = {
        phaseNumber: row.phaseNumber,
        sprintIndex: row.sprintIndex,
        dbTokens,
        transcriptTokens,
        divergencePct: divergencePct ?? Infinity,
      };
      warnings.push(warning);
      try {
        mergePipelinePhaseMetricsMetadata(projectId, row.phaseNumber, row.sprintIndex, {
          usageSanityWarning: {
            checkedAt: new Date().toISOString(),
            dbTokens,
            transcriptTokens,
            ...(divergencePct !== null ? { divergencePct } : {}),
            sessionCount: sessionIds.length,
            ...(missingSessionIds.length > 0 ? { missingSessionIds } : {}),
          },
        });
      } catch (err) {
        logger.warn(
          { err, projectId, phaseNumber: row.phaseNumber, sprintIndex: row.sprintIndex },
          'usage-sanity: falha ao gravar warning no metadata (ignorado)',
        );
      }
      logger.warn(
        {
          projectId,
          phaseNumber: row.phaseNumber,
          sprintIndex: row.sprintIndex,
          dbTokens,
          transcriptTokens,
          divergencePct,
        },
        'usage-sanity: divergencia >10% entre metrica persistida e transcripts',
      );
    }
  } catch (err) {
    logger.warn({ err, projectId }, 'usage-sanity: check abortado por erro (ignorado)');
  }
  return warnings;
}
