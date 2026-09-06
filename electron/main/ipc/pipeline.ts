import { ipcMain, shell } from 'electron';
import fs from 'fs';
import path from 'path';
import { createLogger } from '../logger';
import type { IpcContext } from './context';
import {
  acquireProjectLock,
  ensureProjectLock,
  releaseProjectLock,
} from '../pipeline-shared/lock';
import { withPipelineEngine } from '../pipeline-shared/ipc-helpers';
import { pipelineEventBus } from '../pipeline-event-bus';
import { mapPipelineProject } from '../pipeline-shared/project-mapper';
import {
  getHarnessProject,
  listHarnessProjects,
  getSecurityAgentStatuses,
  getAuditAgentsState,
  deleteHarnessProject,
  getHarnessSprints,
  getHarnessSprintAggregateMetrics,
  getHarnessSprintByIndex,
  getPipelinePhaseMessages,
  listPipelineMessagesForSprint,
  getPipelineMetrics,
  getSecuritySummaryJson,
  getBugAnalysisAgentsState,
} from '../db';
import { createPipelineProject } from '../pipeline-create';
import { conversationPhasesOf, getPhaseNumberForAgent } from '../../../src/types/pipeline';
import type { PipelineConversationPhases } from '../../../src/types';
import {
  generatePipelineReport,
  exportReport as exportPipelineReport,
} from '../pipeline-report';
import {
  findConsolidatedSecurityReport,
  findHarnessSprintsReadPath,
  findPipelineDocReadPath,
  getPipelineDocsContext,
  resolveOpenDesignPromptPath,
} from '../pipeline-paths';
import { getArchitectureReviewContext } from '../architecture-review-paths';
import {
  BUG_PHASE2_SECTIONS,
  getBugContext,
  resolveBugPhaseDocument,
} from '../bug-paths';
import { getPipelineDriveCoordinator } from '../pipeline-drive-coordinator';
import { emitIPC } from '../pipeline-shared/ipc-emitter';

const logger = createLogger('ipc');


function concatBugPhase2Analyses(paths: string[]): { content: string; anyPresent: boolean } {
  let anyPresent = false;
  const blocks = BUG_PHASE2_SECTIONS.map((section, i) => {
    const p = paths[i] ?? '';
    let body: string;
    if (p && fs.existsSync(p)) {
      anyPresent = true;
      try {
        body = fs.readFileSync(p, 'utf-8');
      } catch {
        body = `_Analise nao disponivel: ${p}_`;
      }
    } else {
      body = `_Analise nao disponivel: ${p}_`;
    }
    return `${section.heading}\n\n${body}`;
  });
  return {
    content: `# Analises paralelas do bug\n\n${blocks.join('\n\n')}`,
    anyPresent,
  };
}


type SecurityArtifact =
  | { type: 'markdown'; content: string }
  | { type: 'sprints'; sprints: ReturnType<typeof getHarnessSprints> };

function readSecurityPhaseArtifact(
  project: {
    projectPath: string;
    specPath?: string;
    id: string;
    pipelineDocsId?: string | null;
  },
  phase: number,
): SecurityArtifact | null {
  const projectPath = project.projectPath;
  if (!projectPath) return { type: 'markdown' as const, content: '' };

  if (phase === 1) {
    const manifestPath = path.join(projectPath, '.lionclaw', 'manifest.json');
    return {
      type: 'markdown' as const,
      content: renderManifestAsMarkdown(manifestPath),
    };
  }

  if (phase === 2 || phase === 3) {
    const reportPath = findConsolidatedSecurityReport(
      projectPath,
      project.pipelineDocsId ?? null,
    );
    if (!reportPath) return { type: 'markdown' as const, content: '' };
    try {
      return {
        type: 'markdown' as const,
        content: fs.readFileSync(reportPath, 'utf-8'),
      };
    } catch {
      return { type: 'markdown' as const, content: '' };
    }
  }

  if (phase === 6) {
    const specPath = findPipelineDocReadPath(
      projectPath,
      project.pipelineDocsId ?? null,
      'SPEC.md',
      'SPEC.md',
      project.specPath,
    );
    if (!specPath) return { type: 'markdown' as const, content: '' };
    try {
      return {
        type: 'markdown' as const,
        content: fs.readFileSync(specPath, 'utf-8'),
      };
    } catch {
      return { type: 'markdown' as const, content: '' };
    }
  }

  if (phase === 8) {
    return { type: 'sprints' as const, sprints: getHarnessSprints(project.id) };
  }

  return null;
}

