import { ipcMain } from 'electron';
import fs from 'fs';
import path from 'path';
import { createLogger } from '../logger';
import type { IpcContext } from './context';
import { withHarnessEngine } from '../pipeline-shared/ipc-helpers';
import { setProjectStatus } from '../pipeline-shared/status';
import {
  insertHarnessProject,
  updateHarnessProject,
  getHarnessProject,
  listHarnessProjects,
  deleteHarnessProject,
  getHarnessSprints,
  getHarnessRounds,
  getHarnessProjectMetrics,
} from '../db';
import { readHarnessSprintsJson } from '../harness-planner';
import {
  getLegacyHarnessSprintArtifactDir,
  resolveHarnessProjectDir,
  resolveHarnessSprintArtifactDir,
} from '../pipeline-paths';
import { getPipelineDriveCoordinator } from '../pipeline-drive-coordinator';
import { emitIPC } from '../pipeline-shared/ipc-emitter';

const logger = createLogger('ipc');

function markHarnessOperationFailed(projectId: string, err: unknown, operation: string): void {
  logger.error({ err, projectId }, `${operation} failed`);
  try {
    setProjectStatus(projectId, 'failed');
    emitIPC('harness:project-update', { projectId, status: 'failed' });
  } catch (statusErr) {
    logger.error({ statusErr, projectId }, `${operation}: falha ao marcar projeto como failed`);
  }
}