function renderManifestAsMarkdown(manifestPath: string): string {
  let raw: string;
  try {
    raw = fs.readFileSync(manifestPath, 'utf-8');
  } catch {
    return '';
  }

  let manifest: {
    language?: string;
    framework?: string;
    scannedAt?: string;
    totalFiles?: number;
    classifiedFiles?: number;
    ignoredDirs?: string[];
    filesByRole?: Record<string, string[]>;
    previousScan?: string | null;
  };
  try {
    manifest = JSON.parse(raw);
  } catch {
    return '';
  }

  const lines: string[] = [];
  lines.push('# Repo Profiler');
  lines.push('');

  const language = manifest.language ?? 'desconhecida';
  const framework =
    manifest.framework &&
    manifest.framework !== 'unknown' &&
    manifest.framework !== manifest.language
      ? ` + ${manifest.framework}`
      : '';
  lines.push(`**Stack detectada:** ${language}${framework}`);

  if (manifest.scannedAt) {
    lines.push(`**Escaneado em:** ${manifest.scannedAt}`);
  }
  lines.push('');

  lines.push('## Totais');
  lines.push(`- Arquivos encontrados: **${manifest.totalFiles ?? 0}**`);
  lines.push(`- Arquivos classificados: **${manifest.classifiedFiles ?? 0}**`);
  lines.push('');

  const filesByRole = manifest.filesByRole ?? {};
  const roleEntries = Object.entries(filesByRole)
    .map(([role, files]) => ({
      role,
      count: Array.isArray(files) ? files.length : 0,
    }))
    .filter((e) => e.count > 0)
    .sort((a, b) => b.count - a.count);

  if (roleEntries.length > 0) {
    lines.push('## Classificacao por role');
    lines.push('');
    lines.push('| Role | Arquivos |');
    lines.push('| --- | ---: |');
    for (const { role, count } of roleEntries) {
      lines.push(`| ${role} | ${count} |`);
    }
    lines.push('');
  }

  if (Array.isArray(manifest.ignoredDirs) && manifest.ignoredDirs.length > 0) {
    lines.push(`**Diretorios ignorados:** ${manifest.ignoredDirs.join(', ')}`);
    lines.push('');
  }

  if (manifest.previousScan) {
    lines.push(
      `**Scan anterior:** \`${path.basename(manifest.previousScan)}\``,
    );
    lines.push('');
  }

  return lines.join('\n');
}

export function registerPipelineHandlers(ctx: IpcContext): void {
  const { getPipelineEngine } = ctx;


  ipcMain.handle(
    'pipeline:start',
    async (_event, projectId: string, startPhase: number) => {
      const engine = getPipelineEngine();
      if (!engine) return { error: 'PipelineEngine nao inicializado' };
      const lockResult = acquireProjectLock(projectId, 'pipeline-engine');
      if (!lockResult.ok) {
        logger.warn(
          { projectId, runningSince: lockResult.runningPipeline.acquiredAt },
          'pipeline:start blocked — pipeline ja rodando neste projeto',
        );
        return { error: 'Pipeline ja rodando neste projeto' };
      }
      try {
        const result = await engine.startPipeline(projectId, startPhase);
        if (result && typeof result === 'object' && 'error' in result) {
          releaseProjectLock(projectId);
          logger.warn(
            { projectId, error: result.error },
            'pipeline:start returned error',
          );
          return { error: result.error };
        }
        return { ok: true as const };
      } catch (err) {
        releaseProjectLock(projectId);
        logger.error({ err, projectId }, 'pipeline:start failed');
        return { error: (err as Error).message };
      }
    },
  );

  ipcMain.handle('pipeline:advance', async (_event, projectId: string) => {
    const engine = getPipelineEngine();
    if (!engine) return { error: 'PipelineEngine nao inicializado' };
    ensureProjectLock(projectId, 'pipeline-engine');
    return withPipelineEngine(getPipelineEngine, async (e) => {
      await e.advancePhase(projectId);
      return { ok: true as const };
    });
  });

  ipcMain.handle('pipeline:abort', (_event, projectId: string) => {
    return withPipelineEngine(getPipelineEngine, (e) => {
      e.abortPipeline(projectId);
      return { ok: true as const };
    });
  });

  ipcMain.handle('pipeline:pause', (_event, projectId: string) => {
    return withPipelineEngine(getPipelineEngine, (e) => {
      e.pausePipeline(projectId);
      return { ok: true as const };
    });
  });

  ipcMain.handle('pipeline:resume', async (_event, projectId: string) => {
    const engine = getPipelineEngine();
    if (!engine) return { error: 'PipelineEngine nao inicializado' };
    ensureProjectLock(projectId, 'pipeline-engine');
    return withPipelineEngine(getPipelineEngine, async (e) => {
      await e.resumePipeline(projectId);
      return { ok: true as const };
    });
  });

  ipcMain.handle(
    'pipeline:send',
    async (
      _event,
      projectId: string,
      message: string,
      attachments?: Array<{
        id: string;
        type: string;
        filename: string;
        mimeType: string;
        data: string;
        size: number;
      }>,
    ) => {
      ensureProjectLock(projectId, 'pipeline-engine');
      pipelineEventBus.emit('pipeline:human-message', { projectId, content: message });
      return withPipelineEngine(getPipelineEngine, async (e) => {
        await e.sendMessage(projectId, message, attachments);
        return { ok: true as const };
      });
    },
  );

  ipcMain.handle(
    'pipeline:resume-after-auth',
    async (_event, projectId: string, provider?: 'codex' | 'grok' | 'kimi') => {
      const engine = getPipelineEngine();
      if (!engine)
        return { ok: false, message: 'PipelineEngine nao inicializado' };
      ensureProjectLock(projectId, 'pipeline-engine');
      try {
        return await engine.resumeAfterAuth(projectId, provider);
      } catch (err) {
        logger.error({ err, projectId }, 'pipeline:resume-after-auth failed');
        return { ok: false, message: (err as Error).message };
      }
    },
  );

  ipcMain.handle('pipeline:get-conversation-phases', (): PipelineConversationPhases => {
    return {
      security: Array.from(conversationPhasesOf('security')),
      dev: Array.from(conversationPhasesOf('development')),
      feature: Array.from(conversationPhasesOf('feature')),
      architecture: Array.from(conversationPhasesOf('architecture-review')),
      developmentV2: Array.from(conversationPhasesOf('development-v2')),
      bug: Array.from(conversationPhasesOf('bug')),
    };
  });

  ipcMain.handle(
    'pipeline:approve',
    async (_event, projectId: string, metadata?: Record<string, unknown>) => {
      ensureProjectLock(projectId, 'pipeline-engine');
      return withPipelineEngine(getPipelineEngine, async (e) => {
        await e.approvePhase(projectId, metadata);
        return { ok: true as const };
      });
    },
  );

  ipcMain.handle('pipeline:metrics', (_event, projectId: string) => {
    try {
      return getPipelineMetrics(projectId);
    } catch (err) {
      logger.error({ err, projectId }, 'pipeline:metrics failed');
      return { error: (err as Error).message };
    }
  });

  ipcMain.handle('pipeline:report', (_event, projectId: string) => {
    try {
      return { report: generatePipelineReport(projectId) };
    } catch (err) {
      logger.error({ err, projectId }, 'pipeline:report failed');
      return { error: (err as Error).message };
    }
  });

  ipcMain.handle(
    'pipeline:export-report',
    (_event, projectId: string, format: 'md') => {
      try {
        const reportPath = exportPipelineReport(projectId, format);
        return { ok: true as const, reportPath };
      } catch (err) {
        logger.error({ err, projectId }, 'pipeline:export-report failed');
        return { error: (err as Error).message };
      }
    },
  );

  ipcMain.handle(
    'pipeline:open-project-file',
    async (_event, args: { projectId: string; relativePath: string }) => {
      try {
        if (!args?.projectId || typeof args.relativePath !== 'string') {
          return { error: 'projectId e relativePath obrigatorios' };
        }
        const project = getHarnessProject(args.projectId);
        if (!project) return { error: 'Projeto nao encontrado' };
        const projectRoot = path.resolve(project.projectPath);
        const resolved = path.resolve(projectRoot, args.relativePath);
        if (
          resolved !== projectRoot &&
          !resolved.startsWith(projectRoot + path.sep)
        ) {
          return { error: 'Path fora do diretorio do projeto' };
        }
        if (!fs.existsSync(resolved)) {
          return { error: 'Arquivo nao encontrado' };
        }
        shell.showItemInFolder(resolved);
        return { ok: true as const };
      } catch (err) {
        logger.error({ err, args }, 'pipeline:open-project-file failed');
        return { error: (err as Error).message };
      }
    },
  );

  ipcMain.handle(
    'pipeline:open-smoke-test',
    async (_event, projectId: string) => {
      try {
        const project = getHarnessProject(projectId);
        if (!project) return { error: 'Projeto nao encontrado' };
        const docsCtx = getPipelineDocsContext(
          project.projectPath,
          project.pipelineDocsId ?? null,
        );
        const reportPath = docsCtx
          ? docsCtx.resolveDocPath('smoke-test.md')
          : path.join(project.projectPath, 'smoke-test.md');
        const resolved = path.resolve(reportPath);
        if (!fs.existsSync(resolved)) {
          return { error: 'Smoke test report nao existe ainda' };
        }
        const projectRoot = path.resolve(project.projectPath);
        if (
          resolved !== projectRoot &&
          !resolved.startsWith(projectRoot + path.sep)
        ) {
          return { error: 'Path fora do diretorio do projeto' };
        }
        shell.showItemInFolder(resolved);
        return { ok: true as const };
      } catch (err) {
        logger.error({ err, projectId }, 'pipeline:open-smoke-test failed');
        return { error: (err as Error).message };
      }
    },
  );

  ipcMain.handle(
    'pipeline:get-smoke-test-path',
    async (_event, projectId: string) => {
      try {
        const project = getHarnessProject(projectId);
        if (!project) return { exists: false as const };
        const docsCtx = getPipelineDocsContext(
          project.projectPath,
          project.pipelineDocsId ?? null,
        );
        const reportPath = docsCtx
          ? docsCtx.resolveDocPath('smoke-test.md')
          : path.join(project.projectPath, 'smoke-test.md');
        const resolved = path.resolve(reportPath);
        return { exists: fs.existsSync(resolved), path: resolved };
      } catch (err) {
        logger.warn({ err, projectId }, 'pipeline:get-smoke-test-path failed');
        return { exists: false as const };
      }
    },
  );

  ipcMain.handle(
    'pipeline:decided',
    async (_event, projectId: string, blockId: string) => {
      ensureProjectLock(projectId, 'pipeline-engine');
      return withPipelineEngine(getPipelineEngine, async (e) => {
        await e.approvePhase(projectId, { blockId });
        return { ok: true as const };
      });
    },
  );

  ipcMain.handle('pipeline:conclude', async (_event, projectId: string) => {
    ensureProjectLock(projectId, 'pipeline-engine');
    return withPipelineEngine(getPipelineEngine, async (e) => {
      await e.approvePhase(projectId);
      return { ok: true as const };
    });
  });

  ipcMain.handle(
    'pipeline:confirm-development',
    async (_event, projectId: string) => {
      ensureProjectLock(projectId, 'pipeline-engine');
      return withPipelineEngine(getPipelineEngine, async (e) => {
        await e.confirmStartDevelopment(projectId);
        return { ok: true as const };
      });
    },
  );

  ipcMain.handle('pipeline:retry', async (_event, projectId: string) => {
    const engine = getPipelineEngine();
    if (!engine) return { error: 'PipelineEngine nao inicializado' };
    ensureProjectLock(projectId, 'pipeline-engine');
    try {
      const project = getHarnessProject(projectId);
      if (!project) return { error: 'Project not found' };
      const phase =
        project.pipelineCurrentPhase ?? project.pipelineStartPhase ?? 1;
      await engine.startPipeline(projectId, phase);
      return { ok: true as const };
    } catch (err) {
      logger.error({ err, projectId }, 'pipeline:retry failed');
      return { error: (err as Error).message };
    }
  });

  ipcMain.handle('pipeline:list-projects', () => {
    try {
      const projects = listHarnessProjects();
      return projects.map((p) => {
        const secSummary =
          p.pipelineType === 'security' ? getSecuritySummaryJson(p.id) : null;
        const bugOutcome =
          p.pipelineType === 'bug' ? p.config?.bug?.outcome : undefined;
        return {
          ...mapPipelineProject(p),
          metadata: {
            startPhase: p.pipelineStartPhase ?? 1,
            totalSprints: p.totalSprints > 0 ? p.totalSprints : null,
            totalFeatures: p.totalFeatures > 0 ? p.totalFeatures : null,
            currentSprintIndex: p.pipelineSprintIndex ?? null,
            totalSprintsCount: p.totalSprints > 0 ? p.totalSprints : null,
            ...(secSummary !== null ? { securitySummary: secSummary } : {}),
            ...(bugOutcome ? { bugOutcome } : {}),
          },
        };
      });
    } catch (err) {
      logger.error({ err }, 'pipeline:list-projects failed');
      return [];
    }
  });

  ipcMain.handle(
    'pipeline:create-project',
    async (
      _event,
      data: {
        name: string;
        description: string;
        projectPath: string;
        startPhase: number;
        specPath?: string;
        prdPath?: string;
        pipelineType?:
          | 'development'
          | 'development-v2'
          | 'security'
          | 'feature'
          | 'architecture-review'
          | 'bug';
      },
    ) => {
      try {
        const project = createPipelineProject({
          name: data.name,
          description: data.description,
          projectPath: data.projectPath,
          startPhase: data.startPhase,
          specPath: data.specPath,
          prdPath: data.prdPath,
          pipelineType: data.pipelineType,
        });
        return { id: project.id };
      } catch (err) {
        logger.error({ err, data }, 'pipeline:create-project failed');
        return { error: (err as Error).message };
      }
    },
  );

  ipcMain.handle(
    'pipeline:delete-project',
    async (_event, projectId: string) => {
      try {
        getPipelineDriveCoordinator()?.stopDrive(projectId, 'project-deleted');
        deleteHarnessProject(projectId);
        emitIPC('drive:state-changed', { projectId, drive: null });
        return { ok: true as const };
      } catch (err) {
        logger.error({ err, projectId }, 'pipeline:delete-project failed');
        return { error: (err as Error).message };
      }
    },
  );

  ipcMain.handle('pipeline:get-project', (_event, projectId: string) => {
    try {
      const p = getHarnessProject(projectId);
      if (!p) return { error: 'Project not found' };
      const sprints = getHarnessSprints(projectId);
      const base = mapPipelineProject(p);

      const conversationSet = conversationPhasesOf(p.pipelineType);

      const awaitingUser =
        base.currentPhase !== null &&
        conversationSet.has(base.currentPhase) &&
        p.status !== 'done' &&
        p.status !== 'failed';

      const secSummary =
        p.pipelineType === 'security'
          ? getSecuritySummaryJson(projectId)
          : null;

      const bugOutcome =
        p.pipelineType === 'bug' ? p.config?.bug?.outcome : undefined;
      const metadata: Record<string, unknown> = {
        ...(secSummary !== null ? { securitySummary: secSummary } : {}),
        ...(bugOutcome ? { bugOutcome } : {}),
      };

      return {
        ...base,
        awaitingUser,
        ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
        sprints: sprints.map((s) => ({
          index: s.sprintIndex,
          name: s.name,
          status: s.verdict ?? s.status,
          coderAgentId: s.coderAgentId,
          evaluatorAgentId: s.evaluatorAgentId,
          sprintJsonId: s.sprintJsonId,
          sprintId: s.id,
          rounds: s.roundsUsed,
          metrics: getHarnessSprintAggregateMetrics(s.id),
        })),
      };
    } catch (err) {
      logger.error({ err, projectId }, 'pipeline:get-project failed');
      return { error: (err as Error).message };
    }
  });

  ipcMain.handle(
    'pipeline:get-security-agent-status',
    (_event, projectId: string) => {
      try {
        return getSecurityAgentStatuses(projectId);
      } catch (err) {
        logger.error(
          { err, projectId },
          'pipeline:get-security-agent-status failed',
        );
        return [];
      }
    },
  );

  ipcMain.handle(
    'pipeline:get-audit-agents-state',
    (_event, projectId: string) => {
      try {
        if (!projectId) return { error: 'projectId obrigatorio' };
        const project = getHarnessProject(projectId);
        if (project?.pipelineType === 'bug') {
          const runId = project.config?.bug?.runId;
          if (!runId) return { agents: [] };
          return { agents: getBugAnalysisAgentsState(projectId, runId) };
        }
        return { agents: getAuditAgentsState(projectId) };
      } catch (err) {
        logger.error(
          { err, projectId },
          'pipeline:get-audit-agents-state failed',
        );
        return { error: (err as Error).message };
      }
    },
  );

  ipcMain.handle('pipeline:read-manifest', (_event, projectId: string) => {
    try {
      const project = getHarnessProject(projectId);
      if (
        !project ||
        project.pipelineType !== 'security' ||
        !project.projectPath
      )
        return null;
      const manifestPath = path.join(
        project.projectPath,
        '.lionclaw',
        'manifest.json',
      );
      if (!fs.existsSync(manifestPath)) return null;
      const raw = fs.readFileSync(manifestPath, 'utf-8');
      return JSON.parse(raw);
    } catch (err) {
      logger.error({ err, projectId }, 'pipeline:read-manifest failed');
      return null;
    }
  });

  ipcMain.handle(
    'pipeline:get-phase-messages',
    (_event, projectId: string, phase: number) => {
      try {
        return getPipelinePhaseMessages(projectId, phase);
      } catch (err) {
        logger.error(
          { err, projectId, phase },
          'pipeline:get-phase-messages failed',
        );
        return [];
      }
    },
  );

  ipcMain.handle(
    'pipeline:read-phase-document',
    (_event, projectId: string, phase: number) => {
      try {
        const project = getHarnessProject(projectId);
        if (!project) return { error: 'Project not found' };

        if (project.pipelineType === 'bug') {
          const doc = resolveBugPhaseDocument(project, phase);
          if (doc === null) {
            return { error: `Nenhum documento disponivel para a Fase ${phase}` };
          }
          if (Array.isArray(doc)) {
            const bugCtx = getBugContext(project);
            const { content, anyPresent } = concatBugPhase2Analyses(doc);
            if (!anyPresent) {
              return { error: 'Nenhum documento disponivel para a Fase 2' };
            }
            return { path: bugCtx?.runDir ?? '', content };
          }
          if (!fs.existsSync(doc)) {
            return { error: `Arquivo nao encontrado: ${doc}` };
          }
          return { path: doc, content: fs.readFileSync(doc, 'utf-8') };
        }

        let filePath: string | null = null;
        if (project.pipelineType === 'development-v2') {
          if (phase === 4 || phase === 5) {
            filePath = resolveOpenDesignPromptPath(
              project.projectPath,
              project.pipelineDocsId ?? null,
            );
          } else if (phase === 1) {
            filePath = findPipelineDocReadPath(
              project.projectPath,
              project.pipelineDocsId ?? null,
              'discovery.md',
              'discovery-notes.md',
              project.discoveryNotesPath,
            );
          } else if (phase === 2 || phase === 3) {
            filePath = findPipelineDocReadPath(
              project.projectPath,
              project.pipelineDocsId ?? null,
              'stories-requisitos.md',
              'stories-requisitos.md',
            );
          } else if (phase >= 7 && phase <= 11) {
            filePath = findPipelineDocReadPath(
              project.projectPath,
              project.pipelineDocsId ?? null,
              'PRD.md',
              'PRD.md',
              project.prdPath,
            );
          } else if (phase === 12 || phase === 13) {
            filePath = findPipelineDocReadPath(
              project.projectPath,
              project.pipelineDocsId ?? null,
              'SPEC.md',
              'SPEC.md',
              project.specPath,
            );
          } else if (phase >= 14 && phase <= 17) {
            filePath = findHarnessSprintsReadPath(project);
          }
        } else if (phase === 1) {
          filePath = findPipelineDocReadPath(
            project.projectPath,
            project.pipelineDocsId ?? null,
            'discovery.md',
            'discovery-notes.md',
            project.discoveryNotesPath,
          );
        } else if (phase === 2 || phase === 3) {
          filePath = findPipelineDocReadPath(
            project.projectPath,
            project.pipelineDocsId ?? null,
            'stories-requisitos.md',
            'stories-requisitos.md',
          );
        } else if (
          phase === 4 ||
          phase === 5 ||
          phase === 6 ||
          phase === 7 ||
          phase === 8
        ) {
          filePath = findPipelineDocReadPath(
            project.projectPath,
            project.pipelineDocsId ?? null,
            'PRD.md',
            'PRD.md',
            project.prdPath,
          );
        } else if (phase === 9 || phase === 10) {
          filePath = findPipelineDocReadPath(
            project.projectPath,
            project.pipelineDocsId ?? null,
            'SPEC.md',
            'SPEC.md',
            project.specPath,
          );
        } else if (
          phase === 11 ||
          phase === 12 ||
          phase === 13 ||
          phase === 14
        ) {
          filePath = findHarnessSprintsReadPath(project);
        }

        if (!filePath) {
          return { error: `Nenhum documento disponivel para a Fase ${phase}` };
        }
        if (!fs.existsSync(filePath)) {
          return { error: `Arquivo nao encontrado: ${filePath}` };
        }

        const content = fs.readFileSync(filePath, 'utf-8');
        return { path: filePath, content };
      } catch (err) {
        logger.error(
          { err, projectId, phase },
          'pipeline:read-phase-document failed',
        );
        return { error: (err as Error).message };
      }
    },
  );


  ipcMain.handle(
    'pipeline:reset-phase',
    async (_event, projectId: string, phase: number) => {
      const engine = getPipelineEngine();
      if (!engine) return { error: 'PipelineEngine nao inicializado' };
      ensureProjectLock(projectId, 'pipeline-engine');
      try {
        return await engine.resetPhase(projectId, phase);
      } catch (err) {
        logger.error({ err, projectId, phase }, 'pipeline:reset-phase failed');
        return { ok: false, error: (err as Error).message };
      }
    },
  );

  ipcMain.handle(
    'pipeline:reset-sprint',
    async (_event, projectId: string, sprintIndex: number) => {
      const engine = getPipelineEngine();
      if (!engine) return { error: 'PipelineEngine nao inicializado' };
      ensureProjectLock(projectId, 'pipeline-engine');
      try {
        return await engine.resetSprint(projectId, sprintIndex);
      } catch (err) {
        logger.error(
          { err, projectId, sprintIndex },
          'pipeline:reset-sprint failed',
        );
        return { ok: false, error: (err as Error).message };
      }
    },
  );

  ipcMain.handle(
    'pipeline:get-reset-preview',
    (
      _event,
      projectId: string,
      target: { phase?: number; sprintIndex?: number },
    ) => {
      const engine = getPipelineEngine();
      if (!engine)
        return {
          filesToDelete: [],
          messagesToDelete: 0,
          metricsToDelete: 0,
          sprintsAffected: [],
        };
      try {
        return engine.getResetPreview(projectId, target);
      } catch (err) {
        logger.error(
          { err, projectId, target },
          'pipeline:get-reset-preview failed',
        );
        return {
          filesToDelete: [],
          messagesToDelete: 0,
          metricsToDelete: 0,
          sprintsAffected: [],
        };
      }
    },
  );

  ipcMain.handle(
    'pipeline:read-phase-artifact',
    (_event, projectId: string, phase: number) => {
      try {
        const project = getHarnessProject(projectId);
        if (!project) return { error: 'Project not found' };

        if (project.pipelineType === 'security') {
          const result = readSecurityPhaseArtifact(project, phase);
          if (result !== null) return result;
          return { type: 'markdown' as const, content: '' };
        }

        if (project.pipelineType === 'architecture-review') {
          if (phase === 8) {
            const sprints = getHarnessSprints(projectId);
            return { type: 'sprints' as const, sprints };
          }
          const ctx = getArchitectureReviewContext(project);
          if (!ctx) return { type: 'markdown' as const, content: '' };
          const stems: Record<
            number,
            { md: string; json: string } | undefined
          > = {
            1: { md: ctx.mapMdPath, json: ctx.mapJsonPath },
            2: { md: ctx.candidatesMdPath, json: ctx.candidatesJsonPath },
            3: { md: ctx.diagnosisMdPath, json: ctx.diagnosisJsonPath },
            4: { md: ctx.decisionsMdPath, json: ctx.decisionsJsonPath },
            5: { md: ctx.specPath, json: '' },
            6: { md: ctx.specPath, json: '' },
            7: { md: ctx.specPath, json: '' },
          };
          const paths = stems[phase];
          if (!paths) return { type: 'markdown' as const, content: '' };
          const safeRead = (p: string): string | null => {
            if (!p || !fs.existsSync(p)) return null;
            try {
              return fs.readFileSync(p, 'utf-8');
            } catch {
              return null;
            }
          };
          return {
            type: 'architecture' as const,
            phase,
            markdown: safeRead(paths.md),
            json: safeRead(paths.json),
          };
        }

        if (project.pipelineType === 'bug') {
          if (phase === getPhaseNumberForAgent('bug', 'harness-planner')) {
            const sprints = getHarnessSprints(projectId);
            return { type: 'sprints' as const, sprints };
          }
          const doc = resolveBugPhaseDocument(project, phase);
          if (doc === null) return { type: 'markdown' as const, content: '' };
          if (Array.isArray(doc)) {
            const { content } = concatBugPhase2Analyses(doc);
            return { type: 'markdown' as const, content };
          }
          if (!fs.existsSync(doc)) return { type: 'markdown' as const, content: '' };
          let bugContent = '';
          try {
            bugContent = fs.readFileSync(doc, 'utf-8');
          } catch {
          }
          return { type: 'markdown' as const, content: bugContent };
        }

        if (project.pipelineType === 'development-v2') {
          if (phase === 14) {
            const sprints = getHarnessSprints(projectId);
            return { type: 'sprints' as const, sprints };
          }
          let filePath: string | null = null;
          if (phase === 4 || phase === 5) {
            filePath = resolveOpenDesignPromptPath(
              project.projectPath,
              project.pipelineDocsId ?? null,
            );
          } else if (phase === 2) {
            filePath = findPipelineDocReadPath(
              project.projectPath,
              project.pipelineDocsId ?? null,
              'stories-requisitos.md',
              'stories-requisitos.md',
            );
          } else if (phase === 7) {
            filePath = findPipelineDocReadPath(
              project.projectPath,
              project.pipelineDocsId ?? null,
              'PRD.md',
              'PRD.md',
              project.prdPath,
            );
          } else if (phase === 12) {
            filePath = findPipelineDocReadPath(
              project.projectPath,
              project.pipelineDocsId ?? null,
              'SPEC.md',
              'SPEC.md',
              project.specPath,
            );
          }
          if (!filePath) return { type: 'markdown' as const, content: '' };
          let content = '';
          try {
            content = fs.readFileSync(filePath, 'utf-8');
          } catch {
          }
          return { type: 'markdown' as const, content };
        }

        if (phase === 11) {
          const sprints = getHarnessSprints(projectId);
          return { type: 'sprints' as const, sprints };
        }

        let filePath: string | null = null;
        if (phase === 2) {
          filePath = findPipelineDocReadPath(
            project.projectPath,
            project.pipelineDocsId ?? null,
            'stories-requisitos.md',
            'stories-requisitos.md',
          );
        } else if (phase === 4) {
          filePath = findPipelineDocReadPath(
            project.projectPath,
            project.pipelineDocsId ?? null,
            'PRD.md',
            'PRD.md',
            project.prdPath,
          );
        } else if (phase === 9) {
          filePath = findPipelineDocReadPath(
            project.projectPath,
            project.pipelineDocsId ?? null,
            'SPEC.md',
            'SPEC.md',
            project.specPath,
          );
        }

        if (!filePath) return { type: 'markdown' as const, content: '' };

        let content = '';
        try {
          content = fs.readFileSync(filePath, 'utf-8');
        } catch {
        }
        return { type: 'markdown' as const, content };
      } catch (err) {
        logger.error(
          { err, projectId, phase },
          'pipeline:read-phase-artifact failed',
        );
        return { type: 'markdown' as const, content: '' };
      }
    },
  );

  ipcMain.handle(
    'pipeline:get-sprint-history',
    (_event, projectId: string, sprintIndex: number) => {
      try {
        return listPipelineMessagesForSprint(projectId, sprintIndex);
      } catch (err) {
        logger.error(
          { err, projectId, sprintIndex },
          'pipeline:get-sprint-history failed',
        );
        return [];
      }
    },
  );

  ipcMain.handle('pipeline:list-sprints', (_event, projectId: string) => {
    try {
      return getHarnessSprints(projectId);
    } catch (err) {
      logger.error({ err, projectId }, 'pipeline:list-sprints failed');
      return [];
    }
  });

  ipcMain.handle(
    'pipeline:get-sprint-detail',
    (_event, projectId: string, sprintIndex: number) => {
      try {
        const sprint = getHarnessSprintByIndex(projectId, sprintIndex);
        if (!sprint) return { error: 'Sprint not found' };
        return { sprint };
      } catch (err) {
        logger.error({ err }, 'pipeline:get-sprint-detail error');
        return { error: String(err) };
      }
    },
  );
}