export function registerHarnessHandlers(ctx: IpcContext): void {
  const { getHarnessEngine } = ctx;

  ipcMain.handle(
    'harness:create-project',
    async (
      _event,
      data: {
        name: string;
        description?: string;
        projectPath: string;
        specText?: string;
        specFilePath?: string;
        config: {
          maxRoundsPerSprint: number;
          usePlaywright: boolean;
          evaluatorAgentId: string;
          plannerAgentId: string;
          stack: string[];
          plannerOutputFormat?: 'json' | 'markdown';
        };
      },
    ) => {
      if (!fs.existsSync(data.projectPath)) {
        return {
          error: `Caminho do projeto nao existe: ${data.projectPath}. Crie o diretorio primeiro.`,
        };
      }

      let specContent: string;
      if (data.specFilePath) {
        if (!fs.existsSync(data.specFilePath)) {
          return {
            error: `Arquivo da SPEC nao encontrado: ${data.specFilePath}`,
          };
        }
        specContent = fs.readFileSync(data.specFilePath, 'utf-8');
      } else if (data.specText) {
        specContent = data.specText;
      } else {
        return {
          error: 'Informe o caminho do arquivo da SPEC ou o conteudo da SPEC.',
        };
      }

      const project = insertHarnessProject({
        name: data.name,
        description: data.description,
        projectPath: data.projectPath,
        specPath: '',
        config: data.config,
      });

      const projectDir = resolveHarnessProjectDir(project);
      const specPath = path.join(projectDir, 'spec.md');
      fs.writeFileSync(specPath, specContent, 'utf-8');

      updateHarnessProject(project.id, { specPath });

      return { projectId: project.id };
    },
  );

  ipcMain.handle('harness:plan', (_event, projectId: string) => {
    return withHarnessEngine(getHarnessEngine, (engine) => {
      engine.plan(projectId).catch((err) => {
        markHarnessOperationFailed(projectId, err, 'Plan');
      });
    });
  });

  ipcMain.handle('harness:approve-sprints', (_event, projectId: string) => {
    setProjectStatus(projectId, 'ready');
    return withHarnessEngine(getHarnessEngine, (engine) => {
      engine.run(projectId).catch((err) => {
        markHarnessOperationFailed(projectId, err, 'Run after approval');
      });
    });
  });

  ipcMain.handle(
    'harness:regenerate-sprints',
    (_event, projectId: string, feedback: string) => {
      const project = getHarnessProject(projectId);
      if (!project) return { error: 'Projeto nao encontrado' };
      if (project.status !== 'reviewing') {
        return {
          error: `regenerate-sprints exige o projeto em 'reviewing' (atual: ${project.status})`,
        };
      }
      return withHarnessEngine(getHarnessEngine, (engine) => {
        engine.regenerate(projectId, feedback).catch((err) => {
          markHarnessOperationFailed(projectId, err, 'Regenerate');
        });
      });
    },
  );

  ipcMain.handle('harness:run', (_event, projectId: string) => {
    return withHarnessEngine(getHarnessEngine, (engine) => {
      engine.run(projectId).catch((err) => {
        markHarnessOperationFailed(projectId, err, 'Run');
      });
    });
  });

  ipcMain.handle('harness:pause', (_event, projectId: string) => {
    return withHarnessEngine(getHarnessEngine, (engine) => {
      engine.pause(projectId);
    });
  });

  ipcMain.handle('harness:resume', (_event, projectId: string, provider?: 'grok' | 'codex' | 'kimi') => {
    return withHarnessEngine(getHarnessEngine, (engine) => {
      if (provider) return engine.resumeAfterAuth(projectId, provider);
      return engine.resume(projectId);
    });
  });

  ipcMain.handle('harness:abort', (_event, projectId: string) => {
    return withHarnessEngine(getHarnessEngine, (engine) => {
      engine.abort(projectId);
    });
  });

  ipcMain.handle('harness:delete-project', (_event, projectId: string) => {
    const engine = getHarnessEngine();
    if (engine) {
      try {
        engine.abort(projectId);
      } catch {
      }
    }
    getPipelineDriveCoordinator()?.stopDrive(projectId, 'project-deleted');
    deleteHarnessProject(projectId);
    emitIPC('drive:state-changed', { projectId, drive: null });
    logger.info({ projectId }, 'Harness project deleted via IPC');
  });

  ipcMain.handle('harness:get-project', (_event, projectId: string) => {
    return getHarnessProject(projectId);
  });

  ipcMain.handle('harness:list-projects', () => {
    return listHarnessProjects();
  });

  ipcMain.handle('harness:get-sprints', (_event, projectId: string) => {
    return getHarnessSprints(projectId);
  });

  ipcMain.handle('harness:get-rounds', (_event, sprintId: string) => {
    return getHarnessRounds(sprintId);
  });

  ipcMain.handle(
    'harness:get-evaluation',
    (_event, projectId: string, sprintId: string) => {
      const project = getHarnessProject(projectId);
      if (!project) return null;
      const evalPath = path.join(
        resolveHarnessSprintArtifactDir(project, sprintId),
        'evaluation.json',
      );
      const legacyEvalPath = path.join(
        getLegacyHarnessSprintArtifactDir(projectId, sprintId),
        'evaluation.json',
      );
      const resolvedPath = fs.existsSync(evalPath) ? evalPath : legacyEvalPath;
      try {
        const content = fs.readFileSync(resolvedPath, 'utf-8');
        return JSON.parse(content);
      } catch {
        return null;
      }
    },
  );

  ipcMain.handle(
    'harness:get-sprint-json',
    (_event, projectId: string, sprintJsonId: string) => {
      const project = getHarnessProject(projectId);
      if (!project) return null;
      const sprintsJson = readHarnessSprintsJson(project);
      if (!sprintsJson) return null;
      const sprint = sprintsJson.sprints.find(
        (s: { id: string }) => s.id === sprintJsonId,
      );
      return sprint ?? null;
    },
  );

  ipcMain.handle('harness:get-sprints-json', (_event, projectId: string) => {
    const project = getHarnessProject(projectId);
    if (!project) return null;
    return readHarnessSprintsJson(project);
  });

  ipcMain.handle('harness:get-metrics', (_event, projectId: string) => {
    return getHarnessProjectMetrics(projectId);
  });

  ipcMain.handle(
    'harness:get-stream-log',
    (_event, projectId: string, sprintId: string) => {
      const engine = getHarnessEngine();
      if (!engine) return { coder: [], evaluator: [], round: 0 };
      return engine.getLatestStreamLogs(projectId, sprintId);
    },
  );

  ipcMain.handle(
    'harness:get-feedback-audit',
    (_event, projectId: string, sprintId: string) => {
      const project = getHarnessProject(projectId);
      if (!project) return [];
      const filePath = path.join(
        resolveHarnessSprintArtifactDir(project, sprintId),
        'feedback-audit.jsonl',
      );
      const legacyFilePath = path.join(
        getLegacyHarnessSprintArtifactDir(projectId, sprintId),
        'feedback-audit.jsonl',
      );
      const resolvedPath = fs.existsSync(filePath) ? filePath : legacyFilePath;
      if (!fs.existsSync(resolvedPath)) return [];
      try {
        return fs
          .readFileSync(resolvedPath, 'utf-8')
          .split('\n')
          .filter((line) => line.trim())
          .map((line) => JSON.parse(line));
      } catch {
        return [];
      }
    },
  );
}
