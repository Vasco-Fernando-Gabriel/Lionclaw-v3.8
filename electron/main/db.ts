import type { SwarmRunSummary, SwarmRunStatus } from '../../src/types/swarm';
import { applyMigrationV153 } from './db-migrations/v153-swarm';
import { applyMigrationV154 } from './db-migrations/v154-kanban-external-actor';
import { applyMigrationV155 } from './db-migrations/v155-session-timeline';
import { applyMigrationV156 } from './db-migrations/v156-drive-session-column';
import { applyMigrationV157 } from './db-migrations/v157-opus-5-5-orchestrator-default';
import { applyMigrationV158 } from './db-migrations/v158-gpt6-sol-codex-default';
import { applyMigrationV159 } from './db-migrations/v159-subagents-follow-opus-5-5';
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { createLogger } from './logger';
import { loadSqliteVecForRuntime } from './sqlite-vec-runtime';
import { textProbe } from './pipeline-shared/text-probe';
import { getLionClawHome } from './paths';
import { ALL_SESSIONS_SQL } from './sessions-query';
import { DatabaseInitError, DatabaseIntegrityError, DatabaseSchemaRepairError, MigrationError } from './db-init-error';
import {
  assertDatabaseIntegrity,
  clearMigrationInProgressMarker,
  LATEST_SCHEMA_VERSION,
  prepareDatabaseForMigrations,
} from './db-migration-safety';
import { migrateLegacyHarnessSprintsJsonFile } from './pipeline-paths';
import { acquireDriveLock } from './drive-lock';
import { DriveRebindRefusedError, getDriveRebindRuntimeSync } from './drive-rebind-sync';
import { harnessPlanner, harnessCoder, harnessEvaluator, skillCreator } from './seed-agents';
import { applyMigrationV50 } from './db-migrations/v50-prompts';
import { applyMigrationV53 } from './db-migrations/v53-architecture-review';
import { applyMigrationV54 } from './db-migrations/v54-triage-meta-exclusions';
import { applyMigrationV55 } from './db-migrations/v55-architecture-mapper-layers';
import { applyMigrationV56 } from './db-migrations/v56-interviewer-strict-format';
import { applyMigrationV57 } from './db-migrations/v57-drop-token-usage';
import { applyMigrationV58 } from './db-migrations/v58-development-v2-base';
import { applyMigrationV59 } from './db-migrations/v59-pipe2-prompts';
import { applyMigrationV60 } from './db-migrations/v60-fix-model-aliases';
import { applyMigrationV61 } from './db-migrations/v61-strip-open-design-root';
import { applyMigrationV62 } from './db-migrations/v62-mcp-visibility';
import { applyMigrationV63 } from './db-migrations/v63-orchestrator-settings';
import { applyMigrationV64 } from './db-migrations/v64-zai-agent-runtime';
import { applyMigrationV65 } from './db-migrations/v65-drop-theme-setting';
import { applyMigrationV66 } from './db-migrations/v66-lion-session-summaries';
import { applyMigrationV67 } from './db-migrations/v67-orchestrator-compaction-settings';
import { applyMigrationV68 } from './db-migrations/v68-orchestrator-compaction-trigger-settings';
import { applyMigrationV69 } from './db-migrations/v69-voice-transcription-model';
import { applyMigrationV70 } from './db-migrations/v70-vertex-orchestrator-settings';
import { applyMigrationV71 } from './db-migrations/v71-minimax-token-plan';
import { applyMigrationV72 } from './db-migrations/v72-unknown-cost-tracking';
import { applyMigrationV73 } from './db-migrations/v73-minimax-tp-agent-runtime';
import { applyMigrationV74 } from './db-migrations/v74-dreaming-state';
import { applyMigrationV75 } from './db-migrations/v75-seed-agents-maxturns-80';
import { applyMigrationV76 } from './db-migrations/v76-library-agent-squads';
import { applyMigrationV77 } from './db-migrations/v77-pipe2-spec-validator-status';
import { applyMigrationV78 } from './db-migrations/v78-arch-spec-validator';
import { applyMigrationV79 } from './db-migrations/v79-activity-log';
import { applyMigrationV80 } from './db-migrations/v80-harness-sprints-dedup-unique';
import { applyMigrationV81 } from './db-migrations/v81-activity-log-project-id';
import { applyMigrationV82 } from './db-migrations/v82-repo-graph';
import { applyMigrationV83 } from './db-migrations/v83-dynamic-workflows';
import { applyMigrationV84 } from './db-migrations/v84-dynamic-workflow-builder-tune';
import { applyMigrationV85 } from './db-migrations/v85-dynamic-workflow-builder-specialist';
import { applyMigrationV86 } from './db-migrations/v86-dynamic-workflow-narrator';
import { applyMigrationV87 } from './db-migrations/v87-dynamic-workflow-sprints';
import { applyMigrationV88 } from './db-migrations/v88-dynamic-workflow-plan-agents';
import { applyMigrationV89 } from './db-migrations/v89-dynamic-workflow-builder-plan-driven';
import { applyMigrationV90 } from './db-migrations/v90-dynamic-workflow-builder-writer-no-schema';
import { applyMigrationV91 } from './db-migrations/v91-dynamic-workflow-journal';
import { applyMigrationV92 } from './db-migrations/v92-dynamic-workflow-maestro';
import { applyMigrationV93 } from './db-migrations/v93-dynamic-workflow-sprint-worktree';
import { applyMigrationV94 } from './db-migrations/v94-dynamic-workflow-plan-validator-severity';
import { applyMigrationV95 } from './db-migrations/v95-dynamic-workflow-maestro-acts';
import { applyMigrationV96 } from './db-migrations/v96-dynamic-workflow-plan-validator-converge';
import { applyMigrationV97 } from './db-migrations/v97-dynamic-workflow-maestro-reassert';
import { applyMigrationV98 } from './db-migrations/v98-dynamic-workflow-narrator-delta';
import { applyMigrationV99 } from './db-migrations/v99-dynamic-workflow-plan-validator-converge2';
import { applyMigrationV100 } from './db-migrations/v100-dynamic-workflow-maestro-approve-delivery';
import { applyMigrationV101 } from './db-migrations/v101-dynamic-workflow-planner-respects-spec';
import { applyMigrationV102 } from './db-migrations/v102-dynamic-workflow-planner-stack';
import { applyMigrationV103 } from './db-migrations/v103-dynamic-workflow-maestro-real-outcome';
import { applyMigrationV104 } from './db-migrations/v104-dynamic-workflow-planner-validators-fixed';
import { applyMigrationV105 } from './db-migrations/v105-dynamic-workflow-planner-coder-catalog';
import { applyMigrationV106 } from './db-migrations/v106-kimi-agent-runtime';
import { applyMigrationV107 } from './db-migrations/v107-kimi-model-id-fix';
import { applyMigrationV108 } from './db-migrations/v108-dynamic-workflow-planner-writeset-integration';
import { applyMigrationV109 } from './db-migrations/v109-dynamic-workflow-validator-tests-no-containment';
import { applyMigrationV110 } from './db-migrations/v110-dynamic-workflow-builder-coder-green';
import { applyMigrationV111 } from './db-migrations/v111-dynamic-workflow-builder-green-check';
import { applyMigrationV112 } from './db-migrations/v112-dynamic-workflow-refuter';
import { applyMigrationV113 } from './db-migrations/v113-dynamic-workflow-builder-refute';
import { applyMigrationV114 } from './db-migrations/v114-dynamic-workflow-greencheck-cwd-refuter-id';
import { applyMigrationV115 } from './db-migrations/v115-workflow-authoring-model-agent-axes';
import { applyMigrationV116 } from './db-migrations/v116-dynamic-workflow-sprint-planner-whole-project';
import { applyMigrationV117 } from './db-migrations/v117-dynamic-workflow-builder-plan-review-replan';
import { applyMigrationV118 } from './db-migrations/v118-dynamic-workflow-builder-effective-retry';
import { applyMigrationV119 } from './db-migrations/v119-dynamic-workflow-builder-two-plan-review-gates';
import { applyMigrationV120 } from './db-migrations/v120-dynamic-workflow-builder-single-gate';
import { applyMigrationV121 } from './db-migrations/v121-dynamic-workflow-builder-coverage-only';
import { applyMigrationV122 } from './db-migrations/v122-security-spec-validator';
import { applyMigrationV123 } from './db-migrations/v123-telegram-compaction-columns';
import { applyMigrationV124 } from './db-migrations/v124-orchestrator-single-source';
import { applyMigrationV125 } from './db-migrations/v125-vision-settings';
import { applyMigrationV126 } from './db-migrations/v126-mcp-index';
import { applyMigrationV127 } from './db-migrations/v127-chat-feature-toggles';
import { applyMigrationV128 } from './db-migrations/v128-tool-script-settings';
import { applyMigrationV129 } from './db-migrations/v129-chat-compaction-settings';
import { applyMigrationV130 } from './db-migrations/v130-contexto-vivo-piso';
import { applyMigrationV131 } from './db-migrations/v131-dynamic-workflow-maestro-narrator';
import { applyMigrationV132 } from './db-migrations/v132-dynamic-workflow-budget-removal';
import { applyMigrationV133 } from './db-migrations/v133-dynamic-workflow-fresh-fixer';
import { applyMigrationV134 } from './db-migrations/v134-gpt56-codex-default';
import { applyMigrationV135 } from './db-migrations/v135-remove-local-whisper';
import { applyMigrationV136 } from './db-migrations/v136-liondesign-branding';
import { applyMigrationV137 } from './db-migrations/v137-grok-agent-runtime';
import { applyMigrationV138 } from './db-migrations/v138-task-execution-ledger';
import { applyMigrationV139 } from './db-migrations/v139-provider-metrics-resume';
import { applyMigrationV140 } from './db-migrations/v140-chat-metrics-quality';
import { applyMigrationV141 } from './db-migrations/v141-chat-parent-runtime-metrics';
import { applyMigrationV142 } from './db-migrations/v142-opus-5-orchestrator-default';
import { applyMigrationV143 } from './db-migrations/v143-bug-pipeline';
import { applyMigrationV144 } from './db-migrations/v144-audit-source';
import { applyMigrationV145 } from './db-migrations/v145-dynamic-workflow-validator-haiku';
import { applyMigrationV146 } from './db-migrations/v146-cursor-agent-runtime';
import { applyMigrationV147 } from './db-migrations/v147-kanban';
import { applyMigrationV148 } from './db-migrations/v148-fable-5-1';
import { applyMigrationV149 } from './db-migrations/v149-workflow-adjustment-consumed';
import { applyMigrationV150 } from './db-migrations/v150-gpt6-astra-codex-default';
import { applyMigrationV151 } from './db-migrations/v151-dynamic-workflow-writer-turns';
import { applyMigrationV152 } from './db-migrations/v152-lanes';
import { MAX_DESKTOP_LANES, pickFreeLaneBadge, type LaneSessionState, type SessionOrchestrator } from './lanes';
import { buildDynamicWorkflowEventsQuery } from './dynamic-workflows/events-query';
import type {
  DynamicWorkflowDefinition,
  DynamicWorkflowDefinitionCreateInput,
  DynamicWorkflowDefinitionPatch,
  DynamicWorkflowRun,
  DynamicWorkflowRunCreateInput,
  DynamicWorkflowRunPatch,
  DynamicWorkflowRunStatus,
  DynamicWorkflowNode,
  DynamicWorkflowNodeCreateInput,
  DynamicWorkflowNodeSprintPatch,
  DynamicWorkflowNodeRun,
  DynamicWorkflowNodeRunUpsertInput,
  DynamicWorkflowNodeRunPatch,
  DynamicWorkflowNodeStatus,
  DynamicWorkflowSprintRow,
  DynamicWorkflowSprintUpsertInput,
  DynamicWorkflowSprintPatch,
  MaterializeDynamicWorkflowSprintPlanInput,
  DynamicWorkflowPriorMaterialization,
  DynamicWorkflowJournalEntry,
  DynamicWorkflowJournalAppendInput,
  DynamicWorkflowJournalPrimitive,
  DynamicWorkflowEvent,
  DynamicWorkflowEventInsertInput,
  DynamicWorkflowEventsQuery,
  DynamicWorkflowMessage,
  DynamicWorkflowMessageInsertInput,
  DynamicWorkflowArtifact,
  DynamicWorkflowArtifactInsertInput,
  DynamicWorkflowGateDecision,
  DynamicWorkflowGateDecisionInsertInput,
  DynamicWorkflowRunCostAggregate,
  DynamicWorkflowPhaseCostAggregate,
} from './dynamic-workflows/types';
import type {
  LocalRepositoryRecord,
  RepoGraphRunRecord,
  SessionActiveRepositoryRecord,
  RepoGraphTurnUsageRecord,
  RepoGraphTurnSample,
  RepoGraphSavingsMetrics,
} from './repo-graph/types';
import { computeRepoGraphSavings } from './repo-graph/metrics';
import type {
  ChatMessage,
  ChatSession,
  AgentConfig,
  ExternalConfig,
  CodexConfig,
  CostSource,
  AuditEntry,
  LogFilters,
  MCPServerConfig,
  DailySummary,
  HarnessProject,
  DriveState,
  HarnessSprint,
  HarnessRound,
  HarnessProjectMetrics,
  HarnessProviderAuthCheckpoint,
  SprintMetrics,
  IngestJob,
  LiveActivityEvent,
  LiveActivity,
  ActivityTurnBlock,
  ChatFeatureToggles,
  TimelineTurn,
  TimelineTurnOrigin,
  TimelineRuntime,
  TimelineFidelity,
  TimelineEvent,
  TimelineEventKind,
  TimelineTurnWithEvents,
} from '../../src/types';
import { CHAT_CAPABILITIES_DEFAULT_OFF } from '../../src/types';
import type { PipelineType, RoundDetail, SecuritySummary } from '../../src/types/pipeline';
import type {
  KanbanBoard,
  KanbanCard,
  KanbanCardEvent,
  KanbanAttachment,
  KanbanColumnId,
  KanbanActor,
} from '../../src/types/kanban';
import {
  loopPhasesOf,
  LOOP_HISTORY_BY_TYPE,
  allLoopPhasesWithHistory,
  loopPhasesByRoleWithHistoryOf,
} from '../../src/types/pipeline';

const logger = createLogger('db');

let db: Database.Database;
let dbOpen = false;

function getLionClawPath(): string {
  return getLionClawHome();
}

export function getDb(): Database.Database {
  if (!dbOpen) throw new Error('Database not initialized');
  return db;
}

let vecAvailable = true;
let databaseInitError: DatabaseInitError | null = null;

export function isVecAvailable(): boolean {
  return vecAvailable;
}

export function getDatabaseInitError(): DatabaseInitError | null {
  return databaseInitError;
}

export function getDatabaseFilePath(): string {
  return path.join(getLionClawPath(), 'data', 'lionclaw.db');
}

export interface DatabaseInitHooks {
  prepareSafety?: typeof prepareDatabaseForMigrations;
  runMigrations?: () => void;
  loadSqliteVec?: (database: Database.Database) => void;
  repairVecSchema?: () => void;
}

export function initDatabase(hooks: DatabaseInitHooks = {}): void {
  if (dbOpen) {
    throw new DatabaseIntegrityError(
      getDatabaseFilePath(),
      new Error('Database ja inicializado; reinit recusado para evitar vazamento de handle'),
    );
  }
  databaseInitError = null;
  vecAvailable = true;
  dbOpen = false;
  const dbDir = path.join(getLionClawPath(), 'data');
  const dbPath = path.join(dbDir, 'lionclaw.db');
  let backupPath: string | null = null;
  let phase: 'open' | 'preflight' | 'migration' | 'schema-repair' | 'finalize' = 'open';
  const loadVec = hooks.loadSqliteVec ?? ((database: Database.Database) => loadSqliteVecForRuntime(database));
  try {
    fs.mkdirSync(dbDir, { recursive: true });
    const existingDatabase = fs.existsSync(dbPath) && fs.statSync(dbPath).size > 0;
    db = new Database(dbPath);
    dbOpen = true;
    db.pragma('busy_timeout = 5000');
    phase = 'preflight';
    assertDatabaseIntegrity(db, dbPath);

    try {
      loadVec(db);
      vecAvailable = true;
    } catch (error) {
      vecAvailable = false;
      logger.error(
        { error, code: 'VEC-UNAVAILABLE' },
        'sqlite-vec failed to load; vector search DEGRADED (boot continues)',
      );
    }

    const harnessSql = getHarnessProjectsCreateSql(db);
    const requiresHarnessRepair = harnessSql !== null && !harnessProjectStatusCheckSupportsTerminalStates(db);
    const requiresVecRepair = vecAvailable && semanticMemoriesVecNeedsRepair(db);
    const prepareSafety = hooks.prepareSafety ?? prepareDatabaseForMigrations;
    const safety = prepareSafety({
      database: db,
      dbPath,
      existingDatabase,
      latestSchemaVersion: LATEST_SCHEMA_VERSION,
      requiresSchemaRepair: requiresHarnessRepair || requiresVecRepair,
      integrityAlreadyChecked: true,
      openReadonlyDatabase: (backupDbPath) => new Database(backupDbPath, { readonly: true, fileMustExist: true }),
      ...(vecAvailable ? { loadSqliteVec: (backupDatabase: Database.Database) => loadVec(backupDatabase) } : {}),
    });
    backupPath = safety.backupPath;

    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    phase = 'migration';
    if (hooks.runMigrations) {
      hooks.runMigrations();
    } else {
      runMigrations({
        onSchemaRepairStart: () => {
          phase = 'schema-repair';
        },
        onSchemaRepairEnd: () => {
          phase = 'migration';
        },
      });
    }
    const interruptedExecutions = reconcileInterruptedTaskExecutions();
    if (interruptedExecutions > 0) {
      logger.warn({ interruptedExecutions }, 'Task executions interrompidas foram canceladas no boot');
    }
    phase = 'schema-repair';
    if (vecAvailable) {
      (hooks.repairVecSchema ?? fixVecTableIfNeeded)();
    }
    phase = 'finalize';
    if (backupPath) {
      clearMigrationInProgressMarker(dbPath, backupPath, {
        openReadonlyDatabase: (backupDbPath) => new Database(backupDbPath, { readonly: true, fileMustExist: true }),
      });
    }
  } catch (cause) {
    const failed =
      cause instanceof DatabaseInitError
        ? cause
        : phase === 'schema-repair'
          ? new DatabaseSchemaRepairError(dbPath, backupPath, cause)
          : dbOpen
            ? new MigrationError(safeMaxSchemaVersion() + 1, dbPath, cause, backupPath)
            : new DatabaseIntegrityError(dbPath, cause);
    databaseInitError = failed;
    if (dbOpen) {
      try {
        db.close();
      } catch (closeError) {
        logger.warn({ closeError, dbPath }, 'Database close after init failure also failed');
      }
      dbOpen = false;
      db = undefined as unknown as Database.Database;
    }
    logger.error({ err: failed, code: failed.code, dbPath, backupPath }, 'Database init failed');
    throw failed;
  }
  migrateLegacyHarnessSprintsJsonPaths();
  logger.info({ path: dbPath, vecAvailable }, 'Database ready');
}

function safeMaxSchemaVersion(): number {
  try {
    const row = db.prepare('SELECT MAX(version) as v FROM schema_version').get() as { v: number | null } | undefined;
    return row?.v ?? 0;
  } catch {
    return 0;
  }
}

interface RunMigrationsHooks {
  onSchemaRepairStart: () => void;
  onSchemaRepairEnd: () => void;
}

function runMigrations(hooks?: RunMigrationsHooks): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  const current = db.prepare('SELECT MAX(version) as v FROM schema_version').get() as { v: number | null };
  const currentVersion = current?.v ?? 0;

  if (currentVersion < 1) {
    db.exec(MIGRATION_V1);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(1);
    logger.info('Applied migration v1');
  }

  if (currentVersion < 2) {
    db.exec(MIGRATION_V2);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(2);
    logger.info('Applied migration v2');
  }

  if (currentVersion < 3) {
    db.exec(MIGRATION_V3);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(3);
    logger.info('Applied migration v3');
  }

  if (currentVersion < 4) {
    db.exec(MIGRATION_V4);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(4);
    logger.info('Applied migration v4');
  }

  if (currentVersion < 5) {
    db.exec(MIGRATION_V5);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(5);
    logger.info('Applied migration v5');
  }

  if (currentVersion < 6) {
    db.exec(MIGRATION_V6);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(6);
    logger.info('Applied migration v6');
  }

  if (currentVersion < 7) {
    db.pragma('foreign_keys = OFF');
    db.exec(MIGRATION_V7);
    db.pragma('foreign_keys = ON');
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(7);
    logger.info('Applied migration v7');
  }

  if (currentVersion < 8) {
    db.exec(MIGRATION_V8);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(8);
    logger.info('Applied migration v8');
  }

  if (currentVersion < 9) {
    db.exec(MIGRATION_V9);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(9);
    logger.info('Applied migration v9');
  }

  if (currentVersion < 10) {
    db.exec(MIGRATION_V10);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(10);
    logger.info('Applied migration v10');
  }

  if (currentVersion < 11) {
    db.exec(MIGRATION_V11);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(11);
    logger.info('Applied migration v11');
  }

  if (currentVersion < 12) {
    db.exec(MIGRATION_V12);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(12);
    logger.info('Applied migration v12 - FTS5 for BM25 search');
  }

  if (currentVersion < 13) {
    db.exec(MIGRATION_V13);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(13);
    logger.info('Applied migration v13 - vec table upgraded to 1536 dims (OpenAI)');
  }

  if (currentVersion < 14) {
    db.exec(MIGRATION_V14);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(14);
    logger.info('Applied migration v14 - local agent mode and tool rounds');
  }

  if (currentVersion < 15) {
    db.exec(MIGRATION_V15);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(15);
    logger.info('Applied migration v15 - knowledge base RAG tables');
  }

  if (currentVersion < 16) {
    db.exec(MIGRATION_V16);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(16);
    logger.info('Applied migration v16 - mcp_tool_registry for auto-discovery');
  }

  if (currentVersion < 17) {
    db.exec(MIGRATION_V17);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(17);
    logger.info('Applied migration v17 - personal tasks');
  }

  if (currentVersion < 18) {
    const rows = db.prepare("SELECT id, config FROM channels WHERE type = 'telegram'").all() as Array<{
      id: string;
      config: string;
    }>;

    for (const row of rows) {
      try {
        const cfg = JSON.parse(row.config);
        if (cfg.allowedUsers && cfg.allowedUsers.length > 0) continue;

        let allowedUsers: Array<{ userId: number; name: string }> = [];
        if (cfg.allowedUserIds && cfg.allowedUserIds.length > 0) {
          allowedUsers = cfg.allowedUserIds.map((id: number, i: number) => ({
            userId: id,
            name: `Usuario ${i + 1}`,
          }));
        } else if (cfg.allowedUserId) {
          allowedUsers = [{ userId: cfg.allowedUserId, name: 'Usuario 1' }];
        }

        if (allowedUsers.length > 0) {
          const updated = { ...cfg, allowedUsers };
          delete updated.allowedUserId;
          delete updated.allowedUserIds;
          db.prepare('UPDATE channels SET config = ? WHERE id = ?').run(JSON.stringify(updated), row.id);
        }
      } catch {
        // skip malformed config rows
      }
    }

    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(18);
    logger.info('Applied migration v18 - telegram allowedUsers multi-id support');
  }

  if (currentVersion < 19) {
    try {
      db.exec(MIGRATION_V19);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (!/duplicate column/i.test(msg)) {
        throw error;
      }
      logger.warn({ msg }, 'Migration v19: squad column already exists (skipping)');
    }
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(19);
    logger.info('Applied migration v19 - squad column for agents');
  }

  if (currentVersion < 20) {
    db.exec(MIGRATION_V20);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(20);
    logger.info('Applied migration v20 - task_executions for per-agent usage tracking');
  }

  if (currentVersion < 21) {
    db.exec(MIGRATION_V21);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(21);
    logger.info('Applied migration v21 - harness projects, sprints, rounds');
  }

  if (currentVersion < 22) {
    db.exec(MIGRATION_V22);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(22);
    logger.info('Applied migration v22 - planner metrics on harness_projects');
  }

  if (currentVersion < 23) {
    db.exec(MIGRATION_V23);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(23);
    logger.info('Applied migration v23 - workflow_runs table');
  }

  if (currentVersion < 24) {
    db.exec(MIGRATION_V24);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(24);
    logger.info('Applied migration v24 - workflow_runs add generating status');
  }

  if (currentVersion < 25) {
    db.pragma('foreign_keys = OFF');
    db.exec(MIGRATION_V25);
    db.pragma('foreign_keys = ON');
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(25);
    logger.info('Applied migration v25 - workflow_runs add current_question');
  }

  if (currentVersion < 26) {
    db.exec(MIGRATION_V26);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(26);
    logger.info('Applied migration v26 - enrich_sessions table');
  }

  if (currentVersion < 27) {
    db.exec(MIGRATION_V27);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(27);
    logger.info('Applied migration v27 - enrich_messages table');
  }

  if (currentVersion < 28) {
    db.exec(MIGRATION_V28);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(28);
    logger.info('Applied migration v28 - FTS5 unicode61 remove_diacritics');
  }

  if (currentVersion < 29) {
    db.exec(MIGRATION_V29);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(29);
    logger.info('Applied migration v29 - ingest_jobs table');
  }

  if (currentVersion < 30) {
    db.exec(MIGRATION_V30);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(30);
    logger.info('Applied migration v30 - ingest_jobs partial status + file_hash index');
  }

  if (currentVersion < 31) {
    db.exec(MIGRATION_V31);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(31);
    logger.info('Applied migration v31 - pipeline_phase_metrics and pipeline_messages tables');
  }

  if (currentVersion < 32) {
    db.exec(MIGRATION_V32_MIGRATE_HARNESS_TO_PIPELINE);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(32);
    logger.info('Applied migration v32 - migrated legacy harness metrics to pipeline_phase_metrics');
  }

  if (currentVersion < 33) {
    db.exec(MIGRATION_V33_SPRINT_INDEX_COLUMN);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(33);
    logger.info('Applied migration v33 - added sprint_index column, per-sprint metrics rows');
  }

  if (currentVersion < 34) {
    db.exec(MIGRATION_V34_FIX_AGENT_IDS);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(34);
    logger.info('Applied migration v34 - fix pipeline_phase_metrics agent_id from harness_sprints');
  }

  if (currentVersion < 35) {
    db.pragma('foreign_keys = OFF');
    db.exec(MIGRATION_V35_HARNESS_STATUS_IDLE);
    db.pragma('foreign_keys = ON');
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(35);
    logger.info('Applied migration v35 - add idle status to harness_projects CHECK constraint');
  }

  if (currentVersion < 36) {
    db.exec(MIGRATION_V36_PIPELINE_STATE);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(36);
    logger.info('Applied migration v36 - pipeline state persistence columns');
  }

  if (currentVersion < 37) {
    db.pragma('foreign_keys = OFF');
    db.exec(MIGRATION_V37_DROP_TECH_SUBSTEP);
    db.pragma('foreign_keys = ON');
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(37);
    logger.info('Applied migration v37 - drop pipeline_tech_substep, cleanup old phase data');
  }

  if (currentVersion < 38) {
    db.exec(MIGRATION_V38_PIPELINE_MSG_SPRINT_COLS);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(38);
    logger.info(
      'Applied migration v38 - add sprint_index/round_index/agent_id to pipeline_messages and round_index to pipeline_phase_metrics',
    );
  }

  if (currentVersion < 39) {
    db.pragma('foreign_keys = OFF');
    db.exec(MIGRATION_V39_HARNESS_SPRINT_VERDICT);
    db.pragma('foreign_keys = ON');
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(39);
    logger.info('Applied migration v39 - add verdict/updated_at to harness_sprints and rejected status');
  }

  if (currentVersion < 40) {
    db.exec(MIGRATION_V40_RECONCILE_LEGACY_SESSION_TYPES);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(40);
    logger.info('Applied migration v40 - reconcile legacy scheduler/telegram sessions with type=chat');
  }

  if (currentVersion < 41) {
    db.exec(MIGRATION_V41_SECURITY_PIPELINE);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(41);
    logger.info('Applied migration v41 - pipeline_type column and security_agent_status table');
  }

  if (currentVersion < 42) {
    db.exec(MIGRATION_V42_SECURITY_SUMMARY);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(42);
    logger.info('Applied migration v42 - security_summary_json column on harness_projects');
  }

  if (currentVersion < 43) {
    db.pragma('foreign_keys = OFF');
    db.exec(MIGRATION_V43);
    db.pragma('foreign_keys = ON');
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(43);
    logger.info('Applied migration v43 - external runtime + external_config column');
  }

  if (currentVersion < 44) {
    db.exec(MIGRATION_V44);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(44);
    logger.info('Applied migration v44 - cost source + runtime/provider/model snapshot');
  }

  if (currentVersion < 45) {
    db.exec(MIGRATION_V45);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(45);
    logger.info('Applied migration v45 - pipeline_docs_id column on harness_projects');
  }

  if (currentVersion < 46) {
    db.exec(MIGRATION_V46);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(46);
    logger.info('Applied migration v46 - metadata column on harness_rounds');
  }

  if (currentVersion < 47) {
    db.pragma('foreign_keys = OFF');
    db.exec(MIGRATION_V47);
    db.pragma('foreign_keys = ON');
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(47);
    logger.info('Applied migration v47 - codex runtime + codex_config column on agents');
  }

  hooks?.onSchemaRepairStart();
  try {
    ensureHarnessProjectStatusCheckExpanded(db);
  } finally {
    hooks?.onSchemaRepairEnd();
  }
  if (currentVersion < 48) {
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(48);
    logger.info('Applied migration v48 - expand harness_projects.status CHECK to include aborted/interrupted');
  }

  if (currentVersion < 49) {
    db.exec(MIGRATION_V49_FIX_AGENT_SQUADS);
    applyMigrationV49Tools(db);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(49);
    logger.info('Applied migration v49 - fix agent squads + secrets-scanner tools');
  }

  if (currentVersion < 50) {
    applyMigrationV50(db);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(50);
    logger.info('Applied migration v50 - update spec-builder/validator/security-skeptic prompts');
  }

  if (currentVersion < 51) {
    db.exec(MIGRATION_V51);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(51);
    logger.info('Applied migration v51 - codex_windows_prep_consent + codex_patch_failures column');
  }

  if (currentVersion < 52) {
    applyMigrationV52TechWriteRemoval(db);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(52);
    logger.info('Applied migration v52 - remove Write tool from feat-tech-* and tech-* agents');
  }

  if (currentVersion < 53) {
    applyMigrationV53(db);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(53);
    logger.info('Applied migration v53 - architecture-review pipeline seed agents');
  }

  if (currentVersion < 54) {
    applyMigrationV54(db);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(54);
    logger.info('Applied migration v54 - architecture-target-triage meta exclusions (CLAUDE.md, docs/)');
  }

  if (currentVersion < 55) {
    applyMigrationV55(db);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(55);
    logger.info('Applied migration v55 - architecture-mapper layer/kind schema fields');
  }

  if (currentVersion < 56) {
    applyMigrationV56(db);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(56);
    logger.info('Applied migration v56 - architecture-decision-interviewer strict format labels');
  }

  if (currentVersion < 57) {
    applyMigrationV57(db);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(57);
    logger.info('Applied migration v57 - drop token_usage table (UsagePage replaced by CodeBurn embed)');
  }

  if (currentVersion < 58) {
    applyMigrationV58(db);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(58);
    logger.info('Applied migration v58 - development-v2 pipeline base: seed pipe2-* agents');
  }

  if (currentVersion < 59) {
    applyMigrationV59(db);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(59);
    logger.info('Applied migration v59 - pipe2-* prompts final (Sprint 6)');
  }

  if (currentVersion < 60) {
    applyMigrationV60(db);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(60);
    logger.info('Applied migration v60 - fix model aliases (opus/sonnet/haiku -> explicit IDs)');
  }

  if (currentVersion < 61) {
    applyMigrationV61(db);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(61);
    logger.info(
      'Applied migration v61 - strip harness_projects.config.openDesign.openDesignRoot (Open Design vendor Sprint 1)',
    );
  }

  if (currentVersion < 62) {
    applyMigrationV62(db);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(62);
    logger.info('Applied migration v62 - add mcp_servers.visible_to column (SPEC-001 Sprint 2)');
  }

  if (currentVersion < 63) {
    applyMigrationV63(db);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(63);
    logger.info('Applied migration v63 - seed orchestrator_* defaults in settings (SPEC-001 Sprint 2)');
  }

  if (currentVersion < 64) {
    db.pragma('foreign_keys = OFF');
    applyMigrationV64(db);
    db.pragma('foreign_keys = ON');
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(64);
    logger.info('Applied migration v64 - add zai runtime to agents');
  }

  if (currentVersion < 65) {
    applyMigrationV65(db);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(65);
    logger.info('Applied migration v65 - drop dead theme setting row');
  }

  if (currentVersion < 66) {
    applyMigrationV66(db);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(66);
    logger.info('Applied migration v66 - create lion_session_summaries for compaction cache');
  }

  if (currentVersion < 67) {
    applyMigrationV67(db);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(67);
    logger.info('Applied migration v67 - seed orchestrator_compaction_* defaults in settings');
  }

  if (currentVersion < 68) {
    applyMigrationV68(db);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(68);
    logger.info('Applied migration v68 - seed Lion-SDK compaction trigger settings');
  }

  if (currentVersion < 69) {
    applyMigrationV69(db);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(69);
    logger.info('Applied migration v69 - seed voice transcription model setting');
  }

  if (currentVersion < 70) {
    applyMigrationV70(db);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(70);
    logger.info('Applied migration v70 - seed orchestrator_vertex_* defaults in settings');
  }

  if (currentVersion < 71) {
    applyMigrationV71(db);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(71);
    logger.info('Applied migration v71 - seed orchestrator_minimax_api_key_ref default in settings');
  }

  if (currentVersion < 72) {
    applyMigrationV72(db);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(72);
    logger.info('Applied migration v72 - add unknown_cost_count tracking columns');
  }

  if (currentVersion < 73) {
    db.pragma('foreign_keys = OFF');
    applyMigrationV73(db);
    db.pragma('foreign_keys = ON');
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(73);
    logger.info('Applied migration v73 - add minimax-tp runtime to agents (SPEC-006)');
  }

  if (currentVersion < 74) {
    applyMigrationV74(db);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(74);
    logger.info('Applied migration v74: dreaming_state table + 3 settings');
  }

  if (currentVersion < 75) {
    applyMigrationV75(db);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(75);
    logger.info('Applied migration v75: seed agents maxTurns -> 80');
  }

  if (currentVersion < 76) {
    applyMigrationV76(db);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(76);
    logger.info('Applied migration v76: library agent squads (categorias)');
  }

  if (currentVersion < 77) {
    applyMigrationV77(db);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(77);
    logger.info('Applied migration v77: pipe2-spec-validator status header + spec-validation.md');
  }

  if (currentVersion < 78) {
    applyMigrationV78(db);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(78);
    logger.info('Applied migration v78: seed arch-spec-validator (fase 6 architecture-review)');
  }

  if (currentVersion < 79) {
    applyMigrationV79(db);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(79);
    logger.info('Applied migration v79: activity_log table (activity log v2)');
  }

  if (currentVersion < 80) {
    applyMigrationV80(db);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(80);
    logger.info('Applied migration v80: dedup harness_sprints + unique(project_id, sprint_index)');
  }

  if (currentVersion < 81) {
    applyMigrationV81(db);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(81);
    logger.info('Applied migration v81: activity_log.project_id (clique do bloco pipeline, I2)');
  }

  if (currentVersion < 82) {
    applyMigrationV82(db);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(82);
    logger.info('Applied migration v82: repo-graph tables (repo mode com CodeGraph no chat)');
  }

  if (currentVersion < 83) {
    applyMigrationV83(db);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(83);
    logger.info('Applied migration v83: dynamic_workflow_* tables (SPEC-010 dynamic workflow pipe)');
  }

  if (currentVersion < 84) {
    applyMigrationV84(db);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(84);
    logger.info(
      'Applied migration v84: tune dynamic-workflow-builder (effort high, thinkingBudget 6000) for faster JSON-clean generation',
    );
  }

  if (currentVersion < 85) {
    applyMigrationV85(db);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(85);
    logger.info(
      'Applied migration v85: dynamic-workflow-builder picks stack specialists from the catalog (coder/fixer; generic squad as fallback)',
    );
  }

  if (currentVersion < 86) {
    applyMigrationV86(db);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(86);
    logger.info('Applied migration v86: seed dynamic-workflow-narrator (cockpit narrator agent, INSERT OR IGNORE)');
  }

  if (currentVersion < 87) {
    applyMigrationV87(db);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(87);
    logger.info(
      'Applied migration v87: dynamic_workflow_sprints table + sprint_id/round_index on dynamic_workflow_nodes (SPEC-010 sprint redesign)',
    );
  }

  if (currentVersion < 88) {
    applyMigrationV88(db);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(88);
    logger.info(
      'Applied migration v88: seed dynamic-workflow sprint-planner + 3 plan validators (coverage/topology/criteria), INSERT OR IGNORE (SPEC-010 sprint redesign)',
    );
  }

  if (currentVersion < 89) {
    applyMigrationV89(db);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(89);
    logger.info(
      'Applied migration v89: dynamic-workflow-builder prompt -> plan-driven model (preserves user customizations, SPEC-010 sprint redesign sec 5)',
    );
  }

  if (currentVersion < 90) {
    applyMigrationV90(db);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(90);
    logger.info(
      'Applied migration v90: dynamic-workflow-builder prompt -> writer-sem-schema rule (SPEC-010 F1 HOTFIX sec 3.1/D-7; preserves user customizations)',
    );
  }

  if (currentVersion < 91) {
    applyMigrationV91(db);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(91);
    logger.info(
      'Applied migration v91: dynamic_workflow_journal table (SPEC-010 F2 sec 3.2/D-8; resume por journal ordenado, append-only)',
    );
  }

  if (currentVersion < 92) {
    applyMigrationV92(db);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(92);
    logger.info(
      'Applied migration v92: seed dynamic-workflow-maestro LEAN (kb_enabled=0/skills=[]/mcp=[]/tools de dominio), INSERT OR IGNORE + UPDATE direcionado (SPEC-010 F4a sec 4.1/D-11; preserva customizacoes)',
    );
  }

  if (currentVersion < 93) {
    applyMigrationV93(db);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(93);
    logger.info(
      'Applied migration v93: worktree_path/branch/base_sha/head_sha/merge_status em dynamic_workflow_sprints (SPEC-010 F5 sec 3.4/D-3; persistencia por sprint para writers paralelos)',
    );
  }

  if (currentVersion < 94) {
    applyMigrationV94(db);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(94);
    logger.info(
      'Applied migration v94: afrouxa severidade dos 3 plan-validators do workflow dinamico (SPEC-010 smoke SM-5/SM-8; P1 so para bloqueio real, P2/P3 advisory; preserva customizacoes)',
    );
  }

  if (currentVersion < 95) {
    applyMigrationV95(db);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(95);
    logger.info(
      'Applied migration v95: re-tune do seed dynamic-workflow-maestro para AGIR sob comando do humano via chat (SPEC-010 SM-21; aprovar/rejeitar+replanejar/lancar validadores/pausar/retomar/abortar/trocar agente executados pelo Maestro, nunca "use o botao"; preserva customizacoes)',
    );
  }

  if (currentVersion < 96) {
    applyMigrationV96(db);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(96);
    logger.info(
      'Applied migration v96: segundo pass de severidade dos 3 plan-validators do workflow dinamico (SPEC-010 SM5-CONV; P1 = lista FECHADA do que QUEBRA o plano, nits como "criterio poderia ser mais objetivo"/"inspecao visual sem seletor" viram P2/P3, default P3; plano converge em 1-2 rodadas; nao mexe em maxRounds; preserva customizacoes)',
    );
  }

  if (currentVersion < 97) {
    applyMigrationV97(db);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(97);
    logger.info(
      'Applied migration v97: re-afirma o INSERT OR IGNORE do seed dynamic-workflow-maestro (SPEC-010 SM-11; registra o Maestro em DBs onde a linha ficou ausente, para aparecer/ser editavel em SubAgents; no-op se ja existe, preserva customizacoes)',
    );
  }

  if (currentVersion < 98) {
    applyMigrationV98(db);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(98);
    logger.info(
      'Applied migration v98: narracao do Maestro vira DELTA curto por marco (SPEC-010 SM-23; uma frase narrando so o que mudou neste marco, sem re-descrever o projeto a cada marco; preserva customizacoes)',
    );
  }

  if (currentVersion < 99) {
    applyMigrationV99(db);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(99);
    logger.info(
      'Applied migration v99: terceiro pass de severidade dos 3 plan-validators do workflow dinamico (SPEC-010 SM5-R3; reserva P1 SO para o que QUEBRA a execucao - sprint/criterio ausente, ciclo/dep futura/ausente, criterio sem NENHUMA verificacao, agente inexistente/inativo; "criterio poderia ser mais objetivo"/"falta inspecao em CI"/"poderia cobrir mais" viram P2/P3; default ZERO P1 com teste obrigatorio por eixo; plano converge em 1-2 rodadas; nao mexe em maxRounds; preserva customizacoes)',
    );
  }

  if (currentVersion < 100) {
    applyMigrationV100(db);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(100);
    logger.info(
      'Applied migration v100: Maestro aprova TUDO por chat, inclusive entrega/merge (SPEC-010 SM-31; remove a excecao "aprovacao AS-IS de gate de entrega fica na tela do run"; a palavra do humano no chat E o aval, igual ao Claude Code; seguranca por construcao: gate human so em autonomia semi com humano no loop, merge git LOCAL sem push, budget e caminho a parte; preserva customizacoes)',
    );
  }

  if (currentVersion < 101) {
    applyMigrationV101(db);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(101);
    logger.info(
      'Applied migration v101: sprint-planner RESPEITA o "fora de escopo" da SPEC + declara writeSetHint completo (SPEC-010 SM-40; smoke do run cpf-utils mostrou o planner colocando generateCPF que a SPEC proibiu, gerando conflito SPEC vs plano + churn; REPLACE cirurgico do bloco ESCOPO FECHADO, preserva customizacoes)',
    );
  }

  if (currentVersion < 102) {
    applyMigrationV102(db);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(102);
    logger.info(
      'Applied migration v102: sprint-planner PREENCHE o campo stack pelo SPEC (SPEC-010 SM-45; smoke greenfield slug-utils mostrou stack:[] -> coder generico em vez de especialista; REPLACE cirurgico da secao ESCOLHA DO ESPECIALISTA, preserva customizacoes)',
    );
  }

  if (currentVersion < 103) {
    applyMigrationV103(db);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(103);
    logger.info(
      'Applied migration v103: Maestro narra o OUTCOME real (SPEC-010 SM-47; smoke mostrou o Maestro narrando "rejeitei e mandei pro planner apos a rodada de replan" sem replan ter rodado; fix primario e de codigo - re-inspect do run apos a acao + linha deterministica "Resultado real"; este prompt e o reforco, preserva customizacoes)',
    );
  }

  if (currentVersion < 104) {
    applyMigrationV104(db);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(104);
    logger.info(
      'Applied migration v104: sprint-planner deixa validatorAgentIds VAZIO (validadores fixos por eixo); par do saneamento SM-50 em workflow-host-api (SPEC-010 SM-50)',
    );
  }

  if (currentVersion < 105) {
    applyMigrationV105(db);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(105);
    logger.info(
      'Applied migration v105: sprint-planner escolhe o coder ESPECIALISTA da lista de coders fornecida (catalogo do bundle injetado no prompt via ctx.agentCatalog); generico vira fallback de ultimo recurso; par R10 do plumbing ctx.agentCatalog (SPEC-010)',
    );
  }

  if (currentVersion < 106) {
    db.pragma('foreign_keys = OFF');
    applyMigrationV106(db);
    db.pragma('foreign_keys = ON');
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(106);
    logger.info('Applied migration v106 - add kimi runtime to agents (SPEC-011)');
  }

  if (currentVersion < 107) {
    applyMigrationV107(db);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(107);
    logger.info('Applied migration v107 - kimi model id fix (kimi-for-coding -> kimi-code/kimi-for-coding)');
  }

  if (currentVersion < 108) {
    applyMigrationV108(db);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(108);
    logger.info('Applied migration v108 - planner writeSetHint integration/entry-point guidance (R10 par do seed)');
  }

  if (currentVersion < 109) {
    applyMigrationV109(db);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(109);
    logger.info(
      'Applied migration v109 - validator-tests sem containment de writeSet (enforcement desligado; R10 par do seed)',
    );
  }

  if (currentVersion < 110) {
    applyMigrationV110(db);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(110);
    logger.info(
      'Applied migration v110 - builder gera coder com disciplina rodar-ate-verde (typecheck/test/build; R10 par do seed)',
    );
  }

  if (currentVersion < 111) {
    applyMigrationV111(db);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(111);
    logger.info(
      'Applied migration v111 - builder emite greenCheck() no dev-loop e mescla findings do host antes do devBlockersOf (F1-S4; R10 par do seed)',
    );
  }

  if (currentVersion < 112) {
    applyMigrationV112(db);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(112);
    logger.info(
      'Applied migration v112 - semeia o seed dynamic-workflow-refuter (refuter por evidencia do dev-loop; F2-S6; R10 par do seed novo)',
    );
  }

  if (currentVersion < 113) {
    applyMigrationV113(db);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(113);
    logger.info(
      'Applied migration v113 - builder emite no refuter no dev-loop e convergencia consome refutados (P1+P2 de severityConfirmada; F2-S7; R10 par do seed)',
    );
  }

  if (currentVersion < 114) {
    applyMigrationV114(db);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(114);
    logger.info(
      'Applied migration v114 - green-check com cwd da sprint (sprintIndex) + correlacao do refuter por id estavel (fix 2x P1 da revisao; R10 par dos seeds builder/refuter)',
    );
  }

  if (currentVersion < 115) {
    applyMigrationV115(db);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(115);
    logger.info(
      'Applied migration v115 - authoring_model em dynamic_workflow_definitions + 4 eixos de permissao por agentType (access/allow_bash/allowed_commands/allow_network) como ADD COLUMN, defaults conservadores (Fase 0 claude-code authoring)',
    );
  }

  if (currentVersion < 116) {
    applyMigrationV116(db);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(116);
    logger.info(
      'Applied migration v116 - dynamic-workflow-sprint-planner: planeja o projeto INTEIRO do estado do repo e ignora secoes da SPEC enderecadas a outro motor (dev-v2 4.8/DevelopmentV2SprintMetadata); R10 par do seed',
    );
  }

  if (currentVersion < 117) {
    applyMigrationV117(db);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(117);
    logger.info(
      'Applied migration v117 - dynamic-workflow-builder: gera runPlanReviewGate que honra decisionPayload.action=replan nos 2 caminhos (fim do replan no-op no plan-review) + pre-expande planner-replan-N no manifest; R10 par do seed',
    );
  }

  if (currentVersion < 118) {
    applyMigrationV118(db);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(118);
    logger.info(
      'Applied migration v118 - dynamic-workflow-builder: retry efetivo (deteccao de nao-progresso por assinatura de blockers + reframe do proximo writer) nos 2 loops; R10 par do seed (template ja tem blockerSignature/stuckNote)',
    );
  }

  if (currentVersion < 119) {
    applyMigrationV119(db);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(119);
    logger.info(
      'Applied migration v119 - dynamic-workflow-builder: DOIS ids de plan-review (human + orchestrator) + selecao ternaria dos gates tecnicos por autonomia (semi/full/auto-drive, tabela 1.3); R10 par do seed (template adversarial-feature-delivery ja tem os dois gates + selecao ternaria)',
    );
  }

  if (currentVersion < 120) {
    applyMigrationV120(db);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(120);
    logger.info(
      'Applied migration v120 - dynamic-workflow-builder: MODO UNICO full-automatico - colapsa para UM id por gate (gate-plan-review/gate-delivery) sempre mode orchestrator, remove gate humano/semi/full/auto-drive; R10 par do seed (template ja em 2.7.0, sem gate humano)',
    );
  }

  if (currentVersion < 121) {
    applyMigrationV121(db);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(121);
    logger.info(
      'Applied migration v121 - dynamic-workflow-builder: planejamento SEM gauntlet - validateSprintPlan auto-corrige o cosmetico e so reprova o real, 1 plan-validator de COBERTURA (eixos topology/criteria aposentados, integridade estrutural deterministica no host); R10 par do seed + template 2.8.0',
    );
  }

  if (currentVersion < 122) {
    applyMigrationV122(db);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(122);
    logger.info(
      'Applied migration v122 - semeia o seed security-spec-validator (validator do loop spec-builder<->validator da fase 6 do pipeline security; R10 par do seed novo)',
    );
  }

  if (currentVersion < 123) {
    applyMigrationV123(db);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(123);
    logger.info(
      'Applied migration v123 - telegram-cron-compaction 5.1/9: colunas de compactacao in-place em sessions (compacted_up_to_message_id, rolling_summary, pending_seed, active_context_tokens_est), todas nullable/aditivas',
    );
  }

  if (currentVersion < 124) {
    applyMigrationV124(db);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(124);
    logger.info(
      'Applied migration v124 - orquestrador-fonte-unica 1.2/5: aposenta default_model. Garante o triple orchestrator_* completo (triple completo intocado; runtime presente completa pelo catalogo curado; runtime vazio infere de default_model com alias ou grava PRODUCT_DEFAULT) e apaga default_model. Sem re-bump de valores existentes',
    );
  }

  if (currentVersion < 125) {
    applyMigrationV125(db);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(125);
    logger.info(
      'Applied migration v125 - vision-transcricao-imagens 1.2: semeia vision_provider/vision_model a partir do catalogo curado (VISION_DEFAULT) via INSERT OR IGNORE. Preserva customizacao do usuario',
    );
  }

  if (currentVersion < 126) {
    applyMigrationV126(db);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(126);
    logger.info(
      'Applied migration v126 - mcp-index-invoke 1: registry completo (input_schema/last_discovered_at em mcp_tool_registry, index_mode em mcp_servers, idempotente via PRAGMA table_info) + seed mcp_prompt_mode=index via INSERT OR IGNORE. description ja existia desde a V16',
    );
  }

  if (currentVersion < 127) {
    applyMigrationV127(db);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(127);
    logger.info(
      'Applied migration v127 - chat-context-reduction A.2 (S2): tabela chat_session_features (toggles Pipeline/Workflows por sessao de chat desktop, FK ON DELETE CASCADE) + backfill true/true das sessoes chat/manual existentes (telegram/scheduled sem linha). Idempotente (IF NOT EXISTS + INSERT OR IGNORE)',
    );
  }

  if (currentVersion < 128) {
    applyMigrationV128(db);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(128);
    logger.info(
      'Applied migration v128 - chat-context-reduction B.8 (Fase B, S4): seed dos settings tool_script_* (enabled/tools/timeout_ms/max_stdout_bytes/max_stderr_bytes/max_tool_calls) via INSERT OR IGNORE. Idempotente; preserva customizacao do usuario',
    );
  }

  if (currentVersion < 129) {
    applyMigrationV129(db);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(129);
    logger.info(
      'Applied migration v129 - robustez-chat SA-5 (Pilar A): seed dos settings da compactacao automatica leve do chat (chat_compaction_target_tokens=50000 D2; orchestrator_compaction_threshold_percent=80 D1, alinhando gatilho e barrinha) via INSERT OR IGNORE. Idempotente; preserva customizacao do usuario',
    );
  }

  if (currentVersion < 130) {
    applyMigrationV130(db);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(130);
    logger.info(
      'Applied migration v130 - contexto-vivo-runtimes 3.5/3.6/6: colunas do PISO forte em sessions (agentic_context_tokens_est = acumulador persistente de args+results da thread principal no compat; thread_reset_message_id = fence de reset de thread sem compactacao), ambas nullable/aditivas',
    );
  }

  if (currentVersion < 131) {
    applyMigrationV131(db);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(131);
    logger.info(
      'Applied migration v131 - dynamic-workflow fechamento S2: seed dynamic-workflow-maestro vira NARRADOR PURO (narra marcos em PT-BR, 1-3 frases, nunca aprova/intervem/executa; prompt e description novos). Padrao V50/V103: UPDATE guardado (so quando valor == default antigo pos-v103), preserva customizacao do usuario; R10 par do seed .ts',
    );
  }

  if (currentVersion < 132) {
    applyMigrationV132(db);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(132);
    logger.info(
      'Applied migration v132 - dynamic-workflow fechamento S3: remocao da feature de budget. Corrige a linha "Respeite o budget..." do prompt do seed dynamic-workflow-builder por replace() direcionado na linha (guardado por LIKE, preserva o resto de prompts customizados); R10 par do seed .ts',
    );
  }

  if (currentVersion < 133) {
    applyMigrationV133(db);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(133);
    logger.info(
      'Applied migration v133 - dynamic-workflow fechamento S6: fresh fixer no dev-loop (retry efetivo Increment 2). Insere no prompt do seed dynamic-workflow-builder a instrucao do fresh fixer (stuck >= 2 troca o fix pro node fixer-s{S}-r{R} com o fixer dedicado; fail-safe pro coder) por replace() na linha-ancora, guardado por LIKE + NOT LIKE (idempotente, preserva customizacao); R10 par do seed .ts',
    );
  }

  if (currentVersion < 134) {
    applyMigrationV134(db);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(134);
    logger.info(
      'Applied migration v134 - spec-gpt56 S4: default codex vira gpt-5.6-sol. UPDATE direcionado no seed dynamic-workflow-coder-codex ainda no default antigo (gpt-5.5), trocando SO model + codex_config.$.model via json_set pontual (sandbox/effort/chaves futuras preservados; json_valid guarda JSON corrompido; modelo customizado intocado); R10 par do seed .ts',
    );
  }

  if (currentVersion < 135) {
    applyMigrationV135(db);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(135);
    logger.info(
      'Applied migration v135 - remove Whisper local/FFmpeg: selecoes local-whisper migram para whisper-1; overrides de paths locais obsoletos sao removidos; arquivos do usuario permanecem intactos',
    );
  }

  if (currentVersion < 136) {
    applyMigrationV136(db);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(136);
    logger.info(
      'Applied migration v136 - branding LionDesign: troca o nome upstream nos prompts/descriptions dos tres seeds de design, preservando IDs, paths e IPCs internos',
    );
  }

  if (currentVersion < 137) {
    db.pragma('foreign_keys = OFF');
    try {
      applyMigrationV137(db);
    } finally {
      db.pragma('foreign_keys = ON');
    }
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(137);
    logger.info('Applied migration v137 - runtime Grok em agents e settings de effort/concurrency');
  }

  if (currentVersion < 138) {
    applyMigrationV138(db);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(138);
    logger.info('Applied migration v138 - ledger provider-neutral de subagentes');
  }

  if (currentVersion < 139) {
    applyMigrationV139(db);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(139);
    logger.info('Applied migration v139 - qualidade de metricas do enrich e resume idempotente da auditoria');
  }

  if (currentVersion < 140) {
    applyMigrationV140(db);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(140);
    logger.info('Applied migration v140 - qualidade persistente de custo/tokens do chat');
  }

  if (currentVersion < 141) {
    applyMigrationV141(db);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(141);
    logger.info('Applied migration v141 - breakdown persistente do runtime principal do chat');
  }

  if (currentVersion < 142) {
    applyMigrationV142(db);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(142);
    logger.info('Applied migration v142 - Claude Opus 5 como modelo do orquestrador');
  }

  if (currentVersion < 143) {
    applyMigrationV143(db);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(143);
    logger.info('Applied migration v143 - Bug Pipe: 6 seed agents + bug_analysis_agent_status');
  }

  if (currentVersion < 144) {
    applyMigrationV144(db);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(144);
    logger.info('Applied migration v144 - audit_log.source + auditoria de pipelines/harness/enrich');
  }

  if (currentVersion < 145) {
    applyMigrationV145(db);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(145);
    logger.info('Applied migration v145 - dynamic-workflow: validadores em haiku (roster por papel)');
  }

  if (currentVersion < 146) {
    applyMigrationV146(db);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(146);
    logger.info('Applied migration v146 - add cursor runtime to agents (SPEC cursor-runtime F1)');
  }

  if (currentVersion < 147) {
    applyMigrationV147(db);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(147);
    logger.info('Applied migration v147 - Kanban nativo: 4 tabelas kanban_* (SPEC kanban-nativo F1)');
  }

  if (currentVersion < 148) {
    applyMigrationV148(db);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(148);
    logger.info('Applied migration v148 - Claude Fable 5.1 substitui Fable 5 (orquestrador + agentes)');
  }

  if (currentVersion < 149) {
    applyMigrationV149(db);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(149);
    logger.info(
      'Applied migration v149 - dynamic_workflow_messages.applied_node_id/consumed_at (ajuste consumido, SPEC orquestrador-driver D8)',
    );
  }

  if (currentVersion < 150) {
    applyMigrationV150(db);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(150);
    logger.info(
      'Applied migration v150 - GPT-6 Astra vira o default do codex: UPDATE direcionado no seed dynamic-workflow-coder-codex ainda em gpt-5.6-sol (model + codex_config.$.model via json_set; customizacoes e settings explicitas intocadas); R10 par do seed .ts',
    );
  }

  if (currentVersion < 151) {
    applyMigrationV151(db);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(151);
    logger.info(
      'Applied migration v151 - writers do dynamic-workflow: maxTurns 80->150 (doc-writer 60->100) e allowedCommands com build/lint/diagnostico (follow-up L1.2/L1.8)',
    );
  }

  if (currentVersion < 152) {
    applyMigrationV152(db);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(152);
    logger.info(
      'Applied migration v152 - lanes: sessions.lane_badge/orchestrator_*/sdk_thread_history/dreaming_* + virada das conversas desktop ativas',
    );
  }
  if (currentVersion < 153) {
    applyMigrationV153(db);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(153);
  }
  if (currentVersion < 154) {
    applyMigrationV154(db);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(154);
    logger.info('Applied migration v154 - Kanban: actor lioncode + actor_detail em kanban_card_events');
  }

  if (currentVersion < 155) {
    applyMigrationV155(db);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(155);
    logger.info(
      'Applied migration v155 - timeline de tools: session_timeline_turns/events + lion_session_summaries com mode e selection_hash na PK',
    );
  }

  if (currentVersion < 156) {
    applyMigrationV156(db);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(156);
    logger.info(
      'Applied migration v156 - drive por lane: harness_projects.session_id + indice, backfill do config.drive.sessionId e saneamento de lane duplicada',
    );
  }

  if (currentVersion < 157) {
    applyMigrationV157(db);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(157);
    logger.info('Applied migration v157 - Claude Opus 5.5 como modelo do orquestrador (quem estava no Opus 5)');
  }

  if (currentVersion < 158) {
    applyMigrationV158(db);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(158);
    logger.info(
      'Applied migration v158 - GPT-6 Sol vira o default do codex: UPDATE direcionado no seed dynamic-workflow-coder-codex ainda em gpt-6-astra',
    );
  }

  if (currentVersion < 159) {
    applyMigrationV159(db);
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(159);
    logger.info(
      'Applied migration v159 - sub-agentes seguem o orquestrador: agents cloud em claude-opus-5 sobem para claude-opus-5-5 quando o orquestrador esta no Opus 5.5',
    );
  }
}

export function semanticMemoriesVecNeedsRepair(database: Database.Database): boolean {
  const row = database
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='semantic_memories_vec'")
    .get() as { sql: string | null } | undefined;
  const normalized = row?.sql?.replace(/\s+/g, '').toLowerCase() ?? '';
  return !normalized.includes('embeddingfloat[1536]');
}

function fixVecTableIfNeeded(): void {
  if (!semanticMemoriesVecNeedsRepair(db)) return;
  logger.info('Recreating semantic_memories_vec with correct schema (1536 dims)');
  db.exec('DROP TABLE IF EXISTS semantic_memories_vec');
  db.exec(`CREATE VIRTUAL TABLE semantic_memories_vec USING vec0(
    id TEXT PRIMARY KEY,
    embedding float[1536]
  )`);
}

const MIGRATION_V21 = `
  CREATE TABLE IF NOT EXISTS harness_projects (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    name TEXT NOT NULL,
    description TEXT,
    project_path TEXT NOT NULL,
    spec_path TEXT NOT NULL,
    sprints_json_path TEXT,
    status TEXT NOT NULL DEFAULT 'planning'
      CHECK (status IN ('planning', 'reviewing', 'ready', 'running', 'paused', 'done', 'failed')),
    config TEXT NOT NULL DEFAULT '{}',
    current_sprint_index INTEGER DEFAULT -1,
    total_sprints INTEGER DEFAULT 0,
    total_features INTEGER DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS harness_sprints (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    project_id TEXT NOT NULL REFERENCES harness_projects(id),
    sprint_index INTEGER NOT NULL,
    sprint_json_id TEXT NOT NULL,
    name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending', 'running', 'passed', 'failed', 'interrupted', 'skipped')),
    coder_agent_id TEXT,
    evaluator_agent_id TEXT,
    rounds_used INTEGER DEFAULT 0,
    max_rounds INTEGER DEFAULT 3,
    started_at TEXT,
    completed_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_harness_sprints_project ON harness_sprints(project_id);
  CREATE INDEX IF NOT EXISTS idx_harness_sprints_status ON harness_sprints(status);

  CREATE TABLE IF NOT EXISTS harness_rounds (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    sprint_id TEXT NOT NULL REFERENCES harness_sprints(id),
    round_number INTEGER NOT NULL,
    coder_session_id TEXT,
    coder_input_tokens INTEGER DEFAULT 0,
    coder_output_tokens INTEGER DEFAULT 0,
    coder_cache_tokens INTEGER DEFAULT 0,
    coder_cost_usd REAL DEFAULT 0,
    coder_duration_ms INTEGER DEFAULT 0,
    coder_tool_uses INTEGER DEFAULT 0,
    coder_api_requests INTEGER DEFAULT 0,
    evaluator_session_id TEXT,
    evaluator_input_tokens INTEGER DEFAULT 0,
    evaluator_output_tokens INTEGER DEFAULT 0,
    evaluator_cache_tokens INTEGER DEFAULT 0,
    evaluator_cost_usd REAL DEFAULT 0,
    evaluator_duration_ms INTEGER DEFAULT 0,
    evaluator_tool_uses INTEGER DEFAULT 0,
    evaluator_api_requests INTEGER DEFAULT 0,
    verdict TEXT CHECK (verdict IN ('pass', 'fail')),
    feedback_summary TEXT,
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at TEXT,
    unknown_cost_count INTEGER NOT NULL DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_harness_rounds_sprint ON harness_rounds(sprint_id);
`;

const MIGRATION_V22 = `
  ALTER TABLE harness_projects ADD COLUMN planner_input_tokens INTEGER DEFAULT 0;
  ALTER TABLE harness_projects ADD COLUMN planner_output_tokens INTEGER DEFAULT 0;
  ALTER TABLE harness_projects ADD COLUMN planner_cache_tokens INTEGER DEFAULT 0;
  ALTER TABLE harness_projects ADD COLUMN planner_cost_usd REAL DEFAULT 0;
  ALTER TABLE harness_projects ADD COLUMN planner_duration_ms INTEGER DEFAULT 0;
`;

const MIGRATION_V23 = `
  CREATE TABLE IF NOT EXISTS workflow_runs (
    id TEXT PRIMARY KEY,
    workflow_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    current_stage INTEGER DEFAULT 1,
    notes_path TEXT,
    status TEXT DEFAULT 'active' CHECK (status IN ('active', 'generating', 'completed', 'cancelled')),
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_workflow_runs_status ON workflow_runs(status);
  CREATE INDEX IF NOT EXISTS idx_workflow_runs_workflow_id ON workflow_runs(workflow_id);
`;

const MIGRATION_V24 = `
  CREATE TABLE IF NOT EXISTS workflow_runs_new (
    id TEXT PRIMARY KEY,
    workflow_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    current_stage INTEGER DEFAULT 1,
    notes_path TEXT,
    status TEXT DEFAULT 'active' CHECK (status IN ('active', 'generating', 'completed', 'cancelled')),
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at TEXT
  );
  INSERT OR IGNORE INTO workflow_runs_new SELECT * FROM workflow_runs;
  DROP TABLE workflow_runs;
  ALTER TABLE workflow_runs_new RENAME TO workflow_runs;
  CREATE INDEX IF NOT EXISTS idx_workflow_runs_status ON workflow_runs(status);
  CREATE INDEX IF NOT EXISTS idx_workflow_runs_workflow_id ON workflow_runs(workflow_id);
`;

const MIGRATION_V25 = `
  CREATE TABLE IF NOT EXISTS workflow_runs_new (
    id TEXT PRIMARY KEY,
    workflow_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    current_stage INTEGER DEFAULT 1,
    current_question TEXT DEFAULT 'Q1',
    notes_path TEXT,
    status TEXT DEFAULT 'active' CHECK (status IN ('active', 'generating', 'completed', 'cancelled')),
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at TEXT
  );
  INSERT OR IGNORE INTO workflow_runs_new
    SELECT id, workflow_id, session_id, current_stage, 'Q1', notes_path, status, started_at, updated_at, completed_at
    FROM workflow_runs;
  DROP TABLE workflow_runs;
  ALTER TABLE workflow_runs_new RENAME TO workflow_runs;
  CREATE INDEX IF NOT EXISTS idx_workflow_runs_status ON workflow_runs(status);
  CREATE INDEX IF NOT EXISTS idx_workflow_runs_workflow_id ON workflow_runs(workflow_id);
`;

const MIGRATION_V26 = `
  CREATE TABLE IF NOT EXISTS enrich_sessions (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    spec_path TEXT NOT NULL,
    project_path TEXT,
    prd_path TEXT,
    user_message TEXT,
    validator_agent_id TEXT NOT NULL,
    enricher_agent_id TEXT NOT NULL DEFAULT 'spec-enricher',
    phase TEXT NOT NULL DEFAULT 'validator' CHECK (phase IN ('validator', 'enricher', 'done')),
    status TEXT NOT NULL DEFAULT 'idle' CHECK (status IN ('idle', 'running', 'waiting', 'finalizing', 'done')),
    final_spec_path TEXT,
    validator_input_tokens INTEGER DEFAULT 0,
    validator_output_tokens INTEGER DEFAULT 0,
    validator_cache_read_tokens INTEGER DEFAULT 0,
    validator_cache_creation_tokens INTEGER DEFAULT 0,
    validator_cost_usd REAL DEFAULT 0,
    validator_duration_ms INTEGER DEFAULT 0,
    validator_tool_uses INTEGER DEFAULT 0,
    validator_api_requests INTEGER DEFAULT 0,
    validator_messages INTEGER DEFAULT 0,
    enricher_input_tokens INTEGER DEFAULT 0,
    enricher_output_tokens INTEGER DEFAULT 0,
    enricher_cache_read_tokens INTEGER DEFAULT 0,
    enricher_cache_creation_tokens INTEGER DEFAULT 0,
    enricher_cost_usd REAL DEFAULT 0,
    enricher_duration_ms INTEGER DEFAULT 0,
    enricher_tool_uses INTEGER DEFAULT 0,
    enricher_api_requests INTEGER DEFAULT 0,
    enricher_messages INTEGER DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`;

const MIGRATION_V27 = `
  CREATE TABLE IF NOT EXISTS enrich_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES enrich_sessions(id) ON DELETE CASCADE,
    phase TEXT NOT NULL CHECK (phase IN ('validator', 'enricher')),
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content TEXT NOT NULL DEFAULT '',
    tool_calls TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_enrich_messages_session ON enrich_messages(session_id, phase);
`;

const MIGRATION_V28 = `
  -- Rebuild FTS5 table with unicode61 tokenizer for accent-insensitive search
  DROP TABLE IF EXISTS semantic_memories_fts;
  CREATE VIRTUAL TABLE semantic_memories_fts USING fts5(
    content,
    topic,
    content_rowid='id',
    tokenize='unicode61 remove_diacritics 2'
  );
  INSERT INTO semantic_memories_fts(rowid, content, topic)
    SELECT id, content, COALESCE(topic, '') FROM semantic_memories;
`;

const MIGRATION_V29 = `
  CREATE TABLE IF NOT EXISTS ingest_jobs (
    id TEXT PRIMARY KEY,
    file_name TEXT NOT NULL,
    source_type TEXT NOT NULL,
    original_path TEXT,
    file_hash TEXT,
    status TEXT NOT NULL DEFAULT 'extracting'
      CHECK (status IN ('extracting', 'estimating', 'waiting_confirm', 'processing', 'completed', 'failed')),
    total_chunks INTEGER DEFAULT 0,
    processed_chunks INTEGER DEFAULT 0,
    last_processed_chunk INTEGER DEFAULT -1,
    notes_created INTEGER DEFAULT 0,
    notes_updated INTEGER DEFAULT 0,
    estimated_cost_usd REAL,
    error TEXT,
    started_at TEXT NOT NULL,
    completed_at TEXT,
    created_note_paths TEXT DEFAULT '[]'
  );

  CREATE INDEX IF NOT EXISTS idx_ingest_jobs_status ON ingest_jobs(status);
  CREATE INDEX IF NOT EXISTS idx_ingest_jobs_started ON ingest_jobs(started_at);
`;

const MIGRATION_V30 = `
  -- Allow 'partial' status for ingest_jobs (recreate CHECK via new column trick not needed in SQLite,
  -- but we can drop the constraint by recreating the table or just rely on application-level validation).
  -- SQLite doesn't support ALTER TABLE ... DROP CONSTRAINT, so we add an index on file_hash for dup detection.
  CREATE INDEX IF NOT EXISTS idx_ingest_jobs_file_hash ON ingest_jobs(file_hash);
`;

const MIGRATION_V31 = `
  -- Pipeline phase metrics: one row per phase per project execution
  CREATE TABLE IF NOT EXISTS pipeline_phase_metrics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL REFERENCES harness_projects(id) ON DELETE CASCADE,
    phase_number INTEGER NOT NULL,
    phase_name TEXT NOT NULL,
    agent_id TEXT,
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending', 'running', 'completed', 'failed', 'skipped', 'interrupted')),
    input_tokens INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0,
    cache_read_tokens INTEGER DEFAULT 0,
    cache_creation_tokens INTEGER DEFAULT 0,
    cost_usd REAL DEFAULT 0,
    duration_ms INTEGER DEFAULT 0,
    tool_uses INTEGER DEFAULT 0,
    api_requests INTEGER DEFAULT 0,
    messages_count INTEGER DEFAULT 0,
    model TEXT,
    runtime TEXT,
    started_at TEXT,
    completed_at TEXT,
    metadata TEXT DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(project_id, phase_number)
  );

  CREATE INDEX IF NOT EXISTS idx_pipeline_phase_project ON pipeline_phase_metrics(project_id);
  CREATE INDEX IF NOT EXISTS idx_pipeline_phase_number ON pipeline_phase_metrics(project_id, phase_number);

  -- Pipeline messages: persisted chat messages per phase
  CREATE TABLE IF NOT EXISTS pipeline_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL REFERENCES harness_projects(id) ON DELETE CASCADE,
    phase_number INTEGER NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
    content TEXT NOT NULL DEFAULT '',
    tool_calls TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_pipeline_messages_project ON pipeline_messages(project_id);
  CREATE INDEX IF NOT EXISTS idx_pipeline_messages_phase ON pipeline_messages(project_id, phase_number);

  -- Extra columns on harness_projects for pipeline orchestration
  ALTER TABLE harness_projects ADD COLUMN pipeline_start_phase INTEGER DEFAULT NULL;
  ALTER TABLE harness_projects ADD COLUMN pipeline_current_phase INTEGER DEFAULT NULL;
  ALTER TABLE harness_projects ADD COLUMN discovery_notes_path TEXT DEFAULT NULL;
  ALTER TABLE harness_projects ADD COLUMN prd_path TEXT DEFAULT NULL;
`;

const MIGRATION_V32_MIGRATE_HARNESS_TO_PIPELINE = `
  -- Phase 8 (Planner) from harness_projects planner columns
  INSERT OR IGNORE INTO pipeline_phase_metrics
    (project_id, phase_number, phase_name, agent_id, status,
     input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
     cost_usd, duration_ms, tool_uses, api_requests, model, started_at, completed_at)
  SELECT
    hp.id,
    8,
    'Planner',
    'harness-planner',
    CASE WHEN hp.planner_cost_usd > 0 THEN 'completed' ELSE 'skipped' END,
    COALESCE(hp.planner_input_tokens, 0),
    COALESCE(hp.planner_output_tokens, 0),
    COALESCE(hp.planner_cache_tokens, 0),
    0,
    COALESCE(hp.planner_cost_usd, 0),
    COALESCE(hp.planner_duration_ms, 0),
    0,
    0,
    NULL,
    hp.created_at,
    hp.updated_at
  FROM harness_projects hp
  WHERE hp.id NOT IN (SELECT DISTINCT project_id FROM pipeline_phase_metrics)
    AND (hp.planner_cost_usd > 0 OR hp.planner_input_tokens > 0);

  -- Phase 10 (Coder) aggregated from harness_rounds
  INSERT OR IGNORE INTO pipeline_phase_metrics
    (project_id, phase_number, phase_name, agent_id, status,
     input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
     cost_usd, duration_ms, tool_uses, api_requests, model, started_at, completed_at)
  SELECT
    s.project_id,
    10,
    'Coder',
    'harness-coder',
    'completed',
    COALESCE(SUM(r.coder_input_tokens), 0),
    COALESCE(SUM(r.coder_output_tokens), 0),
    COALESCE(SUM(r.coder_cache_tokens), 0),
    0,
    COALESCE(SUM(r.coder_cost_usd), 0),
    COALESCE(SUM(r.coder_duration_ms), 0),
    COALESCE(SUM(r.coder_tool_uses), 0),
    COALESCE(SUM(r.coder_api_requests), 0),
    NULL,
    MIN(r.started_at),
    MAX(r.completed_at)
  FROM harness_rounds r
  JOIN harness_sprints s ON s.id = r.sprint_id
  WHERE s.project_id NOT IN (SELECT DISTINCT project_id FROM pipeline_phase_metrics WHERE phase_number = 10)
  GROUP BY s.project_id;

  -- Phase 11 (Evaluator) aggregated from harness_rounds
  INSERT OR IGNORE INTO pipeline_phase_metrics
    (project_id, phase_number, phase_name, agent_id, status,
     input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
     cost_usd, duration_ms, tool_uses, api_requests, model, started_at, completed_at)
  SELECT
    s.project_id,
    11,
    'Evaluator',
    'harness-evaluator',
    'completed',
    COALESCE(SUM(r.evaluator_input_tokens), 0),
    COALESCE(SUM(r.evaluator_output_tokens), 0),
    COALESCE(SUM(r.evaluator_cache_tokens), 0),
    0,
    COALESCE(SUM(r.evaluator_cost_usd), 0),
    COALESCE(SUM(r.evaluator_duration_ms), 0),
    COALESCE(SUM(r.evaluator_tool_uses), 0),
    COALESCE(SUM(r.evaluator_api_requests), 0),
    NULL,
    MIN(r.started_at),
    MAX(r.completed_at)
  FROM harness_rounds r
  JOIN harness_sprints s ON s.id = r.sprint_id
  WHERE s.project_id NOT IN (SELECT DISTINCT project_id FROM pipeline_phase_metrics WHERE phase_number = 11)
  GROUP BY s.project_id;
`;

const MIGRATION_V33_SPRINT_INDEX_COLUMN = `
  -- 1. Create new table with sprint_index column and updated UNIQUE constraint
  CREATE TABLE pipeline_phase_metrics_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL REFERENCES harness_projects(id) ON DELETE CASCADE,
    phase_number INTEGER NOT NULL,
    sprint_index INTEGER NOT NULL DEFAULT -1,
    phase_name TEXT NOT NULL,
    agent_id TEXT,
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending', 'running', 'completed', 'failed', 'skipped', 'interrupted')),
    input_tokens INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0,
    cache_read_tokens INTEGER DEFAULT 0,
    cache_creation_tokens INTEGER DEFAULT 0,
    cost_usd REAL DEFAULT 0,
    duration_ms INTEGER DEFAULT 0,
    tool_uses INTEGER DEFAULT 0,
    api_requests INTEGER DEFAULT 0,
    messages_count INTEGER DEFAULT 0,
    model TEXT,
    runtime TEXT,
    started_at TEXT,
    completed_at TEXT,
    metadata TEXT DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(project_id, phase_number, sprint_index)
  );

  -- 2. Copy non-sprint rows (phases that are NOT 10/11 from the old aggregated V32 migration)
  INSERT INTO pipeline_phase_metrics_new
    (id, project_id, phase_number, sprint_index, phase_name, agent_id, status,
     input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
     cost_usd, duration_ms, tool_uses, api_requests, messages_count,
     model, runtime, started_at, completed_at, metadata, created_at)
  SELECT
    id, project_id, phase_number, -1, phase_name, agent_id, status,
    input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
    cost_usd, duration_ms, tool_uses, api_requests, messages_count,
    model, runtime, started_at, completed_at, metadata, created_at
  FROM pipeline_phase_metrics
  WHERE phase_number NOT IN (10, 11);

  -- 3. Drop old table and rename new one
  DROP TABLE pipeline_phase_metrics;
  ALTER TABLE pipeline_phase_metrics_new RENAME TO pipeline_phase_metrics;

  -- 4. Recreate indexes
  CREATE INDEX IF NOT EXISTS idx_pipeline_phase_project ON pipeline_phase_metrics(project_id);
  CREATE INDEX IF NOT EXISTS idx_pipeline_phase_number ON pipeline_phase_metrics(project_id, phase_number);

  -- 5. Insert Coder (phase 10) metrics PER SPRINT from harness_rounds
  --    Uses the ACTUAL coder_agent_id from harness_sprints (not generic 'harness-coder')
  INSERT OR IGNORE INTO pipeline_phase_metrics
    (project_id, phase_number, sprint_index, phase_name, agent_id, status,
     input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
     cost_usd, duration_ms, tool_uses, api_requests, model, started_at, completed_at, metadata)
  SELECT
    s.project_id,
    10,
    s.sprint_index,
    'Coder',
    COALESCE(s.coder_agent_id, 'harness-coder'),
    'completed',
    COALESCE(SUM(r.coder_input_tokens), 0),
    COALESCE(SUM(r.coder_output_tokens), 0),
    COALESCE(SUM(r.coder_cache_tokens), 0),
    0,
    COALESCE(SUM(r.coder_cost_usd), 0),
    COALESCE(SUM(r.coder_duration_ms), 0),
    COALESCE(SUM(r.coder_tool_uses), 0),
    COALESCE(SUM(r.coder_api_requests), 0),
    NULL,
    MIN(r.started_at),
    MAX(r.completed_at),
    json_object('sprintIndex', s.sprint_index, 'sprintName', s.name)
  FROM harness_rounds r
  JOIN harness_sprints s ON s.id = r.sprint_id
  GROUP BY s.project_id, s.sprint_index;

  -- 6. Insert Evaluator (phase 11) metrics PER SPRINT from harness_rounds
  --    Uses the ACTUAL evaluator_agent_id from harness_sprints
  INSERT OR IGNORE INTO pipeline_phase_metrics
    (project_id, phase_number, sprint_index, phase_name, agent_id, status,
     input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
     cost_usd, duration_ms, tool_uses, api_requests, model, started_at, completed_at, metadata)
  SELECT
    s.project_id,
    11,
    s.sprint_index,
    'Evaluator',
    COALESCE(s.evaluator_agent_id, 'harness-evaluator'),
    'completed',
    COALESCE(SUM(r.evaluator_input_tokens), 0),
    COALESCE(SUM(r.evaluator_output_tokens), 0),
    COALESCE(SUM(r.evaluator_cache_tokens), 0),
    0,
    COALESCE(SUM(r.evaluator_cost_usd), 0),
    COALESCE(SUM(r.evaluator_duration_ms), 0),
    COALESCE(SUM(r.evaluator_tool_uses), 0),
    COALESCE(SUM(r.evaluator_api_requests), 0),
    NULL,
    MIN(r.started_at),
    MAX(r.completed_at),
    json_object('sprintIndex', s.sprint_index, 'sprintName', s.name)
  FROM harness_rounds r
  JOIN harness_sprints s ON s.id = r.sprint_id
  GROUP BY s.project_id, s.sprint_index;
`;

const MIGRATION_V34_FIX_AGENT_IDS = `
  -- Fix Coder (phase 10) agent_id: use harness_sprints.coder_agent_id when available
  UPDATE pipeline_phase_metrics
  SET agent_id = (
    SELECT s.coder_agent_id
    FROM harness_sprints s
    WHERE s.project_id = pipeline_phase_metrics.project_id
      AND s.sprint_index = pipeline_phase_metrics.sprint_index
    LIMIT 1
  )
  WHERE phase_number = 10
    AND sprint_index >= 0
    AND EXISTS (
      SELECT 1 FROM harness_sprints s
      WHERE s.project_id = pipeline_phase_metrics.project_id
        AND s.sprint_index = pipeline_phase_metrics.sprint_index
        AND s.coder_agent_id IS NOT NULL
        AND s.coder_agent_id != ''
    );

  -- Fix Evaluator (phase 11) agent_id: use harness_sprints.evaluator_agent_id when available
  UPDATE pipeline_phase_metrics
  SET agent_id = (
    SELECT s.evaluator_agent_id
    FROM harness_sprints s
    WHERE s.project_id = pipeline_phase_metrics.project_id
      AND s.sprint_index = pipeline_phase_metrics.sprint_index
    LIMIT 1
  )
  WHERE phase_number = 11
    AND sprint_index >= 0
    AND EXISTS (
      SELECT 1 FROM harness_sprints s
      WHERE s.project_id = pipeline_phase_metrics.project_id
        AND s.sprint_index = pipeline_phase_metrics.sprint_index
        AND s.evaluator_agent_id IS NOT NULL
        AND s.evaluator_agent_id != ''
    );
`;

const MIGRATION_V35_HARNESS_STATUS_IDLE = `
  CREATE TABLE harness_projects_new (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    name TEXT NOT NULL,
    description TEXT,
    project_path TEXT NOT NULL,
    spec_path TEXT NOT NULL,
    sprints_json_path TEXT,
    status TEXT NOT NULL DEFAULT 'idle'
      CHECK (status IN ('idle', 'planning', 'reviewing', 'ready', 'running', 'paused', 'done', 'failed')),
    config TEXT NOT NULL DEFAULT '{}',
    current_sprint_index INTEGER DEFAULT -1,
    total_sprints INTEGER DEFAULT 0,
    total_features INTEGER DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    planner_input_tokens INTEGER DEFAULT 0,
    planner_output_tokens INTEGER DEFAULT 0,
    planner_cache_tokens INTEGER DEFAULT 0,
    planner_cost_usd REAL DEFAULT 0,
    planner_duration_ms INTEGER DEFAULT 0,
    pipeline_start_phase INTEGER DEFAULT NULL,
    pipeline_current_phase INTEGER DEFAULT NULL,
    discovery_notes_path TEXT DEFAULT NULL,
    prd_path TEXT DEFAULT NULL
  );

  INSERT INTO harness_projects_new
    SELECT
      id, name, description, project_path, spec_path, sprints_json_path,
      status, config, current_sprint_index, total_sprints, total_features,
      created_at, updated_at,
      planner_input_tokens, planner_output_tokens, planner_cache_tokens,
      planner_cost_usd, planner_duration_ms,
      pipeline_start_phase, pipeline_current_phase,
      discovery_notes_path, prd_path
    FROM harness_projects;

  DROP TABLE harness_projects;
  ALTER TABLE harness_projects_new RENAME TO harness_projects;

  CREATE INDEX IF NOT EXISTS idx_harness_projects_status ON harness_projects(status);
`;

const MIGRATION_V36_PIPELINE_STATE = `
  ALTER TABLE harness_projects ADD COLUMN pipeline_tech_substep TEXT DEFAULT NULL;
  ALTER TABLE harness_projects ADD COLUMN pipeline_sprint_index INTEGER DEFAULT 0;
  ALTER TABLE harness_projects ADD COLUMN pipeline_discovery_block INTEGER DEFAULT 1;
`;

const MIGRATION_V37_DROP_TECH_SUBSTEP = `
  CREATE TABLE harness_projects_v37 (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    name TEXT NOT NULL,
    description TEXT,
    project_path TEXT NOT NULL,
    spec_path TEXT NOT NULL,
    sprints_json_path TEXT,
    status TEXT NOT NULL DEFAULT 'idle'
      CHECK (status IN ('idle', 'planning', 'reviewing', 'ready', 'running', 'paused', 'done', 'failed')),
    config TEXT NOT NULL DEFAULT '{}',
    current_sprint_index INTEGER DEFAULT -1,
    total_sprints INTEGER DEFAULT 0,
    total_features INTEGER DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    planner_input_tokens INTEGER DEFAULT 0,
    planner_output_tokens INTEGER DEFAULT 0,
    planner_cache_tokens INTEGER DEFAULT 0,
    planner_cost_usd REAL DEFAULT 0,
    planner_duration_ms INTEGER DEFAULT 0,
    pipeline_start_phase INTEGER DEFAULT NULL,
    pipeline_current_phase INTEGER DEFAULT NULL,
    discovery_notes_path TEXT DEFAULT NULL,
    prd_path TEXT DEFAULT NULL,
    pipeline_sprint_index INTEGER DEFAULT 0,
    pipeline_discovery_block INTEGER DEFAULT 1
  );

  INSERT INTO harness_projects_v37
    SELECT
      id, name, description, project_path, spec_path, sprints_json_path,
      status, config, current_sprint_index, total_sprints, total_features,
      created_at, updated_at,
      planner_input_tokens, planner_output_tokens, planner_cache_tokens,
      planner_cost_usd, planner_duration_ms,
      pipeline_start_phase, pipeline_current_phase,
      discovery_notes_path, prd_path,
      pipeline_sprint_index, pipeline_discovery_block
    FROM harness_projects;

  DROP TABLE harness_projects;
  ALTER TABLE harness_projects_v37 RENAME TO harness_projects;

  CREATE INDEX IF NOT EXISTS idx_harness_projects_status ON harness_projects(status);

  -- Cleanup pipeline data from obsolete phase numbering (phase >= 5)
  UPDATE harness_projects SET pipeline_current_phase = NULL WHERE pipeline_current_phase >= 5;
  DELETE FROM pipeline_phase_metrics WHERE phase_number >= 5;
  DELETE FROM pipeline_messages WHERE phase_number >= 5;
`;

const MIGRATION_V38_PIPELINE_MSG_SPRINT_COLS = `
  ALTER TABLE pipeline_messages ADD COLUMN sprint_index INTEGER DEFAULT NULL;
  ALTER TABLE pipeline_messages ADD COLUMN round_index INTEGER DEFAULT NULL;
  ALTER TABLE pipeline_messages ADD COLUMN agent_id TEXT DEFAULT NULL;

  CREATE INDEX IF NOT EXISTS idx_pipeline_messages_sprint
    ON pipeline_messages(project_id, phase_number, sprint_index, round_index);

  ALTER TABLE pipeline_phase_metrics ADD COLUMN round_index INTEGER DEFAULT NULL;

  CREATE INDEX IF NOT EXISTS idx_pipeline_phase_metrics_sprint
    ON pipeline_phase_metrics(project_id, phase_number, sprint_index, round_index);
`;

const MIGRATION_V39_HARNESS_SPRINT_VERDICT = `
  CREATE TABLE harness_sprints_v39 (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    project_id TEXT NOT NULL REFERENCES harness_projects(id),
    sprint_index INTEGER NOT NULL,
    sprint_json_id TEXT NOT NULL,
    name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending', 'running', 'passed', 'rejected', 'failed', 'interrupted', 'skipped')),
    verdict TEXT DEFAULT NULL,
    coder_agent_id TEXT,
    evaluator_agent_id TEXT,
    rounds_used INTEGER DEFAULT 0,
    max_rounds INTEGER DEFAULT 3,
    started_at TEXT,
    completed_at TEXT,
    updated_at TEXT DEFAULT (datetime('now')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  INSERT INTO harness_sprints_v39
    SELECT
      id, project_id, sprint_index, sprint_json_id, name, status,
      NULL AS verdict,
      coder_agent_id, evaluator_agent_id, rounds_used, max_rounds,
      started_at, completed_at,
      datetime('now') AS updated_at,
      created_at
    FROM harness_sprints;

  DROP TABLE harness_sprints;
  ALTER TABLE harness_sprints_v39 RENAME TO harness_sprints;

  CREATE INDEX IF NOT EXISTS idx_harness_sprints_project ON harness_sprints(project_id);
  CREATE INDEX IF NOT EXISTS idx_harness_sprints_status ON harness_sprints(status);
`;

const MIGRATION_V40_RECONCILE_LEGACY_SESSION_TYPES = `
  UPDATE sessions
  SET type = 'scheduled'
  WHERE task_id IS NOT NULL
    AND type = 'chat';

  UPDATE sessions
  SET type = 'telegram'
  WHERE title LIKE '[Telegram]%'
    AND type = 'chat'
    AND task_id IS NULL;
`;

const MIGRATION_V41_SECURITY_PIPELINE = `
  ALTER TABLE harness_projects ADD COLUMN pipeline_type TEXT NOT NULL DEFAULT 'development';

  CREATE TABLE IF NOT EXISTS security_agent_status (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL REFERENCES harness_projects(id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL,
    agent_name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    findings_count INTEGER DEFAULT 0,
    output_file TEXT,
    started_at TEXT,
    completed_at TEXT,
    error_message TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_security_agent_status_project ON security_agent_status(project_id);
`;

const MIGRATION_V42_SECURITY_SUMMARY = `
  ALTER TABLE harness_projects ADD COLUMN security_summary_json TEXT DEFAULT NULL;
`;

const MIGRATION_V43 = `
  CREATE TABLE agents_new (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    system_prompt TEXT DEFAULT '',
    model TEXT DEFAULT 'claude-sonnet-4-6',
    allowed_tools TEXT DEFAULT '[]',
    mcp_servers TEXT DEFAULT '[]',
    is_active INTEGER DEFAULT 1,
    sort_order INTEGER DEFAULT 0,
    effort TEXT DEFAULT 'medium',
    thinking TEXT DEFAULT 'adaptive',
    thinking_budget INTEGER,
    max_turns INTEGER,
    skills TEXT DEFAULT '[]',
    kb_enabled INTEGER NOT NULL DEFAULT 1,
    runtime TEXT DEFAULT 'cloud'
      CHECK (runtime IN ('cloud', 'local', 'external')),
    local_config TEXT DEFAULT NULL,
    external_config TEXT DEFAULT NULL,
    local_mode TEXT DEFAULT 'simple',
    max_tool_rounds INTEGER DEFAULT 5,
    squad TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  INSERT INTO agents_new (
    id, name, description, system_prompt, model, allowed_tools, mcp_servers,
    is_active, sort_order, effort, thinking, thinking_budget, max_turns,
    skills, kb_enabled, runtime, local_config, local_mode, max_tool_rounds, squad,
    created_at, updated_at
  )
  SELECT
    id, name, description, system_prompt, model, allowed_tools, mcp_servers,
    is_active, sort_order, effort, thinking, thinking_budget, max_turns,
    skills, kb_enabled, runtime, local_config, local_mode, max_tool_rounds, squad,
    created_at, updated_at
  FROM agents;

  DROP TABLE agents;
  ALTER TABLE agents_new RENAME TO agents;
`;

const MIGRATION_V44 = `
  ALTER TABLE harness_rounds ADD COLUMN cost_source TEXT;
  ALTER TABLE harness_rounds ADD COLUMN runtime_used TEXT;
  ALTER TABLE harness_rounds ADD COLUMN provider_used TEXT;
  ALTER TABLE harness_rounds ADD COLUMN model_used TEXT;
`;

const MIGRATION_V45 = `
  ALTER TABLE harness_projects ADD COLUMN pipeline_docs_id TEXT DEFAULT NULL;
`;

const MIGRATION_V46 = `
  ALTER TABLE harness_rounds ADD COLUMN metadata TEXT DEFAULT '{}';
`;

const MIGRATION_V47 = `
  CREATE TABLE agents_new (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    system_prompt TEXT DEFAULT '',
    model TEXT DEFAULT 'claude-sonnet-4-6',
    allowed_tools TEXT DEFAULT '[]',
    mcp_servers TEXT DEFAULT '[]',
    is_active INTEGER DEFAULT 1,
    sort_order INTEGER DEFAULT 0,
    effort TEXT DEFAULT 'medium',
    thinking TEXT DEFAULT 'adaptive',
    thinking_budget INTEGER,
    max_turns INTEGER,
    skills TEXT DEFAULT '[]',
    kb_enabled INTEGER NOT NULL DEFAULT 1,
    runtime TEXT DEFAULT 'cloud'
      CHECK (runtime IN ('cloud', 'local', 'external', 'codex')),
    local_config TEXT DEFAULT NULL,
    external_config TEXT DEFAULT NULL,
    codex_config TEXT DEFAULT NULL,
    local_mode TEXT DEFAULT 'simple',
    max_tool_rounds INTEGER DEFAULT 5,
    squad TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  INSERT INTO agents_new (
    id, name, description, system_prompt, model, allowed_tools, mcp_servers,
    is_active, sort_order, effort, thinking, thinking_budget, max_turns,
    skills, kb_enabled, runtime, local_config, external_config, local_mode,
    max_tool_rounds, squad, created_at, updated_at,
    codex_config
  )
  SELECT
    id, name, description, system_prompt, model, allowed_tools, mcp_servers,
    is_active, sort_order, effort, thinking, thinking_budget, max_turns,
    skills, kb_enabled, runtime, local_config, external_config, local_mode,
    max_tool_rounds, squad, created_at, updated_at,
    NULL AS codex_config
  FROM agents;

  DROP TABLE agents;
  ALTER TABLE agents_new RENAME TO agents;
`;

const MIGRATION_V48_EXPAND_PROJECT_STATUS_CHECK = `
  CREATE TABLE harness_projects_v48 (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    name TEXT NOT NULL,
    description TEXT,
    project_path TEXT NOT NULL,
    spec_path TEXT NOT NULL,
    sprints_json_path TEXT,
    status TEXT NOT NULL DEFAULT 'idle'
      CHECK (status IN (
        'idle', 'planning', 'reviewing', 'ready',
        'running', 'paused', 'done', 'failed',
        'aborted', 'interrupted'
      )),
    config TEXT NOT NULL DEFAULT '{}',
    current_sprint_index INTEGER DEFAULT -1,
    total_sprints INTEGER DEFAULT 0,
    total_features INTEGER DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    planner_input_tokens INTEGER DEFAULT 0,
    planner_output_tokens INTEGER DEFAULT 0,
    planner_cache_tokens INTEGER DEFAULT 0,
    planner_cost_usd REAL DEFAULT 0,
    planner_duration_ms INTEGER DEFAULT 0,
    pipeline_start_phase INTEGER DEFAULT NULL,
    pipeline_current_phase INTEGER DEFAULT NULL,
    discovery_notes_path TEXT DEFAULT NULL,
    prd_path TEXT DEFAULT NULL,
    pipeline_sprint_index INTEGER DEFAULT 0,
    pipeline_discovery_block INTEGER DEFAULT 1,
    pipeline_type TEXT NOT NULL DEFAULT 'development',
    security_summary_json TEXT DEFAULT NULL,
    pipeline_docs_id TEXT DEFAULT NULL
  );

  INSERT INTO harness_projects_v48
    SELECT
      id, name, description, project_path, spec_path, sprints_json_path,
      status, config, current_sprint_index, total_sprints, total_features,
      created_at, updated_at,
      planner_input_tokens, planner_output_tokens, planner_cache_tokens,
      planner_cost_usd, planner_duration_ms,
      pipeline_start_phase, pipeline_current_phase,
      discovery_notes_path, prd_path,
      pipeline_sprint_index, pipeline_discovery_block,
      pipeline_type, security_summary_json, pipeline_docs_id
    FROM harness_projects;

  DROP TABLE harness_projects;
  ALTER TABLE harness_projects_v48 RENAME TO harness_projects;

  CREATE INDEX IF NOT EXISTS idx_harness_projects_status ON harness_projects(status);
  CREATE INDEX IF NOT EXISTS idx_harness_projects_pipeline_type ON harness_projects(pipeline_type);
`;

export function getHarnessProjectsCreateSql(database: Database.Database): string | null {
  const row = database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='harness_projects'").get() as
    { sql: string | null } | undefined;
  return row?.sql ?? null;
}

export function harnessProjectStatusCheckSupportsTerminalStates(database: Database.Database): boolean {
  const sql = getHarnessProjectsCreateSql(database);
  if (!sql) return false;
  return sql.includes("'aborted'") && sql.includes("'interrupted'");
}

export function ensureHarnessProjectStatusCheckExpanded(database: Database.Database): void {
  if (harnessProjectStatusCheckSupportsTerminalStates(database)) return;
  if (getHarnessProjectsCreateSql(database) === null) return;
  database.pragma('foreign_keys = OFF');
  try {
    database.exec(MIGRATION_V48_EXPAND_PROJECT_STATUS_CHECK);
    logger.info(
      'ensureHarnessProjectStatusCheckExpanded: applied schema-real migration (CHECK was missing aborted/interrupted)',
    );
  } finally {
    database.pragma('foreign_keys = ON');
  }
}

const MIGRATION_V49_FIX_AGENT_SQUADS = `
  UPDATE agents SET squad = 'pipeline'
    WHERE id IN ('tech-database', 'tech-backend', 'tech-frontend', 'tech-security')
      AND squad = 'workflow';

  UPDATE agents SET squad = 'harness'
    WHERE squad IS NULL AND id IN ('harness-coder', 'harness-planner', 'harness-evaluator');

  UPDATE agents SET squad = 'pipeline'
    WHERE squad IS NULL AND id IN ('repo-profiler', 'spec-builder', 'spec-validator');

  UPDATE agents SET squad = 'security'
    WHERE squad IS NULL AND id IN (
      'security-secrets-scanner', 'security-auth-auditor', 'security-isolation-inspector',
      'security-duplication-detector', 'security-logic-analyzer', 'security-standards-checker',
      'security-owasp-scanner', 'security-deduplicator', 'security-skeptic-security',
      'security-skeptic-quality', 'security-resolution-tracker'
    );
`;

function applyMigrationV49Tools(database: Database.Database): void {
  const OLD_TOOLS = '["Read","Grep","Glob"]';
  const NEW_TOOLS = '["Read","Grep","Glob","Bash"]';
  database
    .prepare(`UPDATE agents SET allowed_tools = ? WHERE id = 'security-secrets-scanner' AND allowed_tools = ?`)
    .run(NEW_TOOLS, OLD_TOOLS);
}

function applyMigrationV52TechWriteRemoval(database: Database.Database): void {
  const OLD_TOOLS = '["Read","Write","Edit","Glob","Grep"]';
  const NEW_TOOLS = '["Read","Edit","Glob","Grep"]';
  const AGENT_IDS = [
    'feat-tech-database',
    'feat-tech-backend',
    'feat-tech-frontend',
    'feat-tech-security',
    'tech-database',
    'tech-backend',
    'tech-frontend',
    'tech-security',
  ];
  const stmt = database.prepare(`UPDATE agents SET allowed_tools = ? WHERE id = ? AND allowed_tools = ?`);
  for (const id of AGENT_IDS) {
    stmt.run(NEW_TOOLS, id, OLD_TOOLS);
  }
}

const MIGRATION_V51 = `
  CREATE TABLE IF NOT EXISTS codex_windows_prep_consent (
    repo_root TEXT PRIMARY KEY,
    prep_version INTEGER NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('prepared', 'skip')),
    consented_at INTEGER NOT NULL,
    last_applied_at INTEGER
  );

  ALTER TABLE harness_rounds ADD COLUMN codex_patch_failures INTEGER DEFAULT 0;
`;

const MIGRATION_V20 = `
  CREATE TABLE IF NOT EXISTS task_executions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT REFERENCES sessions(id),
    task_id TEXT NOT NULL,
    tool_use_id TEXT,
    agent_id TEXT,
    agent_name TEXT,
    model TEXT,
    description TEXT,
    status TEXT DEFAULT 'running',
    summary TEXT,
    input_tokens INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0,
    cache_read_tokens INTEGER DEFAULT 0,
    cache_creation_tokens INTEGER DEFAULT 0,
    cost_usd REAL DEFAULT 0,
    api_requests INTEGER DEFAULT 0,
    tool_uses INTEGER DEFAULT 0,
    duration_ms INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_task_exec_session ON task_executions(session_id);
  CREATE INDEX IF NOT EXISTS idx_task_exec_agent ON task_executions(agent_id);
  CREATE INDEX IF NOT EXISTS idx_task_exec_created ON task_executions(created_at);
  CREATE INDEX IF NOT EXISTS idx_task_exec_status ON task_executions(status);
`;

const MIGRATION_V19 = `
  ALTER TABLE agents ADD COLUMN squad TEXT DEFAULT NULL;
`;

const MIGRATION_V17 = `
  CREATE TABLE IF NOT EXISTS tasks (
    id              TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    title           TEXT NOT NULL,
    description     TEXT,
    category        TEXT,
    status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'done')),
    priority        TEXT DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high')),
    due_date        TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
    done_at         TEXT,
    done_comment    TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
  CREATE INDEX IF NOT EXISTS idx_tasks_due_date ON tasks(due_date);
  CREATE INDEX IF NOT EXISTS idx_tasks_category ON tasks(category);
`;

const MIGRATION_V16 = `
  CREATE TABLE IF NOT EXISTS mcp_tool_registry (
    mcp_id    TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    description TEXT,
    PRIMARY KEY (mcp_id, tool_name)
  );
`;

const MIGRATION_V15 = `
  CREATE TABLE knowledge_sources (
    id              TEXT PRIMARY KEY,
    agent_id        TEXT NOT NULL,
    file_name       TEXT NOT NULL,
    file_type       TEXT NOT NULL CHECK(file_type IN ('pdf','docx','txt','md','csv')),
    file_size       INTEGER NOT NULL,
    file_path       TEXT NOT NULL,
    title           TEXT,
    description     TEXT,
    status          TEXT NOT NULL DEFAULT 'pending'
                      CHECK(status IN ('pending','processing','completed','failed')),
    chunks_count    INTEGER DEFAULT 0,
    chunk_strategy  TEXT NOT NULL DEFAULT 'recursive',
    chunk_size      INTEGER DEFAULT 1000,
    chunk_overlap   INTEGER DEFAULT 200,
    quality_score   REAL,
    best_strategy   TEXT,
    error_message   TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    processed_at    TEXT,
    updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
  );
  CREATE INDEX idx_ksources_agent_id ON knowledge_sources(agent_id);
  CREATE INDEX idx_ksources_status   ON knowledge_sources(status);

  CREATE TABLE knowledge_chunks (
    id              TEXT PRIMARY KEY,
    source_id       TEXT NOT NULL,
    agent_id        TEXT NOT NULL,
    chunk_index     INTEGER NOT NULL,
    content         TEXT NOT NULL,
    token_count     INTEGER NOT NULL,
    metadata        TEXT NOT NULL DEFAULT '{}',
    strategy_used   TEXT NOT NULL,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (source_id) REFERENCES knowledge_sources(id) ON DELETE CASCADE,
    FOREIGN KEY (agent_id)  REFERENCES agents(id) ON DELETE CASCADE
  );
  CREATE INDEX idx_kchunks_source_id ON knowledge_chunks(source_id);
  CREATE INDEX idx_kchunks_agent_id  ON knowledge_chunks(agent_id);

  CREATE VIRTUAL TABLE knowledge_chunks_vec USING vec0(
    chunk_id   TEXT PRIMARY KEY,
    embedding  FLOAT[1536]
  );

  CREATE VIRTUAL TABLE knowledge_chunks_fts USING fts5(
    chunk_id  UNINDEXED,
    agent_id  UNINDEXED,
    content,
    tokenize = 'unicode61'
  );

  CREATE TABLE knowledge_benchmarks (
    id              TEXT PRIMARY KEY,
    source_id       TEXT NOT NULL,
    agent_id        TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'running'
                      CHECK(status IN ('running','completed','failed')),
    winner_strategy TEXT,
    winner_score    REAL,
    questions       TEXT DEFAULT '[]',
    results         TEXT DEFAULT '{}',
    total_questions INTEGER DEFAULT 10,
    execution_time  INTEGER,
    model_judge     TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at    TEXT,
    FOREIGN KEY (source_id) REFERENCES knowledge_sources(id) ON DELETE CASCADE
  );
  CREATE INDEX idx_kbenchmarks_source_id ON knowledge_benchmarks(source_id);

  CREATE TABLE knowledge_agent_config (
    agent_id          TEXT PRIMARY KEY,
    hyde_enabled      INTEGER NOT NULL DEFAULT 1,
    hyde_threshold    REAL    NOT NULL DEFAULT 0.50,
    min_score         REAL    NOT NULL DEFAULT 0.40,
    default_strategy  TEXT    NOT NULL DEFAULT 'recursive',
    rerank_enabled    INTEGER NOT NULL DEFAULT 1,
    rerank_top_k      INTEGER NOT NULL DEFAULT 3,
    search_top_k      INTEGER NOT NULL DEFAULT 20,
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
  );

  ALTER TABLE agents ADD COLUMN kb_enabled INTEGER NOT NULL DEFAULT 1;
`;

const MIGRATION_V14 = `
  ALTER TABLE agents ADD COLUMN local_mode TEXT DEFAULT 'simple';
  ALTER TABLE agents ADD COLUMN max_tool_rounds INTEGER DEFAULT 5;
`;

const MIGRATION_V13 = `
  -- Migrate vector table from 768 dims (Ollama nomic-embed-text) to 1536 dims (OpenAI text-embedding-3-small).
  -- Old embeddings are incompatible and must be regenerated.
  DROP TABLE IF EXISTS semantic_memories_vec;
  CREATE VIRTUAL TABLE semantic_memories_vec USING vec0(
    id TEXT PRIMARY KEY,
    embedding float[1536]
  );

  -- Clear old embedding blobs (they're 768-dim, incompatible with new 1536-dim vec table)
  UPDATE semantic_memories SET embedding = NULL WHERE embedding IS NOT NULL;
`;

const MIGRATION_V12 = `
  CREATE VIRTUAL TABLE IF NOT EXISTS semantic_memories_fts USING fts5(
    content,
    topic,
    content_rowid='id'
  );

  -- Backfill existing semantic_memories into FTS5
  INSERT OR IGNORE INTO semantic_memories_fts(rowid, content, topic)
    SELECT id, content, COALESCE(topic, '') FROM semantic_memories;
`;

const MIGRATION_V11 = `
  ALTER TABLE agents ADD COLUMN runtime TEXT DEFAULT 'cloud'
    CHECK (runtime IN ('cloud', 'local'));
  ALTER TABLE agents ADD COLUMN local_config TEXT DEFAULT NULL;
`;

const MIGRATION_V8 = `
  ALTER TABLE scheduled_tasks ADD COLUMN tags TEXT DEFAULT '[]';
  ALTER TABLE task_runs ADD COLUMN scheduled_for DATETIME;
  CREATE INDEX IF NOT EXISTS idx_task_runs_scheduled_for ON task_runs(scheduled_for);
  CREATE INDEX IF NOT EXISTS idx_task_runs_status ON task_runs(status);
`;

const MIGRATION_V9 = `
  ALTER TABLE semantic_memories ADD COLUMN embedding BLOB;
  CREATE VIRTUAL TABLE IF NOT EXISTS semantic_memories_vec USING vec0(
    id TEXT PRIMARY KEY,
    embedding float[768]
  );
`;

const MIGRATION_V10 = `
  DROP TABLE IF EXISTS semantic_memories_vec;
  CREATE VIRTUAL TABLE semantic_memories_vec USING vec0(
    id TEXT PRIMARY KEY,
    embedding float[768]
  );
`;

const MIGRATION_V2 = `
  ALTER TABLE sessions ADD COLUMN input_tokens INTEGER DEFAULT 0;
  ALTER TABLE sessions ADD COLUMN output_tokens INTEGER DEFAULT 0;
  ALTER TABLE sessions ADD COLUMN cost_usd REAL DEFAULT 0;
  ALTER TABLE sessions ADD COLUMN status TEXT DEFAULT 'active';
  ALTER TABLE sessions ADD COLUMN max_tokens INTEGER DEFAULT 0;

  CREATE TABLE IF NOT EXISTS token_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT REFERENCES sessions(id),
    model TEXT NOT NULL,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens INTEGER DEFAULT 0,
    cache_creation_tokens INTEGER DEFAULT 0,
    cost_usd REAL NOT NULL DEFAULT 0,
    subagent TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_usage_session ON token_usage(session_id);
  CREATE INDEX IF NOT EXISTS idx_usage_created ON token_usage(created_at);
  CREATE INDEX IF NOT EXISTS idx_usage_model ON token_usage(model);
`;

const MIGRATION_V3 = `
  ALTER TABLE mcp_servers ADD COLUMN description TEXT;
`;

const MIGRATION_V4 = `
  ALTER TABLE agents ADD COLUMN effort TEXT DEFAULT 'medium';
  ALTER TABLE agents ADD COLUMN thinking TEXT DEFAULT 'adaptive';
  ALTER TABLE agents ADD COLUMN thinking_budget INTEGER DEFAULT NULL;
  ALTER TABLE agents ADD COLUMN max_turns INTEGER DEFAULT NULL;
  ALTER TABLE agents ADD COLUMN skills TEXT DEFAULT '[]';
`;

const MIGRATION_V5 = `
  ALTER TABLE sessions ADD COLUMN type TEXT DEFAULT 'chat'
    CHECK (type IN ('chat', 'scheduled', 'manual'));
  ALTER TABLE sessions ADD COLUMN task_id TEXT REFERENCES scheduled_tasks(id);
  ALTER TABLE task_runs ADD COLUMN session_id TEXT REFERENCES sessions(id);
  ALTER TABLE task_runs ADD COLUMN review_status TEXT DEFAULT NULL
    CHECK (review_status IN ('pending_review', 'validated', 'rejected'));
  ALTER TABLE task_runs ADD COLUMN review_note TEXT;
  ALTER TABLE task_runs ADD COLUMN reviewed_at DATETIME;
`;

const MIGRATION_V7 = `
  -- Cleanup in case previous migration attempt left sessions_new behind
  DROP TABLE IF EXISTS sessions_new;

  -- Recreate sessions table to expand type CHECK constraint to include 'telegram'
  CREATE TABLE sessions_new (
    id TEXT PRIMARY KEY,
    sdk_session_id TEXT,
    subagent TEXT,
    title TEXT,
    input_tokens INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0,
    cost_usd REAL DEFAULT 0,
    status TEXT DEFAULT 'active',
    max_tokens INTEGER DEFAULT 0,
    type TEXT DEFAULT 'chat'
      CHECK (type IN ('chat', 'scheduled', 'manual', 'telegram')),
    task_id TEXT REFERENCES scheduled_tasks(id),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  INSERT INTO sessions_new (id, sdk_session_id, subagent, title, input_tokens, output_tokens, cost_usd, status, max_tokens, type, task_id, created_at, updated_at)
    SELECT id, sdk_session_id, subagent, title,
      COALESCE(input_tokens, 0), COALESCE(output_tokens, 0), COALESCE(cost_usd, 0),
      COALESCE(status, 'active'), COALESCE(max_tokens, 0),
      COALESCE(type, 'chat'), task_id,
      created_at, updated_at
    FROM sessions;

  DROP TABLE sessions;

  ALTER TABLE sessions_new RENAME TO sessions;
`;

const MIGRATION_V6 = `
  CREATE TABLE IF NOT EXISTS channels (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL CHECK (type IN ('telegram', 'slack', 'discord', 'whatsapp')),
    name TEXT NOT NULL,
    config TEXT NOT NULL DEFAULT '{}',
    is_active INTEGER DEFAULT 0,
    status TEXT DEFAULT 'disconnected'
      CHECK (status IN ('connected', 'disconnected', 'error')),
    error_message TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`;

const MIGRATION_V1 = `
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS auth (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    password_hash TEXT NOT NULL,
    totp_secret TEXT,
    session_token TEXT,
    session_expires_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    sdk_session_id TEXT,
    subagent TEXT,
    title TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
    content TEXT NOT NULL,
    subagent TEXT,
    metadata TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
  CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);

  CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    system_prompt TEXT NOT NULL,
    model TEXT DEFAULT 'claude-sonnet-4-6',
    allowed_tools TEXT DEFAULT '[]',
    mcp_servers TEXT DEFAULT '[]',
    is_active INTEGER DEFAULT 1,
    sort_order INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS semantic_memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content TEXT NOT NULL,
    source_session TEXT REFERENCES sessions(id),
    topic TEXT,
    subagent TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_semantic_topic ON semantic_memories(topic);
  CREATE INDEX IF NOT EXISTS idx_semantic_created ON semantic_memories(created_at);

  CREATE TABLE IF NOT EXISTS daily_summaries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date DATE NOT NULL UNIQUE,
    summary TEXT NOT NULL,
    decisions TEXT,
    tasks_created TEXT,
    facts_extracted TEXT,
    message_count INTEGER DEFAULT 0,
    subagents_used TEXT,
    tokens_used INTEGER DEFAULT 0,
    cost_usd REAL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS compaction_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    period_start DATETIME NOT NULL,
    period_end DATETIME NOT NULL,
    messages_processed INTEGER DEFAULT 0,
    chunks_created INTEGER DEFAULT 0,
    facts_updated INTEGER DEFAULT 0,
    cost_usd REAL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS scheduled_tasks (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    prompt TEXT NOT NULL,
    subagent TEXT,
    schedule_type TEXT NOT NULL CHECK (schedule_type IN ('cron', 'interval', 'once')),
    schedule_value TEXT NOT NULL,
    status TEXT DEFAULT 'active' CHECK (status IN ('active', 'paused', 'completed')),
    last_run DATETIME,
    next_run DATETIME,
    run_count INTEGER DEFAULT 0,
    notify INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS task_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL REFERENCES scheduled_tasks(id),
    started_at DATETIME NOT NULL,
    completed_at DATETIME,
    status TEXT CHECK (status IN ('running', 'success', 'error')),
    result TEXT,
    error TEXT,
    tokens_used INTEGER DEFAULT 0,
    cost_usd REAL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS mcp_servers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    command TEXT NOT NULL,
    args TEXT DEFAULT '[]',
    env_keys TEXT DEFAULT '[]',
    is_active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT,
    subagent TEXT,
    event_type TEXT NOT NULL,
    tool_name TEXT,
    input TEXT,
    output TEXT,
    duration_ms INTEGER,
    approved INTEGER,
    source TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_audit_session ON audit_log(session_id);
  CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);
  CREATE INDEX IF NOT EXISTS idx_audit_type ON audit_log(event_type);
  CREATE INDEX IF NOT EXISTS idx_audit_source ON audit_log(source);
`;

export function createSession(
  id: string,
  title?: string,
  subagent?: string,
  options?: {
    type?: 'chat' | 'scheduled' | 'manual' | 'telegram';
    taskId?: string;
    orchestrator?: SessionOrchestrator | null;
  },
): ChatSession {
  const stmt = db.prepare(`
    INSERT INTO sessions (id, title, subagent, type, task_id,
      orchestrator_runtime, orchestrator_provider, orchestrator_model, orchestrator_effort)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    id,
    title ?? '',
    subagent ?? null,
    options?.type ?? 'chat',
    options?.taskId ?? null,
    options?.orchestrator?.runtime ?? null,
    options?.orchestrator?.provider ?? null,
    options?.orchestrator?.model ?? null,
    options?.orchestrator?.effort ?? null,
  );
  ensureChatFeatureToggles(id, options?.type ?? 'chat');
  return getSession(id)!;
}

export function getSession(id: string): ChatSession | undefined {
  const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  return mapSession(row);
}

export function getAllSessions(): ChatSession[] {
  const rows = db.prepare(ALL_SESSIONS_SQL).all() as Record<string, unknown>[];
  return rows.map(mapSession);
}

export function getScheduledSessions(): ChatSession[] {
  const rows = db.prepare("SELECT * FROM sessions WHERE type = 'scheduled' ORDER BY updated_at DESC").all() as Record<
    string,
    unknown
  >[];
  return rows.map(mapSession);
}

export function deleteScheduledSessions(): void {
  db.prepare("DELETE FROM messages WHERE session_id IN (SELECT id FROM sessions WHERE type = 'scheduled')").run();
  db.prepare("DELETE FROM sessions WHERE type = 'scheduled'").run();
}

export function updateSessionTitle(id: string, title: string): void {
  db.prepare(`UPDATE sessions SET title = ?, updated_at = datetime('now') WHERE id = ?`).run(title, id);
}

export function deleteSessionById(id: string): void {
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM messages WHERE session_id = ?').run(id);
    db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
  });
  tx();
}

export function deleteSessionsByIds(ids: string[], dbh: Database.Database = db): void {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => '?').join(', ');
  const tx = dbh.transaction(() => {
    dbh.prepare(`DELETE FROM messages WHERE session_id IN (${placeholders})`).run(...ids);
    dbh.prepare(`DELETE FROM sessions WHERE id IN (${placeholders})`).run(...ids);
  });
  tx();
}

export function getAllSessionIds(): string[] {
  const rows = db.prepare('SELECT id FROM sessions').all() as Array<{ id: string }>;
  return rows.map((row) => row.id);
}

export function trashSession(id: string): { success: boolean; error?: string } {
  const session = db.prepare('SELECT status FROM sessions WHERE id = ?').get(id) as { status: string } | undefined;

  if (!session) return { success: false, error: 'session_not_found' };
  if (session.status === 'active') return { success: false, error: 'cannot_trash_active_session' };
  if (session.status === 'trashed') return { success: false, error: 'already_trashed' };

  db.prepare(`UPDATE sessions SET status = 'trashed', updated_at = datetime('now') WHERE id = ?`).run(id);
  return { success: true };
}

const DESKTOP_SESSION_TYPES: ReadonlySet<string> = new Set(['chat', 'manual']);

export type SetChatFeatureTogglesRejectCode = 'session_not_found' | 'session_not_desktop' | 'session_not_active';

export type SetChatFeatureTogglesResult =
  { ok: true; toggles: ChatFeatureToggles } | { ok: false; code: SetChatFeatureTogglesRejectCode };

interface ChatSessionFeaturesRow {
  pipeline_control_enabled: number;
  dynamic_workflows_enabled: number;
  swarm_enabled: number;
}

export function getChatFeatureToggles(sessionId: string, dbh: Database.Database = db): ChatFeatureToggles | null {
  const row = dbh
    .prepare(
      `SELECT pipeline_control_enabled, dynamic_workflows_enabled, swarm_enabled
         FROM chat_session_features WHERE session_id = ?`,
    )
    .get(sessionId) as ChatSessionFeaturesRow | undefined;
  if (!row) return null;
  return {
    pipelineControl: row.pipeline_control_enabled !== 0,
    dynamicWorkflows: row.dynamic_workflows_enabled !== 0,
    swarm: row.swarm_enabled !== 0,
  };
}

export function ensureChatFeatureToggles(
  sessionId: string,
  type: 'chat' | 'scheduled' | 'manual' | 'telegram',
  dbh: Database.Database = db,
): void {
  if (!DESKTOP_SESSION_TYPES.has(type)) return;
  try {
    dbh
      .prepare(
        `INSERT OR IGNORE INTO chat_session_features
           (session_id, pipeline_control_enabled, dynamic_workflows_enabled)
         VALUES (?, 0, 0)`,
      )
      .run(sessionId);
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err), sessionId },
      'ensureChatFeatureToggles falhou (sessao segue sem linha; resolucao cai no default OFF)',
    );
  }
}

export function setChatFeatureToggles(
  sessionId: string,
  patch: Partial<ChatFeatureToggles>,
  dbh: Database.Database = db,
): SetChatFeatureTogglesResult {
  const session = dbh.prepare('SELECT type, status FROM sessions WHERE id = ?').get(sessionId) as
    { type: string | null; status: string | null } | undefined;
  if (!session) return { ok: false, code: 'session_not_found' };
  if (!DESKTOP_SESSION_TYPES.has(session.type ?? 'chat')) {
    return { ok: false, code: 'session_not_desktop' };
  }
  if ((session.status ?? 'active') !== 'active') {
    return { ok: false, code: 'session_not_active' };
  }

  const current = getChatFeatureToggles(sessionId, dbh) ?? {
    ...CHAT_CAPABILITIES_DEFAULT_OFF,
  };
  const next: ChatFeatureToggles = {
    pipelineControl: patch.pipelineControl ?? current.pipelineControl,
    dynamicWorkflows: patch.dynamicWorkflows ?? current.dynamicWorkflows,
    swarm: patch.swarm ?? current.swarm ?? false,
  };
  dbh
    .prepare(
      `INSERT INTO chat_session_features
         (session_id, pipeline_control_enabled, dynamic_workflows_enabled, swarm_enabled, updated_at)
       VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(session_id) DO UPDATE SET
         pipeline_control_enabled = excluded.pipeline_control_enabled,
         dynamic_workflows_enabled = excluded.dynamic_workflows_enabled,
         swarm_enabled = excluded.swarm_enabled,
         updated_at = CURRENT_TIMESTAMP`,
    )
    .run(sessionId, next.pipelineControl ? 1 : 0, next.dynamicWorkflows ? 1 : 0, next.swarm ? 1 : 0);
  return { ok: true, toggles: next };
}

type ChatCostStatus = NonNullable<ChatSession['costStatus']>;

function parseRuntimeCosts(value: unknown): Record<string, number> {
  try {
    const parsed = JSON.parse(String(value ?? '{}')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, number] =>
          typeof entry[1] === 'number' && Number.isFinite(entry[1]) && entry[1] >= 0,
      ),
    );
  } catch {
    return {};
  }
}

function parseRuntimeCostStatuses(value: unknown): Record<string, ChatCostStatus> {
  try {
    const parsed = JSON.parse(String(value ?? '{}')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, ChatCostStatus] =>
          entry[1] === 'known' || entry[1] === 'estimated-partial' || entry[1] === 'unknown',
      ),
    );
  } catch {
    return {};
  }
}

function worstChatCostStatus(current: ChatCostStatus | undefined, next: ChatCostStatus): ChatCostStatus {
  if (current === 'unknown' || next === 'unknown') return 'unknown';
  if (current === 'estimated-partial' || next === 'estimated-partial') return 'estimated-partial';
  return 'known';
}

function mapSession(row: Record<string, unknown>): ChatSession {
  const id = row['id'] as string;
  const subagents = getTaskExecutionRollup({
    ownerKind: 'chat',
    ownerId: id,
    executionKinds: ['subagent', 'native-task'],
  });
  const parentCostStatus =
    row['cost_status'] === 'unknown' || row['cost_status'] === 'estimated-partial' ? row['cost_status'] : 'known';
  const costStatus =
    subagents.costStatus === 'unknown' || parentCostStatus === 'unknown'
      ? 'unknown'
      : subagents.costStatus === 'estimated-partial' || parentCostStatus === 'estimated-partial'
        ? 'estimated-partial'
        : 'known';
  let parentReasons: string[] = [];
  try {
    const parsed = JSON.parse(String(row['cost_unknown_reasons'] ?? '[]')) as unknown;
    if (Array.isArray(parsed)) parentReasons = parsed.filter((value): value is string => typeof value === 'string');
  } catch {
    /* legacy/corrupt quality metadata */
  }
  const parentCostByRuntime = parseRuntimeCosts(row['parent_cost_by_runtime']);
  const costByRuntime = { ...parentCostByRuntime };
  for (const [runtime, cost] of Object.entries(subagents.costByRuntime)) {
    costByRuntime[runtime] = (costByRuntime[runtime] ?? 0) + cost;
  }
  const costStatusByRuntime = parseRuntimeCostStatuses(row['parent_cost_status_by_runtime']);
  for (const entry of subagents.usageMetadata.pricingProvenance) {
    costStatusByRuntime[entry.runtime] = worstChatCostStatus(costStatusByRuntime[entry.runtime], entry.costStatus);
  }
  const childSubscriptionEquivalentCost = subagents.usageMetadata.pricingProvenance
    .filter((entry) => entry.costEstimationKind === 'subscription-equivalent-payg')
    .reduce((sum, entry) => sum + entry.costUsd, 0);
  const subscriptionEquivalentCost =
    Number(row['parent_subscription_equivalent_cost_usd'] ?? 0) + childSubscriptionEquivalentCost;
  return {
    id,
    sdkSessionId: row['sdk_session_id'] as string | undefined,
    subagent: row['subagent'] as string | undefined,
    title: row['title'] as string | undefined,
    inputTokens: (row['input_tokens'] as number) || 0,
    outputTokens: (row['output_tokens'] as number) || 0,
    costUsd: (row['cost_usd'] as number) || 0,
    costStatus,
    tokenStatus:
      row['token_status'] === 'not_reported' || subagents.tokenStatus === 'not_reported' ? 'not_reported' : 'reported',
    unknownCostCount: ((row['unknown_cost_count'] as number) || 0) + subagents.unknownCostCount,
    costUnknownReasons: [...new Set([...parentReasons, ...subagents.costUnknownReasons])].sort(),
    costByRuntime,
    costStatusByRuntime,
    subscriptionEquivalentCost,
    status: (row['status'] as string as ChatSession['status']) || 'active',
    type: (row['type'] as ChatSession['type']) || 'chat',
    taskId: row['task_id'] as string | undefined,
    createdAt: row['created_at'] as string,
    updatedAt: row['updated_at'] as string,
    compactedUpToMessageId: (row['compacted_up_to_message_id'] as number | null) ?? undefined,
    rollingSummary: (row['rolling_summary'] as string | null) ?? undefined,
    pendingSeed: (row['pending_seed'] as string | null) ?? undefined,
    activeContextTokensEst: (row['active_context_tokens_est'] as number | null) ?? undefined,
    agenticContextTokensEst: (row['agentic_context_tokens_est'] as number | null) ?? undefined,
    threadResetMessageId: (row['thread_reset_message_id'] as number | null) ?? undefined,
    laneBadge: (row['lane_badge'] as number | null) ?? null,
    orchestrator: mapSessionOrchestrator(row),
    sdkThreadHistory: parseSdkThreadHistory(row['sdk_thread_history']),
    dreamingStartedAt: (row['dreaming_started_at'] as string | null) ?? undefined,
    dreamingTurnCount: (row['dreaming_turn_count'] as number | null) ?? 0,
  };
}

function mapSessionOrchestrator(row: Record<string, unknown>): SessionOrchestrator | null {
  const runtime = row['orchestrator_runtime'];
  const provider = row['orchestrator_provider'];
  const model = row['orchestrator_model'];
  if (typeof runtime !== 'string' || typeof provider !== 'string' || typeof model !== 'string') {
    return null;
  }
  if (!runtime || !provider || !model) return null;
  const effort = row['orchestrator_effort'];
  return {
    runtime: runtime as SessionOrchestrator['runtime'],
    provider: provider as SessionOrchestrator['provider'],
    model,
    ...(typeof effort === 'string' && effort ? { effort } : {}),
  };
}

function parseSdkThreadHistory(raw: unknown): string[] {
  if (typeof raw !== 'string' || !raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

export function threadIdOf(session: { id: string; sdkSessionId?: string | null }): string {
  return session.sdkSessionId ?? session.id;
}

const DESKTOP_CONVERSATION_SQL = `
  s.type IN ('chat', 'manual')
  AND s.task_id IS NULL
  AND (s.title IS NULL OR s.title NOT LIKE '[Scheduler]%')
  AND s.id NOT LIKE 'dw-drive-%'
`;

export interface OpenDesktopSessionRow {
  id: string;
  laneBadge: number;
  title: string;
  orchestrator: SessionOrchestrator | null;
  messageCount: number;
  lastUserMessageAt: string | null;
  createdAt: string;
  updatedAt: string;
  dreamingStartedAt: string | null;
}

export interface OpenDesktopSession extends OpenDesktopSessionRow {
  state: LaneSessionState;
}

export function listOpenDesktopSessionRows(): OpenDesktopSessionRow[] {
  const rows = db
    .prepare(
      `
    SELECT s.id, s.lane_badge, s.title, s.created_at, s.updated_at, s.dreaming_started_at,
           s.orchestrator_runtime, s.orchestrator_provider, s.orchestrator_model, s.orchestrator_effort,
           (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS message_count,
           (SELECT MAX(m.created_at) FROM messages m WHERE m.session_id = s.id AND m.role = 'user') AS last_user_message_at
    FROM sessions s
    WHERE s.status = 'active'
      AND s.lane_badge IS NOT NULL
      AND ${DESKTOP_CONVERSATION_SQL}
    ORDER BY s.lane_badge ASC
  `,
    )
    .all() as Record<string, unknown>[];
  return rows.map((row) => ({
    id: row['id'] as string,
    laneBadge: row['lane_badge'] as number,
    title: (row['title'] as string | null) ?? '',
    orchestrator: mapSessionOrchestrator(row),
    messageCount: (row['message_count'] as number) || 0,
    lastUserMessageAt: (row['last_user_message_at'] as string | null) ?? null,
    createdAt: row['created_at'] as string,
    updatedAt: row['updated_at'] as string,
    dreamingStartedAt: (row['dreaming_started_at'] as string | null) ?? null,
  }));
}

export function listOpenDesktopSessions(
  resolveState: (row: OpenDesktopSessionRow) => LaneSessionState,
): OpenDesktopSession[] {
  return listOpenDesktopSessionRows().map((row) => ({ ...row, state: resolveState(row) }));
}

export function getOpenLaneSessionById(id: string): OpenDesktopSessionRow | null {
  return listOpenDesktopSessionRows().find((row) => row.id === id) ?? null;
}

export function isOpenDesktopConversation(session: ChatSession): boolean {
  return (
    session.status === 'active' &&
    (session.type === 'chat' || session.type === 'manual') &&
    !session.taskId &&
    !(session.title ?? '').startsWith('[Scheduler]') &&
    !session.id.startsWith('dw-drive-')
  );
}

export function getSessionOrchestrator(sessionId: string): SessionOrchestrator | null {
  const row = db
    .prepare(
      `
    SELECT orchestrator_runtime, orchestrator_provider, orchestrator_model, orchestrator_effort
    FROM sessions WHERE id = ?
  `,
    )
    .get(sessionId) as Record<string, unknown> | undefined;
  if (!row) return null;
  return mapSessionOrchestrator(row);
}

export function setSessionOrchestrator(sessionId: string, orchestrator: SessionOrchestrator | null): void {
  db.prepare(
    `
    UPDATE sessions
    SET orchestrator_runtime = ?, orchestrator_provider = ?, orchestrator_model = ?, orchestrator_effort = ?
    WHERE id = ?
  `,
  ).run(
    orchestrator?.runtime ?? null,
    orchestrator?.provider ?? null,
    orchestrator?.model ?? null,
    orchestrator?.effort ?? null,
    sessionId,
  );
}

export function appendSdkThreadHistory(sessionId: string, threadId: string): void {
  const row = db.prepare('SELECT sdk_thread_history FROM sessions WHERE id = ?').get(sessionId) as
    { sdk_thread_history: string | null } | undefined;
  if (!row) return;
  const history = parseSdkThreadHistory(row.sdk_thread_history);
  if (history.includes(threadId)) return;
  history.push(threadId);
  db.prepare('UPDATE sessions SET sdk_thread_history = ? WHERE id = ?').run(JSON.stringify(history), sessionId);
}

export function countSessionMessages(sessionId: string): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM messages WHERE session_id = ?').get(sessionId) as
    { n: number } | undefined;
  return row?.n ?? 0;
}

export function setDreamingStartedAt(sessionId: string, startedAt: string | null): void {
  db.prepare('UPDATE sessions SET dreaming_started_at = ? WHERE id = ?').run(startedAt, sessionId);
}

export function getSessionsWithDreamingStarted(): ChatSession[] {
  const rows = db
    .prepare(
      `
    SELECT * FROM sessions
    WHERE dreaming_started_at IS NOT NULL AND status = 'active'
    ORDER BY dreaming_started_at ASC
  `,
    )
    .all() as Record<string, unknown>[];
  return rows.map(mapSession);
}

export type CreateLaneSessionResult = { ok: true; session: ChatSession } | { ok: false; code: 'lanes_full' };

export function createLaneSession(input: {
  orchestrator: SessionOrchestrator | null;
  reservedBadges?: Iterable<number>;
  maxLanes?: number;
}): CreateLaneSessionResult {
  const tx = db.transaction((): CreateLaneSessionResult => {
    const taken = listOpenDesktopSessionRows().map((row) => row.laneBadge);
    for (const badge of input.reservedBadges ?? []) taken.push(badge);
    const badge = pickFreeLaneBadge(taken, input.maxLanes ?? MAX_DESKTOP_LANES);
    if (badge === null) return { ok: false, code: 'lanes_full' };
    const id = crypto.randomUUID();
    db.prepare(
      `
      INSERT INTO sessions (id, title, subagent, type, task_id, lane_badge,
        orchestrator_runtime, orchestrator_provider, orchestrator_model, orchestrator_effort)
      VALUES (?, '', NULL, 'chat', NULL, ?, ?, ?, ?, ?)
    `,
    ).run(
      id,
      badge,
      input.orchestrator?.runtime ?? null,
      input.orchestrator?.provider ?? null,
      input.orchestrator?.model ?? null,
      input.orchestrator?.effort ?? null,
    );
    ensureChatFeatureToggles(id, 'chat');
    return { ok: true, session: getSession(id)! };
  });
  return tx.immediate();
}

export function replaceLaneSession(input: {
  sessionId: string;
  finalStatus: 'archived' | 'compacted';
  orchestrator: SessionOrchestrator | null;
  purgeActivityLog?: boolean;
}): { newSessionId: string | null } {
  const tx = db.transaction((): { newSessionId: string | null } => {
    const current = getSession(input.sessionId);
    if (!current) return { newSessionId: null };
    const badge = current.laneBadge ?? null;
    db.prepare(
      `
      UPDATE sessions
      SET status = ?, lane_badge = NULL, dreaming_started_at = NULL, updated_at = datetime('now')
      WHERE id = ?
    `,
    ).run(input.finalStatus, input.sessionId);
    if (input.purgeActivityLog) purgeActivityLog(input.sessionId);
    if (badge === null || !isOpenDesktopConversation({ ...current, status: 'active' })) {
      return { newSessionId: null };
    }
    const id = crypto.randomUUID();
    db.prepare(
      `
      INSERT INTO sessions (id, title, subagent, type, task_id, lane_badge,
        orchestrator_runtime, orchestrator_provider, orchestrator_model, orchestrator_effort)
      VALUES (?, '', ?, ?, NULL, ?, ?, ?, ?, ?)
    `,
    ).run(
      id,
      current.subagent ?? null,
      current.type,
      badge,
      input.orchestrator?.runtime ?? null,
      input.orchestrator?.provider ?? null,
      input.orchestrator?.model ?? null,
      input.orchestrator?.effort ?? null,
    );
    ensureChatFeatureToggles(id, current.type);
    rebindDriveSessions(input.sessionId, id);
    return { newSessionId: id };
  });
  return tx.immediate();
}

export function insertMessage(
  sessionId: string,
  role: 'user' | 'assistant' | 'system',
  content: string,
  subagent?: string,
  metadata?: string,
): number {
  const result = db
    .prepare(
      `
    INSERT INTO messages (session_id, role, content, subagent, metadata)
    VALUES (?, ?, ?, ?, ?)
  `,
    )
    .run(sessionId, role, content, subagent ?? null, metadata ?? null);

  db.prepare(`UPDATE sessions SET updated_at = datetime('now') WHERE id = ?`).run(sessionId);

  return result.lastInsertRowid as number;
}

export function getSessionMessages(sessionId: string): ChatMessage[] {
  const rows = db
    .prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC')
    .all(sessionId) as Record<string, unknown>[];
  return rows.map(mapMessage);
}

export function getSessionMessagesAfterFence(sessionId: string, fenceMessageId: number | null): ChatMessage[] {
  if (fenceMessageId === null) return getSessionMessages(sessionId);
  const rows = db
    .prepare('SELECT * FROM messages WHERE session_id = ? AND id > ? ORDER BY created_at ASC')
    .all(sessionId, fenceMessageId) as Record<string, unknown>[];
  return rows.map(mapMessage);
}

function mapMessage(row: Record<string, unknown>): ChatMessage {
  return {
    id: row['id'] as number,
    sessionId: row['session_id'] as string,
    role: row['role'] as 'user' | 'assistant' | 'system',
    content: row['content'] as string,
    subagent: row['subagent'] as string | undefined,
    metadata: row['metadata'] ? JSON.parse(row['metadata'] as string) : undefined,
    createdAt: row['created_at'] as string,
  };
}

function mapTimelineTurn(row: Record<string, unknown>): TimelineTurn {
  return {
    seqId: row['seq_id'] as number,
    runId: row['run_id'] as string,
    sessionId: row['session_id'] as string,
    turnIndex: row['turn_index'] as number,
    anchorMessageId: (row['anchor_message_id'] as number | null) ?? null,
    currentUserMessageId: (row['current_user_message_id'] as number | null) ?? null,
    assistantMessageId: (row['assistant_message_id'] as number | null) ?? null,
    origin: row['origin'] as TimelineTurnOrigin,
    runtime: row['runtime'] as TimelineRuntime,
    fidelity: row['fidelity'] as TimelineFidelity,
    status: row['status'] as TimelineTurn['status'],
    cwd: (row['cwd'] as string | null) ?? null,
    textTokensEst: (row['text_tokens_est'] as number | null) ?? null,
    toolTokensEst: (row['tool_tokens_est'] as number | null) ?? null,
    createdAt: row['created_at'] as string,
  };
}

function mapTimelineEvent(row: Record<string, unknown>): TimelineEvent {
  return {
    id: row['id'] as number,
    runId: row['run_id'] as string,
    sessionId: row['session_id'] as string,
    seq: row['seq'] as number,
    kind: row['kind'] as TimelineEventKind,
    toolUseId: (row['tool_use_id'] as string | null) ?? null,
    toolName: (row['tool_name'] as string | null) ?? null,
    content: row['content'] as string,
    toolCallsJson: (row['tool_calls_json'] as string | null) ?? null,
    reasoningContent: (row['reasoning_content'] as string | null) ?? null,
    isError: Number(row['is_error'] ?? 0) !== 0,
    originalBytes: (row['original_bytes'] as number | null) ?? null,
    spillPath: (row['spill_path'] as string | null) ?? null,
    createdAt: row['created_at'] as string,
  };
}

export interface InsertTimelineTurnInput {
  runId: string;
  sessionId: string;
  turnIndex: number;
  anchorMessageId: number | null;
  currentUserMessageId: number | null;
  origin: TimelineTurnOrigin;
  runtime: TimelineRuntime;
  fidelity: TimelineFidelity;
  cwd: string | null;
}

export interface InsertTimelineEventInput {
  runId: string;
  sessionId: string;
  seq: number;
  kind: TimelineEventKind;
  toolUseId?: string | null;
  toolName?: string | null;
  content: string;
  toolCallsJson?: string | null;
  reasoningContent?: string | null;
  isError?: boolean;
  originalBytes?: number | null;
  spillPath?: string | null;
}

export function insertTimelineTurn(input: InsertTimelineTurnInput, dbh: Database.Database = db): number {
  const result = dbh
    .prepare(
      `
    INSERT INTO session_timeline_turns
      (run_id, session_id, turn_index, anchor_message_id, current_user_message_id,
       origin, runtime, fidelity, status, cwd)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'interrupted', ?)
  `,
    )
    .run(
      input.runId,
      input.sessionId,
      input.turnIndex,
      input.anchorMessageId,
      input.currentUserMessageId,
      input.origin,
      input.runtime,
      input.fidelity,
      input.cwd,
    );
  return result.lastInsertRowid as number;
}

export function insertTimelineEvent(input: InsertTimelineEventInput, dbh: Database.Database = db): number {
  const result = dbh
    .prepare(
      `
    INSERT INTO session_timeline_events
      (run_id, session_id, seq, kind, tool_use_id, tool_name, content,
       tool_calls_json, reasoning_content, is_error, original_bytes, spill_path)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
    )
    .run(
      input.runId,
      input.sessionId,
      input.seq,
      input.kind,
      input.toolUseId ?? null,
      input.toolName ?? null,
      input.content,
      input.toolCallsJson ?? null,
      input.reasoningContent ?? null,
      input.isError ? 1 : 0,
      input.originalBytes ?? null,
      input.spillPath ?? null,
    );
  return result.lastInsertRowid as number;
}

export function setTimelineTurnStatus(runId: string, status: 'complete', dbh: Database.Database = db): void {
  dbh.prepare('UPDATE session_timeline_turns SET status = ? WHERE run_id = ?').run(status, runId);
}

export function setTimelineTurnMetrics(
  runId: string,
  textTokensEst: number | null,
  toolTokensEst: number | null,
  dbh: Database.Database = db,
): void {
  dbh
    .prepare('UPDATE session_timeline_turns SET text_tokens_est = ?, tool_tokens_est = ? WHERE run_id = ?')
    .run(textTokensEst, toolTokensEst, runId);
}

export function setTimelineTurnAssistantMessageId(runId: string, messageId: number, dbh: Database.Database = db): void {
  dbh.prepare('UPDATE session_timeline_turns SET assistant_message_id = ? WHERE run_id = ?').run(messageId, runId);
}

export function getTimelineTurnsAfterFence(
  sessionId: string,
  fenceMessageId: number | null,
  dbh: Database.Database = db,
): TimelineTurnWithEvents[] {
  const fenceClause = fenceMessageId === null ? '' : 'AND t.anchor_message_id > ?';
  const params: Array<string | number> =
    fenceMessageId === null ? [sessionId, sessionId] : [sessionId, fenceMessageId, sessionId];
  const rows = dbh
    .prepare(
      `
    SELECT t.* FROM session_timeline_turns t
    WHERE t.session_id = ?
      AND t.anchor_message_id IS NOT NULL
      ${fenceClause}
      AND EXISTS (
        SELECT 1 FROM messages m
        WHERE m.id = t.anchor_message_id AND m.session_id = ?
      )
    ORDER BY t.anchor_message_id, t.seq_id
  `,
    )
    .all(...params) as Record<string, unknown>[];

  const eventsStmt = dbh.prepare('SELECT * FROM session_timeline_events WHERE run_id = ? ORDER BY seq');
  return rows.map((row) => {
    const turn = mapTimelineTurn(row);
    const eventRows = eventsStmt.all(turn.runId) as Record<string, unknown>[];
    return { ...turn, events: eventRows.map(mapTimelineEvent) };
  });
}

export function upsertActivityLog(sessionId: string, turnIndex: number, ev: LiveActivityEvent): void {
  const inputTokens = ev.tokens?.input;
  const outputTokens = ev.tokens?.output;
  const cacheRead = ev.tokens?.cacheRead;
  const cacheCreation = ev.tokens?.cacheCreation;

  db.prepare(
    `
    INSERT INTO activity_log (
      session_id, turn_index, activity_id, parent_id, kind, label, description,
      agent_id, model, status, summary, file, command, files_changed, changed,
      exit_code, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
      cost_usd, tool_uses, duration_ms, started_at, ended_at, project_id
    ) VALUES (
      @session_id, @turn_index, @activity_id, @parent_id, @kind, @label, @description,
      @agent_id, @model, @status, @summary, @file, @command, @files_changed, @changed,
      @exit_code, @input_tokens, @output_tokens, @cache_read_tokens, @cache_creation_tokens,
      @cost_usd, @tool_uses, @duration_ms, @started_at, @ended_at, @project_id
    )
    ON CONFLICT(session_id, turn_index, activity_id) DO UPDATE SET
      parent_id = COALESCE(excluded.parent_id, activity_log.parent_id),
      kind = COALESCE(excluded.kind, activity_log.kind),
      label = COALESCE(NULLIF(excluded.label, ''), activity_log.label),
      description = COALESCE(excluded.description, activity_log.description),
      agent_id = COALESCE(excluded.agent_id, activity_log.agent_id),
      model = COALESCE(excluded.model, activity_log.model),
      status = COALESCE(excluded.status, activity_log.status),
      summary = COALESCE(excluded.summary, activity_log.summary),
      file = COALESCE(excluded.file, activity_log.file),
      command = COALESCE(excluded.command, activity_log.command),
      files_changed = COALESCE(excluded.files_changed, activity_log.files_changed),
      changed = COALESCE(excluded.changed, activity_log.changed),
      exit_code = COALESCE(excluded.exit_code, activity_log.exit_code),
      input_tokens = COALESCE(excluded.input_tokens, activity_log.input_tokens),
      output_tokens = COALESCE(excluded.output_tokens, activity_log.output_tokens),
      cache_read_tokens = COALESCE(excluded.cache_read_tokens, activity_log.cache_read_tokens),
      cache_creation_tokens = COALESCE(excluded.cache_creation_tokens, activity_log.cache_creation_tokens),
      cost_usd = COALESCE(excluded.cost_usd, activity_log.cost_usd),
      tool_uses = COALESCE(excluded.tool_uses, activity_log.tool_uses),
      duration_ms = COALESCE(excluded.duration_ms, activity_log.duration_ms),
      started_at = COALESCE(excluded.started_at, activity_log.started_at),
      ended_at = COALESCE(excluded.ended_at, activity_log.ended_at),
      project_id = COALESCE(excluded.project_id, activity_log.project_id)
  `,
  ).run({
    session_id: sessionId,
    turn_index: turnIndex,
    activity_id: ev.id,
    parent_id: ev.parentId ?? null,
    kind: ev.kind ?? null,
    label: ev.label ?? null,
    description: ev.description ?? null,
    agent_id: ev.agentId ?? null,
    model: ev.model ?? null,
    status: ev.status ?? null,
    summary: ev.summary ?? null,
    file: ev.file ?? null,
    command: ev.command ?? null,
    files_changed: ev.filesChanged ? JSON.stringify(ev.filesChanged) : null,
    changed: ev.changed === undefined ? null : ev.changed ? 1 : 0,
    exit_code: ev.exitCode ?? null,
    input_tokens: inputTokens ?? null,
    output_tokens: outputTokens ?? null,
    cache_read_tokens: cacheRead ?? null,
    cache_creation_tokens: cacheCreation ?? null,
    cost_usd: ev.costUsd ?? null,
    tool_uses: ev.toolUses ?? null,
    duration_ms: ev.durationMs ?? null,
    started_at: ev.startedAt ?? null,
    ended_at: ev.endedAt ?? null,
    project_id: ev.projectId ?? null,
  });
}

function mapActivityRow(row: Record<string, unknown>): LiveActivity {
  const filesChangedRaw = row['files_changed'] as string | null;
  const changedRaw = row['changed'] as number | null;
  const exitCodeRaw = row['exit_code'] as number | null;
  const inputTokens = (row['input_tokens'] as number | null) ?? 0;
  const outputTokens = (row['output_tokens'] as number | null) ?? 0;
  const cacheRead = (row['cache_read_tokens'] as number | null) ?? 0;
  const cacheCreation = (row['cache_creation_tokens'] as number | null) ?? 0;

  return {
    id: row['activity_id'] as string,
    parentId: (row['parent_id'] as string | null) ?? undefined,
    kind: row['kind'] as LiveActivity['kind'],
    label: row['label'] as string,
    status: row['status'] as LiveActivity['status'],
    agentId: (row['agent_id'] as string | null) ?? undefined,
    summary: (row['summary'] as string | null) ?? undefined,
    costUsd: (row['cost_usd'] as number | null) ?? undefined,
    durationMs: (row['duration_ms'] as number | null) ?? undefined,
    startedAt: (row['started_at'] as string | null) ?? undefined,
    endedAt: (row['ended_at'] as string | null) ?? undefined,
    turnIndex: row['turn_index'] as number,
    description: (row['description'] as string | null) ?? undefined,
    file: (row['file'] as string | null) ?? undefined,
    command: (row['command'] as string | null) ?? undefined,
    filesChanged: filesChangedRaw ? (JSON.parse(filesChangedRaw) as string[]) : undefined,
    changed: changedRaw === null ? undefined : changedRaw === 1,
    exitCode: exitCodeRaw ?? undefined,
    toolUses: (row['tool_uses'] as number | null) ?? undefined,
    projectId: (row['project_id'] as string | null) ?? undefined,
    tokens:
      inputTokens || outputTokens || cacheRead || cacheCreation
        ? { input: inputTokens, output: outputTokens, cacheRead, cacheCreation }
        : undefined,
  };
}

export function getActivityBlocks(sessionId: string): ActivityTurnBlock[] {
  const rows = db
    .prepare(
      `
    SELECT * FROM activity_log
    WHERE session_id = ?
    ORDER BY turn_index ASC, id ASC
  `,
    )
    .all(sessionId) as Record<string, unknown>[];

  const byTurn = new Map<number, Record<string, unknown>[]>();
  for (const row of rows) {
    const turnIndex = row['turn_index'] as number;
    const bucket = byTurn.get(turnIndex);
    if (bucket) bucket.push(row);
    else byTurn.set(turnIndex, [row]);
  }

  const blocks: ActivityTurnBlock[] = [];
  for (const [turnIndex, turnRows] of byTurn) {
    const items = turnRows.map(mapActivityRow);

    let tokens = 0;
    let costUsd = 0;
    let subagents = 0;
    let tools = 0;
    let startedAt: string | undefined;
    let endedAt: string | undefined;
    let hasRunning = false;
    let hasError = false;
    let hasStopped = false;

    for (const item of items) {
      if (item.kind === 'subagent') subagents += 1;
      else if (item.kind === 'tool') tools += 1;
      if (item.tokens) tokens += (item.tokens.input || 0) + (item.tokens.output || 0);
      costUsd += item.costUsd || 0;
      if (item.startedAt && (!startedAt || item.startedAt < startedAt)) startedAt = item.startedAt;
      if (item.endedAt && (!endedAt || item.endedAt > endedAt)) endedAt = item.endedAt;
      if (item.status === 'running') hasRunning = true;
      else if (item.status === 'error') hasError = true;
      else if (item.status === 'stopped') hasStopped = true;
    }

    const status: ActivityTurnBlock['status'] = hasRunning
      ? 'running'
      : hasError
        ? 'error'
        : hasStopped
          ? 'stopped'
          : 'done';

    blocks.push({
      turnIndex,
      sessionId,
      items,
      startedAt: startedAt ?? '',
      endedAt: hasRunning ? undefined : endedAt,
      totals: { tokens, costUsd, subagents, tools },
      status,
    });
  }

  return blocks;
}

export function getTurnIndexForUserMessage(sessionId: string, messageId: number): number {
  const row = db
    .prepare(
      `
    SELECT COUNT(*) AS c FROM messages
    WHERE session_id = ? AND role = 'user' AND id <= ?
  `,
    )
    .get(sessionId, messageId) as { c: number };
  return row.c;
}

export function getLatestUserTurnIndex(sessionId: string): number {
  const row = db
    .prepare(
      `
    SELECT COUNT(*) AS c FROM messages
    WHERE session_id = ? AND role = 'user'
  `,
    )
    .get(sessionId) as { c: number };
  return row.c;
}

export function purgeActivityLog(sessionId: string): void {
  db.prepare('DELETE FROM activity_log WHERE session_id = ?').run(sessionId);
}

export function getAllAgents(): AgentConfig[] {
  const rows = db.prepare('SELECT * FROM agents ORDER BY sort_order ASC').all() as Record<string, unknown>[];
  return rows.map(mapAgent);
}

export function getAgent(id: string): AgentConfig | undefined {
  const row = db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  return mapAgent(row);
}

export function insertAgent(agent: Omit<AgentConfig, 'sortOrder'> & { sortOrder?: number }): AgentConfig {
  const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order), 0) as m FROM agents').get() as { m: number };
  db.prepare(
    `
    INSERT INTO agents (id, name, description, system_prompt, model, allowed_tools, mcp_servers, is_active, sort_order, effort, thinking, thinking_budget, max_turns, skills, runtime, local_config, external_config, codex_config, local_mode, max_tool_rounds, squad, access, allow_bash, allowed_commands, allow_network)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    agent.id,
    agent.name,
    agent.description,
    agent.systemPrompt,
    agent.model,
    JSON.stringify(agent.allowedTools),
    JSON.stringify(agent.mcpServers),
    agent.isActive ? 1 : 0,
    agent.sortOrder ?? maxOrder.m + 1,
    agent.effort || 'medium',
    agent.thinking || 'adaptive',
    agent.thinkingBudget ?? null,
    agent.maxTurns ?? null,
    JSON.stringify(agent.skills || []),
    agent.runtime || 'cloud',
    agent.localConfig ? JSON.stringify(agent.localConfig) : null,
    agent.externalConfig ? JSON.stringify(agent.externalConfig) : null,
    agent.codexConfig ? JSON.stringify(agent.codexConfig) : null,
    agent.localMode || 'simple',
    agent.maxToolRounds ?? 5,
    agent.squad ?? null,
    agent.access ?? 'read-only',
    agent.allowBash ? 1 : 0,
    JSON.stringify(agent.allowedCommands ?? []),
    agent.allowNetwork ? 1 : 0,
  );
  return getAgent(agent.id)!;
}

export type AgentUpdatePatch = Omit<Partial<AgentConfig>, 'localConfig' | 'externalConfig' | 'codexConfig'> & {
  localConfig?: AgentConfig['localConfig'] | null;
  externalConfig?: AgentConfig['externalConfig'] | null;
  codexConfig?: AgentConfig['codexConfig'] | null;
};

export function updateAgent(id: string, updates: AgentUpdatePatch): AgentConfig {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.name !== undefined) {
    fields.push('name = ?');
    values.push(updates.name);
  }
  if (updates.description !== undefined) {
    fields.push('description = ?');
    values.push(updates.description);
  }
  if (updates.systemPrompt !== undefined) {
    fields.push('system_prompt = ?');
    values.push(updates.systemPrompt);
  }
  if (updates.model !== undefined) {
    fields.push('model = ?');
    values.push(updates.model);
  }
  if (updates.allowedTools !== undefined) {
    fields.push('allowed_tools = ?');
    values.push(JSON.stringify(updates.allowedTools));
  }
  if (updates.mcpServers !== undefined) {
    fields.push('mcp_servers = ?');
    values.push(JSON.stringify(updates.mcpServers));
  }
  if (updates.isActive !== undefined) {
    fields.push('is_active = ?');
    values.push(updates.isActive ? 1 : 0);
  }
  if (updates.sortOrder !== undefined) {
    fields.push('sort_order = ?');
    values.push(updates.sortOrder);
  }
  if (updates.effort !== undefined) {
    fields.push('effort = ?');
    values.push(updates.effort);
  }
  if (updates.thinking !== undefined) {
    fields.push('thinking = ?');
    values.push(updates.thinking);
  }
  if (updates.thinkingBudget !== undefined) {
    fields.push('thinking_budget = ?');
    values.push(updates.thinkingBudget);
  }
  if (updates.maxTurns !== undefined) {
    fields.push('max_turns = ?');
    values.push(updates.maxTurns);
  }
  if (updates.skills !== undefined) {
    fields.push('skills = ?');
    values.push(JSON.stringify(updates.skills));
  }
  if (updates.runtime !== undefined) {
    fields.push('runtime = ?');
    values.push(updates.runtime);
  }
  if (updates.localConfig !== undefined) {
    fields.push('local_config = ?');
    values.push(updates.localConfig === null ? null : JSON.stringify(updates.localConfig));
  }
  if (updates.externalConfig !== undefined) {
    fields.push('external_config = ?');
    values.push(updates.externalConfig === null ? null : JSON.stringify(updates.externalConfig));
  }
  if (updates.codexConfig !== undefined) {
    fields.push('codex_config = ?');
    values.push(updates.codexConfig === null ? null : JSON.stringify(updates.codexConfig));
  }
  if (updates.localMode !== undefined) {
    fields.push('local_mode = ?');
    values.push(updates.localMode);
  }
  if (updates.maxToolRounds !== undefined) {
    fields.push('max_tool_rounds = ?');
    values.push(updates.maxToolRounds);
  }
  if (updates.squad !== undefined) {
    fields.push('squad = ?');
    values.push(updates.squad);
  }
  if (updates.access !== undefined) {
    fields.push('access = ?');
    values.push(updates.access);
  }
  if (updates.allowBash !== undefined) {
    fields.push('allow_bash = ?');
    values.push(updates.allowBash ? 1 : 0);
  }
  if (updates.allowedCommands !== undefined) {
    fields.push('allowed_commands = ?');
    values.push(JSON.stringify(updates.allowedCommands));
  }
  if (updates.allowNetwork !== undefined) {
    fields.push('allow_network = ?');
    values.push(updates.allowNetwork ? 1 : 0);
  }

  if (fields.length > 0) {
    fields.push(`updated_at = datetime('now')`);
    values.push(id);
    db.prepare(`UPDATE agents SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  }
  return getAgent(id)!;
}

export function deleteAgent(id: string): void {
  db.prepare('DELETE FROM agents WHERE id = ?').run(id);
}

function mapAgent(row: Record<string, unknown>): AgentConfig {
  return {
    id: row['id'] as string,
    name: row['name'] as string,
    description: row['description'] as string,
    systemPrompt: row['system_prompt'] as string,
    model: row['model'] as string,
    allowedTools: JSON.parse((row['allowed_tools'] as string) || '[]'),
    mcpServers: JSON.parse((row['mcp_servers'] as string) || '[]'),
    isActive: (row['is_active'] as number) === 1,
    sortOrder: row['sort_order'] as number,
    effort: (row['effort'] as AgentConfig['effort']) || 'medium',
    thinking: (row['thinking'] as AgentConfig['thinking']) || 'adaptive',
    thinkingBudget: (row['thinking_budget'] as number) || undefined,
    maxTurns: (row['max_turns'] as number) || undefined,
    skills: JSON.parse((row['skills'] as string) || '[]'),
    kbEnabled: row['kb_enabled'] !== 0,
    runtime: (row['runtime'] as AgentConfig['runtime']) || 'cloud',
    localConfig: row['local_config'] ? JSON.parse(row['local_config'] as string) : undefined,
    externalConfig: row['external_config']
      ? (JSON.parse(row['external_config'] as string) as ExternalConfig)
      : undefined,
    codexConfig: row['codex_config'] ? (JSON.parse(row['codex_config'] as string) as CodexConfig) : undefined,
    localMode: (row['local_mode'] as AgentConfig['localMode']) || 'simple',
    maxToolRounds: (row['max_tool_rounds'] as number) || 5,
    squad: (row['squad'] as string) || undefined,
    access: (row['access'] as AgentConfig['access']) || 'read-only',
    allowBash: !!row['allow_bash'],
    allowedCommands: JSON.parse((row['allowed_commands'] as string) || '[]'),
    allowNetwork: !!row['allow_network'],
  };
}

export function insertAuditEntry(entry: Omit<AuditEntry, 'id' | 'createdAt'>): void {
  db.prepare(
    `
    INSERT INTO audit_log (session_id, subagent, event_type, tool_name, input, output, duration_ms, approved, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    entry.sessionId ?? null,
    entry.subagent ?? null,
    entry.eventType,
    entry.toolName ?? null,
    entry.input ?? null,
    entry.output ?? null,
    entry.durationMs ?? null,
    entry.approved !== undefined ? (entry.approved ? 1 : 0) : null,
    entry.source ?? 'chat',
  );
}

export function queryAuditLog(filters: LogFilters): AuditEntry[] {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters.sessionId) {
    conditions.push('session_id = ?');
    params.push(filters.sessionId);
  }
  if (filters.subagent) {
    conditions.push('subagent = ?');
    params.push(filters.subagent);
  }
  if (filters.eventType) {
    conditions.push('event_type = ?');
    params.push(filters.eventType);
  }
  if (filters.source) {
    conditions.push('source = ?');
    params.push(filters.source);
  }
  if (filters.from) {
    conditions.push('created_at >= ?');
    params.push(filters.from);
  }
  if (filters.to) {
    conditions.push('created_at <= ?');
    params.push(filters.to);
  }
  if (filters.search) {
    conditions.push('(tool_name LIKE ? OR input LIKE ? OR output LIKE ?)');
    const term = `%${filters.search}%`;
    params.push(term, term, term);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = filters.limit ?? 100;
  const offset = filters.offset ?? 0;

  const rows = db
    .prepare(`SELECT * FROM audit_log ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
    .all(...params, limit, offset) as Record<string, unknown>[];

  return rows.map(mapAudit);
}

function mapAudit(row: Record<string, unknown>): AuditEntry {
  return {
    id: row['id'] as number,
    sessionId: row['session_id'] as string | undefined,
    subagent: row['subagent'] as string | undefined,
    eventType: row['event_type'] as AuditEntry['eventType'],
    toolName: row['tool_name'] as string | undefined,
    input: row['input'] as string | undefined,
    output: row['output'] as string | undefined,
    durationMs: row['duration_ms'] as number | undefined,
    approved: row['approved'] !== null ? (row['approved'] as number) === 1 : undefined,
    source: (row['source'] ?? undefined) as AuditEntry['source'],
    createdAt: row['created_at'] as string,
  };
}

export function getSetting(key: string): string | undefined {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value;
}

export function setSetting(key: string, value: string): void {
  db.prepare(
    `
    INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `,
  ).run(key, value);
}

export interface OrchestratorCompactionSelectionSetting {
  runtime: string;
  provider: string;
  model: string;
}

export function setOrchestratorCompactionSelection(selection: OrchestratorCompactionSelectionSetting | null): void {
  if (selection && (!selection.runtime || !selection.provider || !selection.model)) {
    throw new Error('Compaction selection must be complete or null');
  }

  const upsert = db.prepare(`
    INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `);
  const remove = db.prepare(`
    DELETE FROM settings
    WHERE key IN (
      'orchestrator_compaction_runtime',
      'orchestrator_compaction_provider',
      'orchestrator_compaction_model'
    )
  `);

  db.transaction(() => {
    if (!selection) {
      remove.run();
      return;
    }
    upsert.run('orchestrator_compaction_runtime', selection.runtime);
    upsert.run('orchestrator_compaction_provider', selection.provider);
    upsert.run('orchestrator_compaction_model', selection.model);
  })();
}

const PERMISSION_BYPASS_KEY = 'permission:bypass';

export function getPermissionBypass(): boolean {
  return getSetting(PERMISSION_BYPASS_KEY) !== 'false';
}

export function setPermissionBypass(enabled: boolean): void {
  setSetting(PERMISSION_BYPASS_KEY, enabled ? 'true' : 'false');
}

const TELEGRAM_ARMED_KEY = 'telegram:armed';

export function getTelegramArmed(): boolean {
  return getSetting(TELEGRAM_ARMED_KEY) === 'true';
}

export function setTelegramArmed(enabled: boolean): void {
  setSetting(TELEGRAM_ARMED_KEY, enabled ? 'true' : 'false');
}

export function getAuthRow():
  | {
      password_hash: string;
      totp_secret: string | null;
      session_token: string | null;
      session_expires_at: string | null;
    }
  | undefined {
  return db.prepare('SELECT * FROM auth WHERE id = 1').get() as
    | {
        password_hash: string;
        totp_secret: string | null;
        session_token: string | null;
        session_expires_at: string | null;
      }
    | undefined;
}

export function createAuthRow(passwordHash: string): void {
  db.prepare('INSERT OR REPLACE INTO auth (id, password_hash) VALUES (1, ?)').run(passwordHash);
}

export function updateAuthSession(token: string, expiresAt: string): void {
  db.prepare('UPDATE auth SET session_token = ?, session_expires_at = ? WHERE id = 1').run(token, expiresAt);
}

export function clearAuthSession(): void {
  db.prepare('UPDATE auth SET session_token = NULL, session_expires_at = NULL WHERE id = 1').run();
}

export function setTotpSecret(secret: string): void {
  db.prepare('UPDATE auth SET totp_secret = ? WHERE id = 1').run(secret);
}

export function getAllMCPServers(): MCPServerConfig[] {
  const rows = db.prepare('SELECT * FROM mcp_servers').all() as Record<string, unknown>[];
  return rows.map((row) => ({
    id: row['id'] as string,
    name: row['name'] as string,
    description: (row['description'] as string) || undefined,
    command: row['command'] as string,
    args: JSON.parse((row['args'] as string) || '[]'),
    envKeys: JSON.parse((row['env_keys'] as string) || '[]'),
    isActive: (row['is_active'] as number) === 1,
  }));
}

export function getDailySummaries(from?: string, to?: string): DailySummary[] {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (from) {
    conditions.push('date >= ?');
    params.push(from);
  }
  if (to) {
    conditions.push('date <= ?');
    params.push(to);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows = db.prepare(`SELECT * FROM daily_summaries ${where} ORDER BY date DESC`).all(...params) as Record<
    string,
    unknown
  >[];
  return rows.map((row) => ({
    id: row['id'] as number,
    date: row['date'] as string,
    summary: row['summary'] as string,
    decisions: JSON.parse((row['decisions'] as string) || '[]'),
    tasksCreated: JSON.parse((row['tasks_created'] as string) || '[]'),
    factsExtracted: JSON.parse((row['facts_extracted'] as string) || '[]'),
    messageCount: row['message_count'] as number,
    subagentsUsed: JSON.parse((row['subagents_used'] as string) || '[]'),
    tokensUsed: row['tokens_used'] as number,
    costUsd: row['cost_usd'] as number,
  }));
}

export function updateSessionTokens(
  sessionId: string,
  inputTokens: number,
  outputTokens: number,
  costUsd: number,
  quality: {
    costStatus: 'known' | 'unknown' | 'estimated-partial';
    tokenStatus: 'reported' | 'not_reported';
    costUnknownReason?: string | null;
    runtime?: AgentConfig['runtime'];
    costEstimationKind?: 'subscription-equivalent-payg';
  } = { costStatus: 'known', tokenStatus: 'reported' },
): void {
  db.transaction(() => {
    const row = db
      .prepare(
        `
      SELECT cost_unknown_reasons, parent_cost_by_runtime, parent_cost_status_by_runtime
      FROM sessions WHERE id = ?
    `,
      )
      .get(sessionId) as
      | {
          cost_unknown_reasons: string | null;
          parent_cost_by_runtime: string | null;
          parent_cost_status_by_runtime: string | null;
        }
      | undefined;
    if (!row) return;
    let reasons: string[] = [];
    try {
      const parsed = JSON.parse(row.cost_unknown_reasons ?? '[]') as unknown;
      if (Array.isArray(parsed)) reasons = parsed.filter((value): value is string => typeof value === 'string');
    } catch {
      /* preserve accounting even if legacy metadata is malformed */
    }
    if (quality.costUnknownReason) reasons.push(quality.costUnknownReason);
    const parentCostByRuntime = parseRuntimeCosts(row.parent_cost_by_runtime);
    const parentCostStatusByRuntime = parseRuntimeCostStatuses(row.parent_cost_status_by_runtime);
    if (quality.runtime) {
      parentCostByRuntime[quality.runtime] = (parentCostByRuntime[quality.runtime] ?? 0) + costUsd;
      parentCostStatusByRuntime[quality.runtime] = worstChatCostStatus(
        parentCostStatusByRuntime[quality.runtime],
        quality.costStatus,
      );
    }
    db.prepare(
      `
      UPDATE sessions
      SET input_tokens = input_tokens + ?,
          output_tokens = output_tokens + ?,
          cost_usd = cost_usd + ?,
          cost_status = CASE
            WHEN cost_status = 'unknown' OR ? = 'unknown' THEN 'unknown'
            WHEN cost_status = 'estimated-partial' OR ? = 'estimated-partial' THEN 'estimated-partial'
            ELSE 'known'
          END,
          token_status = CASE
            WHEN token_status = 'not_reported' OR ? = 'not_reported' THEN 'not_reported'
            ELSE 'reported'
          END,
          unknown_cost_count = unknown_cost_count + ?,
          cost_unknown_reasons = ?,
          parent_cost_by_runtime = ?,
          parent_cost_status_by_runtime = ?,
          parent_subscription_equivalent_cost_usd = parent_subscription_equivalent_cost_usd + ?,
          updated_at = datetime('now')
      WHERE id = ?
    `,
    ).run(
      inputTokens,
      outputTokens,
      costUsd,
      quality.costStatus,
      quality.costStatus,
      quality.tokenStatus,
      quality.costStatus === 'unknown' ? 1 : 0,
      JSON.stringify([...new Set(reasons)].sort()),
      JSON.stringify(parentCostByRuntime),
      JSON.stringify(parentCostStatusByRuntime),
      quality.costEstimationKind === 'subscription-equivalent-payg' ? costUsd : 0,
      sessionId,
    );
  }).immediate();
}

export function setSessionSdkSessionId(sessionId: string, sdkSessionId: string | null): void {
  db.prepare(`UPDATE sessions SET sdk_session_id = ?, updated_at = datetime('now') WHERE id = ?`).run(
    sdkSessionId,
    sessionId,
  );
}

export function setSessionCompactionState(
  sessionId: string,
  state: {
    compactedUpToMessageId: number | null;
    rollingSummary: string | null;
    pendingSeed: string | null;
    sdkSessionId?: string | null;
  },
): void {
  const includeSdk = state.sdkSessionId !== undefined;
  const params: Array<string | number | null> = [state.compactedUpToMessageId, state.rollingSummary, state.pendingSeed];
  if (includeSdk) params.push(state.sdkSessionId as string | null);
  params.push(sessionId);
  db.prepare(
    `
    UPDATE sessions
    SET compacted_up_to_message_id = ?,
        rolling_summary = ?,
        pending_seed = ?,
        ${includeSdk ? 'sdk_session_id = ?,' : ''}
        updated_at = datetime('now')
    WHERE id = ?
  `,
  ).run(...params);
}

export function clearSessionPendingSeed(sessionId: string): void {
  db.prepare(`UPDATE sessions SET pending_seed = NULL, updated_at = datetime('now') WHERE id = ?`).run(sessionId);
}

export function setSessionActiveContextTokens(sessionId: string, tokens: number | null): void {
  db.prepare(`UPDATE sessions SET active_context_tokens_est = ?, updated_at = datetime('now') WHERE id = ?`).run(
    tokens,
    sessionId,
  );
}

export function setSessionAgenticContextTokens(
  sessionId: string,
  tokens: number | null,
  threadResetMessageId?: number | null,
): void {
  const includeFence = threadResetMessageId !== undefined;
  const params: Array<string | number | null> = [tokens];
  if (includeFence) params.push(threadResetMessageId as number | null);
  params.push(sessionId);
  db.prepare(
    `
    UPDATE sessions
    SET agentic_context_tokens_est = ?,
        ${includeFence ? 'thread_reset_message_id = ?,' : ''}
        updated_at = datetime('now')
    WHERE id = ?
  `,
  ).run(...params);
}

export function resetSessionAgenticContext(
  sessionId: string,
  opts?: { threadResetMessageId?: number | null; seedTokens?: number },
): void {
  setSessionAgenticContextTokens(
    sessionId,
    opts?.seedTokens && opts.seedTokens > 0 ? Math.floor(opts.seedTokens) : 0,
    opts?.threadResetMessageId,
  );
}

export function updateSessionStatus(sessionId: string, status: 'active' | 'archived' | 'compacted' | 'trashed'): void {
  db.prepare("UPDATE sessions SET status = ?, updated_at = datetime('now') WHERE id = ?").run(status, sessionId);
}

export function clearAllSessions(): void {
  const database = getDb();
  database.exec('DELETE FROM messages');
  database.exec('DELETE FROM audit_log');
  database.exec('DELETE FROM task_executions');
  database.exec('DELETE FROM sessions');
}

export function clearNonSessionResetTables(): void {
  const database = getDb();
  database.exec('DELETE FROM audit_log');
  database.exec('DELETE FROM task_executions');
}

type ActiveSessionSummary = {
  id: string;
  title: string;
  type: string;
  createdAt: string;
  inputTokens: number;
  outputTokens: number;
};

function mapActiveSession(row: Record<string, unknown>): ActiveSessionSummary {
  return {
    id: row['id'] as string,
    title: (row['title'] as string) || '',
    type: (row['type'] as string) || 'chat',
    createdAt: row['created_at'] as string,
    inputTokens: (row['input_tokens'] as number) || 0,
    outputTokens: (row['output_tokens'] as number) || 0,
  };
}

export function getActiveSession(): ActiveSessionSummary | null {
  const row = db
    .prepare(
      `
    SELECT id, title, type, created_at, input_tokens, output_tokens
    FROM sessions
    WHERE status = 'active'
      AND type IN ('chat', 'manual', 'telegram')
      AND task_id IS NULL
    ORDER BY updated_at DESC, created_at DESC
    LIMIT 1
  `,
    )
    .get() as Record<string, unknown> | undefined;
  if (!row) return null;
  return mapActiveSession(row);
}

export function getActiveChatSession(): ActiveSessionSummary | null {
  const row = db
    .prepare(
      `
    SELECT id, title, type, created_at, input_tokens, output_tokens
    FROM sessions
    WHERE status = 'active'
      AND type IN ('chat', 'manual')
      AND task_id IS NULL
      AND (title IS NULL OR title NOT LIKE '[Scheduler]%')
    ORDER BY updated_at DESC, created_at DESC
    LIMIT 1
  `,
    )
    .get() as Record<string, unknown> | undefined;
  if (!row) return null;
  return mapActiveSession(row);
}

export function getDesktopActiveSessionById(id: string): ActiveSessionSummary | null {
  const row = db
    .prepare(
      `
    SELECT id, title, type, created_at, input_tokens, output_tokens
    FROM sessions
    WHERE id = ?
      AND status = 'active'
      AND type IN ('chat', 'manual')
      AND task_id IS NULL
      AND (title IS NULL OR title NOT LIKE '[Scheduler]%')
    LIMIT 1
  `,
    )
    .get(id) as Record<string, unknown> | undefined;
  if (!row) return null;
  return mapActiveSession(row);
}

export function listActiveTelegramSessions(): Array<{ id: string; sdkSessionId?: string }> {
  const database = getDb();
  const rows = database
    .prepare(
      `
    SELECT id, sdk_session_id
    FROM sessions
    WHERE type = 'telegram' AND status = 'active'
    ORDER BY updated_at DESC, created_at DESC
  `,
    )
    .all() as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    id: row['id'] as string,
    sdkSessionId: (row['sdk_session_id'] as string | null) ?? undefined,
  }));
}

const ALL_TOOLS = [
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
  'Bash',
  'WebSearch',
  'WebFetch',
  'Agent',
  'TodoWrite',
  'NotebookEdit',
  'AskUserQuestion',
] as const;

const DEFAULT_DISABLED_TOOLS = new Set(['WebSearch', 'WebFetch', 'NotebookEdit']);

export function getEnabledTools(): string[] {
  return ALL_TOOLS.filter((tool) => {
    const val = getSetting(`tool:${tool}`);
    if (val === undefined) return !DEFAULT_DISABLED_TOOLS.has(tool);
    return val === 'true';
  });
}

export function getDisabledTools(): string[] {
  return ALL_TOOLS.filter((tool) => {
    const val = getSetting(`tool:${tool}`);
    if (val === undefined) return DEFAULT_DISABLED_TOOLS.has(tool);
    return val !== 'true';
  });
}

export function setToolEnabled(tool: string, enabled: boolean): void {
  setSetting(`tool:${tool}`, enabled ? 'true' : 'false');
}

export function getToolSettings(): Record<string, boolean> {
  const result: Record<string, boolean> = {};
  for (const tool of ALL_TOOLS) {
    const val = getSetting(`tool:${tool}`);
    result[tool] = val === undefined ? !DEFAULT_DISABLED_TOOLS.has(tool) : val === 'true';
  }
  return result;
}

export function seedToolDefaults(): void {
  const defaults: Record<string, boolean> = {
    Read: true,
    Write: true,
    Edit: true,
    Glob: true,
    Grep: true,
    Bash: true,
    Agent: true,
    TodoWrite: true,
    AskUserQuestion: true,
    WebSearch: false,
    WebFetch: false,
    NotebookEdit: false,
  };

  for (const [tool, enabled] of Object.entries(defaults)) {
    const existing = getSetting(`tool:${tool}`);
    if (existing === undefined) {
      setSetting(`tool:${tool}`, enabled ? 'true' : 'false');
    }
  }
}

export function seedDefaultAgents(): void {
  const existing = db.prepare('SELECT COUNT(*) as c FROM agents').get() as { c: number };
  if (existing.c > 0) return;

  const defaults = [
    {
      id: 'coder',
      name: 'Coder',
      description: 'Especialista em codigo, debugging, arquitetura de software',
      systemPrompt:
        'Voce e o Coder, um engenheiro de software senior. Escreva codigo limpo, testavel e bem documentado. Use TypeScript por padrao. Siga SOLID principles.',
      model: 'claude-sonnet-4-6', // gate-allow: seed de agente e DADO, nao execucao do orquestrador
      allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'WebSearch'],
      mcpServers: [],
      isActive: true,
      effort: 'high' as const,
      thinking: 'adaptive' as const,
      skills: [],
      runtime: 'cloud' as const,
    },
    {
      id: 'researcher',
      name: 'Researcher',
      description: 'Pesquisa web, analise de documentos, sintese de informacao',
      systemPrompt:
        'Voce e o Researcher, especialista em pesquisa e analise. Busque informacoes na web, analise documentos e sintetize insights claros e acionaveis.',
      model: 'claude-sonnet-4-6', // gate-allow: seed de agente e DADO, nao execucao do orquestrador
      allowedTools: ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch'],
      mcpServers: [],
      isActive: true,
      effort: 'medium' as const,
      thinking: 'adaptive' as const,
      skills: [],
      runtime: 'cloud' as const,
    },
    {
      id: 'writer',
      name: 'Writer',
      description: 'Redacao, emails, documentos, conteudo',
      systemPrompt:
        'Voce e o Writer, especialista em comunicacao escrita. Redija textos claros, persuasivos e adaptados ao publico-alvo. Tom informal e direto em portugues brasileiro.',
      model: 'claude-sonnet-4-6', // gate-allow: seed de agente e DADO, nao execucao do orquestrador
      allowedTools: ['Read', 'Write', 'Edit', 'WebSearch'],
      mcpServers: [],
      isActive: true,
      effort: 'medium' as const,
      thinking: 'adaptive' as const,
      skills: [],
      runtime: 'cloud' as const,
    },
    {
      id: 'ops',
      name: 'Ops',
      description: 'Automacao, scripts, gestao de arquivos, sistema',
      systemPrompt:
        'Voce e o Ops, especialista em operacoes e automacao. Execute tarefas no sistema, gerencie arquivos, crie scripts de automacao. Sempre confirme antes de acoes destrutivas.',
      model: 'claude-sonnet-4-6', // gate-allow: seed de agente e DADO, nao execucao do orquestrador
      allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],
      mcpServers: [],
      isActive: true,
      effort: 'low' as const,
      thinking: 'disabled' as const,
      skills: [],
      runtime: 'cloud' as const,
    },
    skillCreator,
    harnessPlanner,
    harnessCoder,
    harnessEvaluator,
  ];

  const insert = db.transaction(() => {
    for (const agent of defaults) {
      insertAgent(agent);
    }
  });
  insert();
  logger.info('Seeded default agents');
}

export function insertChunkWithEmbedding(content: string, topic: string, embedding: number[]): number {
  const embeddingBuf = Buffer.from(new Float32Array(embedding).buffer);

  const result = db
    .prepare(`INSERT INTO semantic_memories (content, topic, embedding, created_at) VALUES (?, ?, ?, datetime('now'))`)
    .run(content, topic, embeddingBuf);

  const rowId = Number(result.lastInsertRowid);
  const vecId = String(rowId);

  try {
    db.prepare('DELETE FROM semantic_memories_vec WHERE id = ?').run(vecId);
  } catch {
    /* ignore if not exists */
  }

  db.prepare('INSERT INTO semantic_memories_vec (id, embedding) VALUES (?, ?)').run(vecId, embeddingBuf);

  try {
    db.prepare('INSERT INTO semantic_memories_fts(rowid, content, topic) VALUES (?, ?, ?)').run(
      rowId,
      content,
      topic || '',
    );
  } catch {
    /* FTS5 table may not exist yet */
  }

  return rowId;
}

export function searchBM25(
  query: string,
  limit: number = 20,
): Array<{ id: number; content: string; topic: string; created_at: string; bm25_score: number }> {
  const sanitized = query.replace(/["*(){}[\]^~\\:]/g, ' ').trim();
  if (!sanitized) return [];

  const terms = sanitized.split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];
  const orQuery = terms.join(' OR ');

  const rows = db
    .prepare(
      `
    SELECT sm.id, sm.content, sm.topic, sm.created_at,
           bm25(semantic_memories_fts) AS bm25_score
    FROM semantic_memories_fts fts
    JOIN semantic_memories sm ON sm.id = fts.rowid
    WHERE semantic_memories_fts MATCH ?
    ORDER BY bm25_score ASC
    LIMIT ?
  `,
    )
    .all(orQuery, limit) as Array<{
    id: number;
    content: string;
    topic: string;
    created_at: string;
    bm25_score: number;
  }>;

  return rows;
}

export function searchVector(
  queryEmbedding: Buffer,
  limit: number = 20,
): Array<{ id: number; content: string; topic: string; created_at: string; distance: number }> {
  const rows = db
    .prepare(
      `
    SELECT sm.id, sm.content, sm.topic, sm.created_at,
           vec_distance_cosine(v.embedding, ?) AS distance
    FROM semantic_memories_vec v
    JOIN semantic_memories sm ON CAST(sm.id AS TEXT) = v.id
    ORDER BY distance ASC
    LIMIT ?
  `,
    )
    .all(queryEmbedding, limit) as Array<{
    id: number;
    content: string;
    topic: string;
    created_at: string;
    distance: number;
  }>;

  return rows;
}

export function reconcileSeedAgent(agent: Omit<AgentConfig, 'sortOrder'>, category: string): void {
  const existing = db.prepare('SELECT id FROM agents WHERE id = ?').get(agent.id);
  if (existing) return;
  insertAgent(agent);
  logger.info({ agentId: agent.id, category }, 'Created seed agent');
}

export interface KnowledgeSourceRow {
  id: string;
  agentId: string;
  fileName: string;
  fileType: string;
  fileSize: number;
  filePath: string;
  title?: string;
  description?: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  chunksCount: number;
  chunkStrategy: string;
  chunkSize: number;
  chunkOverlap: number;
  qualityScore?: number;
  bestStrategy?: string;
  errorMessage?: string;
  createdAt: string;
  processedAt?: string;
  updatedAt: string;
}

function mapKnowledgeSource(row: Record<string, unknown>): KnowledgeSourceRow {
  return {
    id: row['id'] as string,
    agentId: row['agent_id'] as string,
    fileName: row['file_name'] as string,
    fileType: row['file_type'] as string,
    fileSize: row['file_size'] as number,
    filePath: row['file_path'] as string,
    title: row['title'] as string | undefined,
    description: row['description'] as string | undefined,
    status: row['status'] as KnowledgeSourceRow['status'],
    chunksCount: (row['chunks_count'] as number) ?? 0,
    chunkStrategy: row['chunk_strategy'] as string,
    chunkSize: (row['chunk_size'] as number) ?? 1000,
    chunkOverlap: (row['chunk_overlap'] as number) ?? 200,
    qualityScore: row['quality_score'] as number | undefined,
    bestStrategy: row['best_strategy'] as string | undefined,
    errorMessage: row['error_message'] as string | undefined,
    createdAt: row['created_at'] as string,
    processedAt: row['processed_at'] as string | undefined,
    updatedAt: row['updated_at'] as string,
  };
}

export function insertKnowledgeSource(source: Omit<KnowledgeSourceRow, 'createdAt' | 'updatedAt'>): KnowledgeSourceRow {
  db.prepare(
    `
    INSERT INTO knowledge_sources
      (id, agent_id, file_name, file_type, file_size, file_path, title, description,
       status, chunks_count, chunk_strategy, chunk_size, chunk_overlap,
       quality_score, best_strategy, error_message, processed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    source.id,
    source.agentId,
    source.fileName,
    source.fileType,
    source.fileSize,
    source.filePath,
    source.title ?? null,
    source.description ?? null,
    source.status,
    source.chunksCount,
    source.chunkStrategy,
    source.chunkSize,
    source.chunkOverlap,
    source.qualityScore ?? null,
    source.bestStrategy ?? null,
    source.errorMessage ?? null,
    source.processedAt ?? null,
  );
  return getKnowledgeSource(source.id)!;
}

export function getKnowledgeSource(id: string): KnowledgeSourceRow | undefined {
  const row = db.prepare('SELECT * FROM knowledge_sources WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  return mapKnowledgeSource(row);
}

export function getKnowledgeSources(agentId: string): KnowledgeSourceRow[] {
  const rows = db
    .prepare('SELECT * FROM knowledge_sources WHERE agent_id = ? ORDER BY created_at DESC')
    .all(agentId) as Record<string, unknown>[];
  return rows.map(mapKnowledgeSource);
}

export function getCompletedDocsCount(agentId: string): number {
  const row = db
    .prepare(
      `
    SELECT COUNT(*) as count FROM knowledge_sources
    WHERE agent_id = ? AND status = 'completed'
  `,
    )
    .get(agentId) as { count: number } | undefined;
  return row?.count ?? 0;
}

export function updateKnowledgeSource(
  id: string,
  updates: Partial<Omit<KnowledgeSourceRow, 'id' | 'agentId' | 'createdAt'>>,
): KnowledgeSourceRow {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.fileName !== undefined) {
    fields.push('file_name = ?');
    values.push(updates.fileName);
  }
  if (updates.fileType !== undefined) {
    fields.push('file_type = ?');
    values.push(updates.fileType);
  }
  if (updates.fileSize !== undefined) {
    fields.push('file_size = ?');
    values.push(updates.fileSize);
  }
  if (updates.filePath !== undefined) {
    fields.push('file_path = ?');
    values.push(updates.filePath);
  }
  if (updates.title !== undefined) {
    fields.push('title = ?');
    values.push(updates.title);
  }
  if (updates.description !== undefined) {
    fields.push('description = ?');
    values.push(updates.description);
  }
  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }
  if (updates.chunksCount !== undefined) {
    fields.push('chunks_count = ?');
    values.push(updates.chunksCount);
  }
  if (updates.chunkStrategy !== undefined) {
    fields.push('chunk_strategy = ?');
    values.push(updates.chunkStrategy);
  }
  if (updates.chunkSize !== undefined) {
    fields.push('chunk_size = ?');
    values.push(updates.chunkSize);
  }
  if (updates.chunkOverlap !== undefined) {
    fields.push('chunk_overlap = ?');
    values.push(updates.chunkOverlap);
  }
  if (updates.qualityScore !== undefined) {
    fields.push('quality_score = ?');
    values.push(updates.qualityScore);
  }
  if (updates.bestStrategy !== undefined) {
    fields.push('best_strategy = ?');
    values.push(updates.bestStrategy);
  }
  if (updates.errorMessage !== undefined) {
    fields.push('error_message = ?');
    values.push(updates.errorMessage);
  }
  if (updates.processedAt !== undefined) {
    fields.push('processed_at = ?');
    values.push(updates.processedAt);
  }

  if (fields.length > 0) {
    fields.push(`updated_at = datetime('now')`);
    values.push(id);
    db.prepare(`UPDATE knowledge_sources SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  }
  return getKnowledgeSource(id)!;
}

export function deleteKnowledgeSource(id: string): void {
  const source = getKnowledgeSource(id);

  const doDelete = db.transaction(() => {
    const chunkIds = db.prepare('SELECT id FROM knowledge_chunks WHERE source_id = ?').all(id) as Array<{ id: string }>;

    for (const { id: cid } of chunkIds) {
      db.prepare('DELETE FROM knowledge_chunks_fts WHERE chunk_id = ?').run(cid);
      db.prepare('DELETE FROM knowledge_chunks_vec WHERE chunk_id = ?').run(cid);
    }

    db.prepare('DELETE FROM knowledge_chunks WHERE source_id = ?').run(id);
    db.prepare('DELETE FROM knowledge_benchmarks WHERE source_id = ?').run(id);
    db.prepare('DELETE FROM knowledge_sources WHERE id = ?').run(id);
  });
  doDelete();

  if (source) {
    try {
      const dir = path.dirname(source.filePath);
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    } catch (err) {
      logger.warn({ err, sourceId: id }, 'Failed to remove knowledge source files from filesystem');
    }
  }
}

export interface KnowledgeChunkRow {
  id: string;
  sourceId: string;
  agentId: string;
  chunkIndex: number;
  content: string;
  tokenCount: number;
  metadata: Record<string, unknown>;
  strategyUsed: string;
  createdAt: string;
}

function mapKnowledgeChunk(row: Record<string, unknown>): KnowledgeChunkRow {
  return {
    id: row['id'] as string,
    sourceId: row['source_id'] as string,
    agentId: row['agent_id'] as string,
    chunkIndex: row['chunk_index'] as number,
    content: row['content'] as string,
    tokenCount: row['token_count'] as number,
    metadata: JSON.parse((row['metadata'] as string) || '{}'),
    strategyUsed: row['strategy_used'] as string,
    createdAt: row['created_at'] as string,
  };
}

export function insertKnowledgeChunk(chunk: Omit<KnowledgeChunkRow, 'createdAt'>): void {
  db.prepare(
    `
    INSERT INTO knowledge_chunks
      (id, source_id, agent_id, chunk_index, content, token_count, metadata, strategy_used)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    chunk.id,
    chunk.sourceId,
    chunk.agentId,
    chunk.chunkIndex,
    chunk.content,
    chunk.tokenCount,
    JSON.stringify(chunk.metadata),
    chunk.strategyUsed,
  );
}

export function getKnowledgeChunks(sourceId: string): KnowledgeChunkRow[] {
  const rows = db
    .prepare('SELECT * FROM knowledge_chunks WHERE source_id = ? ORDER BY chunk_index ASC')
    .all(sourceId) as Record<string, unknown>[];
  return rows.map(mapKnowledgeChunk);
}

export function deleteKnowledgeChunksBySource(sourceId: string): void {
  const chunkIds = db.prepare('SELECT id FROM knowledge_chunks WHERE source_id = ?').all(sourceId) as Array<{
    id: string;
  }>;

  for (const { id: cid } of chunkIds) {
    db.prepare('DELETE FROM knowledge_chunks_fts WHERE chunk_id = ?').run(cid);
    db.prepare('DELETE FROM knowledge_chunks_vec WHERE chunk_id = ?').run(cid);
  }
  db.prepare('DELETE FROM knowledge_chunks WHERE source_id = ?').run(sourceId);
}

export function insertKnowledgeChunkVec(chunkId: string, embedding: number[]): void {
  const buf = Buffer.from(new Float32Array(embedding).buffer);
  db.prepare('INSERT INTO knowledge_chunks_vec (chunk_id, embedding) VALUES (?, ?)').run(chunkId, buf);
}

export function deleteKnowledgeChunkVec(chunkId: string): void {
  db.prepare('DELETE FROM knowledge_chunks_vec WHERE chunk_id = ?').run(chunkId);
}

export function insertKnowledgeChunkFts(chunkId: string, agentId: string, content: string): void {
  db.prepare('INSERT INTO knowledge_chunks_fts (chunk_id, agent_id, content) VALUES (?, ?, ?)').run(
    chunkId,
    agentId,
    content,
  );
}

export function deleteKnowledgeChunkFtsBySource(sourceId: string): void {
  const chunkIds = db.prepare('SELECT id FROM knowledge_chunks WHERE source_id = ?').all(sourceId) as Array<{
    id: string;
  }>;
  for (const { id: cid } of chunkIds) {
    db.prepare('DELETE FROM knowledge_chunks_fts WHERE chunk_id = ?').run(cid);
  }
}

export interface KnowledgeBenchmarkRow {
  id: string;
  sourceId: string;
  agentId: string;
  status: 'running' | 'completed' | 'failed';
  winnerStrategy?: string;
  winnerScore?: number;
  questions: string[];
  results: Record<string, unknown>;
  totalQuestions: number;
  executionTime?: number;
  modelJudge?: string;
  createdAt: string;
  completedAt?: string;
}

function mapKnowledgeBenchmark(row: Record<string, unknown>): KnowledgeBenchmarkRow {
  return {
    id: row['id'] as string,
    sourceId: row['source_id'] as string,
    agentId: row['agent_id'] as string,
    status: row['status'] as KnowledgeBenchmarkRow['status'],
    winnerStrategy: row['winner_strategy'] as string | undefined,
    winnerScore: row['winner_score'] as number | undefined,
    questions: JSON.parse((row['questions'] as string) || '[]'),
    results: JSON.parse((row['results'] as string) || '{}'),
    totalQuestions: (row['total_questions'] as number) ?? 10,
    executionTime: row['execution_time'] as number | undefined,
    modelJudge: row['model_judge'] as string | undefined,
    createdAt: row['created_at'] as string,
    completedAt: row['completed_at'] as string | undefined,
  };
}

export function insertKnowledgeBenchmark(benchmark: Omit<KnowledgeBenchmarkRow, 'createdAt'>): KnowledgeBenchmarkRow {
  db.prepare(
    `
    INSERT INTO knowledge_benchmarks
      (id, source_id, agent_id, status, winner_strategy, winner_score,
       questions, results, total_questions, execution_time, model_judge, completed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    benchmark.id,
    benchmark.sourceId,
    benchmark.agentId,
    benchmark.status,
    benchmark.winnerStrategy ?? null,
    benchmark.winnerScore ?? null,
    JSON.stringify(benchmark.questions),
    JSON.stringify(benchmark.results),
    benchmark.totalQuestions,
    benchmark.executionTime ?? null,
    benchmark.modelJudge ?? null,
    benchmark.completedAt ?? null,
  );
  return getKnowledgeBenchmark(benchmark.id)!;
}

export function getKnowledgeBenchmark(id: string): KnowledgeBenchmarkRow | undefined {
  const row = db.prepare('SELECT * FROM knowledge_benchmarks WHERE id = ?').get(id) as
    Record<string, unknown> | undefined;
  if (!row) return undefined;
  return mapKnowledgeBenchmark(row);
}

export function updateKnowledgeBenchmark(
  id: string,
  updates: Partial<Omit<KnowledgeBenchmarkRow, 'id' | 'sourceId' | 'agentId' | 'createdAt'>>,
): KnowledgeBenchmarkRow {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }
  if (updates.winnerStrategy !== undefined) {
    fields.push('winner_strategy = ?');
    values.push(updates.winnerStrategy);
  }
  if (updates.winnerScore !== undefined) {
    fields.push('winner_score = ?');
    values.push(updates.winnerScore);
  }
  if (updates.questions !== undefined) {
    fields.push('questions = ?');
    values.push(JSON.stringify(updates.questions));
  }
  if (updates.results !== undefined) {
    fields.push('results = ?');
    values.push(JSON.stringify(updates.results));
  }
  if (updates.totalQuestions !== undefined) {
    fields.push('total_questions = ?');
    values.push(updates.totalQuestions);
  }
  if (updates.executionTime !== undefined) {
    fields.push('execution_time = ?');
    values.push(updates.executionTime);
  }
  if (updates.modelJudge !== undefined) {
    fields.push('model_judge = ?');
    values.push(updates.modelJudge);
  }
  if (updates.completedAt !== undefined) {
    fields.push('completed_at = ?');
    values.push(updates.completedAt);
  }

  if (fields.length > 0) {
    values.push(id);
    db.prepare(`UPDATE knowledge_benchmarks SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  }
  return getKnowledgeBenchmark(id)!;
}

export interface KnowledgeAgentConfigRow {
  agentId: string;
  hydeEnabled: boolean;
  hydeThreshold: number;
  minScore: number;
  defaultStrategy: string;
  rerankEnabled: boolean;
  rerankTopK: number;
  searchTopK: number;
  createdAt: string;
  updatedAt: string;
}

function mapKnowledgeAgentConfig(row: Record<string, unknown>): KnowledgeAgentConfigRow {
  return {
    agentId: row['agent_id'] as string,
    hydeEnabled: (row['hyde_enabled'] as number) === 1,
    hydeThreshold: (row['hyde_threshold'] as number) ?? 0.5,
    minScore: (row['min_score'] as number) ?? 0.4,
    defaultStrategy: (row['default_strategy'] as string) ?? 'recursive',
    rerankEnabled: (row['rerank_enabled'] as number) === 1,
    rerankTopK: (row['rerank_top_k'] as number) ?? 3,
    searchTopK: (row['search_top_k'] as number) ?? 20,
    createdAt: row['created_at'] as string,
    updatedAt: row['updated_at'] as string,
  };
}

export function getKnowledgeAgentConfig(agentId: string): KnowledgeAgentConfigRow | undefined {
  const row = db.prepare('SELECT * FROM knowledge_agent_config WHERE agent_id = ?').get(agentId) as
    Record<string, unknown> | undefined;
  if (!row) return undefined;
  return mapKnowledgeAgentConfig(row);
}

export function upsertKnowledgeAgentConfig(
  agentId: string,
  config: Partial<Omit<KnowledgeAgentConfigRow, 'agentId' | 'createdAt' | 'updatedAt'>>,
): KnowledgeAgentConfigRow {
  const existing = getKnowledgeAgentConfig(agentId);

  if (!existing) {
    db.prepare(
      `
      INSERT INTO knowledge_agent_config
        (agent_id, hyde_enabled, hyde_threshold, min_score, default_strategy,
         rerank_enabled, rerank_top_k, search_top_k)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
      agentId,
      config.hydeEnabled !== undefined ? (config.hydeEnabled ? 1 : 0) : 1,
      config.hydeThreshold ?? 0.5,
      config.minScore ?? 0.4,
      config.defaultStrategy ?? 'recursive',
      config.rerankEnabled !== undefined ? (config.rerankEnabled ? 1 : 0) : 1,
      config.rerankTopK ?? 3,
      config.searchTopK ?? 20,
    );
  } else {
    const fields: string[] = [];
    const values: unknown[] = [];

    if (config.hydeEnabled !== undefined) {
      fields.push('hyde_enabled = ?');
      values.push(config.hydeEnabled ? 1 : 0);
    }
    if (config.hydeThreshold !== undefined) {
      fields.push('hyde_threshold = ?');
      values.push(config.hydeThreshold);
    }
    if (config.minScore !== undefined) {
      fields.push('min_score = ?');
      values.push(config.minScore);
    }
    if (config.defaultStrategy !== undefined) {
      fields.push('default_strategy = ?');
      values.push(config.defaultStrategy);
    }
    if (config.rerankEnabled !== undefined) {
      fields.push('rerank_enabled = ?');
      values.push(config.rerankEnabled ? 1 : 0);
    }
    if (config.rerankTopK !== undefined) {
      fields.push('rerank_top_k = ?');
      values.push(config.rerankTopK);
    }
    if (config.searchTopK !== undefined) {
      fields.push('search_top_k = ?');
      values.push(config.searchTopK);
    }

    if (fields.length > 0) {
      fields.push(`updated_at = datetime('now')`);
      values.push(agentId);
      db.prepare(`UPDATE knowledge_agent_config SET ${fields.join(', ')} WHERE agent_id = ?`).run(...values);
    }
  }

  return getKnowledgeAgentConfig(agentId)!;
}

export interface TaskRow {
  id: string;
  title: string;
  description: string | null;
  category: string | null;
  status: 'pending' | 'in_progress' | 'done';
  priority: 'low' | 'normal' | 'high';
  due_date: string | null;
  created_at: string;
  updated_at: string;
  done_at: string | null;
  done_comment: string | null;
}

function mapTask(row: Record<string, unknown>): TaskRow {
  return {
    id: row.id as string,
    title: row.title as string,
    description: (row.description as string) || null,
    category: (row.category as string) || null,
    status: row.status as TaskRow['status'],
    priority: (row.priority as TaskRow['priority']) || 'normal',
    due_date: (row.due_date as string) || null,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
    done_at: (row.done_at as string) || null,
    done_comment: (row.done_comment as string) || null,
  };
}

export function getAllTasks(filters?: {
  status?: string;
  category?: string;
  priority?: string;
  period?: 'last30' | 'last90' | 'all';
}): TaskRow[] {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters?.status && filters.status !== 'all') {
    conditions.push('status = ?');
    params.push(filters.status);
  }

  if (filters?.category && filters.category !== 'all') {
    conditions.push('category = ?');
    params.push(filters.category);
  }

  if (filters?.priority && filters.priority !== 'all') {
    conditions.push('priority = ?');
    params.push(filters.priority);
  }

  const period = filters?.period || 'last30';
  if (period !== 'all') {
    const days = period === 'last90' ? 90 : 30;
    conditions.push(`(status != 'done' OR created_at >= datetime('now', '-${days} days'))`);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const rows = db
    .prepare(
      `
    SELECT * FROM tasks ${where}
    ORDER BY
      CASE WHEN due_date IS NOT NULL THEN 0 ELSE 1 END ASC,
      CASE WHEN due_date IS NOT NULL THEN due_date END ASC,
      created_at DESC
  `,
    )
    .all(...params) as Record<string, unknown>[];

  return rows.map(mapTask);
}

export function getTask(id: string): TaskRow | undefined {
  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return row ? mapTask(row) : undefined;
}

export function insertTask(task: {
  title: string;
  description?: string;
  category?: string;
  priority?: string;
  due_date?: string;
}): TaskRow {
  const id = require('crypto').randomBytes(16).toString('hex');
  db.prepare(
    `
    INSERT INTO tasks (id, title, description, category, priority, due_date)
    VALUES (?, ?, ?, ?, ?, ?)
  `,
  ).run(
    id,
    task.title,
    task.description || null,
    task.category || null,
    task.priority || 'normal',
    task.due_date || null,
  );
  return getTask(id)!;
}

export function updateTask(
  id: string,
  updates: Partial<{
    title: string;
    description: string | null;
    category: string | null;
    status: string;
    priority: string;
    due_date: string | null;
    done_comment: string | null;
  }>,
): TaskRow {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.title !== undefined) {
    fields.push('title = ?');
    values.push(updates.title);
  }
  if (updates.description !== undefined) {
    fields.push('description = ?');
    values.push(updates.description);
  }
  if (updates.category !== undefined) {
    fields.push('category = ?');
    values.push(updates.category);
  }
  if (updates.priority !== undefined) {
    fields.push('priority = ?');
    values.push(updates.priority);
  }
  if (updates.due_date !== undefined) {
    fields.push('due_date = ?');
    values.push(updates.due_date);
  }
  if (updates.done_comment !== undefined) {
    fields.push('done_comment = ?');
    values.push(updates.done_comment);
  }

  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
    if (updates.status === 'done') {
      fields.push(`done_at = datetime('now')`);
    } else {
      fields.push('done_at = NULL');
    }
  }

  if (fields.length > 0) {
    fields.push(`updated_at = datetime('now')`);
    values.push(id);
    db.prepare(`UPDATE tasks SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  }

  return getTask(id)!;
}

export function deleteTask(id: string): void {
  db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
}

export function getTaskCategories(): string[] {
  const rows = db
    .prepare(`SELECT DISTINCT category FROM tasks WHERE category IS NOT NULL AND category != '' ORDER BY category`)
    .all() as Array<{ category: string }>;
  return rows.map((r) => r.category);
}

export function getPendingTasksDueCount(): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) as count FROM tasks WHERE status != 'done' AND due_date IS NOT NULL AND due_date <= date('now')`,
    )
    .get() as { count: number };
  return row.count;
}

export function insertTaskExecution(data: {
  sessionId: string;
  taskId: string;
  toolUseId: string | null;
  agentId: string | null;
  agentName: string;
  model: string;
  description: string;
  status: string;
  summary: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
  apiRequests: number;
  toolUses: number;
  durationMs: number;
}): void {
  const stmt = db.prepare(`
    INSERT INTO task_executions (session_id, task_id, tool_use_id, agent_id, agent_name, model, description, status, summary, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost_usd, api_requests, tool_uses, duration_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    data.sessionId,
    data.taskId,
    data.toolUseId,
    data.agentId,
    data.agentName,
    data.model,
    data.description,
    data.status,
    data.summary,
    data.inputTokens,
    data.outputTokens,
    data.cacheReadTokens,
    data.cacheCreationTokens,
    data.costUsd,
    data.apiRequests,
    data.toolUses,
    data.durationMs,
  );
}

export interface TaskExecutionStart {
  executionId: string;
  taskId?: string;
  rootExecutionId: string;
  parentExecutionId: string | null;
  executionKind: 'root' | 'subagent' | 'native-task';
  ownerKind: 'chat' | 'pipeline' | 'harness' | 'workflow' | 'enrich';
  ownerId: string;
  sessionId: string | null;
  toolUseId: string | null;
  agentId: string | null;
  agentName: string;
  model: string;
  description: string;
  runtime: string | null;
  provider: string | null;
  metadata: Record<string, unknown>;
}

export interface TaskExecutionFinalize {
  status: 'completed' | 'failed' | 'cancelled';
  summary: string;
  model: string;
  runtime: string;
  provider: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
  apiRequests: number;
  toolUses: number;
  durationMs: number;
  costStatus: 'known' | 'unknown' | 'estimated-partial';
  tokenStatus: 'reported' | 'not_reported';
  costUnknownReason: 'unknown-pricing' | 'no-usage-reported' | null;
  metadata: Record<string, unknown>;
}

interface TaskExecutionLedgerRow {
  task_id: string;
  execution_id: string;
  root_execution_id: string;
  parent_execution_id: string | null;
  execution_kind: TaskExecutionStart['executionKind'];
  owner_kind: TaskExecutionStart['ownerKind'];
  owner_id: string;
  session_id: string | null;
  tool_use_id: string | null;
  agent_id: string | null;
  agent_name: string;
  status: string;
  summary: string | null;
  model: string | null;
  description: string;
  runtime: string | null;
  provider: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  cost_usd: number;
  api_requests: number;
  tool_uses: number;
  duration_ms: number;
  cost_status: TaskExecutionFinalize['costStatus'] | null;
  token_status: TaskExecutionFinalize['tokenStatus'] | null;
  cost_unknown_reason: TaskExecutionFinalize['costUnknownReason'];
  metadata: string | null;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function startTaskExecution(data: TaskExecutionStart): void {
  if (!data.executionId || !data.rootExecutionId || !data.ownerId) {
    throw new Error('Task execution exige execution/root/owner IDs.');
  }
  if (data.ownerKind === 'chat' && !data.sessionId) {
    throw new Error('Task execution de chat exige session_id.');
  }
  if (data.ownerKind !== 'chat' && data.sessionId !== null) {
    throw new Error('Task execution nao-chat deve manter session_id nulo.');
  }
  if (data.executionKind === 'root') {
    if (data.executionId !== data.rootExecutionId || data.parentExecutionId !== null) {
      throw new Error('Execution root deve ser a raiz e nao pode ter parent.');
    }
  } else if (!data.parentExecutionId) {
    throw new Error('Execution filha exige parent_execution_id.');
  }

  db.transaction(() => {
    if (data.parentExecutionId) {
      const parent = db
        .prepare(
          `
        SELECT execution_id, root_execution_id, owner_kind, owner_id, session_id
        FROM task_executions WHERE execution_id = ?
      `,
        )
        .get(data.parentExecutionId) as
        | Pick<TaskExecutionLedgerRow, 'execution_id' | 'root_execution_id' | 'owner_kind' | 'owner_id' | 'session_id'>
        | undefined;
      if (!parent) throw new Error(`Parent execution nao encontrada: ${data.parentExecutionId}`);
      if (
        parent.root_execution_id !== data.rootExecutionId ||
        parent.owner_kind !== data.ownerKind ||
        parent.owner_id !== data.ownerId ||
        parent.session_id !== data.sessionId
      ) {
        throw new Error('Execution parent pertence a outra arvore/owner/sessao.');
      }
    }

    db.prepare(
      `
      INSERT OR IGNORE INTO task_executions (
        session_id, task_id, tool_use_id, agent_id, agent_name, model,
        description, status, summary, input_tokens, output_tokens,
        cache_read_tokens, cache_creation_tokens, cost_usd, api_requests,
        tool_uses, duration_ms, execution_id, root_execution_id,
        parent_execution_id, execution_kind, owner_kind, owner_id, runtime,
        provider, cost_status, token_status, cost_unknown_reason, metadata
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'running', '', 0, 0, 0, 0, 0, 0, 0, 0,
        ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?)
    `,
    ).run(
      data.sessionId,
      data.taskId ?? data.executionId,
      data.toolUseId,
      data.agentId,
      data.agentName,
      data.model,
      data.description,
      data.executionId,
      data.rootExecutionId,
      data.parentExecutionId,
      data.executionKind,
      data.ownerKind,
      data.ownerId,
      data.runtime,
      data.provider,
      stableJson(data.metadata),
    );

    const stored = db
      .prepare(
        `
      SELECT task_id, execution_id, root_execution_id, parent_execution_id, execution_kind,
        owner_kind, owner_id, session_id, tool_use_id, agent_id, agent_name,
        model, description, runtime, provider, metadata
      FROM task_executions WHERE execution_id = ?
    `,
      )
      .get(data.executionId) as TaskExecutionLedgerRow;
    if (
      stored.task_id !== (data.taskId ?? data.executionId) ||
      stored.root_execution_id !== data.rootExecutionId ||
      stored.parent_execution_id !== data.parentExecutionId ||
      stored.execution_kind !== data.executionKind ||
      stored.owner_kind !== data.ownerKind ||
      stored.owner_id !== data.ownerId ||
      stored.session_id !== data.sessionId ||
      stored.tool_use_id !== data.toolUseId ||
      stored.agent_id !== data.agentId ||
      stored.agent_name !== data.agentName ||
      (stored.model ?? '') !== data.model ||
      stored.description !== data.description ||
      stored.runtime !== data.runtime ||
      stored.provider !== data.provider ||
      (stored.metadata ?? 'null') !== stableJson(data.metadata)
    ) {
      throw new Error(`Execution idempotente divergente: ${data.executionId}`);
    }
  }).immediate();
}

export function finalizeRunningTaskExecutionTree(
  rootExecutionId: string,
  rootStatus: 'completed' | 'cancelled',
  reason: string,
): void {
  db.transaction(() => {
    const rows = db
      .prepare(
        `
      SELECT execution_id, execution_kind, metadata
      FROM task_executions
      WHERE root_execution_id = ? AND status = 'running'
      ORDER BY CASE WHEN execution_kind = 'root' THEN 1 ELSE 0 END, execution_id
    `,
      )
      .all(rootExecutionId) as Array<Pick<TaskExecutionLedgerRow, 'execution_id' | 'execution_kind' | 'metadata'>>;
    for (const row of rows) {
      let metadata: Record<string, unknown> = {};
      try {
        metadata = row.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>) : {};
      } catch {
        /* legacy metadata */
      }
      const isRoot = row.execution_kind === 'root';
      db.prepare(
        `
        UPDATE task_executions SET
          status = ?, summary = ?, cost_status = ?, token_status = ?,
          cost_unknown_reason = ?, metadata = ?
        WHERE execution_id = ? AND status = 'running'
      `,
      ).run(
        isRoot ? rootStatus : 'cancelled',
        reason,
        isRoot ? 'known' : 'unknown',
        isRoot ? 'reported' : 'not_reported',
        isRoot ? null : 'no-usage-reported',
        stableJson({ ...metadata, finalizationReason: reason }),
        row.execution_id,
      );
    }
  }).immediate();
}

export function finalizeTaskExecutionRootIfIdle(rootExecutionId: string): boolean {
  return db
    .transaction(() => {
      const pending = db
        .prepare(
          `
      SELECT COUNT(*) AS count
      FROM task_executions
      WHERE root_execution_id = ? AND execution_kind <> 'root' AND status = 'running'
    `,
        )
        .get(rootExecutionId) as { count: number };
      if (pending.count > 0) return false;
      const changed = db
        .prepare(
          `
      UPDATE task_executions SET
        status = 'completed', summary = 'Arvore de subagentes concluida',
        cost_status = 'known', token_status = 'reported', cost_unknown_reason = NULL
      WHERE execution_id = ? AND execution_kind = 'root' AND status = 'running'
    `,
        )
        .run(rootExecutionId);
      return changed.changes === 1;
    })
    .immediate();
}

export function reconcileInterruptedTaskExecutions(): number {
  const table = db
    .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'task_executions'")
    .get() as { present: number } | undefined;
  if (!table) return 0;
  const columns = db.prepare('PRAGMA table_info(task_executions)').all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === 'execution_id')) return 0;
  return db
    .transaction(() => {
      const rows = db
        .prepare(
          `
      SELECT execution_id, execution_kind, metadata
      FROM task_executions
      WHERE status = 'running' AND execution_id IS NOT NULL
      ORDER BY CASE WHEN execution_kind = 'root' THEN 1 ELSE 0 END, execution_id
    `,
        )
        .all() as Array<Pick<TaskExecutionLedgerRow, 'execution_id' | 'execution_kind' | 'metadata'>>;
      for (const row of rows) {
        let metadata: Record<string, unknown> = {};
        try {
          metadata = row.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>) : {};
        } catch {
          /* legacy */
        }
        const isRoot = row.execution_kind === 'root';
        db.prepare(
          `
        UPDATE task_executions SET
          status = 'cancelled', summary = 'Execucao interrompida pelo encerramento anterior',
          cost_status = ?, token_status = ?, cost_unknown_reason = ?, metadata = ?
        WHERE execution_id = ? AND status = 'running'
      `,
        ).run(
          isRoot ? 'known' : 'unknown',
          isRoot ? 'reported' : 'not_reported',
          isRoot ? null : 'no-usage-reported',
          stableJson({ ...metadata, finalizationReason: 'reconciled-on-boot' }),
          row.execution_id,
        );
      }
      return rows.length;
    })
    .immediate();
}

function finalizedPayloadMatches(row: TaskExecutionLedgerRow, data: TaskExecutionFinalize): boolean {
  return (
    row.status === data.status &&
    (row.summary ?? '') === data.summary &&
    (row.model ?? '') === data.model &&
    row.runtime === data.runtime &&
    row.provider === data.provider &&
    row.input_tokens === data.inputTokens &&
    row.output_tokens === data.outputTokens &&
    row.cache_read_tokens === data.cacheReadTokens &&
    row.cache_creation_tokens === data.cacheCreationTokens &&
    row.cost_usd === data.costUsd &&
    row.api_requests === data.apiRequests &&
    row.tool_uses === data.toolUses &&
    row.duration_ms === data.durationMs &&
    row.cost_status === data.costStatus &&
    row.token_status === data.tokenStatus &&
    row.cost_unknown_reason === data.costUnknownReason &&
    (row.metadata ?? 'null') === stableJson(data.metadata)
  );
}

export function finalizeTaskExecutionOnce(executionId: string, data: TaskExecutionFinalize): void {
  db.transaction(() => {
    const row = db.prepare('SELECT * FROM task_executions WHERE execution_id = ?').get(executionId) as
      TaskExecutionLedgerRow | undefined;
    if (!row) throw new Error(`Execution nao encontrada: ${executionId}`);
    if (row.status !== 'running') {
      if (finalizedPayloadMatches(row, data)) return;
      throw new Error(`Execution ${executionId} ja foi finalizada com payload divergente.`);
    }
    const changed = db
      .prepare(
        `
      UPDATE task_executions SET
        status = ?, summary = ?, model = ?, runtime = ?, provider = ?,
        input_tokens = ?, output_tokens = ?, cache_read_tokens = ?,
        cache_creation_tokens = ?, cost_usd = ?, api_requests = ?, tool_uses = ?,
        duration_ms = ?, cost_status = ?, token_status = ?,
        cost_unknown_reason = ?, metadata = ?
      WHERE execution_id = ? AND status = 'running'
    `,
      )
      .run(
        data.status,
        data.summary,
        data.model,
        data.runtime,
        data.provider,
        data.inputTokens,
        data.outputTokens,
        data.cacheReadTokens,
        data.cacheCreationTokens,
        data.costUsd,
        data.apiRequests,
        data.toolUses,
        data.durationMs,
        data.costStatus,
        data.tokenStatus,
        data.costUnknownReason,
        stableJson(data.metadata),
        executionId,
      );
    if (changed.changes !== 1) throw new Error(`Falha ao finalizar execution ${executionId}.`);
  }).immediate();
}

export type TaskExecutionRollupScope =
  | { executionId: string; rootExecutionId?: never; ownerKind?: never; ownerId?: never }
  | { executionId?: never; rootExecutionId: string; ownerKind?: never; ownerId?: never }
  | {
      executionId?: never;
      rootExecutionId?: never;
      ownerKind: TaskExecutionStart['ownerKind'];
      ownerId: string;
      surface?: string;
      executionKinds?: Array<Exclude<TaskExecutionStart['executionKind'], 'root'>>;
    };

export interface TaskExecutionRollup {
  executionCount: number;
  executionIds: string[];
  statusCounts: {
    running: number;
    completed: number;
    failed: number;
    cancelled: number;
  };
  metrics: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    costUsd: number;
    apiRequests: number;
    toolUses: number;
    durationMs: number;
  };
  costStatus: TaskExecutionFinalize['costStatus'] | null;
  tokenStatus: TaskExecutionFinalize['tokenStatus'] | null;
  costUnknownReasons: Array<NonNullable<TaskExecutionFinalize['costUnknownReason']>>;
  costByRuntime: Record<string, number>;
  unknownCostCount: number;
  notReportedTokenCount: number;
  usageMetadata: {
    modelUsage: Record<
      string,
      {
        inputTokens: number;
        outputTokens: number;
        cacheReadInputTokens: number;
        cacheCreationInputTokens: number;
        costUSD: number;
        reasoningTokens?: number;
        modelCalls?: number;
        costUsdTicks?: number;
      }
    >;
    pricingProvenance: Array<{
      executionId: string;
      model: string;
      runtime: string;
      provider: string | null;
      costUsd: number;
      costStatus: TaskExecutionFinalize['costStatus'];
      costSource?: string;
      costEstimationKind?: 'subscription-equivalent-payg';
      pricingSnapshot?: unknown;
      grok?: unknown;
    }>;
    unattributedCostUsd?: number;
    overAttributedCostUsd?: number;
  };
}

type TaskExecutionRollupRow = Pick<
  TaskExecutionLedgerRow,
  | 'execution_id'
  | 'status'
  | 'input_tokens'
  | 'output_tokens'
  | 'cache_read_tokens'
  | 'cache_creation_tokens'
  | 'cost_usd'
  | 'api_requests'
  | 'tool_uses'
  | 'duration_ms'
  | 'cost_status'
  | 'token_status'
  | 'cost_unknown_reason'
  | 'runtime'
  | 'provider'
  | 'model'
  | 'metadata'
>;

const COST_QUALITY_RANK: Record<TaskExecutionFinalize['costStatus'], number> = {
  known: 0,
  'estimated-partial': 1,
  unknown: 2,
};

export function getTaskExecutionRollup(scope: TaskExecutionRollupScope): TaskExecutionRollup {
  let predicate: string;
  let bindings: string[];
  if (scope.executionId) {
    predicate = 'execution_id = ?';
    bindings = [scope.executionId];
  } else if (scope.rootExecutionId) {
    predicate = 'root_execution_id = ?';
    bindings = [scope.rootExecutionId];
  } else if (scope.ownerKind && scope.ownerId) {
    predicate = 'owner_kind = ? AND owner_id = ?';
    bindings = [scope.ownerKind, scope.ownerId];
    if (scope.executionKinds && scope.executionKinds.length > 0) {
      predicate += ` AND execution_kind IN (${scope.executionKinds.map(() => '?').join(', ')})`;
      bindings.push(...scope.executionKinds);
    }
    if (scope.surface) {
      predicate += ` AND root_execution_id IN (
        SELECT execution_id FROM task_executions
        WHERE execution_kind = 'root'
          AND owner_kind = ? AND owner_id = ?
          AND json_extract(metadata, '$.surface') = ?
      )`;
      bindings.push(scope.ownerKind, scope.ownerId, scope.surface);
    }
  } else {
    throw new Error('Rollup de task executions exige execution, root ou owner.');
  }

  const rows = db
    .prepare(
      `
    WITH canonical AS (
      SELECT
        execution_id, status, input_tokens, output_tokens, cache_read_tokens,
        cache_creation_tokens, cost_usd, api_requests, tool_uses, duration_ms,
        cost_status, token_status, cost_unknown_reason, runtime, provider, model, metadata,
        ROW_NUMBER() OVER (PARTITION BY execution_id ORDER BY id DESC) AS position
      FROM task_executions
      WHERE execution_id IS NOT NULL
        AND execution_kind <> 'root'
        AND ${predicate}
    )
    SELECT execution_id, status, input_tokens, output_tokens, cache_read_tokens,
      cache_creation_tokens, cost_usd, api_requests, tool_uses, duration_ms,
      cost_status, token_status, cost_unknown_reason, runtime, provider, model, metadata
    FROM canonical
    WHERE position = 1
    ORDER BY execution_id
  `,
    )
    .all(...bindings) as TaskExecutionRollupRow[];

  const rollup: TaskExecutionRollup = {
    executionCount: rows.length,
    executionIds: [],
    statusCounts: { running: 0, completed: 0, failed: 0, cancelled: 0 },
    metrics: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUsd: 0,
      apiRequests: 0,
      toolUses: 0,
      durationMs: 0,
    },
    costStatus: null,
    tokenStatus: null,
    costUnknownReasons: [],
    costByRuntime: {},
    unknownCostCount: 0,
    notReportedTokenCount: 0,
    usageMetadata: {
      modelUsage: {},
      pricingProvenance: [],
    },
  };
  const unknownReasons = new Set<NonNullable<TaskExecutionFinalize['costUnknownReason']>>();

  for (const row of rows) {
    rollup.executionIds.push(row.execution_id);
    if (row.status in rollup.statusCounts) {
      rollup.statusCounts[row.status as keyof TaskExecutionRollup['statusCounts']] += 1;
    }
    rollup.metrics.inputTokens += row.input_tokens;
    rollup.metrics.outputTokens += row.output_tokens;
    rollup.metrics.cacheReadTokens += row.cache_read_tokens;
    rollup.metrics.cacheCreationTokens += row.cache_creation_tokens;
    rollup.metrics.costUsd += row.cost_usd;
    rollup.metrics.apiRequests += row.api_requests;
    rollup.metrics.toolUses += row.tool_uses;
    rollup.metrics.durationMs += row.duration_ms;
    const runtime = row.runtime ?? 'unknown';
    rollup.costByRuntime[runtime] = (rollup.costByRuntime[runtime] ?? 0) + row.cost_usd;

    let metadata: Record<string, unknown> = {};
    try {
      metadata = row.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>) : {};
    } catch {
      /* metadata legado/corrompido fica sem breakdown */
    }
    const rawModelUsage = metadata['modelUsage'];
    if (rawModelUsage && typeof rawModelUsage === 'object' && !Array.isArray(rawModelUsage)) {
      for (const [model, rawUsage] of Object.entries(rawModelUsage as Record<string, unknown>)) {
        if (!rawUsage || typeof rawUsage !== 'object' || Array.isArray(rawUsage)) continue;
        const usage = rawUsage as Record<string, unknown>;
        const number = (key: string): number =>
          typeof usage[key] === 'number' && Number.isFinite(usage[key]) ? usage[key] : 0;
        const previous = rollup.usageMetadata.modelUsage[model];
        const next = {
          inputTokens: number('inputTokens'),
          outputTokens: number('outputTokens'),
          cacheReadInputTokens: number('cacheReadInputTokens'),
          cacheCreationInputTokens: number('cacheCreationInputTokens'),
          costUSD: number('costUSD'),
          ...(typeof usage['reasoningTokens'] === 'number' ? { reasoningTokens: number('reasoningTokens') } : {}),
          ...(typeof usage['modelCalls'] === 'number' ? { modelCalls: number('modelCalls') } : {}),
          ...(typeof usage['costUsdTicks'] === 'number' ? { costUsdTicks: number('costUsdTicks') } : {}),
        };
        rollup.usageMetadata.modelUsage[model] = previous
          ? {
              inputTokens: previous.inputTokens + next.inputTokens,
              outputTokens: previous.outputTokens + next.outputTokens,
              cacheReadInputTokens: previous.cacheReadInputTokens + next.cacheReadInputTokens,
              cacheCreationInputTokens: previous.cacheCreationInputTokens + next.cacheCreationInputTokens,
              costUSD: previous.costUSD + next.costUSD,
              ...(previous.reasoningTokens !== undefined || next.reasoningTokens !== undefined
                ? { reasoningTokens: (previous.reasoningTokens ?? 0) + (next.reasoningTokens ?? 0) }
                : {}),
              ...(previous.modelCalls !== undefined || next.modelCalls !== undefined
                ? { modelCalls: (previous.modelCalls ?? 0) + (next.modelCalls ?? 0) }
                : {}),
              ...(previous.costUsdTicks !== undefined || next.costUsdTicks !== undefined
                ? { costUsdTicks: (previous.costUsdTicks ?? 0) + (next.costUsdTicks ?? 0) }
                : {}),
            }
          : next;
      }
    }
    rollup.usageMetadata.pricingProvenance.push({
      executionId: row.execution_id,
      model: row.model || `${runtime}:unknown-model`,
      runtime,
      provider: row.provider,
      costUsd: row.cost_usd,
      costStatus: row.cost_status ?? 'unknown',
      ...(typeof metadata['costSource'] === 'string' ? { costSource: metadata['costSource'] } : {}),
      ...(metadata['costEstimationKind'] === 'subscription-equivalent-payg'
        ? { costEstimationKind: metadata['costEstimationKind'] }
        : {}),
      ...(metadata['pricingSnapshot'] !== undefined ? { pricingSnapshot: metadata['pricingSnapshot'] } : {}),
      ...(metadata['grok'] !== undefined ? { grok: metadata['grok'] } : {}),
    });

    const rowCostStatus = row.cost_status ?? 'unknown';
    if (rowCostStatus === 'unknown') rollup.unknownCostCount += 1;
    if (rollup.costStatus === null || COST_QUALITY_RANK[rowCostStatus] > COST_QUALITY_RANK[rollup.costStatus]) {
      rollup.costStatus = rowCostStatus;
    }
    if (row.token_status !== 'reported') {
      rollup.tokenStatus = 'not_reported';
      rollup.notReportedTokenCount += 1;
    } else if (rollup.tokenStatus === null) rollup.tokenStatus = 'reported';
    if (row.cost_unknown_reason) unknownReasons.add(row.cost_unknown_reason);
  }

  rollup.costUnknownReasons = [...unknownReasons].sort();
  const attributedCost = Object.values(rollup.usageMetadata.modelUsage).reduce((sum, usage) => sum + usage.costUSD, 0);
  if (rollup.costStatus === 'known') {
    const attributionDelta = rollup.metrics.costUsd - attributedCost;
    if (attributionDelta >= 0) {
      rollup.usageMetadata.unattributedCostUsd = attributionDelta;
    } else {
      rollup.usageMetadata.unattributedCostUsd = 0;
      rollup.usageMetadata.overAttributedCostUsd = Math.abs(attributionDelta);
    }
  }
  return rollup;
}

function mapHarnessProject(row: Record<string, unknown>): HarnessProject {
  return {
    id: row['id'] as string,
    name: row['name'] as string,
    description: row['description'] as string | undefined,
    projectPath: row['project_path'] as string,
    specPath: row['spec_path'] as string,
    sprintsJsonPath: row['sprints_json_path'] as string | undefined,
    status: row['status'] as HarnessProject['status'],
    config: JSON.parse((row['config'] as string) || '{}'),
    currentSprintIndex: (row['current_sprint_index'] as number) ?? -1,
    totalSprints: (row['total_sprints'] as number) ?? 0,
    totalFeatures: (row['total_features'] as number) ?? 0,
    plannerInputTokens: (row['planner_input_tokens'] as number) ?? 0,
    plannerOutputTokens: (row['planner_output_tokens'] as number) ?? 0,
    plannerCacheTokens: (row['planner_cache_tokens'] as number) ?? 0,
    plannerCostUsd: (row['planner_cost_usd'] as number) ?? 0,
    plannerDurationMs: (row['planner_duration_ms'] as number) ?? 0,
    plannerUnknownCostCount: (row['planner_unknown_cost_count'] as number) ?? 0,
    createdAt: row['created_at'] as string,
    updatedAt: row['updated_at'] as string,
    discoveryNotesPath: row['discovery_notes_path'] as string | undefined,
    prdPath: row['prd_path'] as string | undefined,
    pipelineCurrentPhase: row['pipeline_current_phase'] as number | null | undefined,
    pipelineStartPhase: row['pipeline_start_phase'] as number | null | undefined,
    pipelineSprintIndex: (row['pipeline_sprint_index'] as number | null | undefined) ?? 0,
    pipelineDiscoveryBlock: (row['pipeline_discovery_block'] as number | null | undefined) ?? 1,
    pipelineType: ((row['pipeline_type'] as string | undefined) ?? 'development') as PipelineType,
    pipelineDocsId: (row['pipeline_docs_id'] as string | null) ?? null,
  };
}

function applyLegacyHarnessSprintsJsonMigration(project: HarnessProject): HarnessProject {
  try {
    const result = migrateLegacyHarnessSprintsJsonFile(project);
    if (result.shouldUpdateDb) {
      db.prepare(
        `
        UPDATE harness_projects
        SET sprints_json_path = ?, updated_at = datetime('now')
        WHERE id = ?
      `,
      ).run(result.canonicalPath, project.id);
      return { ...project, sprintsJsonPath: result.canonicalPath };
    }
  } catch (err) {
    logger.warn({ err, projectId: project.id }, 'Failed to migrate legacy harness sprints JSON');
  }
  return project;
}

export function migrateLegacyHarnessSprintsJsonPaths(): void {
  let rows: Record<string, unknown>[];
  try {
    rows = db
      .prepare(
        `
      SELECT * FROM harness_projects
      WHERE sprints_json_path IS NOT NULL
        AND sprints_json_path != ''
    `,
      )
      .all() as Record<string, unknown>[];
  } catch (err) {
    logger.warn({ err }, 'Failed to query harness projects for legacy sprints migration');
    return;
  }

  for (const row of rows) {
    applyLegacyHarnessSprintsJsonMigration(mapHarnessProject(row));
  }
}

export function insertHarnessProject(data: {
  name: string;
  description?: string;
  projectPath: string;
  specPath: string;
  sprintsJsonPath?: string;
  config: HarnessProject['config'];
  pipelineType?: PipelineType;
  pipelineDocsId?: string | null;
}): HarnessProject {
  const result = db
    .prepare(
      `
    INSERT INTO harness_projects (name, description, project_path, spec_path, sprints_json_path, config, pipeline_type, pipeline_docs_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `,
    )
    .run(
      data.name,
      data.description ?? null,
      data.projectPath,
      data.specPath,
      data.sprintsJsonPath ?? null,
      JSON.stringify(data.config),
      data.pipelineType ?? 'development',
      data.pipelineDocsId ?? null,
    );
  const id = db.prepare('SELECT id FROM harness_projects WHERE rowid = ?').get(result.lastInsertRowid) as {
    id: string;
  };
  return getHarnessProject(id.id)!;
}

export function updateHarnessProject(
  id: string,
  updates: Partial<{
    name: string;
    description: string | null;
    projectPath: string;
    specPath: string;
    sprintsJsonPath: string | null;
    status: HarnessProject['status'];
    config: HarnessProject['config'];
    currentSprintIndex: number;
    totalSprints: number;
    totalFeatures: number;
    plannerInputTokens: number;
    plannerOutputTokens: number;
    plannerCacheTokens: number;
    plannerCostUsd: number;
    plannerDurationMs: number;
    pipelineDocsId: string | null;
    plannerUnknownCostCount: number;
  }>,
): HarnessProject {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.name !== undefined) {
    fields.push('name = ?');
    values.push(updates.name);
  }
  if (updates.description !== undefined) {
    fields.push('description = ?');
    values.push(updates.description);
  }
  if (updates.projectPath !== undefined) {
    fields.push('project_path = ?');
    values.push(updates.projectPath);
  }
  if (updates.specPath !== undefined) {
    fields.push('spec_path = ?');
    values.push(updates.specPath);
  }
  if (updates.sprintsJsonPath !== undefined) {
    fields.push('sprints_json_path = ?');
    values.push(updates.sprintsJsonPath);
  }
  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }
  if (updates.config !== undefined) {
    fields.push('config = ?');
    values.push(JSON.stringify(updates.config));
  }
  if (updates.currentSprintIndex !== undefined) {
    fields.push('current_sprint_index = ?');
    values.push(updates.currentSprintIndex);
  }
  if (updates.totalSprints !== undefined) {
    fields.push('total_sprints = ?');
    values.push(updates.totalSprints);
  }
  if (updates.totalFeatures !== undefined) {
    fields.push('total_features = ?');
    values.push(updates.totalFeatures);
  }
  if (updates.plannerInputTokens !== undefined) {
    fields.push('planner_input_tokens = ?');
    values.push(updates.plannerInputTokens);
  }
  if (updates.plannerOutputTokens !== undefined) {
    fields.push('planner_output_tokens = ?');
    values.push(updates.plannerOutputTokens);
  }
  if (updates.plannerCacheTokens !== undefined) {
    fields.push('planner_cache_tokens = ?');
    values.push(updates.plannerCacheTokens);
  }
  if (updates.plannerCostUsd !== undefined) {
    fields.push('planner_cost_usd = ?');
    values.push(updates.plannerCostUsd);
  }
  if (updates.plannerDurationMs !== undefined) {
    fields.push('planner_duration_ms = ?');
    values.push(updates.plannerDurationMs);
  }
  if (updates.pipelineDocsId !== undefined) {
    fields.push('pipeline_docs_id = ?');
    values.push(updates.pipelineDocsId);
  }
  if (updates.plannerUnknownCostCount !== undefined) {
    fields.push('planner_unknown_cost_count = ?');
    values.push(updates.plannerUnknownCostCount);
  }

  if (fields.length > 0) {
    fields.push(`updated_at = datetime('now')`);
    values.push(id);
    db.prepare(`UPDATE harness_projects SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  }
  return getHarnessProject(id)!;
}

function parseHarnessConfig(value: unknown): HarnessProject['config'] {
  try {
    return JSON.parse(typeof value === 'string' ? value : '{}') as HarnessProject['config'];
  } catch {
    return {} as HarnessProject['config'];
  }
}

export function getHarnessProviderAuthCheckpoint(projectId: string): HarnessProviderAuthCheckpoint | undefined {
  const row = db.prepare('SELECT config FROM harness_projects WHERE id = ?').get(projectId) as
    { config: string } | undefined;
  return row ? parseHarnessConfig(row.config).providerAuthCheckpoint : undefined;
}

export function persistHarnessProviderAuthCheckpoint(
  projectId: string,
  checkpoint: HarnessProviderAuthCheckpoint,
): boolean {
  return db
    .transaction(() => {
      const row = db.prepare('SELECT config FROM harness_projects WHERE id = ?').get(projectId) as
        { config: string } | undefined;
      if (!row) return false;
      const config = parseHarnessConfig(row.config);
      config.providerAuthCheckpoint = { ...checkpoint, claimState: 'pending' };
      const result = db
        .prepare(
          `
      UPDATE harness_projects
      SET config = ?, status = 'paused', updated_at = datetime('now')
      WHERE id = ?
    `,
        )
        .run(JSON.stringify(config), projectId);
      return result.changes === 1;
    })
    .immediate();
}

export function claimHarnessProviderAuthCheckpoint(
  projectId: string,
  checkpointId: string,
): HarnessProviderAuthCheckpoint | undefined {
  return db
    .transaction(() => {
      const row = db.prepare('SELECT config FROM harness_projects WHERE id = ?').get(projectId) as
        { config: string } | undefined;
      if (!row) return undefined;
      const config = parseHarnessConfig(row.config);
      const checkpoint = config.providerAuthCheckpoint;
      if (!checkpoint || checkpoint.checkpointId !== checkpointId) return undefined;
      if (
        checkpoint.claimState !== undefined &&
        checkpoint.claimState !== 'pending' &&
        checkpoint.claimState !== 'claimed'
      )
        return undefined;
      if (checkpoint.claimState === 'claimed') return checkpoint;
      const claimed: HarnessProviderAuthCheckpoint = { ...checkpoint, claimState: 'claimed' };
      config.providerAuthCheckpoint = claimed;
      const result = db
        .prepare(
          `
      UPDATE harness_projects
      SET config = ?, updated_at = datetime('now')
      WHERE id = ? AND config = ?
    `,
        )
        .run(JSON.stringify(config), projectId, row.config);
      return result.changes === 1 ? claimed : undefined;
    })
    .immediate();
}

export function advanceClaimedHarnessProviderAuthCheckpoint(
  projectId: string,
  checkpointId: string,
  resume: unknown,
): HarnessProviderAuthCheckpoint | undefined {
  return db
    .transaction(() => {
      const row = db.prepare('SELECT config FROM harness_projects WHERE id = ?').get(projectId) as
        { config: string } | undefined;
      if (!row) return undefined;
      const config = parseHarnessConfig(row.config);
      const checkpoint = config.providerAuthCheckpoint;
      if (!checkpoint || checkpoint.checkpointId !== checkpointId || checkpoint.claimState !== 'claimed')
        return undefined;
      const advanced: HarnessProviderAuthCheckpoint = { ...checkpoint, resume };
      config.providerAuthCheckpoint = advanced;
      const result = db
        .prepare(
          `
      UPDATE harness_projects
      SET config = ?, updated_at = datetime('now')
      WHERE id = ? AND config = ?
    `,
        )
        .run(JSON.stringify(config), projectId, row.config);
      return result.changes === 1 ? advanced : undefined;
    })
    .immediate();
}

export interface HarnessEvaluatorRoundCompletion {
  evaluatorSessionId?: string | null;
  evaluatorInputTokens: number;
  evaluatorOutputTokens: number;
  evaluatorCacheTokens: number;
  evaluatorCostUsd: number;
  evaluatorDurationMs: number;
  evaluatorToolUses: number;
  evaluatorApiRequests: number;
  verdict: HarnessRound['verdict'];
  feedbackSummary: string | null;
  completedAt: string;
  metadata: Record<string, unknown>;
  unknownCostCount?: number;
}

export interface HarnessEvaluatorPipelineMessage {
  projectId: string;
  phaseNumber: number;
  role: 'assistant';
  content: string;
  toolCalls?: Array<{ tool: string; input: unknown; output?: string; isError?: boolean }>;
  sprintIndex: number;
  roundIndex: number;
  agentId: string;
}

function harnessResumeRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function harnessResumeCheckpoint(value: unknown): Record<string, unknown> | undefined {
  return harnessResumeRecord(harnessResumeRecord(value)?.['checkpoint']);
}

export function persistClaimedHarnessEvaluatorCompletion(data: {
  projectId: string;
  checkpointId: string;
  roundId: string;
  resume: unknown;
  round: HarnessEvaluatorRoundCompletion;
  pipelineMessage?: HarnessEvaluatorPipelineMessage;
}): HarnessProviderAuthCheckpoint | undefined {
  const requestedResume = harnessResumeRecord(data.resume);
  const requestedCheckpoint = harnessResumeCheckpoint(data.resume);
  if (
    (requestedResume?.['kind'] !== 'run' && requestedResume?.['kind'] !== 'pipeline-run') ||
    requestedCheckpoint?.['stage'] !== 'evaluator-completed' ||
    requestedCheckpoint['roundId'] !== data.roundId
  ) {
    throw new Error('Conclusao do evaluator exige checkpoint terminal do mesmo round.');
  }

  return db
    .transaction(() => {
      const row = db.prepare('SELECT config FROM harness_projects WHERE id = ?').get(data.projectId) as
        { config: string } | undefined;
      if (!row) return undefined;
      const config = parseHarnessConfig(row.config);
      const checkpoint = config.providerAuthCheckpoint;
      if (
        !checkpoint ||
        checkpoint.checkpointId !== data.checkpointId ||
        checkpoint.claimState !== 'claimed' ||
        (checkpoint.roundId !== undefined && checkpoint.roundId !== data.roundId)
      )
        return undefined;

      const currentResume = harnessResumeRecord(checkpoint.resume);
      const currentRound = harnessResumeCheckpoint(checkpoint.resume);
      if (
        currentResume?.['kind'] !== requestedResume['kind'] ||
        currentResume?.['provider'] !== checkpoint.provider ||
        requestedResume['provider'] !== checkpoint.provider ||
        currentRound?.['roundId'] !== data.roundId
      )
        return undefined;

      if (currentRound['stage'] === 'evaluator-completed') return checkpoint;
      if (currentRound['stage'] !== 'evaluator') return undefined;

      updateHarnessRound(data.roundId, data.round);
      if (data.pipelineMessage) savePipelineMessage(data.pipelineMessage);

      const advanced: HarnessProviderAuthCheckpoint = { ...checkpoint, resume: data.resume };
      config.providerAuthCheckpoint = advanced;
      const result = db
        .prepare(
          `
      UPDATE harness_projects
      SET config = ?, updated_at = datetime('now')
      WHERE id = ? AND config = ?
    `,
        )
        .run(JSON.stringify(config), data.projectId, row.config);
      if (result.changes !== 1) {
        throw new Error('Checkpoint de autenticacao mudou durante o commit do evaluator.');
      }
      return advanced;
    })
    .immediate();
}

export function completeHarnessProviderAuthCheckpoint(projectId: string, checkpointId: string): boolean {
  return db
    .transaction(() => {
      const row = db.prepare('SELECT config FROM harness_projects WHERE id = ?').get(projectId) as
        { config: string } | undefined;
      if (!row) return false;
      const config = parseHarnessConfig(row.config);
      const checkpoint = config.providerAuthCheckpoint;
      if (!checkpoint || checkpoint.checkpointId !== checkpointId || checkpoint.claimState !== 'claimed') return false;
      delete config.providerAuthCheckpoint;
      const result = db
        .prepare(
          `
      UPDATE harness_projects
      SET config = ?, updated_at = datetime('now')
      WHERE id = ? AND config = ?
    `,
        )
        .run(JSON.stringify(config), projectId, row.config);
      return result.changes === 1;
    })
    .immediate();
}

export function getHarnessProject(id: string): HarnessProject | undefined {
  const row = db.prepare('SELECT * FROM harness_projects WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  return applyLegacyHarnessSprintsJsonMigration(mapHarnessProject(row));
}

export function listHarnessProjects(): HarnessProject[] {
  const rows = db.prepare('SELECT * FROM harness_projects ORDER BY created_at DESC').all() as Record<string, unknown>[];
  return rows.map((row) => applyLegacyHarnessSprintsJsonMigration(mapHarnessProject(row)));
}

export function deleteHarnessProject(id: string): void {
  const deleteAll = db.transaction(() => {
    db.prepare(
      `
      DELETE FROM harness_rounds
      WHERE sprint_id IN (SELECT id FROM harness_sprints WHERE project_id = ?)
    `,
    ).run(id);
    db.prepare('DELETE FROM harness_sprints WHERE project_id = ?').run(id);
    db.prepare('DELETE FROM harness_projects WHERE id = ?').run(id);
  });
  deleteAll();
  logger.info({ projectId: id }, 'Deleted harness project and related data (files on disk preserved)');
}

function mapHarnessSprint(row: Record<string, unknown>): HarnessSprint {
  return {
    id: row['id'] as string,
    projectId: row['project_id'] as string,
    sprintIndex: row['sprint_index'] as number,
    sprintJsonId: row['sprint_json_id'] as string,
    name: row['name'] as string,
    status: row['status'] as HarnessSprint['status'],
    verdict: row['verdict'] as string | null | undefined,
    coderAgentId: row['coder_agent_id'] as string | undefined,
    evaluatorAgentId: row['evaluator_agent_id'] as string | undefined,
    roundsUsed: (row['rounds_used'] as number) ?? 0,
    maxRounds: (row['max_rounds'] as number) ?? 3,
    startedAt: row['started_at'] as string | undefined,
    completedAt: row['completed_at'] as string | undefined,
    updatedAt: row['updated_at'] as string | undefined,
  };
}

export function insertHarnessSprint(data: {
  projectId: string;
  sprintIndex: number;
  sprintJsonId: string;
  name: string;
  coderAgentId?: string;
  evaluatorAgentId?: string;
  maxRounds?: number;
}): HarnessSprint {
  const result = db
    .prepare(
      `
    INSERT INTO harness_sprints (project_id, sprint_index, sprint_json_id, name, coder_agent_id, evaluator_agent_id, max_rounds)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `,
    )
    .run(
      data.projectId,
      data.sprintIndex,
      data.sprintJsonId,
      data.name,
      data.coderAgentId ?? null,
      data.evaluatorAgentId ?? null,
      data.maxRounds ?? 3,
    );
  const row = db.prepare('SELECT id FROM harness_sprints WHERE rowid = ?').get(result.lastInsertRowid) as {
    id: string;
  };
  return getHarnessSprints(data.projectId).find((s) => s.id === row.id)!;
}

export function replaceHarnessSprintsForProject(
  projectId: string,
  sprints: Array<{
    sprintIndex: number;
    sprintJsonId: string;
    name: string;
    coderAgentId?: string;
    evaluatorAgentId?: string;
    maxRounds?: number;
  }>,
  extras?: {
    totals?: { totalSprints: number; totalFeatures: number };
    sprintJsonHashes?: Record<string, string>;
  },
): void {
  const replace = db.transaction(() => {
    const existing = db.prepare('SELECT id FROM harness_sprints WHERE project_id = ?').all(projectId) as Array<{
      id: string;
    }>;
    const delRounds = db.prepare('DELETE FROM harness_rounds WHERE sprint_id = ?');
    for (const s of existing) delRounds.run(s.id);
    db.prepare('DELETE FROM harness_sprints WHERE project_id = ?').run(projectId);
    const ins = db.prepare(`
      INSERT INTO harness_sprints
        (project_id, sprint_index, sprint_json_id, name, coder_agent_id, evaluator_agent_id, max_rounds)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (const s of sprints) {
      ins.run(
        projectId,
        s.sprintIndex,
        s.sprintJsonId,
        s.name,
        s.coderAgentId ?? null,
        s.evaluatorAgentId ?? null,
        s.maxRounds ?? 3,
      );
    }
    if (extras?.totals) {
      db.prepare(
        `UPDATE harness_projects SET total_sprints = ?, total_features = ?, updated_at = datetime('now') WHERE id = ?`,
      ).run(extras.totals.totalSprints, extras.totals.totalFeatures, projectId);
    }
    if (extras?.sprintJsonHashes) {
      writeSprintJsonHashesInCurrentTx(projectId, extras.sprintJsonHashes, 'replace');
    }
  });
  replace();
}

export function updateHarnessPendingSprintsFromReseed(
  projectId: string,
  updates: Array<{ id: string; name: string; coderAgentId: string | null; maxRounds: number }>,
  totals: { totalSprints: number; totalFeatures: number },
  sprintJsonHashes: Record<string, string>,
): void {
  const apply = db.transaction(() => {
    const upd = db.prepare(
      `UPDATE harness_sprints SET name = ?, coder_agent_id = ?, max_rounds = ?, updated_at = datetime('now')
       WHERE id = ? AND project_id = ? AND status = 'pending'`,
    );
    for (const u of updates) {
      const res = upd.run(u.name, u.coderAgentId, u.maxRounds, u.id, projectId);
      if (res.changes !== 1) {
        throw new Error(
          `Reseed de sprints: linha ${u.id} nao esta mais 'pending' (corrida com a execucao) — nada foi alterado. Re-aprove o plano quando a fila estiver estavel.`,
        );
      }
    }
    db.prepare(
      `UPDATE harness_projects SET total_sprints = ?, total_features = ?, updated_at = datetime('now') WHERE id = ?`,
    ).run(totals.totalSprints, totals.totalFeatures, projectId);
    writeSprintJsonHashesInCurrentTx(projectId, sprintJsonHashes, 'merge');
  });
  apply();
}

export function mergeHarnessProjectSprintJsonHashes(projectId: string, sprintJsonHashes: Record<string, string>): void {
  const apply = db.transaction(() => {
    writeSprintJsonHashesInCurrentTx(projectId, sprintJsonHashes, 'merge');
  });
  apply();
}

export function countHarnessRoundsForProject(projectId: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM harness_rounds
     WHERE sprint_id IN (SELECT id FROM harness_sprints WHERE project_id = ?)`,
    )
    .get(projectId) as { n: number };
  return row.n;
}

function writeSprintJsonHashesInCurrentTx(
  projectId: string,
  sprintJsonHashes: Record<string, string>,
  mode: 'replace' | 'merge',
): void {
  const row = db.prepare('SELECT config FROM harness_projects WHERE id = ?').get(projectId) as
    { config: string | null } | undefined;
  if (!row) throw new Error(`Projeto ${projectId} nao encontrado ao gravar sprintJsonHashes`);
  const config = row.config ? (JSON.parse(row.config) as Record<string, unknown>) : {};
  const current = (config['sprintJsonHashes'] ?? {}) as Record<string, string>;
  config['sprintJsonHashes'] = mode === 'replace' ? sprintJsonHashes : { ...current, ...sprintJsonHashes };
  db.prepare(`UPDATE harness_projects SET config = ?, updated_at = datetime('now') WHERE id = ?`).run(
    JSON.stringify(config),
    projectId,
  );
}

export function updateHarnessSprint(
  id: string,
  updates: Partial<{
    status: HarnessSprint['status'];
    coderAgentId: string | null;
    evaluatorAgentId: string | null;
    roundsUsed: number;
    maxRounds: number;
    startedAt: string | null;
    completedAt: string | null;
  }>,
): HarnessSprint {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }
  if (updates.coderAgentId !== undefined) {
    fields.push('coder_agent_id = ?');
    values.push(updates.coderAgentId);
  }
  if (updates.evaluatorAgentId !== undefined) {
    fields.push('evaluator_agent_id = ?');
    values.push(updates.evaluatorAgentId);
  }
  if (updates.roundsUsed !== undefined) {
    fields.push('rounds_used = ?');
    values.push(updates.roundsUsed);
  }
  if (updates.maxRounds !== undefined) {
    fields.push('max_rounds = ?');
    values.push(updates.maxRounds);
  }
  if (updates.startedAt !== undefined) {
    fields.push('started_at = ?');
    values.push(updates.startedAt);
  }
  if (updates.completedAt !== undefined) {
    fields.push('completed_at = ?');
    values.push(updates.completedAt);
  }

  if (fields.length > 0) {
    values.push(id);
    db.prepare(`UPDATE harness_sprints SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  }

  const row = db.prepare('SELECT * FROM harness_sprints WHERE id = ?').get(id) as Record<string, unknown>;
  return mapHarnessSprint(row);
}

export function getHarnessSprints(projectId: string): HarnessSprint[] {
  const rows = db
    .prepare('SELECT * FROM harness_sprints WHERE project_id = ? ORDER BY sprint_index ASC')
    .all(projectId) as Record<string, unknown>[];
  return rows.map(mapHarnessSprint);
}

function mapHarnessRound(row: Record<string, unknown>): HarnessRound {
  const metadata = row['metadata'] ? (JSON.parse(row['metadata'] as string) as Record<string, unknown>) : {};
  const unknownCostCount = (row['unknown_cost_count'] as number) ?? 0;
  let costStatus: TaskExecutionFinalize['costStatus'] = unknownCostCount > 0 ? 'unknown' : 'known';
  for (const key of ['coderCostStatus', 'evaluatorCostStatus'] as const) {
    const value = metadata[key];
    if (
      (value === 'known' || value === 'unknown' || value === 'estimated-partial') &&
      COST_QUALITY_RANK[value] > COST_QUALITY_RANK[costStatus]
    ) {
      costStatus = value;
    }
  }
  const coderCostUsd = (row['coder_cost_usd'] as number) ?? 0;
  const evaluatorCostUsd = (row['evaluator_cost_usd'] as number) ?? 0;
  const subscriptionEquivalentCost =
    (metadata['coderCostEstimationKind'] === 'subscription-equivalent-payg' ? coderCostUsd : 0) +
    (metadata['evaluatorCostEstimationKind'] === 'subscription-equivalent-payg' ? evaluatorCostUsd : 0);
  return {
    id: row['id'] as string,
    sprintId: row['sprint_id'] as string,
    roundNumber: row['round_number'] as number,
    coderSessionId: row['coder_session_id'] as string | undefined,
    coderInputTokens: (row['coder_input_tokens'] as number) ?? 0,
    coderOutputTokens: (row['coder_output_tokens'] as number) ?? 0,
    coderCacheTokens: (row['coder_cache_tokens'] as number) ?? 0,
    coderCostUsd,
    coderDurationMs: (row['coder_duration_ms'] as number) ?? 0,
    coderToolUses: (row['coder_tool_uses'] as number) ?? 0,
    coderApiRequests: (row['coder_api_requests'] as number) ?? 0,
    evaluatorSessionId: row['evaluator_session_id'] as string | undefined,
    evaluatorInputTokens: (row['evaluator_input_tokens'] as number) ?? 0,
    evaluatorOutputTokens: (row['evaluator_output_tokens'] as number) ?? 0,
    evaluatorCacheTokens: (row['evaluator_cache_tokens'] as number) ?? 0,
    evaluatorCostUsd,
    evaluatorDurationMs: (row['evaluator_duration_ms'] as number) ?? 0,
    evaluatorToolUses: (row['evaluator_tool_uses'] as number) ?? 0,
    evaluatorApiRequests: (row['evaluator_api_requests'] as number) ?? 0,
    verdict: row['verdict'] as HarnessRound['verdict'],
    feedbackSummary: row['feedback_summary'] as string | undefined,
    startedAt: row['started_at'] as string,
    completedAt: row['completed_at'] as string | undefined,
    costSource: (row['cost_source'] as CostSource | null) ?? null,
    runtimeUsed: (row['runtime_used'] as HarnessRound['runtimeUsed']) ?? null,
    providerUsed: (row['provider_used'] as string | null) ?? null,
    modelUsed: (row['model_used'] as string | null) ?? null,
    metadata,
    codexPatchFailures: (row['codex_patch_failures'] as number) ?? 0,
    unknownCostCount,
    costStatus,
    subscriptionEquivalentCost,
  };
}

export function insertHarnessRound(data: {
  sprintId: string;
  roundNumber: number;
  coderSessionId?: string;
  costSource?: CostSource | null;
  runtimeUsed?: 'cloud' | 'local' | 'external' | 'codex' | 'zai' | 'minimax-tp' | 'kimi' | 'grok' | 'cursor' | null;
  providerUsed?: string | null;
  modelUsed?: string | null;
}): HarnessRound {
  const result = db
    .prepare(
      `
    INSERT INTO harness_rounds (sprint_id, round_number, coder_session_id, cost_source, runtime_used, provider_used, model_used)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `,
    )
    .run(
      data.sprintId,
      data.roundNumber,
      data.coderSessionId ?? null,
      data.costSource ?? null,
      data.runtimeUsed ?? null,
      data.providerUsed ?? null,
      data.modelUsed ?? null,
    );
  const row = db.prepare('SELECT * FROM harness_rounds WHERE rowid = ?').get(result.lastInsertRowid) as Record<
    string,
    unknown
  >;
  return mapHarnessRound(row);
}

export function updateHarnessRound(
  id: string,
  updates: Partial<{
    coderSessionId: string | null;
    coderInputTokens: number;
    coderOutputTokens: number;
    coderCacheTokens: number;
    coderCostUsd: number;
    coderDurationMs: number;
    coderToolUses: number;
    coderApiRequests: number;
    evaluatorSessionId: string | null;
    evaluatorInputTokens: number;
    evaluatorOutputTokens: number;
    evaluatorCacheTokens: number;
    evaluatorCostUsd: number;
    evaluatorDurationMs: number;
    evaluatorToolUses: number;
    evaluatorApiRequests: number;
    verdict: HarnessRound['verdict'];
    feedbackSummary: string | null;
    completedAt: string | null;
    costSource: CostSource | null;
    runtimeUsed: 'cloud' | 'local' | 'external' | 'codex' | 'zai' | 'minimax-tp' | 'kimi' | 'grok' | 'cursor' | null;
    providerUsed: string | null;
    modelUsed: string | null;
    metadata: Record<string, unknown>;
    codexPatchFailures: number;
    unknownCostCount: number;
  }>,
): HarnessRound {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.coderSessionId !== undefined) {
    fields.push('coder_session_id = ?');
    values.push(updates.coderSessionId);
  }
  if (updates.coderInputTokens !== undefined) {
    fields.push('coder_input_tokens = ?');
    values.push(updates.coderInputTokens);
  }
  if (updates.coderOutputTokens !== undefined) {
    fields.push('coder_output_tokens = ?');
    values.push(updates.coderOutputTokens);
  }
  if (updates.coderCacheTokens !== undefined) {
    fields.push('coder_cache_tokens = ?');
    values.push(updates.coderCacheTokens);
  }
  if (updates.coderCostUsd !== undefined) {
    fields.push('coder_cost_usd = ?');
    values.push(updates.coderCostUsd);
  }
  if (updates.coderDurationMs !== undefined) {
    fields.push('coder_duration_ms = ?');
    values.push(updates.coderDurationMs);
  }
  if (updates.coderToolUses !== undefined) {
    fields.push('coder_tool_uses = ?');
    values.push(updates.coderToolUses);
  }
  if (updates.coderApiRequests !== undefined) {
    fields.push('coder_api_requests = ?');
    values.push(updates.coderApiRequests);
  }
  if (updates.evaluatorSessionId !== undefined) {
    fields.push('evaluator_session_id = ?');
    values.push(updates.evaluatorSessionId);
  }
  if (updates.evaluatorInputTokens !== undefined) {
    fields.push('evaluator_input_tokens = ?');
    values.push(updates.evaluatorInputTokens);
  }
  if (updates.evaluatorOutputTokens !== undefined) {
    fields.push('evaluator_output_tokens = ?');
    values.push(updates.evaluatorOutputTokens);
  }
  if (updates.evaluatorCacheTokens !== undefined) {
    fields.push('evaluator_cache_tokens = ?');
    values.push(updates.evaluatorCacheTokens);
  }
  if (updates.evaluatorCostUsd !== undefined) {
    fields.push('evaluator_cost_usd = ?');
    values.push(updates.evaluatorCostUsd);
  }
  if (updates.evaluatorDurationMs !== undefined) {
    fields.push('evaluator_duration_ms = ?');
    values.push(updates.evaluatorDurationMs);
  }
  if (updates.evaluatorToolUses !== undefined) {
    fields.push('evaluator_tool_uses = ?');
    values.push(updates.evaluatorToolUses);
  }
  if (updates.evaluatorApiRequests !== undefined) {
    fields.push('evaluator_api_requests = ?');
    values.push(updates.evaluatorApiRequests);
  }
  if (updates.verdict !== undefined) {
    fields.push('verdict = ?');
    values.push(updates.verdict);
  }
  if (updates.feedbackSummary !== undefined) {
    fields.push('feedback_summary = ?');
    values.push(updates.feedbackSummary);
  }
  if (updates.completedAt !== undefined) {
    fields.push('completed_at = ?');
    values.push(updates.completedAt);
  }
  if (updates.costSource !== undefined) {
    fields.push('cost_source = ?');
    values.push(updates.costSource);
  }
  if (updates.runtimeUsed !== undefined) {
    fields.push('runtime_used = ?');
    values.push(updates.runtimeUsed);
  }
  if (updates.providerUsed !== undefined) {
    fields.push('provider_used = ?');
    values.push(updates.providerUsed);
  }
  if (updates.modelUsed !== undefined) {
    fields.push('model_used = ?');
    values.push(updates.modelUsed);
  }
  if (updates.metadata !== undefined) {
    fields.push('metadata = ?');
    values.push(JSON.stringify(updates.metadata));
  }
  if (updates.codexPatchFailures !== undefined) {
    fields.push('codex_patch_failures = ?');
    values.push(updates.codexPatchFailures);
  }
  if (updates.unknownCostCount !== undefined) {
    fields.push('unknown_cost_count = ?');
    values.push(updates.unknownCostCount);
  }

  if (fields.length > 0) {
    values.push(id);
    db.prepare(`UPDATE harness_rounds SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  }

  const row = db.prepare('SELECT * FROM harness_rounds WHERE id = ?').get(id) as Record<string, unknown>;
  return mapHarnessRound(row);
}

export function getHarnessRounds(sprintId: string): HarnessRound[] {
  const rows = db
    .prepare('SELECT * FROM harness_rounds WHERE sprint_id = ? ORDER BY round_number ASC')
    .all(sprintId) as Record<string, unknown>[];
  return rows.map(mapHarnessRound);
}

export function getRoundDetailsForSprint(projectId: string, sprintIndex: number): RoundDetail[] {
  const sprintRow = db
    .prepare(`SELECT id FROM harness_sprints WHERE project_id = ? AND sprint_index = ? LIMIT 1`)
    .get(projectId, sprintIndex) as { id: string } | undefined;
  if (!sprintRow) return [];

  const rounds = db
    .prepare(
      `SELECT round_number, verdict, feedback_summary,
            model_used,
            coder_input_tokens, coder_output_tokens, coder_cost_usd, coder_duration_ms,
            evaluator_input_tokens, evaluator_output_tokens, evaluator_cost_usd, evaluator_duration_ms,
            started_at, completed_at
     FROM harness_rounds
     WHERE sprint_id = ?
     ORDER BY round_number ASC`,
    )
    .all(sprintRow.id) as Record<string, unknown>[];

  const pipelineType = getProjectPipelineType(projectId);
  const coderPhaseIn = [...loopPhasesByRoleWithHistoryOf(pipelineType, 'coder')].sort((a, b) => a - b).join(', ');
  const evalPhaseIn = [...loopPhasesByRoleWithHistoryOf(pipelineType, 'evaluator')].sort((a, b) => a - b).join(', ');
  const coderPhaseRow = db
    .prepare(
      `SELECT model FROM pipeline_phase_metrics
     WHERE project_id = ? AND sprint_index = ? AND phase_number IN (${coderPhaseIn})
     LIMIT 1`,
    )
    .get(projectId, sprintIndex) as { model: string | null } | undefined;

  const evalPhaseRow = db
    .prepare(
      `SELECT model FROM pipeline_phase_metrics
     WHERE project_id = ? AND sprint_index = ? AND phase_number IN (${evalPhaseIn})
     LIMIT 1`,
    )
    .get(projectId, sprintIndex) as { model: string | null } | undefined;

  const fallbackCoderModel = coderPhaseRow?.model ?? null;
  const fallbackEvalModel = evalPhaseRow?.model ?? null;

  return rounds.map((r) => ({
    roundNumber: r['round_number'] as number,
    verdict: (r['verdict'] as string | null) ?? null,
    feedbackSummary: (r['feedback_summary'] as string | null) ?? null,
    coderModel: (r['model_used'] as string | null) ?? fallbackCoderModel,
    evaluatorModel: (r['model_used'] as string | null) ?? fallbackEvalModel,
    coderInputTokens: (r['coder_input_tokens'] as number) ?? 0,
    coderOutputTokens: (r['coder_output_tokens'] as number) ?? 0,
    coderCostUsd: (r['coder_cost_usd'] as number) ?? 0,
    coderDurationMs: (r['coder_duration_ms'] as number) ?? 0,
    evaluatorInputTokens: (r['evaluator_input_tokens'] as number) ?? 0,
    evaluatorOutputTokens: (r['evaluator_output_tokens'] as number) ?? 0,
    evaluatorCostUsd: (r['evaluator_cost_usd'] as number) ?? 0,
    evaluatorDurationMs: (r['evaluator_duration_ms'] as number) ?? 0,
    startedAt: (r['started_at'] as string | null) ?? null,
    completedAt: (r['completed_at'] as string | null) ?? null,
  }));
}

export interface HarnessSprintAggregateMetrics {
  coder: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    costUsd: number;
    durationMs: number;
    toolUses: number;
    apiRequests: number;
  };
  evaluator: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    costUsd: number;
    durationMs: number;
    toolUses: number;
    apiRequests: number;
  };
}

export function getHarnessSprintAggregateMetrics(sprintId: string): HarnessSprintAggregateMetrics {
  const row = db
    .prepare(
      `
    SELECT
      COALESCE(SUM(coder_input_tokens), 0)      AS coder_input,
      COALESCE(SUM(coder_output_tokens), 0)     AS coder_output,
      COALESCE(SUM(coder_cache_tokens), 0)      AS coder_cache,
      COALESCE(SUM(coder_cost_usd), 0)          AS coder_cost,
      COALESCE(SUM(coder_duration_ms), 0)       AS coder_duration,
      COALESCE(SUM(coder_tool_uses), 0)         AS coder_tools,
      COALESCE(SUM(coder_api_requests), 0)      AS coder_requests,
      COALESCE(SUM(evaluator_input_tokens), 0)  AS eval_input,
      COALESCE(SUM(evaluator_output_tokens), 0) AS eval_output,
      COALESCE(SUM(evaluator_cache_tokens), 0)  AS eval_cache,
      COALESCE(SUM(evaluator_cost_usd), 0)      AS eval_cost,
      COALESCE(SUM(evaluator_duration_ms), 0)   AS eval_duration,
      COALESCE(SUM(evaluator_tool_uses), 0)     AS eval_tools,
      COALESCE(SUM(evaluator_api_requests), 0)  AS eval_requests
    FROM harness_rounds WHERE sprint_id = ?
  `,
    )
    .get(sprintId) as Record<string, number>;
  return {
    coder: {
      inputTokens: row['coder_input'],
      outputTokens: row['coder_output'],
      cacheReadTokens: row['coder_cache'],
      costUsd: row['coder_cost'],
      durationMs: row['coder_duration'],
      toolUses: row['coder_tools'],
      apiRequests: row['coder_requests'],
    },
    evaluator: {
      inputTokens: row['eval_input'],
      outputTokens: row['eval_output'],
      cacheReadTokens: row['eval_cache'],
      costUsd: row['eval_cost'],
      durationMs: row['eval_duration'],
      toolUses: row['eval_tools'],
      apiRequests: row['eval_requests'],
    },
  };
}

export function getHarnessProjectMetrics(projectId: string): HarnessProjectMetrics {
  const sprints = getHarnessSprints(projectId);

  const qualityFromRounds = (
    rounds: HarnessRound[],
  ): {
    costStatus: TaskExecutionFinalize['costStatus'];
    tokenStatus: TaskExecutionFinalize['tokenStatus'];
    reasons: string[];
    coderSubscriptionEquivalentCost: number;
    evaluatorSubscriptionEquivalentCost: number;
  } => {
    let costStatus: TaskExecutionFinalize['costStatus'] = 'known';
    let tokenStatus: TaskExecutionFinalize['tokenStatus'] = 'reported';
    const reasons = new Set<string>();
    let coderSubscriptionEquivalentCost = 0;
    let evaluatorSubscriptionEquivalentCost = 0;
    for (const round of rounds) {
      const metadata = round.metadata ?? {};
      if (metadata['coderCostEstimationKind'] === 'subscription-equivalent-payg') {
        coderSubscriptionEquivalentCost += round.coderCostUsd;
      }
      if (metadata['evaluatorCostEstimationKind'] === 'subscription-equivalent-payg') {
        evaluatorSubscriptionEquivalentCost += round.evaluatorCostUsd;
      }
      for (const key of ['coderCostStatus', 'evaluatorCostStatus'] as const) {
        const status = metadata[key];
        if (
          (status === 'known' || status === 'unknown' || status === 'estimated-partial') &&
          COST_QUALITY_RANK[status] > COST_QUALITY_RANK[costStatus]
        )
          costStatus = status;
      }
      if (metadata['coderTokenStatus'] === 'not_reported' || metadata['evaluatorTokenStatus'] === 'not_reported')
        tokenStatus = 'not_reported';
      for (const key of ['coderCostUnknownReason', 'evaluatorCostUnknownReason'] as const) {
        const reason = metadata[key];
        if (typeof reason === 'string' && reason) reasons.add(reason);
      }
    }
    return {
      costStatus,
      tokenStatus,
      reasons: [...reasons].sort(),
      coderSubscriptionEquivalentCost,
      evaluatorSubscriptionEquivalentCost,
    };
  };

  const sprintMetrics: SprintMetrics[] = sprints.map((sprint) => {
    const rounds = getHarnessRounds(sprint.id);
    const quality = qualityFromRounds(rounds);
    const coderCost = rounds.reduce((sum, r) => sum + r.coderCostUsd, 0);
    const evaluatorCost = rounds.reduce((sum, r) => sum + r.evaluatorCostUsd, 0);
    const coderInputTokens = rounds.reduce((sum, r) => sum + r.coderInputTokens, 0);
    const coderOutputTokens = rounds.reduce((sum, r) => sum + r.coderOutputTokens, 0);
    const evaluatorInputTokens = rounds.reduce((sum, r) => sum + r.evaluatorInputTokens, 0);
    const evaluatorOutputTokens = rounds.reduce((sum, r) => sum + r.evaluatorOutputTokens, 0);
    const duration = rounds.reduce((sum, r) => sum + r.coderDurationMs + r.evaluatorDurationMs, 0);
    const unknownCostCount = rounds.reduce((sum, r) => sum + (r.unknownCostCount ?? 0), 0);
    return {
      sprintId: sprint.id,
      name: sprint.name,
      rounds: rounds.length,
      coderCost,
      evaluatorCost,
      totalCost: coderCost + evaluatorCost,
      subscriptionEquivalentCost: quality.coderSubscriptionEquivalentCost + quality.evaluatorSubscriptionEquivalentCost,
      coderSubscriptionEquivalentCost: quality.coderSubscriptionEquivalentCost,
      evaluatorSubscriptionEquivalentCost: quality.evaluatorSubscriptionEquivalentCost,
      coderInputTokens,
      coderOutputTokens,
      evaluatorInputTokens,
      evaluatorOutputTokens,
      duration,
      verdict: sprint.status === 'passed' ? 'passed' : 'failed',
      unknownCostCount,
      costStatus: quality.costStatus,
      tokenStatus: quality.tokenStatus,
      costUnknownReasons: quality.reasons,
    };
  });

  const allRoundsRow = db
    .prepare(
      `
    SELECT
      COALESCE(SUM(r.coder_cost_usd + r.evaluator_cost_usd), 0)            AS total_cost,
      COALESCE(SUM(r.coder_duration_ms + r.evaluator_duration_ms), 0)       AS total_duration,
      COUNT(r.id)                                                            AS total_rounds,
      COALESCE(SUM(r.coder_input_tokens + r.coder_output_tokens
                 + r.evaluator_input_tokens + r.evaluator_output_tokens), 0) AS total_tokens,
      COALESCE(SUM(r.coder_input_tokens + r.evaluator_input_tokens), 0)     AS total_input_tokens,
      COALESCE(SUM(r.coder_output_tokens + r.evaluator_output_tokens), 0)   AS total_output_tokens,
      COALESCE(SUM(r.coder_api_requests + r.evaluator_api_requests), 0)     AS total_api_requests,
      COALESCE(SUM(r.coder_cost_usd), 0)                                    AS coder_cost,
      COALESCE(SUM(r.evaluator_cost_usd), 0)                                AS evaluator_cost
    FROM harness_rounds r
    JOIN harness_sprints s ON s.id = r.sprint_id
    WHERE s.project_id = ?
  `,
    )
    .get(projectId) as Record<string, number>;

  const passedSprints = sprints.filter((s) => s.status === 'passed').length;
  const completedSprints = sprints.filter((s) => s.status === 'passed' || s.status === 'failed').length;
  const passRate = completedSprints > 0 ? passedSprints / completedSprints : 0;

  const project = getHarnessProject(projectId);
  const plannerCost = project?.plannerCostUsd ?? 0;
  const plannerDuration = project?.plannerDurationMs ?? 0;
  const plannerTokens = (project?.plannerInputTokens ?? 0) + (project?.plannerOutputTokens ?? 0);
  const subagents = getTaskExecutionRollup({
    ownerKind: 'harness',
    ownerId: projectId,
    executionKinds: ['subagent'],
  });
  const baseUnknownCostCount =
    (project?.plannerUnknownCostCount ?? 0) +
    sprintMetrics.reduce((sum, sprint) => sum + (sprint.unknownCostCount ?? 0), 0);
  const unknownCostCount = baseUnknownCostCount + subagents.unknownCostCount;
  const plannerQuality = project?.config.metricsQuality;
  const plannerSubscriptionEquivalentCost = Math.min(
    plannerCost,
    Math.max(0, plannerQuality?.plannerSubscriptionEquivalentCostUsd ?? 0),
  );
  const subagentSubscriptionEquivalentCost = subagents.usageMetadata.pricingProvenance
    .filter((entry) => entry.costEstimationKind === 'subscription-equivalent-payg')
    .reduce((sum, entry) => sum + entry.costUsd, 0);
  const coderSubscriptionEquivalentCost = sprintMetrics.reduce(
    (sum, sprint) => sum + sprint.coderSubscriptionEquivalentCost,
    0,
  );
  const evaluatorSubscriptionEquivalentCost = sprintMetrics.reduce(
    (sum, sprint) => sum + sprint.evaluatorSubscriptionEquivalentCost,
    0,
  );
  const subscriptionEquivalentCost =
    plannerSubscriptionEquivalentCost +
    subagentSubscriptionEquivalentCost +
    coderSubscriptionEquivalentCost +
    evaluatorSubscriptionEquivalentCost;
  const baseStatuses = [
    plannerQuality?.plannerCostStatus ?? 'known',
    ...sprintMetrics.map((sprint) => sprint.costStatus ?? 'known'),
  ] as TaskExecutionFinalize['costStatus'][];
  let costStatus = baseStatuses.reduce(
    (worst, status) => (COST_QUALITY_RANK[status] > COST_QUALITY_RANK[worst] ? status : worst),
    'known',
  );
  if (subagents.costStatus && COST_QUALITY_RANK[subagents.costStatus] > COST_QUALITY_RANK[costStatus]) {
    costStatus = subagents.costStatus;
  }
  if (unknownCostCount > 0) costStatus = 'unknown';
  const tokenStatus =
    plannerQuality?.plannerTokenStatus === 'not_reported' ||
    sprintMetrics.some((sprint) => sprint.tokenStatus === 'not_reported') ||
    subagents.tokenStatus === 'not_reported'
      ? 'not_reported'
      : 'reported';
  const costUnknownReasons = [
    ...new Set([
      ...(plannerQuality?.plannerCostUnknownReasons ?? []),
      ...sprintMetrics.flatMap((sprint) => sprint.costUnknownReasons ?? []),
      ...subagents.costUnknownReasons,
    ]),
  ].sort();

  return {
    totalCost: (allRoundsRow['total_cost'] ?? 0) + plannerCost + subagents.metrics.costUsd,
    totalDuration: (allRoundsRow['total_duration'] ?? 0) + plannerDuration + subagents.metrics.durationMs,
    totalRounds: allRoundsRow['total_rounds'] ?? 0,
    totalTokens:
      (allRoundsRow['total_tokens'] ?? 0) +
      plannerTokens +
      subagents.metrics.inputTokens +
      subagents.metrics.outputTokens,
    totalInputTokens:
      (allRoundsRow['total_input_tokens'] ?? 0) + (project?.plannerInputTokens ?? 0) + subagents.metrics.inputTokens,
    totalOutputTokens:
      (allRoundsRow['total_output_tokens'] ?? 0) + (project?.plannerOutputTokens ?? 0) + subagents.metrics.outputTokens,
    totalApiRequests: (allRoundsRow['total_api_requests'] ?? 0) + subagents.metrics.apiRequests,
    passRate,
    coderCost: allRoundsRow['coder_cost'] ?? 0,
    evaluatorCost: allRoundsRow['evaluator_cost'] ?? 0,
    plannerCost,
    subscriptionEquivalentCost,
    coderSubscriptionEquivalentCost,
    evaluatorSubscriptionEquivalentCost,
    plannerSubscriptionEquivalentCost,
    subagentSubscriptionEquivalentCost,
    sprintMetrics,
    costStatus,
    tokenStatus,
    unknownCostCount,
    costUnknownReasons,
  };
}

export interface EnrichSessionRow {
  id: string;
  name: string;
  specPath: string;
  projectPath: string | null;
  prdPath: string | null;
  userMessage: string | null;
  validatorAgentId: string;
  enricherAgentId: string;
  phase: 'validator' | 'enricher' | 'done';
  status: 'idle' | 'running' | 'paused' | 'waiting' | 'finalizing' | 'done';
  finalSpecPath: string | null;
  validatorInputTokens: number;
  validatorOutputTokens: number;
  validatorCacheReadTokens: number;
  validatorCacheCreationTokens: number;
  validatorCostUsd: number;
  validatorDurationMs: number;
  validatorToolUses: number;
  validatorApiRequests: number;
  validatorMessages: number;
  validatorCostStatus: 'known' | 'unknown' | 'estimated-partial';
  validatorTokenStatus: 'reported' | 'not_reported';
  validatorCostUnknownReason: string | null;
  validatorCostSource: string | null;
  validatorCostEstimationKind: 'subscription-equivalent-payg' | null;
  validatorUnknownCostCount: number;
  validatorUsageMetadata: Record<string, unknown> | null;
  enricherInputTokens: number;
  enricherOutputTokens: number;
  enricherCacheReadTokens: number;
  enricherCacheCreationTokens: number;
  enricherCostUsd: number;
  enricherDurationMs: number;
  enricherToolUses: number;
  enricherApiRequests: number;
  enricherMessages: number;
  enricherCostStatus: 'known' | 'unknown' | 'estimated-partial';
  enricherTokenStatus: 'reported' | 'not_reported';
  enricherCostUnknownReason: string | null;
  enricherCostSource: string | null;
  enricherCostEstimationKind: 'subscription-equivalent-payg' | null;
  enricherUnknownCostCount: number;
  enricherUsageMetadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

function mapEnrichSession(row: Record<string, unknown>): EnrichSessionRow {
  return {
    id: row['id'] as string,
    name: row['name'] as string,
    specPath: row['spec_path'] as string,
    projectPath: (row['project_path'] as string | null) ?? null,
    prdPath: (row['prd_path'] as string | null) ?? null,
    userMessage: (row['user_message'] as string | null) ?? null,
    validatorAgentId: row['validator_agent_id'] as string,
    enricherAgentId: row['enricher_agent_id'] as string,
    phase: row['phase'] as EnrichSessionRow['phase'],
    status: row['status'] as EnrichSessionRow['status'],
    finalSpecPath: (row['final_spec_path'] as string | null) ?? null,
    validatorInputTokens: (row['validator_input_tokens'] as number) ?? 0,
    validatorOutputTokens: (row['validator_output_tokens'] as number) ?? 0,
    validatorCacheReadTokens: (row['validator_cache_read_tokens'] as number) ?? 0,
    validatorCacheCreationTokens: (row['validator_cache_creation_tokens'] as number) ?? 0,
    validatorCostUsd: (row['validator_cost_usd'] as number) ?? 0,
    validatorDurationMs: (row['validator_duration_ms'] as number) ?? 0,
    validatorToolUses: (row['validator_tool_uses'] as number) ?? 0,
    validatorApiRequests: (row['validator_api_requests'] as number) ?? 0,
    validatorMessages: (row['validator_messages'] as number) ?? 0,
    validatorCostStatus: (row['validator_cost_status'] as EnrichSessionRow['validatorCostStatus']) ?? 'known',
    validatorTokenStatus: (row['validator_token_status'] as EnrichSessionRow['validatorTokenStatus']) ?? 'reported',
    validatorCostUnknownReason: (row['validator_cost_unknown_reason'] as string | null) ?? null,
    validatorCostSource: (row['validator_cost_source'] as string | null) ?? null,
    validatorCostEstimationKind:
      (row['validator_cost_estimation_kind'] as EnrichSessionRow['validatorCostEstimationKind']) ?? null,
    validatorUnknownCostCount: (row['validator_unknown_cost_count'] as number) ?? 0,
    validatorUsageMetadata: (() => {
      try {
        return JSON.parse((row['validator_usage_metadata'] as string) || 'null') as Record<string, unknown> | null;
      } catch {
        return null;
      }
    })(),
    enricherInputTokens: (row['enricher_input_tokens'] as number) ?? 0,
    enricherOutputTokens: (row['enricher_output_tokens'] as number) ?? 0,
    enricherCacheReadTokens: (row['enricher_cache_read_tokens'] as number) ?? 0,
    enricherCacheCreationTokens: (row['enricher_cache_creation_tokens'] as number) ?? 0,
    enricherCostUsd: (row['enricher_cost_usd'] as number) ?? 0,
    enricherDurationMs: (row['enricher_duration_ms'] as number) ?? 0,
    enricherToolUses: (row['enricher_tool_uses'] as number) ?? 0,
    enricherApiRequests: (row['enricher_api_requests'] as number) ?? 0,
    enricherMessages: (row['enricher_messages'] as number) ?? 0,
    enricherCostStatus: (row['enricher_cost_status'] as EnrichSessionRow['enricherCostStatus']) ?? 'known',
    enricherTokenStatus: (row['enricher_token_status'] as EnrichSessionRow['enricherTokenStatus']) ?? 'reported',
    enricherCostUnknownReason: (row['enricher_cost_unknown_reason'] as string | null) ?? null,
    enricherCostSource: (row['enricher_cost_source'] as string | null) ?? null,
    enricherCostEstimationKind:
      (row['enricher_cost_estimation_kind'] as EnrichSessionRow['enricherCostEstimationKind']) ?? null,
    enricherUnknownCostCount: (row['enricher_unknown_cost_count'] as number) ?? 0,
    enricherUsageMetadata: (() => {
      try {
        return JSON.parse((row['enricher_usage_metadata'] as string) || 'null') as Record<string, unknown> | null;
      } catch {
        return null;
      }
    })(),
    createdAt: row['created_at'] as string,
    updatedAt: row['updated_at'] as string,
  };
}

export function insertEnrichSession(session: {
  id: string;
  name: string;
  specPath: string;
  projectPath?: string;
  prdPath?: string;
  userMessage?: string;
  validatorAgentId: string;
  enricherAgentId?: string;
}): EnrichSessionRow {
  db.prepare(
    `
    INSERT INTO enrich_sessions (id, name, spec_path, project_path, prd_path, user_message, validator_agent_id, enricher_agent_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    session.id,
    session.name,
    session.specPath,
    session.projectPath ?? null,
    session.prdPath ?? null,
    session.userMessage ?? null,
    session.validatorAgentId,
    session.enricherAgentId ?? 'spec-enricher',
  );
  return getEnrichSession(session.id)!;
}

export function getEnrichSession(id: string): EnrichSessionRow | undefined {
  const row = db.prepare('SELECT * FROM enrich_sessions WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  return mapEnrichSession(row);
}

export function updateEnrichSession(
  id: string,
  fields: Partial<{
    name: string;
    specPath: string;
    projectPath: string | null;
    prdPath: string | null;
    userMessage: string | null;
    validatorAgentId: string;
    enricherAgentId: string;
    phase: EnrichSessionRow['phase'];
    status: EnrichSessionRow['status'];
    finalSpecPath: string | null;
  }>,
): EnrichSessionRow {
  const cols: string[] = [];
  const values: unknown[] = [];

  if (fields.name !== undefined) {
    cols.push('name = ?');
    values.push(fields.name);
  }
  if (fields.specPath !== undefined) {
    cols.push('spec_path = ?');
    values.push(fields.specPath);
  }
  if (fields.projectPath !== undefined) {
    cols.push('project_path = ?');
    values.push(fields.projectPath);
  }
  if (fields.prdPath !== undefined) {
    cols.push('prd_path = ?');
    values.push(fields.prdPath);
  }
  if (fields.userMessage !== undefined) {
    cols.push('user_message = ?');
    values.push(fields.userMessage);
  }
  if (fields.validatorAgentId !== undefined) {
    cols.push('validator_agent_id = ?');
    values.push(fields.validatorAgentId);
  }
  if (fields.enricherAgentId !== undefined) {
    cols.push('enricher_agent_id = ?');
    values.push(fields.enricherAgentId);
  }
  if (fields.phase !== undefined) {
    cols.push('phase = ?');
    values.push(fields.phase);
  }
  if (fields.status !== undefined) {
    cols.push('status = ?');
    values.push(fields.status);
  }
  if (fields.finalSpecPath !== undefined) {
    cols.push('final_spec_path = ?');
    values.push(fields.finalSpecPath);
  }

  if (cols.length > 0) {
    cols.push(`updated_at = datetime('now')`);
    values.push(id);
    db.prepare(`UPDATE enrich_sessions SET ${cols.join(', ')} WHERE id = ?`).run(...values);
  }
  return getEnrichSession(id)!;
}

export function listEnrichSessions(): EnrichSessionRow[] {
  const rows = db.prepare('SELECT * FROM enrich_sessions ORDER BY created_at DESC').all() as Record<string, unknown>[];
  return rows.map(mapEnrichSession);
}

export function deleteEnrichSession(id: string): void {
  db.transaction(() => {
    db.prepare('DELETE FROM enrich_messages WHERE session_id = ?').run(id);
    db.prepare('DELETE FROM enrich_sessions WHERE id = ?').run(id);
  })();
}

export function accumulateEnrichMetrics(
  id: string,
  phase: 'validator' | 'enricher',
  metrics: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
    costUsd?: number;
    durationMs?: number;
    toolUses?: number;
    apiRequests?: number;
    messages?: number;
    costStatus?: 'known' | 'unknown' | 'estimated-partial';
    tokenStatus?: 'reported' | 'not_reported';
    costUnknownReason?: string;
    costSource?: string;
    costEstimationKind?: 'subscription-equivalent-payg';
    unknownCostCount?: number;
    usageMetadata?: Record<string, unknown>;
  },
): void {
  const p = phase;
  const cols: string[] = [];
  const values: unknown[] = [];

  if (metrics.inputTokens) {
    cols.push(`${p}_input_tokens = ${p}_input_tokens + ?`);
    values.push(metrics.inputTokens);
  }
  if (metrics.outputTokens) {
    cols.push(`${p}_output_tokens = ${p}_output_tokens + ?`);
    values.push(metrics.outputTokens);
  }
  if (metrics.cacheReadTokens) {
    cols.push(`${p}_cache_read_tokens = ${p}_cache_read_tokens + ?`);
    values.push(metrics.cacheReadTokens);
  }
  if (metrics.cacheCreationTokens) {
    cols.push(`${p}_cache_creation_tokens = ${p}_cache_creation_tokens + ?`);
    values.push(metrics.cacheCreationTokens);
  }
  if (metrics.costUsd) {
    cols.push(`${p}_cost_usd = ${p}_cost_usd + ?`);
    values.push(metrics.costUsd);
  }
  if (metrics.durationMs) {
    cols.push(`${p}_duration_ms = ${p}_duration_ms + ?`);
    values.push(metrics.durationMs);
  }
  if (metrics.toolUses) {
    cols.push(`${p}_tool_uses = ${p}_tool_uses + ?`);
    values.push(metrics.toolUses);
  }
  if (metrics.apiRequests) {
    cols.push(`${p}_api_requests = ${p}_api_requests + ?`);
    values.push(metrics.apiRequests);
  }
  if (metrics.messages) {
    cols.push(`${p}_messages = ${p}_messages + ?`);
    values.push(metrics.messages);
  }
  if (metrics.costStatus !== undefined) {
    cols.push(`${p}_cost_status = CASE
      WHEN ${p}_cost_status = 'unknown' OR ? = 'unknown' THEN 'unknown'
      WHEN ${p}_cost_status = 'estimated-partial' OR ? = 'estimated-partial' THEN 'estimated-partial'
      ELSE 'known' END`);
    values.push(metrics.costStatus, metrics.costStatus);
  }
  if (metrics.tokenStatus === 'not_reported') {
    cols.push(`${p}_token_status = 'not_reported'`);
  }
  if (metrics.costUnknownReason !== undefined) {
    cols.push(`${p}_cost_unknown_reason = ?`);
    values.push(metrics.costUnknownReason);
  }
  if (metrics.costSource !== undefined) {
    cols.push(`${p}_cost_source = ?`);
    values.push(metrics.costSource);
  }
  if (metrics.costEstimationKind !== undefined) {
    cols.push(`${p}_cost_estimation_kind = ?`);
    values.push(metrics.costEstimationKind);
  }
  if ((metrics.unknownCostCount ?? 0) > 0) {
    cols.push(`${p}_unknown_cost_count = ${p}_unknown_cost_count + ?`);
    values.push(metrics.unknownCostCount);
  }
  if (metrics.usageMetadata !== undefined) {
    const stored = db
      .prepare(`SELECT ${p}_usage_metadata AS usage_metadata FROM enrich_sessions WHERE id = ?`)
      .get(id) as { usage_metadata?: string | null } | undefined;
    let turns: Record<string, unknown>[] = [];
    try {
      const parsed = JSON.parse(stored?.usage_metadata || '{}') as { turns?: Record<string, unknown>[] };
      if (Array.isArray(parsed.turns)) turns = parsed.turns;
    } catch {
      turns = [];
    }
    cols.push(`${p}_usage_metadata = ?`);
    values.push(JSON.stringify({ turns: [...turns, metrics.usageMetadata] }));
  }

  if (cols.length === 0) return;

  cols.push(`updated_at = datetime('now')`);
  values.push(id);
  db.prepare(`UPDATE enrich_sessions SET ${cols.join(', ')} WHERE id = ?`).run(...values);
}

export interface SecurityAgentStatusRow {
  id: number;
  projectId: string;
  agentId: string;
  agentName: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  findingsCount: number;
  outputFile?: string;
  startedAt?: string;
  completedAt?: string;
  errorMessage?: string;
  createdAt: string;
}

function mapSecurityAgentStatus(row: Record<string, unknown>): SecurityAgentStatusRow {
  return {
    id: row['id'] as number,
    projectId: row['project_id'] as string,
    agentId: row['agent_id'] as string,
    agentName: row['agent_name'] as string,
    status: row['status'] as SecurityAgentStatusRow['status'],
    findingsCount: (row['findings_count'] as number) ?? 0,
    outputFile: row['output_file'] as string | undefined,
    startedAt: row['started_at'] as string | undefined,
    completedAt: row['completed_at'] as string | undefined,
    errorMessage: row['error_message'] as string | undefined,
    createdAt: row['created_at'] as string,
  };
}

export function insertSecurityAgentStatus(
  projectId: string,
  agents: Array<{ agentId: string; agentName: string }>,
): void {
  const insert = db.transaction(() => {
    const stmt = db.prepare(`
      INSERT OR IGNORE INTO security_agent_status (project_id, agent_id, agent_name, status)
      VALUES (?, ?, ?, 'pending')
    `);
    for (const agent of agents) {
      stmt.run(projectId, agent.agentId, agent.agentName);
    }
  });
  insert();
}

export function updateSecurityAgentStatus(
  projectId: string,
  agentId: string,
  patch: Partial<
    Pick<
      SecurityAgentStatusRow,
      'status' | 'findingsCount' | 'outputFile' | 'startedAt' | 'completedAt' | 'errorMessage'
    >
  >,
): void {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (patch.status !== undefined) {
    fields.push('status = ?');
    values.push(patch.status);
  }
  if (patch.findingsCount !== undefined) {
    fields.push('findings_count = ?');
    values.push(patch.findingsCount);
  }
  if (patch.outputFile !== undefined) {
    fields.push('output_file = ?');
    values.push(patch.outputFile);
  }
  if (patch.startedAt !== undefined) {
    fields.push('started_at = ?');
    values.push(patch.startedAt);
  }
  if (patch.completedAt !== undefined) {
    fields.push('completed_at = ?');
    values.push(patch.completedAt);
  }
  if (patch.errorMessage !== undefined) {
    fields.push('error_message = ?');
    values.push(patch.errorMessage);
  }

  if (fields.length === 0) return;

  values.push(projectId, agentId);
  db.prepare(
    `
    UPDATE security_agent_status SET ${fields.join(', ')}
    WHERE project_id = ? AND agent_id = ?
  `,
  ).run(...values);
}

export function getSecurityAgentStatuses(projectId: string): SecurityAgentStatusRow[] {
  const rows = db
    .prepare(
      `
    SELECT * FROM security_agent_status WHERE project_id = ? ORDER BY id ASC
  `,
    )
    .all(projectId) as Record<string, unknown>[];
  return rows.map(mapSecurityAgentStatus);
}

export function deleteSecurityAgentStatuses(projectId: string): void {
  db.prepare('DELETE FROM security_agent_status WHERE project_id = ?').run(projectId);
}

export interface AuditAgentRow {
  agentId: string;
  agentSlug?: string;
  agentName: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  findingsCount?: number;
  costUsd: number;
  durationMs: number;
  model: string | null;
  runtime: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  filesAnalyzed: number;
  additionalFilesAfterStart: number;
  toolCallsCount: number;
}

export function getAuditAgentsState(projectId: string): AuditAgentRow[] {
  const statuses = getSecurityAgentStatuses(projectId);
  if (statuses.length === 0) return [];

  const metricsRows = db
    .prepare(
      `
    SELECT agent_id, model, runtime, cost_usd, duration_ms, tool_uses, started_at, completed_at, status, metadata
    FROM pipeline_phase_metrics
    WHERE project_id = ? AND phase_number = 2 AND agent_id IS NOT NULL
  `,
    )
    .all(projectId) as Array<{
    agent_id: string;
    model: string | null;
    runtime: string | null;
    cost_usd: number;
    duration_ms: number;
    tool_uses: number;
    started_at: string | null;
    completed_at: string | null;
    status: string;
    metadata: string | null;
  }>;

  const metricsByAgent = new Map<string, (typeof metricsRows)[0]>();
  for (const m of metricsRows) {
    metricsByAgent.set(m.agent_id, m);
  }

  const parseMetadata = (raw: string | null | undefined): Record<string, unknown> => {
    if (!raw) return {};
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  };

  const readNumber = (value: unknown): number | null => {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  };

  return statuses.map((s) => {
    const m = metricsByAgent.get(s.agentId);
    const metadata = parseMetadata(m?.metadata);
    const filesAnalyzed = readNumber(metadata['filesAnalyzed']) ?? m?.tool_uses ?? 0;
    const additionalFilesAfterStart = readNumber(metadata['additionalFilesAfterStart']) ?? 0;
    return {
      agentId: s.agentId,
      agentName: s.agentName,
      status: s.status as AuditAgentRow['status'],
      findingsCount: s.findingsCount,
      costUsd: m?.cost_usd ?? 0,
      durationMs: m?.duration_ms ?? 0,
      model: m?.model ?? null,
      runtime: m?.runtime ?? null,
      startedAt: s.startedAt ?? m?.started_at ?? null,
      completedAt: s.completedAt ?? m?.completed_at ?? null,
      filesAnalyzed,
      additionalFilesAfterStart,
      toolCallsCount: m?.tool_uses ?? 0,
    };
  });
}

export interface BugAnalysisAgentStatusRow {
  id: number;
  projectId: string;
  runId: string;
  agentId: string;
  agentName: string;
  agentSlug: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  outputFile?: string;
  startedAt?: string;
  completedAt?: string;
  errorMessage?: string;
  createdAt: string;
}

function mapBugAnalysisAgentStatus(row: Record<string, unknown>): BugAnalysisAgentStatusRow {
  return {
    id: row['id'] as number,
    projectId: row['project_id'] as string,
    runId: row['run_id'] as string,
    agentId: row['agent_id'] as string,
    agentName: row['agent_name'] as string,
    agentSlug: row['agent_slug'] as string,
    status: row['status'] as BugAnalysisAgentStatusRow['status'],
    outputFile: row['output_file'] as string | undefined,
    startedAt: row['started_at'] as string | undefined,
    completedAt: row['completed_at'] as string | undefined,
    errorMessage: row['error_message'] as string | undefined,
    createdAt: row['created_at'] as string,
  };
}

export function insertBugAnalysisAgentStatus(
  projectId: string,
  runId: string,
  agents: Array<{ agentId: string; agentName: string; agentSlug: string }>,
): void {
  const insert = db.transaction(() => {
    const stmt = db.prepare(`
      INSERT OR IGNORE INTO bug_analysis_agent_status
        (project_id, run_id, agent_id, agent_name, agent_slug, status)
      VALUES (?, ?, ?, ?, ?, 'pending')
    `);
    for (const agent of agents) {
      stmt.run(projectId, runId, agent.agentId, agent.agentName, agent.agentSlug);
    }
  });
  insert();
}

export function updateBugAnalysisAgentStatus(
  projectId: string,
  runId: string,
  agentId: string,
  patch: Partial<
    Pick<BugAnalysisAgentStatusRow, 'status' | 'outputFile' | 'startedAt' | 'completedAt' | 'errorMessage'>
  >,
): void {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (patch.status !== undefined) {
    fields.push('status = ?');
    values.push(patch.status);
  }
  if (patch.outputFile !== undefined) {
    fields.push('output_file = ?');
    values.push(patch.outputFile);
  }
  if (patch.startedAt !== undefined) {
    fields.push('started_at = ?');
    values.push(patch.startedAt);
  }
  if (patch.completedAt !== undefined) {
    fields.push('completed_at = ?');
    values.push(patch.completedAt);
  }
  if (patch.errorMessage !== undefined) {
    fields.push('error_message = ?');
    values.push(patch.errorMessage);
  }

  if (fields.length === 0) return;

  values.push(projectId, runId, agentId);
  db.prepare(
    `
    UPDATE bug_analysis_agent_status SET ${fields.join(', ')}
    WHERE project_id = ? AND run_id = ? AND agent_id = ?
  `,
  ).run(...values);
}

export function getBugAnalysisAgentStatuses(projectId: string, runId: string): BugAnalysisAgentStatusRow[] {
  const rows = db
    .prepare(
      `
    SELECT * FROM bug_analysis_agent_status
    WHERE project_id = ? AND run_id = ?
    ORDER BY id ASC
  `,
    )
    .all(projectId, runId) as Record<string, unknown>[];
  return rows.map(mapBugAnalysisAgentStatus);
}

export function getBugAnalysisAgentsState(projectId: string, runId: string): AuditAgentRow[] {
  const statuses = getBugAnalysisAgentStatuses(projectId, runId);
  if (statuses.length === 0) return [];

  const metricsRows = db
    .prepare(
      `
    SELECT agent_id, model, runtime, cost_usd, duration_ms, tool_uses, started_at, completed_at, status, metadata
    FROM pipeline_phase_metrics
    WHERE project_id = ? AND phase_number = 2 AND agent_id IS NOT NULL
  `,
    )
    .all(projectId) as Array<{
    agent_id: string;
    model: string | null;
    runtime: string | null;
    cost_usd: number;
    duration_ms: number;
    tool_uses: number;
    started_at: string | null;
    completed_at: string | null;
    status: string;
    metadata: string | null;
  }>;

  const metricsByAgent = new Map<string, (typeof metricsRows)[0]>();
  for (const m of metricsRows) {
    metricsByAgent.set(m.agent_id, m);
  }

  const parseMetadata = (raw: string | null | undefined): Record<string, unknown> => {
    if (!raw) return {};
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  };

  const readNumber = (value: unknown): number | null => {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  };

  return statuses.map((s) => {
    const m = metricsByAgent.get(s.agentId);
    const metadata = parseMetadata(m?.metadata);
    const filesAnalyzed = readNumber(metadata['filesAnalyzed']) ?? 0;
    const additionalFilesAfterStart = readNumber(metadata['additionalFilesAfterStart']) ?? 0;
    return {
      agentId: s.agentId,
      agentSlug: s.agentSlug,
      agentName: s.agentName,
      status: s.status as AuditAgentRow['status'],
      costUsd: m?.cost_usd ?? 0,
      durationMs: m?.duration_ms ?? 0,
      model: m?.model ?? null,
      runtime: m?.runtime ?? null,
      startedAt: s.startedAt ?? m?.started_at ?? null,
      completedAt: s.completedAt ?? m?.completed_at ?? null,
      filesAnalyzed,
      additionalFilesAfterStart,
      toolCallsCount: m?.tool_uses ?? 0,
    };
  });
}

export function deleteBugAnalysisAgentStatuses(projectId: string): void {
  db.prepare('DELETE FROM bug_analysis_agent_status WHERE project_id = ?').run(projectId);
}

export interface EnrichMessageRow {
  id: number;
  sessionId: string;
  phase: 'validator' | 'enricher';
  role: 'user' | 'assistant';
  content: string;
  toolCalls: Array<{ tool: string; input: unknown }> | null;
  createdAt: string;
}

export function insertEnrichMessage(
  sessionId: string,
  phase: string,
  role: string,
  content: string,
  toolCalls?: Array<{ tool: string; input: unknown }>,
): void {
  db.prepare(
    `
    INSERT INTO enrich_messages (session_id, phase, role, content, tool_calls)
    VALUES (?, ?, ?, ?, ?)
  `,
  ).run(sessionId, phase, role, content, toolCalls && toolCalls.length > 0 ? JSON.stringify(toolCalls) : null);
}

export function getEnrichMessages(sessionId: string, phase?: string): EnrichMessageRow[] {
  let rows: Record<string, unknown>[];
  if (phase) {
    rows = db
      .prepare(
        `
      SELECT * FROM enrich_messages
      WHERE session_id = ? AND phase = ?
      ORDER BY id ASC
    `,
      )
      .all(sessionId, phase) as Record<string, unknown>[];
  } else {
    rows = db
      .prepare(
        `
      SELECT * FROM enrich_messages
      WHERE session_id = ?
      ORDER BY id ASC
    `,
      )
      .all(sessionId) as Record<string, unknown>[];
  }

  return rows.map((row) => ({
    id: row['id'] as number,
    sessionId: row['session_id'] as string,
    phase: row['phase'] as 'validator' | 'enricher',
    role: row['role'] as 'user' | 'assistant',
    content: row['content'] as string,
    toolCalls: row['tool_calls']
      ? (JSON.parse(row['tool_calls'] as string) as Array<{ tool: string; input: unknown }>)
      : null,
    createdAt: row['created_at'] as string,
  }));
}

export function insertIngestJob(job: {
  id: string;
  fileName: string;
  sourceType: string;
  originalPath?: string;
  fileHash?: string;
  totalChunks?: number;
  estimatedCostUsd?: number;
}): void {
  db.prepare(
    `
    INSERT INTO ingest_jobs (id, file_name, source_type, original_path, file_hash, status, total_chunks, estimated_cost_usd, started_at)
    VALUES (?, ?, ?, ?, ?, 'extracting', ?, ?, ?)
  `,
  ).run(
    job.id,
    job.fileName,
    job.sourceType,
    job.originalPath || null,
    job.fileHash || null,
    job.totalChunks || 0,
    job.estimatedCostUsd || null,
    new Date().toISOString(),
  );
}

export function updateIngestJob(
  id: string,
  updates: Partial<{
    status: string;
    totalChunks: number;
    processedChunks: number;
    lastProcessedChunk: number;
    notesCreated: number;
    notesUpdated: number;
    estimatedCostUsd: number;
    error: string;
    completedAt: string;
    createdNotePaths: string[];
  }>,
): void {
  const sets: string[] = [];
  const vals: unknown[] = [];

  if (updates.status !== undefined) {
    sets.push('status = ?');
    vals.push(updates.status);
  }
  if (updates.totalChunks !== undefined) {
    sets.push('total_chunks = ?');
    vals.push(updates.totalChunks);
  }
  if (updates.processedChunks !== undefined) {
    sets.push('processed_chunks = ?');
    vals.push(updates.processedChunks);
  }
  if (updates.lastProcessedChunk !== undefined) {
    sets.push('last_processed_chunk = ?');
    vals.push(updates.lastProcessedChunk);
  }
  if (updates.notesCreated !== undefined) {
    sets.push('notes_created = ?');
    vals.push(updates.notesCreated);
  }
  if (updates.notesUpdated !== undefined) {
    sets.push('notes_updated = ?');
    vals.push(updates.notesUpdated);
  }
  if (updates.estimatedCostUsd !== undefined) {
    sets.push('estimated_cost_usd = ?');
    vals.push(updates.estimatedCostUsd);
  }
  if (updates.error !== undefined) {
    sets.push('error = ?');
    vals.push(updates.error);
  }
  if (updates.completedAt !== undefined) {
    sets.push('completed_at = ?');
    vals.push(updates.completedAt);
  }
  if (updates.createdNotePaths !== undefined) {
    sets.push('created_note_paths = ?');
    vals.push(JSON.stringify(updates.createdNotePaths));
  }

  if (sets.length === 0) return;
  vals.push(id);
  db.prepare(`UPDATE ingest_jobs SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
}

export function getIngestJob(id: string): IngestJob | null {
  const row = db.prepare('SELECT * FROM ingest_jobs WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!row) return null;
  return mapIngestJobRow(row);
}

export function getIngestJobByHash(fileHash: string): IngestJob | null {
  const row = db
    .prepare("SELECT * FROM ingest_jobs WHERE file_hash = ? AND status = 'completed' ORDER BY started_at DESC LIMIT 1")
    .get(fileHash) as Record<string, unknown> | undefined;
  if (!row) return null;
  return mapIngestJobRow(row);
}

export function getAllIngestJobs(): IngestJob[] {
  const rows = db.prepare('SELECT * FROM ingest_jobs ORDER BY started_at DESC').all() as Record<string, unknown>[];
  return rows.map(mapIngestJobRow);
}

function mapIngestJobRow(row: Record<string, unknown>): IngestJob {
  let createdNotePaths: string[] = [];
  try {
    createdNotePaths = JSON.parse((row['created_note_paths'] as string) || '[]');
  } catch {
    /* ignore */
  }

  return {
    id: row['id'] as string,
    fileName: row['file_name'] as string,
    sourceType: row['source_type'] as string,
    originalPath: row['original_path'] as string | undefined,
    fileHash: row['file_hash'] as string | undefined,
    status: row['status'] as IngestJob['status'],
    totalChunks: row['total_chunks'] as number,
    processedChunks: row['processed_chunks'] as number,
    lastProcessedChunk: row['last_processed_chunk'] as number,
    notesCreated: row['notes_created'] as number,
    notesUpdated: row['notes_updated'] as number,
    estimatedCostUsd: row['estimated_cost_usd'] as number | undefined,
    error: row['error'] as string | undefined,
    startedAt: row['started_at'] as string,
    completedAt: row['completed_at'] as string | undefined,
    createdNotePaths,
  };
}

export type PipelinePhaseStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped' | 'interrupted';

export interface PipelinePhaseMetricsRow {
  id: number;
  projectId: string;
  phaseNumber: number;
  sprintIndex: number;
  phaseName: string;
  agentId: string | null;
  status: PipelinePhaseStatus;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
  durationMs: number;
  toolUses: number;
  apiRequests: number;
  messagesCount: number;
  model: string | null;
  runtime: string | null;
  startedAt: string | null;
  completedAt: string | null;
  metadata: Record<string, unknown>;
  unknownCostCount: number;
  createdAt: string;
}

export interface PipelineMessageRow {
  id: number;
  projectId: string;
  phaseNumber: number;
  role: 'user' | 'assistant' | 'system';
  content: string;
  toolCalls: Array<{ tool: string; input: unknown }> | null;
  createdAt: string;
}

export interface PipelineMetrics {
  totals: {
    inputTokens: number;
    outputTokens: number;
    cacheTokens: number;
    costUsd: number;
    durationMs: number;
    toolUses: number;
    apiRequests: number;
    costStatus?: 'known' | 'unknown' | 'estimated-partial';
    tokenStatus?: 'reported' | 'not_reported';
    unknownCostCount?: number;
    costUnknownReasons?: string[];
  };
  cloudCost: number;
  localCost: number;
  costByRuntime: Record<string, number>;
  costStatusByRuntime: Record<string, TaskExecutionFinalize['costStatus']>;
  subscriptionEquivalentCost: number;
  phases: PipelinePhaseMetricsRow[];
  sprintPhases: PipelinePhaseMetricsRow[];
  agentNames: Record<string, string>;
}

function mapPipelinePhaseMetrics(row: Record<string, unknown>): PipelinePhaseMetricsRow {
  return {
    id: row['id'] as number,
    projectId: row['project_id'] as string,
    phaseNumber: row['phase_number'] as number,
    sprintIndex: (row['sprint_index'] as number) ?? -1,
    phaseName: row['phase_name'] as string,
    agentId: (row['agent_id'] as string | null) ?? null,
    status: row['status'] as PipelinePhaseStatus,
    inputTokens: (row['input_tokens'] as number) ?? 0,
    outputTokens: (row['output_tokens'] as number) ?? 0,
    cacheReadTokens: (row['cache_read_tokens'] as number) ?? 0,
    cacheCreationTokens: (row['cache_creation_tokens'] as number) ?? 0,
    costUsd: (row['cost_usd'] as number) ?? 0,
    durationMs: (row['duration_ms'] as number) ?? 0,
    toolUses: (row['tool_uses'] as number) ?? 0,
    apiRequests: (row['api_requests'] as number) ?? 0,
    messagesCount: (row['messages_count'] as number) ?? 0,
    model: (row['model'] as string | null) ?? null,
    runtime: (row['runtime'] as string | null) ?? null,
    startedAt: (row['started_at'] as string | null) ?? null,
    completedAt: (row['completed_at'] as string | null) ?? null,
    metadata: (() => {
      try {
        return JSON.parse((row['metadata'] as string) || '{}');
      } catch {
        return {};
      }
    })(),
    unknownCostCount: (row['unknown_cost_count'] as number) ?? 0,
    createdAt: row['created_at'] as string,
  };
}

function isLegacyDevelopmentV2PhaseNumbering(projectId: string, phaseRows?: Array<Record<string, unknown>>): boolean {
  const project = db.prepare('SELECT pipeline_type FROM harness_projects WHERE id = ?').get(projectId) as
    { pipeline_type: string } | undefined;
  if (project?.pipeline_type !== 'development-v2') return false;

  const rows =
    phaseRows ??
    (db
      .prepare(
        `
    SELECT phase_number, phase_name
    FROM pipeline_phase_metrics
    WHERE project_id = ?
  `,
      )
      .all(projectId) as Array<Record<string, unknown>>);

  const hasOldDesignLock = rows.some((row) => row['phase_number'] === 5 && row['phase_name'] === 'Design Lock');
  const hasNewDesignLock = rows.some((row) => row['phase_number'] === 6 && row['phase_name'] === 'Design Lock');
  return hasOldDesignLock && !hasNewDesignLock;
}

function hasLegacyDevelopmentV2Phase4OpenDesign(
  projectId: string,
  phaseRows?: Array<Record<string, unknown>>,
): boolean {
  const project = db.prepare('SELECT pipeline_type FROM harness_projects WHERE id = ?').get(projectId) as
    { pipeline_type: string } | undefined;
  if (project?.pipeline_type !== 'development-v2') return false;

  const rows =
    phaseRows ??
    (db
      .prepare(
        `
    SELECT phase_number, phase_name
    FROM pipeline_phase_metrics
    WHERE project_id = ?
  `,
      )
      .all(projectId) as Array<Record<string, unknown>>);

  return rows.some((row) => row['phase_number'] === 4 && row['phase_name'] === 'Open Design Studio');
}

function remapLegacyDevelopmentV2MetricPhase(
  metric: PipelinePhaseMetricsRow,
  hasPhase4OpenDesign = false,
): PipelinePhaseMetricsRow {
  if (hasPhase4OpenDesign && metric.phaseNumber === 4) {
    return {
      ...metric,
      phaseNumber: 5,
    };
  }
  if (metric.phaseNumber < 5) return metric;
  return {
    ...metric,
    phaseNumber: metric.phaseNumber + 1,
  };
}

function getProjectPipelineType(projectId: string): string | undefined {
  const project = db.prepare('SELECT pipeline_type FROM harness_projects WHERE id = ?').get(projectId) as
    { pipeline_type: string } | undefined;
  return project?.pipeline_type;
}

function resolveStoredPhaseForHistoryRead(projectId: string, phaseNumber: number): number {
  if (!isLegacyDevelopmentV2PhaseNumbering(projectId)) return phaseNumber;
  const hasPhase4OpenDesign = hasLegacyDevelopmentV2Phase4OpenDesign(projectId);
  if (hasPhase4OpenDesign && phaseNumber === 5) return 4;
  if (phaseNumber === 16) return 13;
  if (phaseNumber === 17) return 14;
  if (phaseNumber >= 6) return phaseNumber - 1;
  return phaseNumber;
}

function resolveStoredPhaseCandidatesForHistoryRead(projectId: string, phaseNumber: number): number[] {
  const projectType = getProjectPipelineType(projectId);
  const storedPhase = resolveStoredPhaseForHistoryRead(projectId, phaseNumber);

  const loopPhases = projectType ? [...loopPhasesOf(projectType)].sort((a, b) => a - b) : [];
  const history = LOOP_HISTORY_BY_TYPE[projectType as PipelineType] ?? [];
  const roleIndex = loopPhases.indexOf(phaseNumber);

  if (projectType === 'architecture-review' || projectType === 'security') {
    if (phaseNumber === 10) return Array.from(new Set([storedPhase, history[roleIndex]!]));
    if (phaseNumber === 11) return Array.from(new Set([storedPhase, history[roleIndex]!]));
  }

  if (projectType === 'development-v2') {
    if (phaseNumber === 16) return Array.from(new Set([storedPhase, phaseNumber, history[roleIndex]!]));
    if (phaseNumber === 17) return Array.from(new Set([storedPhase, phaseNumber, history[roleIndex]!]));
  }

  return [storedPhase];
}

function isSprintLoopPhaseForProject(projectId: string, phaseNumber: number): boolean {
  return loopPhasesOf(getProjectPipelineType(projectId)).has(phaseNumber);
}

function getSprintMessagePhaseNumbersForProject(projectId: string): number[] {
  const type = getProjectPipelineType(projectId);
  const history = LOOP_HISTORY_BY_TYPE[type as PipelineType] ?? [];
  return [...loopPhasesOf(type), ...history];
}

export function savePipelinePhaseMetrics(data: {
  projectId: string;
  phaseNumber: number;
  phaseName: string;
  agentId?: string;
  status: PipelinePhaseStatus;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  costUsd?: number;
  durationMs?: number;
  toolUses?: number;
  apiRequests?: number;
  messagesCount?: number;
  model?: string;
  runtime?: string;
  startedAt?: string;
  completedAt?: string;
  metadata?: Record<string, unknown>;
  sprintIndex?: number;
  unknownCostCount?: number;
}): number {
  const sprintIdx = data.sprintIndex ?? -1;
  const unknownCostIncrement = data.unknownCostCount ?? 0;

  const existingRow = db
    .prepare(
      `SELECT metadata FROM pipeline_phase_metrics
     WHERE project_id = ? AND phase_number = ? AND sprint_index = ?`,
    )
    .get(data.projectId, data.phaseNumber, sprintIdx) as { metadata?: string } | undefined;

  const existingMeta: Record<string, unknown> = existingRow?.metadata
    ? (() => {
        try {
          return JSON.parse(existingRow.metadata) as Record<string, unknown>;
        } catch {
          return {};
        }
      })()
    : {};
  const mergedMeta: Record<string, unknown> = {
    ...existingMeta,
    ...(data.metadata ?? {}),
  };
  const asStringArray = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [];
  const prevSessionIds = asStringArray(existingMeta['sessionIds']);
  const nextSessionIds = asStringArray((data.metadata ?? {})['sessionIds']);
  if (prevSessionIds.length > 0 || nextSessionIds.length > 0) {
    mergedMeta['sessionIds'] = Array.from(new Set([...prevSessionIds, ...nextSessionIds]));
  }

  const result = db
    .prepare(
      `
    INSERT INTO pipeline_phase_metrics
      (project_id, phase_number, sprint_index, phase_name, agent_id, status,
       input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
       cost_usd, duration_ms, tool_uses, api_requests, messages_count,
       model, runtime, started_at, completed_at, metadata, unknown_cost_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(project_id, phase_number, sprint_index) DO UPDATE SET
      phase_name = excluded.phase_name,
      agent_id = excluded.agent_id,
      status = excluded.status,
      input_tokens = excluded.input_tokens,
      output_tokens = excluded.output_tokens,
      cache_read_tokens = excluded.cache_read_tokens,
      cache_creation_tokens = excluded.cache_creation_tokens,
      cost_usd = excluded.cost_usd,
      duration_ms = excluded.duration_ms,
      tool_uses = excluded.tool_uses,
      api_requests = excluded.api_requests,
      messages_count = excluded.messages_count,
      model = excluded.model,
      runtime = excluded.runtime,
      started_at = excluded.started_at,
      completed_at = excluded.completed_at,
      metadata = excluded.metadata,
      unknown_cost_count = pipeline_phase_metrics.unknown_cost_count + excluded.unknown_cost_count
  `,
    )
    .run(
      data.projectId,
      data.phaseNumber,
      sprintIdx,
      data.phaseName,
      data.agentId ?? null,
      data.status,
      data.inputTokens ?? 0,
      data.outputTokens ?? 0,
      data.cacheReadTokens ?? 0,
      data.cacheCreationTokens ?? 0,
      data.costUsd ?? 0,
      data.durationMs ?? 0,
      data.toolUses ?? 0,
      data.apiRequests ?? 0,
      data.messagesCount ?? 0,
      data.model ?? null,
      data.runtime ?? null,
      data.startedAt ?? null,
      data.completedAt ?? null,
      JSON.stringify(mergedMeta),
      unknownCostIncrement,
    );

  return result.lastInsertRowid as number;
}

export function getPipelinePhaseMetricsRows(projectId: string): PipelinePhaseMetricsRow[] {
  const rows = db
    .prepare(
      `
    SELECT * FROM pipeline_phase_metrics
    WHERE project_id = ?
    ORDER BY phase_number ASC, sprint_index ASC
  `,
    )
    .all(projectId) as Record<string, unknown>[];
  return rows.map(mapPipelinePhaseMetrics);
}

export function mergePipelinePhaseMetricsMetadata(
  projectId: string,
  phaseNumber: number,
  sprintIndex: number,
  patch: Record<string, unknown>,
): void {
  const row = db
    .prepare(
      `SELECT metadata FROM pipeline_phase_metrics
     WHERE project_id = ? AND phase_number = ? AND sprint_index = ?`,
    )
    .get(projectId, phaseNumber, sprintIndex) as { metadata?: string | null } | undefined;
  if (!row) return;
  let existing: Record<string, unknown> = {};
  try {
    existing = JSON.parse(row.metadata || '{}') as Record<string, unknown>;
  } catch {
    existing = {};
  }
  db.prepare(
    `UPDATE pipeline_phase_metrics SET metadata = ?
     WHERE project_id = ? AND phase_number = ? AND sprint_index = ?`,
  ).run(JSON.stringify({ ...existing, ...patch }), projectId, phaseNumber, sprintIndex);
}

export const PIPELINE_GREETING_AGENT_ID = '__greeting__';

export function updateHarnessProjectPipelineColumns(
  projectId: string,
  columns: {
    pipelineCurrentPhase?: number | null;
    pipelineStartPhase?: number | null;
    discoveryNotesPath?: string | null;
    prdPath?: string | null;
    status?: string;
    pipelineSprintIndex?: number;
    pipelineDiscoveryBlock?: number;
  },
): void {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (columns.pipelineCurrentPhase !== undefined) {
    fields.push('pipeline_current_phase = ?');
    values.push(columns.pipelineCurrentPhase);
  }
  if (columns.pipelineStartPhase !== undefined) {
    fields.push('pipeline_start_phase = ?');
    values.push(columns.pipelineStartPhase);
  }
  if (columns.discoveryNotesPath !== undefined) {
    fields.push('discovery_notes_path = ?');
    values.push(columns.discoveryNotesPath);
  }
  if (columns.prdPath !== undefined) {
    fields.push('prd_path = ?');
    values.push(columns.prdPath);
  }
  if (columns.status !== undefined) {
    fields.push('status = ?');
    values.push(columns.status);
  }
  if (columns.pipelineSprintIndex !== undefined) {
    fields.push('pipeline_sprint_index = ?');
    values.push(columns.pipelineSprintIndex);
  }
  if (columns.pipelineDiscoveryBlock !== undefined) {
    fields.push('pipeline_discovery_block = ?');
    values.push(columns.pipelineDiscoveryBlock);
  }

  if (fields.length > 0) {
    fields.push(`updated_at = datetime('now')`);
    values.push(projectId);
    db.prepare(`UPDATE harness_projects SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  }
}

export function savePipelineMessage(data: {
  projectId: string;
  phaseNumber: number;
  role: 'user' | 'assistant' | 'system';
  content: string;
  toolCalls?: Array<{ tool: string; input: unknown; output?: string; isError?: boolean }>;
  sprintIndex?: number;
  roundIndex?: number;
  agentId?: string;
}): void {
  db.prepare(
    `
    INSERT INTO pipeline_messages (project_id, phase_number, role, content, tool_calls, sprint_index, round_index, agent_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    data.projectId,
    data.phaseNumber,
    data.role,
    data.content,
    data.toolCalls && data.toolCalls.length > 0 ? JSON.stringify(data.toolCalls) : null,
    data.sprintIndex ?? null,
    data.roundIndex ?? null,
    data.agentId ?? null,
  );
  logger.debug(
    { projectId: data.projectId, phase: data.phaseNumber, role: data.role, probe: textProbe(data.content) },
    '(F8) pipeline_messages row gravada',
  );
}

export function listPipelineMessagesForSprint(
  projectId: string,
  sprintIndex: number,
): Array<{
  id: number;
  phaseNumber: number;
  role: 'user' | 'assistant' | 'system';
  content: string;
  toolCalls?: Array<{ tool: string; input: unknown }>;
  sprintIndex: number | null;
  roundIndex: number | null;
  agentId: string | null;
  createdAt: string;
}> {
  const phaseNumbers = getSprintMessagePhaseNumbersForProject(projectId);
  const placeholders = phaseNumbers.map(() => '?').join(', ');
  const rows = db
    .prepare(
      `
    SELECT id, phase_number, role, content, tool_calls, sprint_index, round_index, agent_id, created_at
    FROM pipeline_messages
    WHERE project_id = ? AND sprint_index = ? AND phase_number IN (${placeholders})
    ORDER BY round_index ASC, created_at ASC
  `,
    )
    .all(projectId, sprintIndex, ...phaseNumbers) as Array<{
    id: number;
    phase_number: number;
    role: string;
    content: string;
    tool_calls: string | null;
    sprint_index: number | null;
    round_index: number | null;
    agent_id: string | null;
    created_at: string;
  }>;

  return rows.map((row) => ({
    id: row.id,
    phaseNumber: row.phase_number,
    role: row.role as 'user' | 'assistant' | 'system',
    content: row.content,
    toolCalls: row.tool_calls ? (JSON.parse(row.tool_calls) as Array<{ tool: string; input: unknown }>) : undefined,
    sprintIndex: row.sprint_index,
    roundIndex: row.round_index,
    agentId: row.agent_id,
    createdAt: row.created_at,
  }));
}

export function deletePipelineMessagesFromPhase(projectId: string, fromPhase: number): void {
  db.prepare(
    `
    DELETE FROM pipeline_messages WHERE project_id = ? AND phase_number >= ?
  `,
  ).run(projectId, fromPhase);
}

export function deletePipelinePhaseMetricsFromPhase(projectId: string, fromPhase: number): void {
  db.prepare(
    `
    DELETE FROM pipeline_phase_metrics WHERE project_id = ? AND phase_number >= ?
  `,
  ).run(projectId, fromPhase);
}

export function deletePipelineMessagesForSprint(projectId: string, sprintIndex: number): void {
  const loopPhaseIn = [...allLoopPhasesWithHistory()].sort((a, b) => a - b).join(', ');
  db.prepare(
    `
    DELETE FROM pipeline_messages
    WHERE project_id = ? AND sprint_index = ? AND phase_number IN (${loopPhaseIn})
  `,
  ).run(projectId, sprintIndex);
}

export function deletePipelinePhaseMetricsForSprint(projectId: string, sprintIndex: number): void {
  const loopPhaseIn = [...allLoopPhasesWithHistory()].sort((a, b) => a - b).join(', ');
  const rows = db
    .prepare(
      `
    SELECT id, metadata FROM pipeline_phase_metrics
    WHERE project_id = ? AND sprint_index = ? AND phase_number IN (${loopPhaseIn})
  `,
    )
    .all(projectId, sprintIndex) as Array<{ id: number; metadata?: string | null }>;

  const deleteStmt = db.prepare('DELETE FROM pipeline_phase_metrics WHERE id = ?');
  const carryStmt = db.prepare(`
    UPDATE pipeline_phase_metrics SET
      status = 'pending',
      input_tokens = 0, output_tokens = 0,
      cache_read_tokens = 0, cache_creation_tokens = 0,
      cost_usd = 0, duration_ms = 0, tool_uses = 0, api_requests = 0,
      messages_count = 0, unknown_cost_count = 0,
      model = NULL, runtime = NULL, started_at = NULL, completed_at = NULL,
      metadata = ?
    WHERE id = ?
  `);

  const run = db.transaction(() => {
    for (const row of rows) {
      let sessionIds: string[] = [];
      try {
        const meta = JSON.parse(row.metadata || '{}') as Record<string, unknown>;
        const raw = meta['sessionIds'];
        if (Array.isArray(raw)) {
          sessionIds = raw.filter((s): s is string => typeof s === 'string' && s.length > 0);
        }
      } catch {
        // metadata corrompido: trata como sem sessionIds (delete puro).
      }
      if (sessionIds.length > 0) {
        carryStmt.run(JSON.stringify({ sessionIds }), row.id);
      } else {
        deleteStmt.run(row.id);
      }
    }
  });
  run();
}

export function countPipelineMessagesFromPhase(projectId: string, fromPhase: number): number {
  const row = db
    .prepare(`SELECT COUNT(*) as cnt FROM pipeline_messages WHERE project_id = ? AND phase_number >= ?`)
    .get(projectId, fromPhase) as { cnt: number };
  return row.cnt;
}

export function countPipelinePhaseMetricsFromPhase(projectId: string, fromPhase: number): number {
  const row = db
    .prepare(`SELECT COUNT(*) as cnt FROM pipeline_phase_metrics WHERE project_id = ? AND phase_number >= ?`)
    .get(projectId, fromPhase) as { cnt: number };
  return row.cnt;
}

export function countPipelineMessagesForSprint(projectId: string, sprintIndex: number): number {
  const row = db
    .prepare(`SELECT COUNT(*) as cnt FROM pipeline_messages WHERE project_id = ? AND sprint_index = ?`)
    .get(projectId, sprintIndex) as { cnt: number };
  return row.cnt;
}

export function countPipelinePhaseMetricsForSprint(projectId: string, sprintIndex: number): number {
  const row = db
    .prepare(`SELECT COUNT(*) as cnt FROM pipeline_phase_metrics WHERE project_id = ? AND sprint_index = ?`)
    .get(projectId, sprintIndex) as { cnt: number };
  return row.cnt;
}

export function getMostRecentInProgressRoundId(sprintId: string): string | undefined {
  const row = db
    .prepare(
      `SELECT id FROM harness_rounds
         WHERE sprint_id = ?
           AND (completed_at IS NULL OR completed_at = '')
         ORDER BY round_number DESC
         LIMIT 1`,
    )
    .get(sprintId) as { id: string } | undefined;
  return row?.id;
}

export function getRunningPipelineProjectIds(): string[] {
  const rows = db
    .prepare(`SELECT id FROM harness_projects WHERE status = 'running' AND pipeline_current_phase IS NOT NULL`)
    .all() as { id: string }[];
  return rows.map((r) => r.id);
}

export function getStaleRunningPhaseMetrics(): Array<{ id: number; projectId: string; phaseNumber: number }> {
  const rows = db
    .prepare(
      `SELECT m.id, m.project_id, m.phase_number
       FROM pipeline_phase_metrics m
       INNER JOIN harness_projects p ON p.id = m.project_id
       WHERE m.status = 'running'
         AND p.status != 'running'`,
    )
    .all() as { id: number; project_id: string; phase_number: number }[];
  return rows.map((r) => ({ id: r.id, projectId: r.project_id, phaseNumber: r.phase_number }));
}

export function markPhaseMetricInterrupted(id: number): void {
  db.prepare(
    `UPDATE pipeline_phase_metrics SET status = 'interrupted', completed_at = datetime('now') WHERE id = ?`,
  ).run(id);
}

export function deleteHarnessRoundsForSprint(projectId: string, sprintIndex: number): void {
  const sprint = db
    .prepare('SELECT id FROM harness_sprints WHERE project_id = ? AND sprint_index = ?')
    .get(projectId, sprintIndex) as { id: string } | undefined;
  if (!sprint) return;
  db.prepare('DELETE FROM harness_rounds WHERE sprint_id = ?').run(sprint.id);
}

export function carryHarnessRoundSessionIdsForSprint(
  projectId: string,
  sprintIndex: number,
  coderPhase: number,
  evaluatorPhase: number,
): void {
  const sprint = db
    .prepare('SELECT id FROM harness_sprints WHERE project_id = ? AND sprint_index = ?')
    .get(projectId, sprintIndex) as { id: string } | undefined;
  if (!sprint) return;

  const rounds = db
    .prepare('SELECT coder_session_id, evaluator_session_id FROM harness_rounds WHERE sprint_id = ?')
    .all(sprint.id) as Array<{ coder_session_id?: string | null; evaluator_session_id?: string | null }>;
  if (rounds.length === 0) return;

  const collect = (col: 'coder_session_id' | 'evaluator_session_id'): string[] => {
    const ids = new Set<string>();
    for (const r of rounds) {
      for (const part of (r[col] ?? '').split(',')) {
        const id = part.trim();
        if (id) ids.add(id);
      }
    }
    return [...ids];
  };

  const seed = (phaseNumber: number, sessionIds: string[]): void => {
    if (sessionIds.length === 0) return;
    const row = db
      .prepare(
        `SELECT id, metadata FROM pipeline_phase_metrics
       WHERE project_id = ? AND phase_number = ? AND sprint_index = ?`,
      )
      .get(projectId, phaseNumber, sprintIndex) as { id: number; metadata?: string | null } | undefined;
    if (row) {
      let meta: Record<string, unknown> = {};
      try {
        meta = JSON.parse(row.metadata || '{}') as Record<string, unknown>;
      } catch {
        meta = {};
      }
      const prev = Array.isArray(meta['sessionIds'])
        ? (meta['sessionIds'] as unknown[]).filter((s): s is string => typeof s === 'string')
        : [];
      meta['sessionIds'] = Array.from(new Set([...prev, ...sessionIds]));
      db.prepare('UPDATE pipeline_phase_metrics SET metadata = ? WHERE id = ?').run(JSON.stringify(meta), row.id);
    } else {
      db.prepare(
        `
        INSERT INTO pipeline_phase_metrics
          (project_id, phase_number, sprint_index, phase_name, status, metadata)
        VALUES (?, ?, ?, ?, 'pending', ?)
      `,
      ).run(projectId, phaseNumber, sprintIndex, `Phase ${phaseNumber}`, JSON.stringify({ sessionIds }));
    }
  };

  db.transaction(() => {
    seed(coderPhase, collect('coder_session_id'));
    seed(evaluatorPhase, collect('evaluator_session_id'));
  })();
}

export function resetHarnessSprintStatus(projectId: string, sprintIndex: number): void {
  db.prepare(
    `
    UPDATE harness_sprints
    SET status = 'pending', verdict = NULL, updated_at = datetime('now')
    WHERE project_id = ? AND sprint_index = ?
  `,
  ).run(projectId, sprintIndex);
}

export function deleteHarnessSprintsForProject(projectId: string): void {
  const sprints = db.prepare('SELECT id FROM harness_sprints WHERE project_id = ?').all(projectId) as Array<{
    id: string;
  }>;
  for (const sprint of sprints) {
    db.prepare('DELETE FROM harness_rounds WHERE sprint_id = ?').run(sprint.id);
  }
  db.prepare('DELETE FROM harness_sprints WHERE project_id = ?').run(projectId);
}

export function getHarnessSprintByIndex(projectId: string, sprintIndex: number): HarnessSprint | null {
  const row = db
    .prepare('SELECT * FROM harness_sprints WHERE project_id = ? AND sprint_index = ?')
    .get(projectId, sprintIndex) as Record<string, unknown> | undefined;
  if (!row) return null;
  return mapHarnessSprint(row);
}

export function updateHarnessProjectPipelineMeta(
  projectId: string,
  columns: {
    pipelineCurrentPhase?: number | null;
    pipelineStartPhase?: number | null;
    prdPath?: string | null;
    status?: string;
  },
): void {
  const fields: string[] = [];
  const values: unknown[] = [];
  if (columns.pipelineCurrentPhase !== undefined) {
    fields.push('pipeline_current_phase = ?');
    values.push(columns.pipelineCurrentPhase);
  }
  if (columns.pipelineStartPhase !== undefined) {
    fields.push('pipeline_start_phase = ?');
    values.push(columns.pipelineStartPhase);
  }
  if (columns.prdPath !== undefined) {
    fields.push('prd_path = ?');
    values.push(columns.prdPath);
  }
  if (columns.status !== undefined) {
    fields.push('status = ?');
    values.push(columns.status);
  }
  if (fields.length > 0) {
    fields.push(`updated_at = datetime('now')`);
    values.push(projectId);
    db.prepare(`UPDATE harness_projects SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  }
}

export function getDriveState(projectId: string): DriveState | null {
  const project = getHarnessProject(projectId);
  if (!project) return null;
  const drive = project.config.drive;
  if (!drive) return null;
  return { ...drive, sessionId: getDriveSessionId(projectId) ?? undefined };
}

export function getDriveSessionId(projectId: string): string | null {
  const row = db.prepare('SELECT session_id FROM harness_projects WHERE id = ?').get(projectId) as
    { session_id: string | null } | undefined;
  return row?.session_id ?? null;
}

export function listHarnessProjectsBySession(sessionId: string): HarnessProject[] {
  const rows = db
    .prepare('SELECT * FROM harness_projects WHERE session_id = ? ORDER BY created_at DESC')
    .all(sessionId) as Record<string, unknown>[];
  return rows.map((row) => applyLegacyHarnessSprintsJsonMigration(mapHarnessProject(row)));
}

export function rebindDriveSessions(oldSessionId: string, newSessionId: string): number {
  if (!oldSessionId || !newSessionId || oldSessionId === newSessionId) return 0;

  const projects = listHarnessProjectsBySession(oldSessionId);
  if (projects.length === 0) return 0;

  const engaged = projects.filter((project) => {
    const drive = project.config.drive;
    return drive?.driver === 'orchestrator' && drive.status !== 'stopped';
  });

  const runtimeSync = getDriveRebindRuntimeSync();
  for (const project of engaged) {
    if (runtimeSync?.isTurnInFlight(project.id)) {
      throw new DriveRebindRefusedError(project.id);
    }
  }

  const changed = db
    .prepare(
      `
      UPDATE harness_projects
         SET session_id = ?,
             config = json_set(config, '$.drive.sessionId', ?, '$.drive.rebindFrom', ?),
             updated_at = datetime('now')
       WHERE session_id = ?
    `,
    )
    .run(newSessionId, newSessionId, oldSessionId, oldSessionId).changes;

  const migrated: string[] = [];
  try {
    for (const project of engaged) {
      const lock = acquireDriveLock(project.id, newSessionId, {
        allowRebind: true,
        turnInFlight: false,
      });
      if (!lock.ok) {
        throw new Error(
          `drive_rebind_lock_refused: ${lock.reason} ao mover o drive do projeto ` +
            `"${project.id}" para a lane "${newSessionId}"`,
        );
      }
      runtimeSync?.onRebound(project.id, oldSessionId, newSessionId);
      migrated.push(project.id);
    }
  } catch (err) {
    for (const projectId of migrated.reverse()) {
      try {
        acquireDriveLock(projectId, oldSessionId, { allowRebind: true, turnInFlight: false });
        runtimeSync?.onRollback(projectId, oldSessionId, newSessionId);
      } catch (rollbackErr) {
        logger.error(
          { projectId, error: (rollbackErr as Error).message },
          'rebindDriveSessions: rollback de lock/runtime falhou',
        );
      }
    }
    throw err;
  }

  logger.info(
    { oldSessionId, newSessionId, changed, engaged: engaged.length },
    'rebindDriveSessions: lane re-apontada para a conversa nova',
  );
  return changed;
}

export function findEngagedDriveBySession(sessionId: string): HarnessProject | null {
  if (!sessionId) return null;
  const engaged = listHarnessProjectsBySession(sessionId).filter((project) => {
    const drive = project.config.drive;
    return drive?.driver === 'orchestrator' && drive.status !== 'stopped';
  });
  if (engaged.length === 0) return null;
  if (engaged.length > 1) {
    throw new Error(
      `drive_uniqueness_violated: ${engaged.length} pipelines engajados na sessao "${sessionId}": ${engaged
        .map((project) => project.id)
        .join(', ')}`,
    );
  }
  return engaged[0];
}

export function isDriveEngaged(projectId: string): boolean {
  const drive = getDriveState(projectId);
  if (!drive) return false;
  return drive.driver === 'orchestrator' && drive.status !== 'stopped';
}

export function setDriveState(projectId: string, patch: Partial<DriveState>): DriveState {
  const project = getHarnessProject(projectId);
  if (!project) {
    throw new Error(`setDriveState: project not found: ${projectId}`);
  }
  const existing = project.config.drive;
  const currentSessionId = getDriveSessionId(projectId) ?? existing?.sessionId;
  const merged: DriveState = {
    driver: patch.driver ?? existing?.driver ?? 'orchestrator',
    status: patch.status ?? existing?.status ?? 'driving',
    handoff: patch.handoff ?? existing?.handoff ?? 'none',
    mode: patch.mode ?? existing?.mode ?? 'semi',
    sessionId: patch.sessionId !== undefined ? patch.sessionId : currentSessionId,
    requiresHumanPhases: patch.requiresHumanPhases ?? existing?.requiresHumanPhases ?? [],
    startedAt: patch.startedAt !== undefined ? patch.startedAt : existing?.startedAt,
    stoppedReason: patch.stoppedReason !== undefined ? patch.stoppedReason : existing?.stoppedReason,
    rebindFrom: patch.rebindFrom !== undefined ? patch.rebindFrom : existing?.rebindFrom,
    lastEscalation: 'lastEscalation' in patch ? patch.lastEscalation : existing?.lastEscalation,
  };
  updateHarnessProject(projectId, {
    config: { ...project.config, drive: merged },
  });
  if (patch.sessionId !== undefined) {
    db.prepare('UPDATE harness_projects SET session_id = ? WHERE id = ?').run(patch.sessionId, projectId);
  }
  return merged;
}

export function getSecuritySummaryJson(projectId: string): SecuritySummary | null {
  const row = db.prepare('SELECT security_summary_json FROM harness_projects WHERE id = ?').get(projectId) as
    { security_summary_json: string | null } | undefined;
  if (!row || !row.security_summary_json) return null;
  try {
    return JSON.parse(row.security_summary_json) as SecuritySummary;
  } catch {
    logger.warn({ projectId }, 'getSecuritySummaryJson: failed to parse stored JSON');
    return null;
  }
}

export function patchSecuritySummaryJson(projectId: string, patch: Partial<SecuritySummary>): void {
  const existing = getSecuritySummaryJson(projectId) ?? {};
  const merged: SecuritySummary = { ...existing, ...patch };
  db.prepare(`UPDATE harness_projects SET security_summary_json = ?, updated_at = datetime('now') WHERE id = ?`).run(
    JSON.stringify(merged),
    projectId,
  );
}

export function getPipelinePhaseMessages(
  projectId: string,
  phaseNumber: number,
): Array<{
  role: 'user' | 'assistant';
  content: string;
  toolCalls?: Array<{ tool: string; input: unknown }>;
}> {
  const storedPhaseNumbers = resolveStoredPhaseCandidatesForHistoryRead(projectId, phaseNumber);
  const placeholders = storedPhaseNumbers.map(() => '?').join(', ');
  const includeSprintMessages = isSprintLoopPhaseForProject(projectId, phaseNumber) ? 1 : 0;
  const rows = db
    .prepare(
      `
    SELECT role, content, tool_calls
    FROM pipeline_messages
    WHERE project_id = ? AND phase_number IN (${placeholders}) AND (? = 1 OR sprint_index IS NULL)
      AND agent_id IS NOT '${PIPELINE_GREETING_AGENT_ID}'
    ORDER BY id ASC
  `,
    )
    .all(projectId, ...storedPhaseNumbers, includeSprintMessages) as Array<{
    role: string;
    content: string;
    tool_calls: string | null;
  }>;

  const merged: Array<{
    role: 'user' | 'assistant';
    content: string;
    toolCalls?: Array<{ tool: string; input: unknown }>;
  }> = [];
  for (const row of rows) {
    const last = merged[merged.length - 1];
    const toolCalls = row.tool_calls
      ? (JSON.parse(row.tool_calls) as Array<{ tool: string; input: unknown }>)
      : undefined;
    if (last && last.role === row.role) {
      last.content += row.content;
      if (toolCalls) {
        last.toolCalls = [...(last.toolCalls ?? []), ...toolCalls];
      }
    } else {
      merged.push({
        role: row.role as 'user' | 'assistant',
        content: row.content,
        toolCalls,
      });
    }
  }
  return merged;
}

export function getPipelinePhaseMessagesAsChatHistory(
  projectId: string,
  phaseNumber: number,
): Array<{
  role: 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}> {
  const storedPhaseNumbers = resolveStoredPhaseCandidatesForHistoryRead(projectId, phaseNumber);
  const placeholders = storedPhaseNumbers.map(() => '?').join(', ');
  const includeSprintMessages = isSprintLoopPhaseForProject(projectId, phaseNumber) ? 1 : 0;
  const rows = db
    .prepare(
      `
    SELECT id, role, content, tool_calls
    FROM pipeline_messages
    WHERE project_id = ? AND phase_number IN (${placeholders}) AND (? = 1 OR sprint_index IS NULL)
    ORDER BY id ASC
  `,
    )
    .all(projectId, ...storedPhaseNumbers, includeSprintMessages) as Array<{
    id: number;
    role: string;
    content: string;
    tool_calls: string | null;
  }>;

  const out: Array<{
    role: 'user' | 'assistant' | 'tool';
    content: string | null;
    tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
    tool_call_id?: string;
  }> = [];

  for (const row of rows) {
    if (row.role === 'user') {
      out.push({ role: 'user', content: row.content });
      continue;
    }
    if (row.role !== 'assistant') continue;

    const tcRaw = row.tool_calls
      ? (JSON.parse(row.tool_calls) as Array<{ tool: string; input: unknown; output?: string; isError?: boolean }>)
      : [];

    if (tcRaw.length === 0) {
      out.push({ role: 'assistant', content: row.content });
      continue;
    }

    const tcWithIds = tcRaw.map((tc, idx) => ({
      id: `call_${row.id}_${idx}`,
      type: 'function' as const,
      function: {
        name: tc.tool,
        arguments: typeof tc.input === 'string' ? tc.input : JSON.stringify(tc.input ?? {}),
      },
      output: tc.output,
    }));

    out.push({
      role: 'assistant',
      content: '',
      tool_calls: tcWithIds.map((tc) => ({ id: tc.id, type: tc.type, function: tc.function })),
    });

    for (const tc of tcWithIds) {
      if (tc.output !== undefined) {
        out.push({ role: 'tool', tool_call_id: tc.id, content: tc.output });
      }
    }

    if (row.content && row.content.trim().length > 0) {
      out.push({ role: 'assistant', content: row.content });
    }
  }

  for (let i = out.length - 1; i >= 0; i--) {
    const m = out[i];
    if (m && m.role === 'assistant' && typeof m.content === 'string' && m.content.trim().length > 0) {
      logger.debug(
        { projectId, phaseNumber, rows: rows.length, probe: textProbe(m.content) },
        '(F8) pipeline_messages historico lido (ultimo assistant)',
      );
      break;
    }
  }

  return out;
}

export function getPipelineMetrics(projectId: string): PipelineMetrics {
  const phases = db
    .prepare(
      `
    SELECT * FROM pipeline_phase_metrics
    WHERE project_id = ?
    ORDER BY phase_number ASC
  `,
    )
    .all(projectId) as Record<string, unknown>[];

  const legacyDevelopmentV2PhaseNumbers = isLegacyDevelopmentV2PhaseNumbering(projectId, phases);
  const legacyDevelopmentV2Phase4OpenDesign = hasLegacyDevelopmentV2Phase4OpenDesign(projectId, phases);
  const mappedPhases = phases
    .map(mapPipelinePhaseMetrics)
    .map((phase) =>
      legacyDevelopmentV2PhaseNumbers
        ? remapLegacyDevelopmentV2MetricPhase(phase, legacyDevelopmentV2Phase4OpenDesign)
        : phase,
    );

  const pipelineType = getProjectPipelineType(projectId);
  const isPhaseAggregateWrapper = (phase: PipelinePhaseMetricsRow): boolean =>
    phase.sprintIndex === -1 &&
    phase.metadata['auditAgent'] !== true &&
    (phase.metadata['aggregateOnly'] === true ||
      (pipelineType === 'security' && phase.phaseNumber === 2 && phase.agentId === 'multi-agent'));
  const reportablePhases = mappedPhases.filter((phase) => !isPhaseAggregateWrapper(phase));
  const phaseTotals = reportablePhases.reduce(
    (totals, phase) => ({
      inputTokens: totals.inputTokens + phase.inputTokens,
      outputTokens: totals.outputTokens + phase.outputTokens,
      cacheTokens: totals.cacheTokens + phase.cacheReadTokens + phase.cacheCreationTokens,
      costUsd: totals.costUsd + phase.costUsd,
      durationMs: totals.durationMs + phase.durationMs,
      toolUses: totals.toolUses + phase.toolUses,
      apiRequests: totals.apiRequests + phase.apiRequests,
    }),
    {
      inputTokens: 0,
      outputTokens: 0,
      cacheTokens: 0,
      costUsd: 0,
      durationMs: 0,
      toolUses: 0,
      apiRequests: 0,
    },
  );

  const sprintPhaseSet = new Set<number>([
    ...loopPhasesOf(pipelineType),
    ...(LOOP_HISTORY_BY_TYPE[pipelineType as PipelineType] ?? []),
  ]);
  const sprintPhases = reportablePhases.filter((p) => sprintPhaseSet.has(p.phaseNumber));
  const subagents = getTaskExecutionRollup({
    ownerKind: 'pipeline',
    ownerId: projectId,
    executionKinds: ['subagent'],
  });
  const costByRuntime = { ...subagents.costByRuntime };
  const costStatusByRuntime: Record<string, TaskExecutionFinalize['costStatus']> = {};
  const mergeRuntimeCostStatus = (runtime: string, status: TaskExecutionFinalize['costStatus']): void => {
    const current = costStatusByRuntime[runtime];
    if (!current || COST_QUALITY_RANK[status] > COST_QUALITY_RANK[current]) {
      costStatusByRuntime[runtime] = status;
    }
  };
  for (const entry of subagents.usageMetadata.pricingProvenance) {
    mergeRuntimeCostStatus(entry.runtime, entry.costStatus);
  }
  for (const phase of reportablePhases) {
    const runtime = phase.runtime ?? 'cloud';
    costByRuntime[runtime] = (costByRuntime[runtime] ?? 0) + phase.costUsd;
    const metadataCostStatus = phase.metadata['costStatus'];
    const phaseCostStatus: TaskExecutionFinalize['costStatus'] =
      phase.unknownCostCount > 0 || metadataCostStatus === 'unknown'
        ? 'unknown'
        : metadataCostStatus === 'estimated-partial'
          ? 'estimated-partial'
          : 'known';
    mergeRuntimeCostStatus(runtime, phaseCostStatus);
  }
  const phaseSubscriptionEquivalentCost = reportablePhases
    .filter((phase) => phase.metadata['costEstimationKind'] === 'subscription-equivalent-payg')
    .reduce((sum, phase) => sum + phase.costUsd, 0);
  const subagentSubscriptionEquivalentCost = subagents.usageMetadata.pricingProvenance
    .filter((entry) => entry.costEstimationKind === 'subscription-equivalent-payg')
    .reduce((sum, entry) => sum + entry.costUsd, 0);
  const subscriptionEquivalentCost = Math.min(
    phaseTotals.costUsd + subagents.metrics.costUsd,
    Math.max(0, phaseSubscriptionEquivalentCost + subagentSubscriptionEquivalentCost),
  );
  let phaseCostStatus: 'known' | 'unknown' | 'estimated-partial' = 'known';
  let phaseTokenStatus: 'reported' | 'not_reported' = 'reported';
  let phaseUnknownCostCount = 0;
  const costUnknownReasons = new Set<string>(subagents.costUnknownReasons);
  for (const phase of reportablePhases) {
    const metadataCostStatus = phase.metadata['costStatus'];
    const phaseUnknown = phase.unknownCostCount ?? 0;
    phaseUnknownCostCount += phaseUnknown;
    if (phaseUnknown > 0 || metadataCostStatus === 'unknown') {
      phaseCostStatus = 'unknown';
    } else if (metadataCostStatus === 'estimated-partial' && phaseCostStatus === 'known') {
      phaseCostStatus = 'estimated-partial';
    }
    if (phase.metadata['tokenStatus'] === 'not_reported') phaseTokenStatus = 'not_reported';
    const reason = phase.metadata['costUnknownReason'];
    if (typeof reason === 'string' && reason.length > 0) costUnknownReasons.add(reason);
  }
  const totalCostStatus =
    phaseCostStatus === 'unknown' || subagents.costStatus === 'unknown'
      ? 'unknown'
      : phaseCostStatus === 'estimated-partial' || subagents.costStatus === 'estimated-partial'
        ? 'estimated-partial'
        : 'known';

  const agentIds = new Set<string>();
  for (const p of reportablePhases) {
    if (p.agentId) agentIds.add(p.agentId);
  }
  const agentNames: Record<string, string> = {};
  for (const aid of agentIds) {
    const agentRow = db.prepare('SELECT name FROM agents WHERE id = ?').get(aid) as { name: string } | undefined;
    agentNames[aid] = agentRow?.name ?? aid;
  }

  return {
    totals: {
      inputTokens: phaseTotals.inputTokens + subagents.metrics.inputTokens,
      outputTokens: phaseTotals.outputTokens + subagents.metrics.outputTokens,
      cacheTokens: phaseTotals.cacheTokens + subagents.metrics.cacheReadTokens + subagents.metrics.cacheCreationTokens,
      costUsd: phaseTotals.costUsd + subagents.metrics.costUsd,
      durationMs: phaseTotals.durationMs + subagents.metrics.durationMs,
      toolUses: phaseTotals.toolUses + subagents.metrics.toolUses,
      apiRequests: phaseTotals.apiRequests + subagents.metrics.apiRequests,
      costStatus: totalCostStatus,
      tokenStatus:
        phaseTokenStatus === 'not_reported' || subagents.tokenStatus === 'not_reported' ? 'not_reported' : 'reported',
      unknownCostCount: phaseUnknownCostCount + subagents.unknownCostCount,
      costUnknownReasons: [...costUnknownReasons].sort(),
    },
    cloudCost:
      reportablePhases.filter((phase) => phase.runtime !== 'local').reduce((sum, phase) => sum + phase.costUsd, 0) +
      subagents.metrics.costUsd -
      (subagents.costByRuntime['local'] ?? 0),
    localCost:
      reportablePhases.filter((phase) => phase.runtime === 'local').reduce((sum, phase) => sum + phase.costUsd, 0) +
      (subagents.costByRuntime['local'] ?? 0),
    costByRuntime,
    costStatusByRuntime,
    subscriptionEquivalentCost,
    phases: reportablePhases,
    sprintPhases,
    agentNames,
  };
}

export const CODEX_PREP_VERSION_CURRENT = 1;

export interface CodexWindowsPrepConsent {
  repoRoot: string;
  prepVersion: number;
  action: 'prepared' | 'skip';
  consentedAt: number;
  lastAppliedAt: number | null;
}

export function getCodexWindowsPrepConsent(repoRoot: string): CodexWindowsPrepConsent | null {
  const row = db
    .prepare(
      `SELECT repo_root, prep_version, action, consented_at, last_applied_at
     FROM codex_windows_prep_consent
     WHERE repo_root = ?`,
    )
    .get(repoRoot) as
    | {
        repo_root: string;
        prep_version: number;
        action: 'prepared' | 'skip';
        consented_at: number;
        last_applied_at: number | null;
      }
    | undefined;

  if (!row) return null;

  return {
    repoRoot: row.repo_root,
    prepVersion: row.prep_version,
    action: row.action,
    consentedAt: row.consented_at,
    lastAppliedAt: row.last_applied_at,
  };
}

export function upsertCodexWindowsPrepConsent(input: {
  repoRoot: string;
  prepVersion: number;
  action: 'prepared' | 'skip';
}): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO codex_windows_prep_consent (repo_root, prep_version, action, consented_at, last_applied_at)
     VALUES (?, ?, ?, ?, NULL)
     ON CONFLICT(repo_root) DO UPDATE SET
       prep_version = excluded.prep_version,
       action = excluded.action,
       consented_at = excluded.consented_at,
       last_applied_at = NULL`,
  ).run(input.repoRoot, input.prepVersion, input.action, now);
}

export function markCodexWindowsPrepApplied(repoRoot: string): void {
  db.prepare(
    `UPDATE codex_windows_prep_consent
     SET last_applied_at = ?
     WHERE repo_root = ?`,
  ).run(Date.now(), repoRoot);
}

export function systemHasActiveCodexAgents(): boolean {
  const row = db.prepare(`SELECT COUNT(*) as c FROM agents WHERE runtime = 'codex' AND is_active = 1`).get() as {
    c: number;
  };
  return row.c > 0;
}

export interface DreamingState {
  lastGateRunAt: number | null;
  lastTurnRunAt: number | null;
  turnCount: number;
  totalTurnRuns: number;
  totalTurnFailsafes: number;
}

export function getDreamingState(): DreamingState {
  const row = db
    .prepare(
      'SELECT last_gate_run_at, last_turn_run_at, turn_count, total_turn_runs, total_turn_failsafes FROM dreaming_state WHERE id = 1',
    )
    .get() as
    | {
        last_gate_run_at: number | null;
        last_turn_run_at: number | null;
        turn_count: number;
        total_turn_runs: number;
        total_turn_failsafes: number;
      }
    | undefined;
  if (!row) {
    return { lastGateRunAt: null, lastTurnRunAt: null, turnCount: 0, totalTurnRuns: 0, totalTurnFailsafes: 0 };
  }
  return {
    lastGateRunAt: row.last_gate_run_at,
    lastTurnRunAt: row.last_turn_run_at,
    turnCount: row.turn_count,
    totalTurnRuns: row.total_turn_runs,
    totalTurnFailsafes: row.total_turn_failsafes,
  };
}

export function setLastGateRunAt(ms: number): void {
  db.prepare('UPDATE dreaming_state SET last_gate_run_at = ? WHERE id = 1').run(ms);
}

export function setLastTurnRunAt(ms: number): void {
  db.prepare('UPDATE dreaming_state SET last_turn_run_at = ? WHERE id = 1').run(ms);
}

export function incrementTurnCount(): number {
  db.prepare('UPDATE dreaming_state SET turn_count = turn_count + 1 WHERE id = 1').run();
  const row = db.prepare('SELECT turn_count FROM dreaming_state WHERE id = 1').get() as { turn_count: number };
  return row.turn_count;
}

export function resetTurnCount(): void {
  db.prepare('UPDATE dreaming_state SET turn_count = 0 WHERE id = 1').run();
}

export function incrementTotalTurnRuns(): void {
  db.prepare('UPDATE dreaming_state SET total_turn_runs = total_turn_runs + 1 WHERE id = 1').run();
}

export function incrementTotalTurnFailsafes(): void {
  db.prepare('UPDATE dreaming_state SET total_turn_failsafes = total_turn_failsafes + 1 WHERE id = 1').run();
}

export function getDreamingTurnInterval(): number {
  const raw = getSetting('dreaming_turn_based_interval') || '20';
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return 20;
  return Math.min(500, Math.max(10, parsed));
}

function mapLocalRepository(row: Record<string, unknown>): LocalRepositoryRecord {
  return {
    id: row['id'] as string,
    name: row['name'] as string,
    rootPath: row['root_path'] as string,
    canonicalRootPath: row['canonical_root_path'] as string,
    gitRoot: (row['git_root'] as string | null) ?? null,
    provider: row['provider'] as string,
    graphPath: (row['graph_path'] as string | null) ?? null,
    status: row['status'] as LocalRepositoryRecord['status'],
    indexedCommit: (row['indexed_commit'] as string | null) ?? null,
    indexedWorktreeHash: (row['indexed_worktree_hash'] as string | null) ?? null,
    lastIndexedAt: (row['last_indexed_at'] as string | null) ?? null,
    statsJson: (row['stats_json'] as string | null) ?? null,
    graphPromptSuppressedGlobal: Boolean(row['graph_prompt_suppressed_global']),
    settingsJson: (row['settings_json'] as string) ?? '{}',
    createdAt: row['created_at'] as string,
    updatedAt: row['updated_at'] as string,
  };
}

export function upsertLocalRepository(input: {
  id: string;
  name: string;
  rootPath: string;
  canonicalRootPath: string;
  gitRoot: string | null;
  provider?: string;
}): LocalRepositoryRecord {
  const existing = getLocalRepositoryByCanonicalPath(input.canonicalRootPath);
  if (existing) {
    db.prepare(
      `UPDATE local_repositories
       SET name = ?, root_path = ?, git_root = ?, updated_at = datetime('now')
       WHERE id = ?`,
    ).run(input.name, input.rootPath, input.gitRoot, existing.id);
    return getLocalRepository(existing.id) as LocalRepositoryRecord;
  }
  db.prepare(
    `INSERT INTO local_repositories (id, name, root_path, canonical_root_path, git_root, provider)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(input.id, input.name, input.rootPath, input.canonicalRootPath, input.gitRoot, input.provider ?? 'codegraph');
  return getLocalRepository(input.id) as LocalRepositoryRecord;
}

export function getLocalRepository(id: string): LocalRepositoryRecord | null {
  const row = db.prepare('SELECT * FROM local_repositories WHERE id = ?').get(id) as
    Record<string, unknown> | undefined;
  return row ? mapLocalRepository(row) : null;
}

export function getLocalRepositoryByCanonicalPath(canonicalRootPath: string): LocalRepositoryRecord | null {
  const row = db.prepare('SELECT * FROM local_repositories WHERE canonical_root_path = ?').get(canonicalRootPath) as
    Record<string, unknown> | undefined;
  return row ? mapLocalRepository(row) : null;
}

export function listLocalRepositories(): LocalRepositoryRecord[] {
  const rows = db.prepare('SELECT * FROM local_repositories ORDER BY created_at DESC').all() as Array<
    Record<string, unknown>
  >;
  return rows.map(mapLocalRepository);
}

export function removeLocalRepository(id: string): void {
  db.prepare('DELETE FROM local_repositories WHERE id = ?').run(id);
}

export function updateLocalRepositoryGraphState(
  id: string,
  patch: {
    status?: LocalRepositoryRecord['status'];
    indexedCommit?: string | null;
    indexedWorktreeHash?: string | null;
    lastIndexedAt?: string | null;
    statsJson?: string | null;
    graphPath?: string | null;
  },
): void {
  const fields: string[] = [];
  const values: unknown[] = [];
  if (patch.status !== undefined) {
    fields.push('status = ?');
    values.push(patch.status);
  }
  if (patch.indexedCommit !== undefined) {
    fields.push('indexed_commit = ?');
    values.push(patch.indexedCommit);
  }
  if (patch.indexedWorktreeHash !== undefined) {
    fields.push('indexed_worktree_hash = ?');
    values.push(patch.indexedWorktreeHash);
  }
  if (patch.lastIndexedAt !== undefined) {
    fields.push('last_indexed_at = ?');
    values.push(patch.lastIndexedAt);
  }
  if (patch.statsJson !== undefined) {
    fields.push('stats_json = ?');
    values.push(patch.statsJson);
  }
  if (patch.graphPath !== undefined) {
    fields.push('graph_path = ?');
    values.push(patch.graphPath);
  }
  if (fields.length === 0) return;
  fields.push(`updated_at = datetime('now')`);
  values.push(id);
  db.prepare(`UPDATE local_repositories SET ${fields.join(', ')} WHERE id = ?`).run(...values);
}

export function setRepoGraphPromptSuppressedGlobal(id: string, suppressed: boolean): void {
  db.prepare(
    `UPDATE local_repositories
     SET graph_prompt_suppressed_global = ?, updated_at = datetime('now')
     WHERE id = ?`,
  ).run(suppressed ? 1 : 0, id);
}

function mapRepoGraphRun(row: Record<string, unknown>): RepoGraphRunRecord {
  return {
    id: row['id'] as string,
    repositoryId: row['repository_id'] as string,
    sessionId: (row['session_id'] as string | null) ?? null,
    provider: row['provider'] as string,
    kind: row['kind'] as RepoGraphRunRecord['kind'],
    status: row['status'] as RepoGraphRunRecord['status'],
    startedAt: row['started_at'] as string,
    completedAt: (row['completed_at'] as string | null) ?? null,
    durationMs: (row['duration_ms'] as number) || 0,
    output: (row['output'] as string | null) ?? null,
    error: (row['error'] as string | null) ?? null,
    statsJson: (row['stats_json'] as string | null) ?? null,
  };
}

export function insertRepoGraphRun(input: {
  id: string;
  repositoryId: string;
  sessionId: string | null;
  provider: string;
  kind: RepoGraphRunRecord['kind'];
}): RepoGraphRunRecord {
  db.prepare(
    `INSERT INTO repo_graph_runs (id, repository_id, session_id, provider, kind, status)
     VALUES (?, ?, ?, ?, ?, 'running')`,
  ).run(input.id, input.repositoryId, input.sessionId, input.provider, input.kind);
  return getRepoGraphRun(input.id) as RepoGraphRunRecord;
}

export function updateRepoGraphRun(
  id: string,
  patch: {
    status?: RepoGraphRunRecord['status'];
    completedAt?: string | null;
    durationMs?: number;
    output?: string | null;
    error?: string | null;
    statsJson?: string | null;
  },
): void {
  const fields: string[] = [];
  const values: unknown[] = [];
  if (patch.status !== undefined) {
    fields.push('status = ?');
    values.push(patch.status);
  }
  if (patch.completedAt !== undefined) {
    fields.push('completed_at = ?');
    values.push(patch.completedAt);
  }
  if (patch.durationMs !== undefined) {
    fields.push('duration_ms = ?');
    values.push(patch.durationMs);
  }
  if (patch.output !== undefined) {
    fields.push('output = ?');
    values.push(patch.output);
  }
  if (patch.error !== undefined) {
    fields.push('error = ?');
    values.push(patch.error);
  }
  if (patch.statsJson !== undefined) {
    fields.push('stats_json = ?');
    values.push(patch.statsJson);
  }
  if (fields.length === 0) return;
  values.push(id);
  db.prepare(`UPDATE repo_graph_runs SET ${fields.join(', ')} WHERE id = ?`).run(...values);
}

export function getRepoGraphRun(id: string): RepoGraphRunRecord | null {
  const row = db.prepare('SELECT * FROM repo_graph_runs WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return row ? mapRepoGraphRun(row) : null;
}

export function getLatestRepoGraphRun(repositoryId: string): RepoGraphRunRecord | null {
  const row = db
    .prepare('SELECT * FROM repo_graph_runs WHERE repository_id = ? ORDER BY started_at DESC, id DESC LIMIT 1')
    .get(repositoryId) as Record<string, unknown> | undefined;
  return row ? mapRepoGraphRun(row) : null;
}

function mapSessionActiveRepository(row: Record<string, unknown>): SessionActiveRepositoryRecord {
  return {
    sessionId: row['session_id'] as string,
    repositoryId: row['repository_id'] as string,
    graphPromptSuppressed: Boolean(row['graph_prompt_suppressed']),
    attachedAt: row['attached_at'] as string,
    updatedAt: row['updated_at'] as string,
  };
}

export function attachSessionRepository(sessionId: string, repositoryId: string): void {
  db.prepare(
    `INSERT INTO session_active_repository (session_id, repository_id)
     VALUES (?, ?)
     ON CONFLICT(session_id) DO UPDATE SET
       repository_id = excluded.repository_id,
       graph_prompt_suppressed = 0,
       updated_at = datetime('now')`,
  ).run(sessionId, repositoryId);
}

export function detachSessionRepository(sessionId: string): void {
  db.prepare('DELETE FROM session_active_repository WHERE session_id = ?').run(sessionId);
}

export function getSessionActiveRepository(sessionId: string): SessionActiveRepositoryRecord | null {
  const row = db.prepare('SELECT * FROM session_active_repository WHERE session_id = ?').get(sessionId) as
    Record<string, unknown> | undefined;
  return row ? mapSessionActiveRepository(row) : null;
}

export function setSessionGraphPromptSuppressed(sessionId: string, suppressed: boolean): void {
  db.prepare(
    `UPDATE session_active_repository
     SET graph_prompt_suppressed = ?, updated_at = datetime('now')
     WHERE session_id = ?`,
  ).run(suppressed ? 1 : 0, sessionId);
}

function mapRepoGraphTurnUsage(row: Record<string, unknown>): RepoGraphTurnUsageRecord {
  return {
    id: row['id'] as string,
    sessionId: row['session_id'] as string,
    turnIndex: row['turn_index'] as number,
    repositoryId: row['repository_id'] as string,
    source: row['source'] as RepoGraphTurnUsageRecord['source'],
    runtime: (row['runtime'] as string | null) ?? null,
    toolName: (row['tool_name'] as string | null) ?? null,
    used: Boolean(row['used']),
    reason: (row['reason'] as string | null) ?? null,
    resultCount: (row['result_count'] as number) || 0,
    bytesReturned: (row['bytes_returned'] as number) || 0,
    durationMs: (row['duration_ms'] as number) || 0,
    createdAt: row['created_at'] as string,
  };
}

export function insertRepoGraphTurnUsage(input: {
  id: string;
  sessionId: string;
  turnIndex: number;
  repositoryId: string;
  source: RepoGraphTurnUsageRecord['source'];
  runtime?: string | null;
  toolName?: string | null;
  used: boolean;
  reason?: string | null;
  resultCount?: number;
  bytesReturned?: number;
  durationMs?: number;
}): void {
  db.prepare(
    `INSERT INTO repo_graph_turn_usage
       (id, session_id, turn_index, repository_id, source, runtime, tool_name, used, reason,
        result_count, bytes_returned, duration_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.sessionId,
    input.turnIndex,
    input.repositoryId,
    input.source,
    input.runtime ?? null,
    input.toolName ?? null,
    input.used ? 1 : 0,
    input.reason ?? null,
    input.resultCount ?? 0,
    input.bytesReturned ?? 0,
    input.durationMs ?? 0,
  );
}

export function getRepoGraphTurnUsage(sessionId: string, turnIndex: number): RepoGraphTurnUsageRecord[] {
  const rows = db
    .prepare(
      `SELECT * FROM repo_graph_turn_usage
       WHERE session_id = ? AND turn_index = ?
       ORDER BY created_at ASC, id ASC`,
    )
    .all(sessionId, turnIndex) as Array<Record<string, unknown>>;
  return rows.map(mapRepoGraphTurnUsage);
}

interface RepoGraphTurnAggregateRow {
  tool_calls: number | null;
  tokens: number | null;
}

function mapTurnSample(row: RepoGraphTurnAggregateRow): RepoGraphTurnSample {
  return {
    toolCalls: row.tool_calls ?? 0,
    tokens: row.tokens ?? 0,
  };
}

export function getRepoGraphSavingsMetrics(): RepoGraphSavingsMetrics {
  const withRepoRows = db
    .prepare(
      `SELECT
         SUM(CASE WHEN a.kind = 'tool'
               AND a.label NOT LIKE '%repo\\_graph%' ESCAPE '\\'
               AND a.label NOT LIKE '%repo-graph%'
             THEN 1 ELSE 0 END) AS tool_calls,
         SUM(COALESCE(a.input_tokens, 0) + COALESCE(a.output_tokens, 0)) AS tokens
       FROM activity_log a
       WHERE EXISTS (
         SELECT 1 FROM repo_graph_turn_usage u
         WHERE u.session_id = a.session_id
           AND u.turn_index = a.turn_index
           AND u.used = 1
       )
       GROUP BY a.session_id, a.turn_index`,
    )
    .all() as RepoGraphTurnAggregateRow[];

  const withoutRepoRows = db
    .prepare(
      `SELECT
         SUM(CASE WHEN a.kind = 'tool'
               AND a.label NOT LIKE '%repo\\_graph%' ESCAPE '\\'
               AND a.label NOT LIKE '%repo-graph%'
             THEN 1 ELSE 0 END) AS tool_calls,
         SUM(COALESCE(a.input_tokens, 0) + COALESCE(a.output_tokens, 0)) AS tokens
       FROM activity_log a
       WHERE a.session_id NOT IN (SELECT session_id FROM session_active_repository)
         AND a.session_id NOT IN (SELECT DISTINCT session_id FROM repo_graph_turn_usage)
       GROUP BY a.session_id, a.turn_index`,
    )
    .all() as RepoGraphTurnAggregateRow[];

  return computeRepoGraphSavings(withRepoRows.map(mapTurnSample), withoutRepoRows.map(mapTurnSample));
}

function mapDynamicWorkflowDefinition(row: Record<string, unknown>): DynamicWorkflowDefinition {
  return {
    id: row['id'] as string,
    name: row['name'] as string,
    definitionVersion: (row['definition_version'] as number) ?? 1,
    authoringModel: (row['authoring_model'] as DynamicWorkflowDefinition['authoringModel']) ?? 'claude-code',
    parentDefinitionId: (row['parent_definition_id'] as string | null) ?? null,
    supersedesDefinitionId: (row['supersedes_definition_id'] as string | null) ?? null,
    sourceType: row['source_type'] as string,
    projectPath: row['project_path'] as string,
    specPath: (row['spec_path'] as string | null) ?? null,
    specSha256: (row['spec_sha256'] as string | null) ?? null,
    workflowJsPath: row['workflow_js_path'] as string,
    manifestPath: row['manifest_path'] as string,
    manifestJson: row['manifest_json'] as string,
    manifestHash: row['manifest_hash'] as string,
    contextBundlePath: (row['context_bundle_path'] as string | null) ?? null,
    builderModel: (row['builder_model'] as string | null) ?? null,
    status: row['status'] as string,
    createdAt: row['created_at'] as string,
    updatedAt: row['updated_at'] as string,
  };
}

export function createDynamicWorkflowDefinition(
  input: DynamicWorkflowDefinitionCreateInput,
): DynamicWorkflowDefinition {
  db.prepare(
    `INSERT INTO dynamic_workflow_definitions (
       id, name, definition_version, authoring_model, parent_definition_id, supersedes_definition_id,
       source_type, project_path, spec_path, spec_sha256, workflow_js_path,
       manifest_path, manifest_json, manifest_hash, context_bundle_path,
       builder_agent_id, builder_model, status, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
  ).run(
    input.id,
    input.name,
    input.definitionVersion ?? 1,
    'claude-code',
    input.parentDefinitionId ?? null,
    input.supersedesDefinitionId ?? null,
    input.sourceType,
    input.projectPath,
    input.specPath ?? null,
    input.specSha256 ?? null,
    input.workflowJsPath,
    input.manifestPath,
    input.manifestJson,
    input.manifestHash,
    input.contextBundlePath ?? null,
    null,
    input.builderModel ?? null,
    input.status,
  );
  return getDynamicWorkflowDefinition(input.id) as DynamicWorkflowDefinition;
}

export function getDynamicWorkflowDefinition(id: string): DynamicWorkflowDefinition | null {
  const row = db.prepare('SELECT * FROM dynamic_workflow_definitions WHERE id = ?').get(id) as
    Record<string, unknown> | undefined;
  return row ? mapDynamicWorkflowDefinition(row) : null;
}

export function listDynamicWorkflowDefinitions(): DynamicWorkflowDefinition[] {
  const rows = db.prepare('SELECT * FROM dynamic_workflow_definitions ORDER BY created_at DESC').all() as Array<
    Record<string, unknown>
  >;
  return rows.map(mapDynamicWorkflowDefinition);
}

export function updateDynamicWorkflowDefinition(id: string, patch: DynamicWorkflowDefinitionPatch): void {
  const fields: string[] = [];
  const values: unknown[] = [];
  if (patch.name !== undefined) {
    fields.push('name = ?');
    values.push(patch.name);
  }
  if (patch.definitionVersion !== undefined) {
    fields.push('definition_version = ?');
    values.push(patch.definitionVersion);
  }
  if (patch.parentDefinitionId !== undefined) {
    fields.push('parent_definition_id = ?');
    values.push(patch.parentDefinitionId);
  }
  if (patch.supersedesDefinitionId !== undefined) {
    fields.push('supersedes_definition_id = ?');
    values.push(patch.supersedesDefinitionId);
  }
  if (patch.specPath !== undefined) {
    fields.push('spec_path = ?');
    values.push(patch.specPath);
  }
  if (patch.specSha256 !== undefined) {
    fields.push('spec_sha256 = ?');
    values.push(patch.specSha256);
  }
  if (patch.workflowJsPath !== undefined) {
    fields.push('workflow_js_path = ?');
    values.push(patch.workflowJsPath);
  }
  if (patch.manifestPath !== undefined) {
    fields.push('manifest_path = ?');
    values.push(patch.manifestPath);
  }
  if (patch.manifestJson !== undefined) {
    fields.push('manifest_json = ?');
    values.push(patch.manifestJson);
  }
  if (patch.manifestHash !== undefined) {
    fields.push('manifest_hash = ?');
    values.push(patch.manifestHash);
  }
  if (patch.contextBundlePath !== undefined) {
    fields.push('context_bundle_path = ?');
    values.push(patch.contextBundlePath);
  }
  if (patch.builderModel !== undefined) {
    fields.push('builder_model = ?');
    values.push(patch.builderModel);
  }
  if (patch.status !== undefined) {
    fields.push('status = ?');
    values.push(patch.status);
  }
  if (fields.length === 0) return;
  fields.push(`updated_at = datetime('now')`);
  values.push(id);
  db.prepare(`UPDATE dynamic_workflow_definitions SET ${fields.join(', ')} WHERE id = ?`).run(...values);
}

function mapDynamicWorkflowRun(row: Record<string, unknown>): DynamicWorkflowRun {
  return {
    id: row['id'] as string,
    definitionId: row['definition_id'] as string,
    chatSessionId: (row['chat_session_id'] as string | null) ?? null,
    status: row['status'] as DynamicWorkflowRun['status'],
    currentPhaseId: (row['current_phase_id'] as string | null) ?? null,
    currentNodeId: (row['current_node_id'] as string | null) ?? null,
    workspaceMode: (row['workspace_mode'] as DynamicWorkflowRun['workspaceMode']) ?? null,
    baseBranch: (row['base_branch'] as string | null) ?? null,
    baseCommitSha: (row['base_commit_sha'] as string | null) ?? null,
    baseWorktreeHash: (row['base_worktree_hash'] as string | null) ?? null,
    worktreePath: (row['worktree_path'] as string | null) ?? null,
    worktreeBranch: (row['worktree_branch'] as string | null) ?? null,
    deliveredAt: (row['delivered_at'] as string | null) ?? null,
    finalizedAt: (row['finalized_at'] as string | null) ?? null,
    closerSessionId: (row['closer_session_id'] as string | null) ?? null,
    closerStatus: (row['closer_status'] as DynamicWorkflowRun['closerStatus']) ?? null,
    inputJson: (row['input_json'] as string) ?? '{}',
    outputJson: (row['output_json'] as string | null) ?? null,
    checkpointJson: (row['checkpoint_json'] as string) ?? '{}',
    error: (row['error'] as string | null) ?? null,
    totalCostUsd: (row['total_cost_usd'] as number) || 0,
    totalDurationMs: (row['total_duration_ms'] as number) || 0,
    createdBy: row['created_by'] as string,
    startedAt: (row['started_at'] as string | null) ?? null,
    updatedAt: row['updated_at'] as string,
    completedAt: (row['completed_at'] as string | null) ?? null,
  };
}

export function createDynamicWorkflowRun(input: DynamicWorkflowRunCreateInput): DynamicWorkflowRun {
  db.prepare(
    `INSERT INTO dynamic_workflow_runs (
       id, definition_id, chat_session_id, status, workspace_mode, base_branch,
       base_commit_sha, base_worktree_hash, worktree_path, worktree_branch,
       input_json, created_by, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
  ).run(
    input.id,
    input.definitionId,
    input.chatSessionId ?? null,
    input.status ?? 'created',
    input.workspaceMode ?? null,
    input.baseBranch ?? null,
    input.baseCommitSha ?? null,
    input.baseWorktreeHash ?? null,
    input.worktreePath ?? null,
    input.worktreeBranch ?? null,
    input.inputJson ?? '{}',
    input.createdBy,
  );
  return getDynamicWorkflowRun(input.id) as DynamicWorkflowRun;
}

export function getDynamicWorkflowRun(id: string): DynamicWorkflowRun | null {
  const row = db.prepare('SELECT * FROM dynamic_workflow_runs WHERE id = ?').get(id) as
    Record<string, unknown> | undefined;
  return row ? mapDynamicWorkflowRun(row) : null;
}

export function listDynamicWorkflowRuns(): DynamicWorkflowRun[] {
  try {
    const rows = db
      .prepare(
        `SELECT r.*,
           (SELECT COUNT(*) FROM dynamic_workflow_sprints s WHERE s.run_id = r.id) AS x_sprints_total,
           (SELECT COUNT(*) FROM dynamic_workflow_sprints s
              WHERE s.run_id = r.id AND s.merge_status IN ('merged', 'skipped')) AS x_sprints_merged,
           (SELECT COALESCE(SUM(json_array_length(s.features_json)), 0)
              FROM dynamic_workflow_sprints s WHERE s.run_id = r.id) AS x_features_total
         FROM dynamic_workflow_runs r
         ORDER BY r.updated_at DESC`,
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map((row) => {
      const run = mapDynamicWorkflowRun(row);
      const sprintsTotal = (row['x_sprints_total'] as number) ?? 0;
      const sprintsMerged = (row['x_sprints_merged'] as number) ?? 0;
      const terminalSuccess = run.status === 'delivered' || run.status === 'completed';
      return {
        ...run,
        sprintsTotal,
        sprintsDone: terminalSuccess ? sprintsTotal : sprintsMerged,
        featuresTotal: (row['x_features_total'] as number) ?? 0,
      };
    });
  } catch {
    const rows = db.prepare('SELECT * FROM dynamic_workflow_runs ORDER BY updated_at DESC').all() as Array<
      Record<string, unknown>
    >;
    return rows.map(mapDynamicWorkflowRun);
  }
}

export function listDynamicWorkflowRunsByStatus(status: DynamicWorkflowRunStatus): DynamicWorkflowRun[] {
  const rows = db
    .prepare('SELECT * FROM dynamic_workflow_runs WHERE status = ? ORDER BY updated_at DESC')
    .all(status) as Array<Record<string, unknown>>;
  return rows.map(mapDynamicWorkflowRun);
}

export function setDynamicWorkflowRunStatus(id: string, status: DynamicWorkflowRunStatus): void {
  db.prepare(`UPDATE dynamic_workflow_runs SET status = ?, updated_at = datetime('now') WHERE id = ?`).run(status, id);
}

export function updateDynamicWorkflowRun(id: string, patch: DynamicWorkflowRunPatch): void {
  const fields: string[] = [];
  const values: unknown[] = [];
  if (patch.status !== undefined) {
    fields.push('status = ?');
    values.push(patch.status);
  }
  if (patch.chatSessionId !== undefined) {
    fields.push('chat_session_id = ?');
    values.push(patch.chatSessionId);
  }
  if (patch.currentPhaseId !== undefined) {
    fields.push('current_phase_id = ?');
    values.push(patch.currentPhaseId);
  }
  if (patch.currentNodeId !== undefined) {
    fields.push('current_node_id = ?');
    values.push(patch.currentNodeId);
  }
  if (patch.workspaceMode !== undefined) {
    fields.push('workspace_mode = ?');
    values.push(patch.workspaceMode);
  }
  if (patch.baseBranch !== undefined) {
    fields.push('base_branch = ?');
    values.push(patch.baseBranch);
  }
  if (patch.baseCommitSha !== undefined) {
    fields.push('base_commit_sha = ?');
    values.push(patch.baseCommitSha);
  }
  if (patch.baseWorktreeHash !== undefined) {
    fields.push('base_worktree_hash = ?');
    values.push(patch.baseWorktreeHash);
  }
  if (patch.worktreePath !== undefined) {
    fields.push('worktree_path = ?');
    values.push(patch.worktreePath);
  }
  if (patch.worktreeBranch !== undefined) {
    fields.push('worktree_branch = ?');
    values.push(patch.worktreeBranch);
  }
  if (patch.deliveredAt !== undefined) {
    fields.push('delivered_at = ?');
    values.push(patch.deliveredAt);
  }
  if (patch.finalizedAt !== undefined) {
    fields.push('finalized_at = ?');
    values.push(patch.finalizedAt);
  }
  if (patch.closerSessionId !== undefined) {
    fields.push('closer_session_id = ?');
    values.push(patch.closerSessionId);
  }
  if (patch.closerStatus !== undefined) {
    fields.push('closer_status = ?');
    values.push(patch.closerStatus);
  }
  if (patch.inputJson !== undefined) {
    fields.push('input_json = ?');
    values.push(patch.inputJson);
  }
  if (patch.outputJson !== undefined) {
    fields.push('output_json = ?');
    values.push(patch.outputJson);
  }
  if (patch.checkpointJson !== undefined) {
    fields.push('checkpoint_json = ?');
    values.push(patch.checkpointJson);
  }
  if (patch.error !== undefined) {
    fields.push('error = ?');
    values.push(patch.error);
  }
  if (patch.totalCostUsd !== undefined) {
    fields.push('total_cost_usd = ?');
    values.push(patch.totalCostUsd);
  }
  if (patch.totalDurationMs !== undefined) {
    fields.push('total_duration_ms = ?');
    values.push(patch.totalDurationMs);
  }
  if (patch.startedAt !== undefined) {
    fields.push('started_at = ?');
    values.push(patch.startedAt);
  }
  if (patch.completedAt !== undefined) {
    fields.push('completed_at = ?');
    values.push(patch.completedAt);
  }
  if (fields.length === 0) return;
  fields.push(`updated_at = datetime('now')`);
  values.push(id);
  db.prepare(`UPDATE dynamic_workflow_runs SET ${fields.join(', ')} WHERE id = ?`).run(...values);
}

export function deleteDynamicWorkflowRun(id: string): boolean {
  const info = db.prepare('DELETE FROM dynamic_workflow_runs WHERE id = ?').run(id);
  return info.changes > 0;
}

export function repointDynamicWorkflowRunDefinition(runId: string, definitionId: string): void {
  db.prepare(`UPDATE dynamic_workflow_runs SET definition_id = ?, updated_at = datetime('now') WHERE id = ?`).run(
    definitionId,
    runId,
  );
}

function mapDynamicWorkflowNode(row: Record<string, unknown>): DynamicWorkflowNode {
  return {
    id: row['id'] as string,
    definitionId: row['definition_id'] as string,
    nodeId: row['node_id'] as string,
    phaseId: row['phase_id'] as string,
    sprintId: (row['sprint_id'] as string | null) ?? null,
    roundIndex: typeof row['round_index'] === 'number' ? (row['round_index'] as number) : null,
    type: row['type'] as DynamicWorkflowNode['type'],
    agentId: (row['agent_id'] as string | null) ?? null,
    label: (row['label'] as string | null) ?? null,
    access: (row['access'] as DynamicWorkflowNode['access']) ?? null,
    readSetJson: (row['read_set_json'] as string) ?? '[]',
    writeSetJson: (row['write_set_json'] as string) ?? '[]',
    isolation: (row['isolation'] as DynamicWorkflowNode['isolation']) ?? null,
    allowedToolsJson: (row['allowed_tools_json'] as string) ?? '[]',
    allowedMcpJson: (row['allowed_mcp_json'] as string) ?? '[]',
    policyHash: (row['policy_hash'] as string | null) ?? null,
    timeoutMs: (row['timeout_ms'] as number | null) ?? null,
    costCeilingUsd: (row['cost_ceiling_usd'] as number | null) ?? null,
    dependenciesJson: (row['dependencies_json'] as string) ?? '[]',
    retryPolicyJson: (row['retry_policy_json'] as string) ?? '{}',
    gateConfigJson: (row['gate_config_json'] as string) ?? '{}',
    riskLevel: (row['risk_level'] as string | null) ?? null,
    schemaRef: (row['schema_ref'] as string | null) ?? null,
    producesJson: (row['produces_json'] as string) ?? '[]',
    consumesJson: (row['consumes_json'] as string) ?? '[]',
  };
}

export function createDynamicWorkflowNode(input: DynamicWorkflowNodeCreateInput): DynamicWorkflowNode {
  db.prepare(
    `INSERT INTO dynamic_workflow_nodes (
       id, definition_id, node_id, phase_id, type, agent_id, label, access,
       read_set_json, write_set_json, isolation, allowed_tools_json,
       allowed_mcp_json, policy_hash, timeout_ms, cost_ceiling_usd,
       dependencies_json, retry_policy_json, gate_config_json, risk_level,
       schema_ref, produces_json, consumes_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.definitionId,
    input.nodeId,
    input.phaseId,
    input.type,
    input.agentId ?? null,
    input.label ?? null,
    input.access ?? null,
    JSON.stringify(input.readSet ?? []),
    JSON.stringify(input.writeSet ?? []),
    input.isolation ?? null,
    JSON.stringify(input.allowedTools ?? []),
    JSON.stringify(input.allowedMcp ?? { servers: [], tools: [] }),
    input.policyHash ?? null,
    input.timeoutMs ?? null,
    input.costCeilingUsd ?? null,
    JSON.stringify(input.dependencies ?? []),
    JSON.stringify(input.retryPolicy ?? {}),
    JSON.stringify(input.gateConfig ?? {}),
    input.riskLevel ?? null,
    input.schemaRef ?? null,
    JSON.stringify(input.produces),
    JSON.stringify(input.consumes),
  );
  return getDynamicWorkflowNodeByKey(input.definitionId, input.nodeId) as DynamicWorkflowNode;
}

export function listDynamicWorkflowNodes(definitionId: string): DynamicWorkflowNode[] {
  const rows = db
    .prepare('SELECT * FROM dynamic_workflow_nodes WHERE definition_id = ? ORDER BY rowid ASC')
    .all(definitionId) as Array<Record<string, unknown>>;
  return rows.map(mapDynamicWorkflowNode);
}

export function getDynamicWorkflowNodeByKey(definitionId: string, nodeId: string): DynamicWorkflowNode | null {
  const row = db
    .prepare('SELECT * FROM dynamic_workflow_nodes WHERE definition_id = ? AND node_id = ?')
    .get(definitionId, nodeId) as Record<string, unknown> | undefined;
  return row ? mapDynamicWorkflowNode(row) : null;
}

export function updateDynamicWorkflowNodeSprintMeta(
  definitionId: string,
  nodeId: string,
  patch: DynamicWorkflowNodeSprintPatch,
): void {
  const fields: string[] = [];
  const values: unknown[] = [];
  if (patch.sprintId !== undefined) {
    fields.push('sprint_id = ?');
    values.push(patch.sprintId);
  }
  if (patch.roundIndex !== undefined) {
    fields.push('round_index = ?');
    values.push(patch.roundIndex);
  }
  if (fields.length === 0) return;
  values.push(definitionId, nodeId);
  db.prepare(`UPDATE dynamic_workflow_nodes SET ${fields.join(', ')} WHERE definition_id = ? AND node_id = ?`).run(
    ...values,
  );
}

function mapDynamicWorkflowSprint(row: Record<string, unknown>): DynamicWorkflowSprintRow {
  return {
    runId: row['run_id'] as string,
    sprintId: row['sprint_id'] as string,
    planVersion: (row['plan_version'] as number) ?? 0,
    planHash: (row['plan_hash'] as string) ?? '',
    sprintIndex: (row['sprint_index'] as number) ?? 0,
    name: (row['name'] as string) ?? '',
    coderAgentId: (row['coder_agent_id'] as string | null) ?? null,
    validatorAgentIdsJson: (row['validator_agent_ids_json'] as string) ?? '[]',
    featuresJson: (row['features_json'] as string) ?? '[]',
    writeSetHintJson: (row['write_set_hint_json'] as string) ?? '[]',
    dependenciesJson: (row['dependencies_json'] as string) ?? '[]',
    maxRounds: (row['max_rounds'] as number | null) ?? null,
    status: row['status'] as DynamicWorkflowSprintRow['status'],
    worktreePath: (row['worktree_path'] as string | null) ?? null,
    branch: (row['branch'] as string | null) ?? null,
    baseSha: (row['base_sha'] as string | null) ?? null,
    headSha: (row['head_sha'] as string | null) ?? null,
    mergeStatus: (row['merge_status'] as DynamicWorkflowSprintRow['mergeStatus'] | undefined) ?? 'pending',
    createdAt: row['created_at'] as string,
    updatedAt: row['updated_at'] as string,
  };
}

export function upsertDynamicWorkflowSprint(input: DynamicWorkflowSprintUpsertInput): DynamicWorkflowSprintRow {
  db.prepare(
    `INSERT INTO dynamic_workflow_sprints (
       run_id, sprint_id, plan_version, plan_hash, sprint_index, name,
       coder_agent_id, validator_agent_ids_json, features_json,
       write_set_hint_json, dependencies_json, max_rounds, status,
       worktree_path, branch, base_sha, head_sha, merge_status,
       created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
     ON CONFLICT(run_id, sprint_id) DO UPDATE SET
       plan_version = excluded.plan_version,
       plan_hash = excluded.plan_hash,
       sprint_index = excluded.sprint_index,
       name = excluded.name,
       coder_agent_id = excluded.coder_agent_id,
       validator_agent_ids_json = excluded.validator_agent_ids_json,
       features_json = excluded.features_json,
       write_set_hint_json = excluded.write_set_hint_json,
       dependencies_json = excluded.dependencies_json,
       max_rounds = excluded.max_rounds,
       updated_at = datetime('now')`,
  ).run(
    input.runId,
    input.sprintId,
    input.planVersion,
    input.planHash,
    input.sprintIndex,
    input.name,
    input.coderAgentId ?? null,
    JSON.stringify(input.validatorAgentIds ?? []),
    JSON.stringify(input.features ?? []),
    JSON.stringify(input.writeSetHint ?? []),
    JSON.stringify(input.dependencies ?? []),
    input.maxRounds,
    input.worktreePath ?? null,
    input.branch ?? null,
    input.baseSha ?? null,
    input.headSha ?? null,
    input.mergeStatus ?? 'pending',
  );
  return getDynamicWorkflowSprint(input.runId, input.sprintId) as DynamicWorkflowSprintRow;
}

export function getDynamicWorkflowSprint(runId: string, sprintId: string): DynamicWorkflowSprintRow | null {
  const row = db
    .prepare('SELECT * FROM dynamic_workflow_sprints WHERE run_id = ? AND sprint_id = ?')
    .get(runId, sprintId) as Record<string, unknown> | undefined;
  return row ? mapDynamicWorkflowSprint(row) : null;
}

export function listDynamicWorkflowSprints(runId: string): DynamicWorkflowSprintRow[] {
  const rows = db
    .prepare('SELECT * FROM dynamic_workflow_sprints WHERE run_id = ? ORDER BY sprint_index ASC')
    .all(runId) as Array<Record<string, unknown>>;
  return rows.map(mapDynamicWorkflowSprint);
}

export function updateDynamicWorkflowSprint(runId: string, sprintId: string, patch: DynamicWorkflowSprintPatch): void {
  const fields: string[] = [];
  const values: unknown[] = [];
  if (patch.status !== undefined) {
    fields.push('status = ?');
    values.push(patch.status);
  }
  if (patch.worktreePath !== undefined) {
    fields.push('worktree_path = ?');
    values.push(patch.worktreePath);
  }
  if (patch.branch !== undefined) {
    fields.push('branch = ?');
    values.push(patch.branch);
  }
  if (patch.baseSha !== undefined) {
    fields.push('base_sha = ?');
    values.push(patch.baseSha);
  }
  if (patch.headSha !== undefined) {
    fields.push('head_sha = ?');
    values.push(patch.headSha);
  }
  if (patch.mergeStatus !== undefined) {
    fields.push('merge_status = ?');
    values.push(patch.mergeStatus);
  }
  if (fields.length === 0) return;
  fields.push(`updated_at = datetime('now')`);
  values.push(runId, sprintId);
  db.prepare(`UPDATE dynamic_workflow_sprints SET ${fields.join(', ')} WHERE run_id = ? AND sprint_id = ?`).run(
    ...values,
  );
}

export function materializeDynamicWorkflowSprintPlan(input: MaterializeDynamicWorkflowSprintPlanInput): void {
  const tx = db.transaction((inp: MaterializeDynamicWorkflowSprintPlanInput) => {
    for (const node of inp.nodes) {
      if (getDynamicWorkflowNodeByKey(inp.definitionId, node.nodeId)) continue;
      createDynamicWorkflowNode({ ...node, definitionId: inp.definitionId });
    }
    updateDynamicWorkflowDefinition(inp.definitionId, inp.definitionPatch);
    for (const meta of inp.nodeSprintMeta) {
      updateDynamicWorkflowNodeSprintMeta(inp.definitionId, meta.nodeId, meta.patch);
    }
    for (const sprint of inp.sprints) upsertDynamicWorkflowSprint(sprint);
  });
  tx(input);
}

export function getDynamicWorkflowPriorMaterialization(
  runId: string,
  definitionId: string,
): DynamicWorkflowPriorMaterialization | null {
  const sprints = listDynamicWorkflowSprints(runId);
  if (sprints.length === 0) return null;
  let planVersion = 0;
  let planHash = '';
  for (const s of sprints) {
    if (s.planVersion >= planVersion) {
      planVersion = s.planVersion;
      planHash = s.planHash;
    }
  }
  const nodes = listDynamicWorkflowNodes(definitionId);
  const bySprint = new Map<string, string[]>();
  for (const node of nodes) {
    if (!node.sprintId) continue;
    const list = bySprint.get(node.sprintId) ?? [];
    list.push(node.nodeId);
    bySprint.set(node.sprintId, list);
  }
  const sprintNodeIds = sprints
    .filter((s) => bySprint.has(s.sprintId))
    .map((s) => ({ sprintId: s.sprintId, nodeIds: bySprint.get(s.sprintId) ?? [] }));
  return { planVersion, planHash, sprintNodeIds };
}

function mapDynamicWorkflowJournalEntry(row: Record<string, unknown>): DynamicWorkflowJournalEntry {
  return {
    runId: row['run_id'] as string,
    callIndex: row['call_index'] as number,
    callPath: row['call_path'] as string,
    primitive: row['primitive'] as DynamicWorkflowJournalPrimitive,
    nodeId: (row['node_id'] as string) ?? null,
    argHash: row['arg_hash'] as string,
    schemaRef: (row['schema_ref'] as string) ?? null,
    policyHash: (row['policy_hash'] as string) ?? null,
    agentId: (row['agent_id'] as string) ?? null,
    model: (row['model'] as string) ?? null,
    runtime: (row['runtime'] as string) ?? null,
    planHash: (row['plan_hash'] as string) ?? null,
    workflowRevision: (row['workflow_revision'] as string) ?? null,
    outputRef: (row['output_ref'] as string) ?? null,
    sideEffectKey: (row['side_effect_key'] as string) ?? null,
    createdAt: row['created_at'] as string,
  };
}

export function appendDynamicWorkflowJournalEntry(input: DynamicWorkflowJournalAppendInput): void {
  db.prepare(
    `INSERT OR REPLACE INTO dynamic_workflow_journal (
       run_id, call_index, call_path, primitive, node_id, arg_hash, schema_ref,
       policy_hash, agent_id, model, runtime, plan_hash, workflow_revision,
       output_ref, side_effect_key, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
  ).run(
    input.runId,
    input.callIndex,
    input.callPath,
    input.primitive,
    input.nodeId ?? null,
    input.argHash,
    input.schemaRef ?? null,
    input.policyHash ?? null,
    input.agentId ?? null,
    input.model ?? null,
    input.runtime ?? null,
    input.planHash ?? null,
    input.workflowRevision ?? null,
    input.outputRef ?? null,
    input.sideEffectKey ?? null,
  );
}

export function listDynamicWorkflowJournalEntries(runId: string): DynamicWorkflowJournalEntry[] {
  const rows = db
    .prepare('SELECT * FROM dynamic_workflow_journal WHERE run_id = ? ORDER BY call_index ASC')
    .all(runId) as Record<string, unknown>[];
  return rows.map(mapDynamicWorkflowJournalEntry);
}

export function truncateDynamicWorkflowJournalFrom(runId: string, fromIndex: number): void {
  db.prepare('DELETE FROM dynamic_workflow_journal WHERE run_id = ? AND call_index >= ?').run(runId, fromIndex);
}

function mapDynamicWorkflowNodeRun(row: Record<string, unknown>): DynamicWorkflowNodeRun {
  return {
    id: row['id'] as string,
    runId: row['run_id'] as string,
    nodeId: row['node_id'] as string,
    phaseId: row['phase_id'] as string,
    type: row['type'] as DynamicWorkflowNodeRun['type'],
    agentId: (row['agent_id'] as string | null) ?? null,
    status: row['status'] as DynamicWorkflowNodeRun['status'],
    attempt: (row['attempt'] as number) ?? 1,
    inputHash: (row['input_hash'] as string | null) ?? null,
    policyHash: (row['policy_hash'] as string | null) ?? null,
    policySnapshotJson: (row['policy_snapshot_json'] as string) ?? '{}',
    inputJson: (row['input_json'] as string) ?? '{}',
    outputHash: (row['output_hash'] as string | null) ?? null,
    outputJson: (row['output_json'] as string | null) ?? null,
    error: (row['error'] as string | null) ?? null,
    failureClass: (row['failure_class'] as DynamicWorkflowNodeRun['failureClass']) ?? null,
    inputTokens: (row['input_tokens'] as number) || 0,
    outputTokens: (row['output_tokens'] as number) || 0,
    cacheReadTokens: (row['cache_read_tokens'] as number) || 0,
    cacheCreationTokens: (row['cache_creation_tokens'] as number) || 0,
    costUsd: (row['cost_usd'] as number) || 0,
    costStatus: (row['cost_status'] as string | null) ?? null,
    tokenStatus: (row['token_status'] as string | null) ?? null,
    costUnknownReason: (row['cost_unknown_reason'] as string | null) ?? null,
    metricsMetadataJson: (row['metrics_metadata_json'] as string) ?? '{}',
    model: (row['model'] as string | null) ?? null,
    runtime: (row['runtime'] as string | null) ?? null,
    provider: (row['provider'] as string | null) ?? null,
    toolUses: (row['tool_uses'] as number) || 0,
    apiRequests: (row['api_requests'] as number) || 0,
    durationMs: (row['duration_ms'] as number) || 0,
    startedAt: (row['started_at'] as string | null) ?? null,
    completedAt: (row['completed_at'] as string | null) ?? null,
  };
}

export function upsertDynamicWorkflowNodeRun(input: DynamicWorkflowNodeRunUpsertInput): DynamicWorkflowNodeRun {
  db.prepare(
    `INSERT INTO dynamic_workflow_node_runs (
       id, run_id, node_id, phase_id, type, agent_id, status, attempt,
       input_hash, policy_hash, policy_snapshot_json, input_json, started_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(run_id, node_id, attempt) DO UPDATE SET
       phase_id = excluded.phase_id,
       type = excluded.type,
       agent_id = excluded.agent_id,
       status = excluded.status,
       input_hash = excluded.input_hash,
       policy_hash = excluded.policy_hash,
       policy_snapshot_json = excluded.policy_snapshot_json,
       input_json = excluded.input_json,
       started_at = COALESCE(excluded.started_at, dynamic_workflow_node_runs.started_at)`,
  ).run(
    input.id,
    input.runId,
    input.nodeId,
    input.phaseId,
    input.type,
    input.agentId ?? null,
    input.status,
    input.attempt,
    input.inputHash ?? null,
    input.policyHash ?? null,
    input.policySnapshotJson ?? '{}',
    input.inputJson ?? '{}',
    input.startedAt ?? null,
  );
  return getDynamicWorkflowNodeRunByKey(input.runId, input.nodeId, input.attempt) as DynamicWorkflowNodeRun;
}

export function getDynamicWorkflowNodeRunByKey(
  runId: string,
  nodeId: string,
  attempt: number,
): DynamicWorkflowNodeRun | null {
  const row = db
    .prepare('SELECT * FROM dynamic_workflow_node_runs WHERE run_id = ? AND node_id = ? AND attempt = ?')
    .get(runId, nodeId, attempt) as Record<string, unknown> | undefined;
  return row ? mapDynamicWorkflowNodeRun(row) : null;
}

export function listDynamicWorkflowNodeRuns(runId: string): DynamicWorkflowNodeRun[] {
  const rows = db
    .prepare(
      `SELECT * FROM dynamic_workflow_node_runs
       WHERE run_id = ?
       ORDER BY (started_at IS NULL) ASC, started_at ASC, node_id ASC, attempt ASC`,
    )
    .all(runId) as Array<Record<string, unknown>>;
  return rows.map(mapDynamicWorkflowNodeRun);
}

export function listDynamicWorkflowNodeRunAttempts(runId: string, nodeId: string): DynamicWorkflowNodeRun[] {
  const rows = db
    .prepare(
      `SELECT * FROM dynamic_workflow_node_runs
       WHERE run_id = ? AND node_id = ?
       ORDER BY attempt ASC`,
    )
    .all(runId, nodeId) as Array<Record<string, unknown>>;
  return rows.map(mapDynamicWorkflowNodeRun);
}

export function listDynamicWorkflowLatestNodeRuns(runId: string): DynamicWorkflowNodeRun[] {
  const rows = db
    .prepare(
      `SELECT nr.* FROM dynamic_workflow_node_runs nr
       JOIN (
         SELECT node_id, MAX(attempt) AS max_attempt
         FROM dynamic_workflow_node_runs
         WHERE run_id = ?
         GROUP BY node_id
       ) latest ON latest.node_id = nr.node_id AND latest.max_attempt = nr.attempt
       WHERE nr.run_id = ?
       ORDER BY (nr.started_at IS NULL) ASC, nr.started_at ASC, nr.node_id ASC`,
    )
    .all(runId, runId) as Array<Record<string, unknown>>;
  return rows.map(mapDynamicWorkflowNodeRun);
}

export function setDynamicWorkflowNodeRunStatus(id: string, status: DynamicWorkflowNodeStatus): void {
  db.prepare('UPDATE dynamic_workflow_node_runs SET status = ? WHERE id = ?').run(status, id);
}

export function updateDynamicWorkflowNodeRun(id: string, patch: DynamicWorkflowNodeRunPatch): void {
  const fields: string[] = [];
  const values: unknown[] = [];
  if (patch.status !== undefined) {
    fields.push('status = ?');
    values.push(patch.status);
  }
  if (patch.inputHash !== undefined) {
    fields.push('input_hash = ?');
    values.push(patch.inputHash);
  }
  if (patch.policyHash !== undefined) {
    fields.push('policy_hash = ?');
    values.push(patch.policyHash);
  }
  if (patch.policySnapshotJson !== undefined) {
    fields.push('policy_snapshot_json = ?');
    values.push(patch.policySnapshotJson);
  }
  if (patch.inputJson !== undefined) {
    fields.push('input_json = ?');
    values.push(patch.inputJson);
  }
  if (patch.outputHash !== undefined) {
    fields.push('output_hash = ?');
    values.push(patch.outputHash);
  }
  if (patch.outputJson !== undefined) {
    fields.push('output_json = ?');
    values.push(patch.outputJson);
  }
  if (patch.error !== undefined) {
    fields.push('error = ?');
    values.push(patch.error);
  }
  if (patch.failureClass !== undefined) {
    fields.push('failure_class = ?');
    values.push(patch.failureClass);
  }
  if (patch.inputTokens !== undefined) {
    fields.push('input_tokens = ?');
    values.push(patch.inputTokens);
  }
  if (patch.outputTokens !== undefined) {
    fields.push('output_tokens = ?');
    values.push(patch.outputTokens);
  }
  if (patch.cacheReadTokens !== undefined) {
    fields.push('cache_read_tokens = ?');
    values.push(patch.cacheReadTokens);
  }
  if (patch.cacheCreationTokens !== undefined) {
    fields.push('cache_creation_tokens = ?');
    values.push(patch.cacheCreationTokens);
  }
  if (patch.costUsd !== undefined) {
    fields.push('cost_usd = ?');
    values.push(patch.costUsd);
  }
  if (patch.costStatus !== undefined) {
    fields.push('cost_status = ?');
    values.push(patch.costStatus);
  }
  if (patch.tokenStatus !== undefined) {
    fields.push('token_status = ?');
    values.push(patch.tokenStatus);
  }
  if (patch.costUnknownReason !== undefined) {
    fields.push('cost_unknown_reason = ?');
    values.push(patch.costUnknownReason);
  }
  if (patch.metricsMetadataJson !== undefined) {
    fields.push('metrics_metadata_json = ?');
    values.push(patch.metricsMetadataJson);
  }
  if (patch.model !== undefined) {
    fields.push('model = ?');
    values.push(patch.model);
  }
  if (patch.runtime !== undefined) {
    fields.push('runtime = ?');
    values.push(patch.runtime);
  }
  if (patch.provider !== undefined) {
    fields.push('provider = ?');
    values.push(patch.provider);
  }
  if (patch.toolUses !== undefined) {
    fields.push('tool_uses = ?');
    values.push(patch.toolUses);
  }
  if (patch.apiRequests !== undefined) {
    fields.push('api_requests = ?');
    values.push(patch.apiRequests);
  }
  if (patch.durationMs !== undefined) {
    fields.push('duration_ms = ?');
    values.push(patch.durationMs);
  }
  if (patch.startedAt !== undefined) {
    fields.push('started_at = ?');
    values.push(patch.startedAt);
  }
  if (patch.completedAt !== undefined) {
    fields.push('completed_at = ?');
    values.push(patch.completedAt);
  }
  if (fields.length === 0) return;
  values.push(id);
  db.prepare(`UPDATE dynamic_workflow_node_runs SET ${fields.join(', ')} WHERE id = ?`).run(...values);
}

function mapDynamicWorkflowEvent(row: Record<string, unknown>): DynamicWorkflowEvent {
  return {
    id: row['id'] as number,
    runId: row['run_id'] as string,
    nodeId: (row['node_id'] as string | null) ?? null,
    phaseId: (row['phase_id'] as string | null) ?? null,
    seq: row['seq'] as number,
    type: row['type'] as string,
    payloadJson: (row['payload_json'] as string) ?? '{}',
    createdAt: row['created_at'] as string,
  };
}

export function insertDynamicWorkflowEvent(input: DynamicWorkflowEventInsertInput): DynamicWorkflowEvent {
  const tx = db.transaction((inp: DynamicWorkflowEventInsertInput): DynamicWorkflowEvent => {
    const next = db
      .prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM dynamic_workflow_events WHERE run_id = ?')
      .get(inp.runId) as { next: number };
    const result = db
      .prepare(
        `INSERT INTO dynamic_workflow_events (run_id, node_id, phase_id, seq, type, payload_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
      )
      .run(inp.runId, inp.nodeId ?? null, inp.phaseId ?? null, next.next, inp.type, inp.payloadJson ?? '{}');
    const row = db
      .prepare('SELECT * FROM dynamic_workflow_events WHERE id = ?')
      .get(Number(result.lastInsertRowid)) as Record<string, unknown>;
    return mapDynamicWorkflowEvent(row);
  });
  return tx(input);
}

export function listDynamicWorkflowEvents(runId: string, opts?: DynamicWorkflowEventsQuery): DynamicWorkflowEvent[] {
  const built = buildDynamicWorkflowEventsQuery(runId, opts);
  const rows = db.prepare(built.sql).all(...built.params) as Array<Record<string, unknown>>;
  return rows.map(mapDynamicWorkflowEvent);
}

export function listDynamicWorkflowRecentEvents(runId: string, limit: number): DynamicWorkflowEvent[] {
  const rows = db
    .prepare(
      `SELECT * FROM (
         SELECT * FROM dynamic_workflow_events WHERE run_id = ? ORDER BY seq DESC LIMIT ?
       ) ORDER BY seq ASC`,
    )
    .all(runId, limit) as Array<Record<string, unknown>>;
  return rows.map(mapDynamicWorkflowEvent);
}

function mapDynamicWorkflowMessage(row: Record<string, unknown>): DynamicWorkflowMessage {
  return {
    id: row['id'] as number,
    runId: row['run_id'] as string,
    nodeId: (row['node_id'] as string | null) ?? null,
    role: row['role'] as string,
    source: row['source'] as DynamicWorkflowMessage['source'],
    kind: row['kind'] as string,
    content: (row['content'] as string) ?? '',
    toolCallsJson: (row['tool_calls_json'] as string | null) ?? null,
    agentId: (row['agent_id'] as string | null) ?? null,
    createdAt: row['created_at'] as string,
    appliedNodeId: (row['applied_node_id'] as string | null | undefined) ?? null,
    consumedAt: (row['consumed_at'] as string | null | undefined) ?? null,
  };
}

export function claimAdjustmentsForNode(runId: string, nodeId: string): DynamicWorkflowMessage[] {
  if (!runId || !nodeId) return [];
  const tx = db.transaction((rid: string, nid: string): DynamicWorkflowMessage[] => {
    const claim = db.prepare(
      `UPDATE dynamic_workflow_messages
          SET applied_node_id = ?, consumed_at = datetime('now')
        WHERE run_id = ? AND kind IN ('adjustment', 'agent-switch') AND node_id = ? AND consumed_at IS NULL
        RETURNING *`,
    );
    const exact = claim.all(nid, rid, nid) as Array<Record<string, unknown>>;
    const wildcard = claim.all(nid, rid, '*') as Array<Record<string, unknown>>;
    return [...exact, ...wildcard].map(mapDynamicWorkflowMessage).sort((a, b) => a.id - b.id);
  });
  return tx(runId, nodeId);
}

export function getConsumedAdjustmentsForNode(runId: string, nodeId: string): DynamicWorkflowMessage[] {
  if (!runId || !nodeId) return [];
  const rows = db
    .prepare(
      `SELECT * FROM dynamic_workflow_messages
        WHERE run_id = ? AND kind IN ('adjustment', 'agent-switch') AND applied_node_id = ? AND consumed_at IS NOT NULL
        ORDER BY id ASC`,
    )
    .all(runId, nodeId) as Array<Record<string, unknown>>;
  return rows.map(mapDynamicWorkflowMessage);
}

export function insertDynamicWorkflowMessage(input: DynamicWorkflowMessageInsertInput): DynamicWorkflowMessage {
  const result = db
    .prepare(
      `INSERT INTO dynamic_workflow_messages (run_id, node_id, role, source, kind, content, tool_calls_json, agent_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
    )
    .run(
      input.runId,
      input.nodeId ?? null,
      input.role,
      input.source,
      input.kind,
      input.content,
      input.toolCallsJson ?? null,
      input.agentId ?? null,
    );
  const row = db
    .prepare('SELECT * FROM dynamic_workflow_messages WHERE id = ?')
    .get(Number(result.lastInsertRowid)) as Record<string, unknown>;
  return mapDynamicWorkflowMessage(row);
}

export function listDynamicWorkflowMessages(runId: string): DynamicWorkflowMessage[] {
  const rows = db
    .prepare(
      `SELECT * FROM dynamic_workflow_messages
       WHERE run_id = ?
       ORDER BY created_at ASC, id ASC`,
    )
    .all(runId) as Array<Record<string, unknown>>;
  return rows.map(mapDynamicWorkflowMessage);
}

function mapDynamicWorkflowArtifact(row: Record<string, unknown>): DynamicWorkflowArtifact {
  return {
    id: row['id'] as string,
    runId: row['run_id'] as string,
    nodeId: (row['node_id'] as string | null) ?? null,
    kind: row['kind'] as string,
    path: row['path'] as string,
    sha256: row['sha256'] as string,
    metadataJson: (row['metadata_json'] as string) ?? '{}',
    createdAt: row['created_at'] as string,
  };
}

export function insertDynamicWorkflowArtifact(input: DynamicWorkflowArtifactInsertInput): DynamicWorkflowArtifact {
  db.prepare(
    `INSERT INTO dynamic_workflow_artifacts (id, run_id, node_id, kind, path, sha256, metadata_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
  ).run(input.id, input.runId, input.nodeId ?? null, input.kind, input.path, input.sha256, input.metadataJson ?? '{}');
  const row = db.prepare('SELECT * FROM dynamic_workflow_artifacts WHERE id = ?').get(input.id) as Record<
    string,
    unknown
  >;
  return mapDynamicWorkflowArtifact(row);
}

export function listDynamicWorkflowArtifacts(runId: string): DynamicWorkflowArtifact[] {
  const rows = db
    .prepare(
      `SELECT * FROM dynamic_workflow_artifacts
       WHERE run_id = ?
       ORDER BY created_at ASC, id ASC`,
    )
    .all(runId) as Array<Record<string, unknown>>;
  return rows.map(mapDynamicWorkflowArtifact);
}

function mapDynamicWorkflowGateDecision(row: Record<string, unknown>): DynamicWorkflowGateDecision {
  return {
    id: row['id'] as string,
    runId: row['run_id'] as string,
    gateId: row['gate_id'] as string,
    nodeId: (row['node_id'] as string | null) ?? null,
    mode: row['mode'] as DynamicWorkflowGateDecision['mode'],
    decision: row['decision'] as DynamicWorkflowGateDecision['decision'],
    decidedBy: row['decided_by'] as string,
    reason: (row['reason'] as string | null) ?? null,
    payloadJson: (row['payload_json'] as string) ?? '{}',
    createdAt: row['created_at'] as string,
  };
}

export function insertDynamicWorkflowGateDecision(
  input: DynamicWorkflowGateDecisionInsertInput,
): DynamicWorkflowGateDecision {
  db.prepare(
    `INSERT INTO dynamic_workflow_gate_decisions (id, run_id, gate_id, node_id, mode, decision, decided_by, reason, payload_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
  ).run(
    input.id,
    input.runId,
    input.gateId,
    input.nodeId ?? null,
    input.mode,
    input.decision,
    input.decidedBy,
    input.reason ?? null,
    input.payloadJson ?? '{}',
  );
  const row = db.prepare('SELECT * FROM dynamic_workflow_gate_decisions WHERE id = ?').get(input.id) as Record<
    string,
    unknown
  >;
  return mapDynamicWorkflowGateDecision(row);
}

export function listDynamicWorkflowGateDecisions(runId: string): DynamicWorkflowGateDecision[] {
  const rows = db
    .prepare(
      `SELECT * FROM dynamic_workflow_gate_decisions
       WHERE run_id = ?
       ORDER BY created_at ASC, id ASC`,
    )
    .all(runId) as Array<Record<string, unknown>>;
  return rows.map(mapDynamicWorkflowGateDecision);
}

interface DynamicWorkflowCostAggregateRow {
  total_cost_usd: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_creation_tokens: number | null;
  total_duration_ms: number | null;
  node_run_count: number | null;
  unknown_cost_node_runs: number | null;
}

export function getDynamicWorkflowRunCostAggregate(runId: string): DynamicWorkflowRunCostAggregate {
  const row = db
    .prepare(
      `SELECT
         COALESCE(SUM(cost_usd), 0) AS total_cost_usd,
         COALESCE(SUM(input_tokens), 0) AS input_tokens,
         COALESCE(SUM(output_tokens), 0) AS output_tokens,
         COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
         COALESCE(SUM(cache_creation_tokens), 0) AS cache_creation_tokens,
         COALESCE(SUM(duration_ms), 0) AS total_duration_ms,
         COUNT(*) AS node_run_count,
         COALESCE(SUM(CASE WHEN cost_status = 'unknown' THEN 1 ELSE 0 END), 0) AS unknown_cost_node_runs
       FROM dynamic_workflow_node_runs
       WHERE run_id = ?`,
    )
    .get(runId) as DynamicWorkflowCostAggregateRow;
  return {
    runId,
    totalCostUsd: row.total_cost_usd ?? 0,
    inputTokens: row.input_tokens ?? 0,
    outputTokens: row.output_tokens ?? 0,
    cacheReadTokens: row.cache_read_tokens ?? 0,
    cacheCreationTokens: row.cache_creation_tokens ?? 0,
    totalDurationMs: row.total_duration_ms ?? 0,
    nodeRunCount: row.node_run_count ?? 0,
    unknownCostNodeRuns: row.unknown_cost_node_runs ?? 0,
  };
}

interface DynamicWorkflowPhaseAggregateRow {
  phase_id: string;
  cost_usd: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  duration_ms: number | null;
  node_run_count: number | null;
}

export function listDynamicWorkflowPhaseCostAggregates(runId: string): DynamicWorkflowPhaseCostAggregate[] {
  const rows = db
    .prepare(
      `SELECT
         phase_id,
         COALESCE(SUM(cost_usd), 0) AS cost_usd,
         COALESCE(SUM(input_tokens), 0) AS input_tokens,
         COALESCE(SUM(output_tokens), 0) AS output_tokens,
         COALESCE(SUM(duration_ms), 0) AS duration_ms,
         COUNT(*) AS node_run_count
       FROM dynamic_workflow_node_runs
       WHERE run_id = ?
       GROUP BY phase_id`,
    )
    .all(runId) as DynamicWorkflowPhaseAggregateRow[];
  return rows.map((row) => ({
    phaseId: row.phase_id,
    costUsd: row.cost_usd ?? 0,
    inputTokens: row.input_tokens ?? 0,
    outputTokens: row.output_tokens ?? 0,
    durationMs: row.duration_ms ?? 0,
    nodeRunCount: row.node_run_count ?? 0,
  }));
}

function mapKanbanBoard(row: Record<string, unknown>): KanbanBoard {
  return {
    id: row['id'] as string,
    repositoryId: row['repository_id'] as string,
    name: row['name'] as string,
    prefix: row['prefix'] as string,
    nextLocalId: row['next_local_id'] as number,
    createdAt: row['created_at'] as string,
  };
}

function mapKanbanCard(row: Record<string, unknown>): KanbanCard {
  return {
    id: row['id'] as number,
    boardId: row['board_id'] as string,
    boardPrefix: row['board_prefix'] as string,
    localId: row['local_id'] as number,
    title: row['title'] as string,
    boardColumn: row['board_column'] as KanbanColumnId,
    type: (row['type'] as KanbanCard['type']) ?? null,
    priority: (row['priority'] as KanbanCard['priority']) ?? null,
    complexity: (row['complexity'] as KanbanCard['complexity']) ?? null,
    severity: (row['severity'] as KanbanCard['severity']) ?? null,
    problem: (row['problem'] as string | null) ?? null,
    acceptanceCriteria: (row['acceptance_criteria'] as string | null) ?? null,
    reproduction: (row['reproduction'] as string | null) ?? null,
    acceptanceTests: (row['acceptance_tests'] as string | null) ?? null,
    commitUrl: (row['commit_url'] as string | null) ?? null,
    docRef: (row['doc_ref'] as string | null) ?? null,
    startDate: (row['start_date'] as string | null) ?? null,
    dueDate: (row['due_date'] as string | null) ?? null,
    body: (row['body'] as string | null) ?? null,
    archived: Boolean(row['archived']),
    createdAt: row['created_at'] as string,
    updatedAt: row['updated_at'] as string,
    stalledDays: (row['stalled_days'] as number | null) ?? 0,
    attachmentCount: (row['attachment_count'] as number | null) ?? 0,
  };
}

function mapKanbanEvent(row: Record<string, unknown>): KanbanCardEvent {
  return {
    id: row['id'] as number,
    cardId: row['card_id'] as number,
    event: row['event'] as KanbanCardEvent['event'],
    fromColumn: (row['from_column'] as KanbanCardEvent['fromColumn']) ?? null,
    toColumn: (row['to_column'] as KanbanCardEvent['toColumn']) ?? null,
    reason: (row['reason'] as string | null) ?? null,
    actor: row['actor'] as KanbanCardEvent['actor'],
    actorDetail: (row['actor_detail'] as string | null) ?? null,
    createdAt: row['created_at'] as string,
  };
}

function mapKanbanAttachment(row: Record<string, unknown>): KanbanAttachment {
  return {
    id: row['id'] as string,
    cardId: row['card_id'] as number,
    filename: row['filename'] as string,
    storedPath: row['stored_path'] as string,
    mime: (row['mime'] as string | null) ?? null,
    sizeBytes: (row['size_bytes'] as number | null) ?? null,
    createdAt: row['created_at'] as string,
  };
}

const KANBAN_STALLED_DAYS_SQL = `
  CAST(julianday('now') - julianday((
    SELECT MAX(e.created_at) FROM kanban_card_events e
    WHERE e.card_id = c.id
      AND e.event IN ('created','moved','delivered','reopened')
      AND e.to_column = c.board_column
  )) AS INTEGER)`;

const KANBAN_CARD_SELECT = `
  SELECT c.*, b.prefix AS board_prefix, ${KANBAN_STALLED_DAYS_SQL} AS stalled_days,
    (SELECT COUNT(*) FROM kanban_card_attachments a WHERE a.card_id = c.id) AS attachment_count
  FROM kanban_cards c
  JOIN kanban_boards b ON b.id = c.board_id`;

export function insertKanbanBoard(input: {
  id: string;
  repositoryId: string;
  name: string;
  prefix: string;
}): KanbanBoard {
  db.prepare(
    `INSERT INTO kanban_boards (id, repository_id, name, prefix)
     VALUES (?, ?, ?, ?)`,
  ).run(input.id, input.repositoryId, input.name, input.prefix);
  return getKanbanBoard(input.id) as KanbanBoard;
}

export function getKanbanBoard(id: string): KanbanBoard | null {
  const row = db.prepare('SELECT * FROM kanban_boards WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return row ? mapKanbanBoard(row) : null;
}

export function getKanbanBoardByPrefix(prefix: string): KanbanBoard | null {
  const row = db.prepare('SELECT * FROM kanban_boards WHERE prefix = ?').get(prefix) as
    Record<string, unknown> | undefined;
  return row ? mapKanbanBoard(row) : null;
}

export function getKanbanBoardByRepositoryId(repositoryId: string): KanbanBoard | null {
  const row = db.prepare('SELECT * FROM kanban_boards WHERE repository_id = ?').get(repositoryId) as
    Record<string, unknown> | undefined;
  return row ? mapKanbanBoard(row) : null;
}

export function listKanbanBoards(): KanbanBoard[] {
  const rows = db.prepare('SELECT * FROM kanban_boards ORDER BY created_at ASC').all() as Array<
    Record<string, unknown>
  >;
  return rows.map(mapKanbanBoard);
}

export function getKanbanBoardColumnCounts(boardId: string): Record<KanbanColumnId, number> {
  const rows = db
    .prepare(
      `SELECT board_column, COUNT(*) AS n FROM kanban_cards
       WHERE board_id = ? AND archived = 0 GROUP BY board_column`,
    )
    .all(boardId) as Array<{ board_column: KanbanColumnId; n: number }>;
  const counts: Record<KanbanColumnId, number> = {
    Backlog: 0,
    Desenvolvimento: 0,
    Testes: 0,
    Done: 0,
  };
  for (const row of rows) counts[row.board_column] = row.n;
  return counts;
}

export function deleteKanbanBoard(id: string): void {
  db.prepare('DELETE FROM kanban_boards WHERE id = ?').run(id);
}

export interface KanbanCardRowInput {
  boardId: string;
  title: string;
  boardColumn: KanbanColumnId;
  type: string | null;
  priority: string | null;
  complexity: string | null;
  severity: string | null;
  problem: string | null;
  acceptanceCriteria: string | null;
  reproduction: string | null;
  acceptanceTests: string | null;
  commitUrl: string | null;
  docRef: string | null;
  startDate: string | null;
  dueDate: string | null;
  body: string | null;
}

export interface KanbanEventInput {
  event: KanbanCardEvent['event'];
  fromColumn?: string | null;
  toColumn?: string | null;
  reason?: string | null;
  actor: KanbanActor;
  actorDetail?: string | null;
}

function insertKanbanEventRow(cardId: number, event: KanbanEventInput): void {
  db.prepare(
    `INSERT INTO kanban_card_events (card_id, event, from_column, to_column, reason, actor, actor_detail)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    cardId,
    event.event,
    event.fromColumn ?? null,
    event.toColumn ?? null,
    event.reason ?? null,
    event.actor,
    event.actorDetail ?? null,
  );
}

export function insertKanbanCardWithEvent(input: KanbanCardRowInput, event: KanbanEventInput): KanbanCard {
  const run = db.transaction(() => {
    const board = db.prepare('SELECT next_local_id FROM kanban_boards WHERE id = ?').get(input.boardId) as
      { next_local_id: number } | undefined;
    if (!board) throw new Error(`quadro nao encontrado: ${input.boardId}`);
    const localId = board.next_local_id;
    db.prepare('UPDATE kanban_boards SET next_local_id = next_local_id + 1 WHERE id = ?').run(input.boardId);
    const result = db
      .prepare(
        `INSERT INTO kanban_cards (
           board_id, local_id, title, board_column, type, priority, complexity,
           severity, problem, acceptance_criteria, reproduction, acceptance_tests,
           commit_url, doc_ref, start_date, due_date, body
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.boardId,
        localId,
        input.title,
        input.boardColumn,
        input.type,
        input.priority,
        input.complexity,
        input.severity,
        input.problem,
        input.acceptanceCriteria,
        input.reproduction,
        input.acceptanceTests,
        input.commitUrl,
        input.docRef,
        input.startDate,
        input.dueDate,
        input.body,
      );
    const cardId = Number(result.lastInsertRowid);
    insertKanbanEventRow(cardId, event);
    return cardId;
  });
  const cardId = run();
  return getKanbanCardById(cardId) as KanbanCard;
}

export interface KanbanCardRowPatch {
  title?: string;
  boardColumn?: KanbanColumnId;
  type?: string | null;
  priority?: string | null;
  complexity?: string | null;
  severity?: string | null;
  problem?: string | null;
  acceptanceCriteria?: string | null;
  reproduction?: string | null;
  acceptanceTests?: string | null;
  commitUrl?: string | null;
  docRef?: string | null;
  startDate?: string | null;
  dueDate?: string | null;
  body?: string | null;
  archived?: boolean;
}

const KANBAN_PATCH_COLUMNS: Array<[keyof KanbanCardRowPatch, string]> = [
  ['title', 'title'],
  ['boardColumn', 'board_column'],
  ['type', 'type'],
  ['priority', 'priority'],
  ['complexity', 'complexity'],
  ['severity', 'severity'],
  ['problem', 'problem'],
  ['acceptanceCriteria', 'acceptance_criteria'],
  ['reproduction', 'reproduction'],
  ['acceptanceTests', 'acceptance_tests'],
  ['commitUrl', 'commit_url'],
  ['docRef', 'doc_ref'],
  ['startDate', 'start_date'],
  ['dueDate', 'due_date'],
  ['body', 'body'],
];

export function updateKanbanCardWithEvents(
  cardId: number,
  patch: KanbanCardRowPatch,
  events: KanbanEventInput[],
): KanbanCard {
  const run = db.transaction(() => {
    const fields: string[] = [];
    const values: unknown[] = [];
    for (const [key, column] of KANBAN_PATCH_COLUMNS) {
      if (key !== 'archived' && patch[key] !== undefined) {
        fields.push(`${column} = ?`);
        values.push(patch[key]);
      }
    }
    if (patch.archived !== undefined) {
      fields.push('archived = ?');
      values.push(patch.archived ? 1 : 0);
    }
    fields.push(`updated_at = datetime('now')`);
    values.push(cardId);
    const result = db.prepare(`UPDATE kanban_cards SET ${fields.join(', ')} WHERE id = ?`).run(...values);
    if (result.changes === 0) throw new Error(`card nao encontrado: ${cardId}`);
    for (const event of events) insertKanbanEventRow(cardId, event);
  });
  run();
  return getKanbanCardById(cardId) as KanbanCard;
}

export function getKanbanCardById(id: number): KanbanCard | null {
  const row = db.prepare(`${KANBAN_CARD_SELECT} WHERE c.id = ?`).get(id) as Record<string, unknown> | undefined;
  return row ? mapKanbanCard(row) : null;
}

export function getKanbanCardByLocalId(boardId: string, localId: number): KanbanCard | null {
  const row = db.prepare(`${KANBAN_CARD_SELECT} WHERE c.board_id = ? AND c.local_id = ?`).get(boardId, localId) as
    Record<string, unknown> | undefined;
  return row ? mapKanbanCard(row) : null;
}

export function deleteKanbanCard(id: number): void {
  db.prepare('DELETE FROM kanban_cards WHERE id = ?').run(id);
}

export function listKanbanCardEvents(cardId: number): KanbanCardEvent[] {
  const rows = db
    .prepare('SELECT * FROM kanban_card_events WHERE card_id = ? ORDER BY created_at ASC, id ASC')
    .all(cardId) as Array<Record<string, unknown>>;
  return rows.map(mapKanbanEvent);
}

export interface KanbanCardQuery {
  boardId?: string;
  column?: KanbanColumnId;
  type?: string;
  priority?: string;
  severity?: string;
  text?: string;
  textRef?: { prefix: string; localId: number };
  dueBefore?: string;
  stalledDays?: number;
  archived: boolean;
}

export function queryKanbanCards(query: KanbanCardQuery): KanbanCard[] {
  const where: string[] = ['c.archived = ?'];
  const values: unknown[] = [query.archived ? 1 : 0];
  if (query.boardId) {
    where.push('c.board_id = ?');
    values.push(query.boardId);
  }
  if (query.column) {
    where.push('c.board_column = ?');
    values.push(query.column);
  }
  if (query.type) {
    where.push('c.type = ?');
    values.push(query.type);
  }
  if (query.priority) {
    where.push('c.priority = ?');
    values.push(query.priority);
  }
  if (query.severity) {
    where.push('c.severity = ?');
    values.push(query.severity);
  }
  if (query.text) {
    const clauses = [`c.title LIKE '%' || ? || '%'`, `c.problem LIKE '%' || ? || '%'`, `c.body LIKE '%' || ? || '%'`];
    values.push(query.text, query.text, query.text);
    if (query.textRef) {
      clauses.push('(b.prefix = ? AND c.local_id = ?)');
      values.push(query.textRef.prefix, query.textRef.localId);
    }
    where.push(`(${clauses.join(' OR ')})`);
  }
  if (query.dueBefore) {
    where.push('c.due_date IS NOT NULL AND c.due_date < ?');
    values.push(query.dueBefore);
  }
  if (query.stalledDays !== undefined) {
    where.push(`${KANBAN_STALLED_DAYS_SQL} >= ?`);
    values.push(query.stalledDays);
  }
  const rows = db
    .prepare(
      `${KANBAN_CARD_SELECT}
       WHERE ${where.join(' AND ')}
       ORDER BY
         CASE c.board_column
           WHEN 'Backlog' THEN 0 WHEN 'Desenvolvimento' THEN 1
           WHEN 'Testes' THEN 2 WHEN 'Done' THEN 3 END,
         CASE c.priority
           WHEN 'Crítica' THEN 0 WHEN 'Alta' THEN 1
           WHEN 'Média' THEN 2 WHEN 'Baixa' THEN 3 ELSE 4 END,
         c.created_at ASC, c.id ASC`,
    )
    .all(...values) as Array<Record<string, unknown>>;
  return rows.map(mapKanbanCard);
}

export function insertKanbanCardAttachmentWithEvent(
  input: {
    id: string;
    cardId: number;
    filename: string;
    storedPath: string;
    mime: string | null;
    sizeBytes: number | null;
  },
  event: KanbanEventInput,
): KanbanAttachment {
  const run = db.transaction(() => {
    db.prepare(
      `INSERT INTO kanban_card_attachments (id, card_id, filename, stored_path, mime, size_bytes)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(input.id, input.cardId, input.filename, input.storedPath, input.mime, input.sizeBytes);
    insertKanbanEventRow(input.cardId, event);
  });
  run();
  return getKanbanCardAttachment(input.id) as KanbanAttachment;
}

export function deleteKanbanCardAttachmentWithEvent(attachmentId: string, event: KanbanEventInput): void {
  const attachment = getKanbanCardAttachment(attachmentId);
  if (!attachment) return;
  const run = db.transaction(() => {
    db.prepare('DELETE FROM kanban_card_attachments WHERE id = ?').run(attachmentId);
    insertKanbanEventRow(attachment.cardId, event);
  });
  run();
}

export function getKanbanCardAttachment(id: string): KanbanAttachment | null {
  const row = db.prepare('SELECT * FROM kanban_card_attachments WHERE id = ?').get(id) as
    Record<string, unknown> | undefined;
  return row ? mapKanbanAttachment(row) : null;
}

export function listKanbanCardAttachments(cardId: number): KanbanAttachment[] {
  const rows = db
    .prepare('SELECT * FROM kanban_card_attachments WHERE card_id = ? ORDER BY created_at ASC')
    .all(cardId) as Array<Record<string, unknown>>;
  return rows.map(mapKanbanAttachment);
}

export function upsertSwarmRunIndex(summary: SwarmRunSummary, dbh: Database.Database = db): void {
  dbh
    .prepare(
      `INSERT INTO swarm_runs (run_id,session_id,revision,created_at,summary_json)
    VALUES (?,?,?,?,?) ON CONFLICT(run_id) DO UPDATE SET
      revision=excluded.revision,summary_json=excluded.summary_json
    WHERE excluded.revision > swarm_runs.revision AND excluded.session_id = swarm_runs.session_id`,
    )
    .run(summary.runId, summary.chatSessionId, summary.revision, summary.createdAt, JSON.stringify(summary));
}

export function listSwarmRunIndex(
  sessionId: string,
  cursor?: string,
  limit = 20,
  dbh: Database.Database = db,
): {
  runs: SwarmRunSummary[];
  nextCursor: string | null;
} {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new Error('Limite Swarm deve ser inteiro entre 1 e 100.');
  let after: { created_at: string; run_id: string } | undefined;
  if (cursor) {
    after = dbh
      .prepare('SELECT created_at,run_id FROM swarm_runs WHERE session_id=? AND run_id=?')
      .get(sessionId, cursor) as typeof after;
    if (!after) throw new Error('Cursor Swarm inválido para esta sessão.');
  }
  const rows = (
    after
      ? dbh
          .prepare(
            `SELECT summary_json FROM swarm_runs WHERE session_id=? AND
        (created_at < ? OR (created_at = ? AND run_id < ?)) ORDER BY created_at DESC,run_id DESC LIMIT ?`,
          )
          .all(sessionId, after.created_at, after.created_at, after.run_id, limit + 1)
      : dbh
          .prepare(
            'SELECT summary_json FROM swarm_runs WHERE session_id=? ORDER BY created_at DESC,run_id DESC LIMIT ?',
          )
          .all(sessionId, limit + 1)
  ) as Array<{ summary_json: string }>;
  const runs = rows.slice(0, limit).map((row) => JSON.parse(row.summary_json) as SwarmRunSummary);
  return { runs, nextCursor: rows.length > limit ? runs[runs.length - 1].runId : null };
}

export interface SwarmDelivery {
  runId: string;
  terminalRevision: number;
  sessionId: string;
  envelope: string;
  runStatus: Extract<SwarmRunStatus, 'done' | 'partial' | 'failed' | 'aborted'>;
  state: 'pending' | 'claimed' | 'delivered' | 'undeliverable';
  claimId: string | null;
  error: string | null;
}
function mapSwarmDelivery(row: Record<string, unknown>): SwarmDelivery {
  return {
    runId: row.run_id as string,
    terminalRevision: row.terminal_revision as number,
    sessionId: row.session_id as string,
    envelope: row.envelope as string,
    runStatus: row.run_status as SwarmDelivery['runStatus'],
    state: row.state as SwarmDelivery['state'],
    claimId: row.claim_id as string | null,
    error: row.error as string | null,
  };
}
export function getSwarmDelivery(
  runId: string,
  terminalRevision: number,
  dbh: Database.Database = db,
): SwarmDelivery | undefined {
  const row = dbh
    .prepare('SELECT * FROM swarm_delivery_outbox WHERE run_id=? AND terminal_revision=?')
    .get(runId, terminalRevision) as Record<string, unknown> | undefined;
  return row ? mapSwarmDelivery(row) : undefined;
}
export function enqueueSwarmDelivery(
  runId: string,
  terminalRevision: number,
  sessionId: string,
  envelope: string,
  status: SwarmRunStatus,
  dbh: Database.Database = db,
): SwarmDelivery {
  return dbh.transaction(() => {
    dbh
      .prepare(
        `INSERT OR IGNORE INTO swarm_delivery_outbox
      (run_id,terminal_revision,session_id,envelope,run_status) VALUES (?,?,?,?,?)`,
      )
      .run(runId, terminalRevision, sessionId, envelope, status);
    const delivery = getSwarmDelivery(runId, terminalRevision, dbh);
    if (
      !delivery ||
      delivery.sessionId !== sessionId ||
      delivery.envelope !== envelope ||
      delivery.runStatus !== status
    ) {
      throw new Error('Conflito na identidade imutável da entrega Swarm.');
    }
    return delivery;
  })();
}
export function getPendingSwarmDeliveries(dbh: Database.Database = db): SwarmDelivery[] {
  return (
    dbh.prepare("SELECT * FROM swarm_delivery_outbox WHERE state='pending' ORDER BY created_at,run_id").all() as Record<
      string,
      unknown
    >[]
  ).map(mapSwarmDelivery);
}
export function recoverSwarmDeliveryClaims(dbh: Database.Database = db): number {
  return dbh
    .prepare(
      `UPDATE swarm_delivery_outbox SET state='pending',claim_id=NULL,updated_at=CURRENT_TIMESTAMP
    WHERE state='claimed'`,
    )
    .run().changes;
}
export function claimSwarmDelivery(
  runId: string,
  terminalRevision: number,
  claimId: string,
  dbh: Database.Database = db,
): SwarmDelivery | undefined {
  if (!claimId) throw new Error('Claim Swarm vazio.');
  return dbh.transaction(() => {
    const result = dbh
      .prepare(
        `UPDATE swarm_delivery_outbox SET state='claimed',claim_id=?,error=NULL,updated_at=CURRENT_TIMESTAMP
      WHERE run_id=? AND terminal_revision=? AND state='pending'`,
      )
      .run(claimId, runId, terminalRevision);
    return result.changes ? getSwarmDelivery(runId, terminalRevision, dbh) : undefined;
  })();
}
export function releaseSwarmDelivery(
  runId: string,
  terminalRevision: number,
  claimId: string,
  error?: string,
  dbh: Database.Database = db,
): boolean {
  return (
    dbh
      .prepare(
        `UPDATE swarm_delivery_outbox SET state='pending',claim_id=NULL,error=?,updated_at=CURRENT_TIMESTAMP
    WHERE run_id=? AND terminal_revision=? AND state='claimed' AND claim_id=?`,
      )
      .run(error ?? null, runId, terminalRevision, claimId).changes === 1
  );
}
export function completeSwarmDelivery(
  runId: string,
  terminalRevision: number,
  claimId: string,
  status: 'delivered' | 'undeliverable',
  reason?: string,
  dbh: Database.Database = db,
): boolean {
  if (status === 'delivered') {
    const delivery = getSwarmDelivery(runId, terminalRevision, dbh);
    const kind = delivery?.runStatus === 'aborted' ? 'event' : 'response';
    if (
      !dbh
        .prepare('SELECT 1 FROM swarm_chat_receipts WHERE run_id=? AND terminal_revision=? AND kind=?')
        .get(runId, terminalRevision, kind)
    )
      throw new Error('Entrega Swarm sem mensagem final persistida.');
  }
  return (
    dbh
      .prepare(
        `UPDATE swarm_delivery_outbox SET state=?,claim_id=NULL,error=?,updated_at=CURRENT_TIMESTAMP
    WHERE run_id=? AND terminal_revision=? AND state='claimed' AND claim_id=?`,
      )
      .run(status, reason ?? null, runId, terminalRevision, claimId).changes === 1
  );
}

export function persistSwarmChatMessageOnce(
  input: {
    sessionId: string;
    runId: string;
    terminalRevision: number;
    kind: 'event' | 'response';
    content: string;
    claimId?: string;
    metadata?: string;
  },
  dbh: Database.Database = db,
): { messageId: number; inserted: boolean } {
  return dbh.transaction(() => {
    const delivery = getSwarmDelivery(input.runId, input.terminalRevision, dbh);
    if (!delivery || delivery.sessionId !== input.sessionId) throw new Error('Entrega Swarm não pertence à sessão.');
    const prior = dbh
      .prepare('SELECT message_id FROM swarm_chat_receipts WHERE run_id=? AND terminal_revision=? AND kind=?')
      .get(input.runId, input.terminalRevision, input.kind) as { message_id: number } | undefined;
    if (prior) return { messageId: prior.message_id, inserted: false };
    if (delivery.state !== 'claimed' || !input.claimId || delivery.claimId !== input.claimId) {
      throw new Error('Claim Swarm ausente ou expirado.');
    }
    const session = dbh.prepare('SELECT status FROM sessions WHERE id=?').get(input.sessionId) as
      { status: string } | undefined;
    if (!session || session.status === 'trashed') throw new Error('Sessão Swarm removida.');
    const role = input.kind === 'event' ? 'system' : 'assistant';
    const metadata = JSON.stringify({
      ...(input.metadata ? (JSON.parse(input.metadata) as Record<string, unknown>) : {}),
      swarm: { runId: input.runId, terminalRevision: input.terminalRevision, kind: input.kind },
    });
    const result = dbh
      .prepare('INSERT INTO messages (session_id,role,content,metadata) VALUES (?,?,?,?)')
      .run(input.sessionId, role, input.content, metadata);
    const messageId = Number(result.lastInsertRowid);
    dbh
      .prepare(
        'INSERT INTO swarm_chat_receipts (run_id,terminal_revision,kind,session_id,message_id) VALUES (?,?,?,?,?)',
      )
      .run(input.runId, input.terminalRevision, input.kind, input.sessionId, messageId);
    dbh.prepare('UPDATE sessions SET updated_at=CURRENT_TIMESTAMP WHERE id=?').run(input.sessionId);
    if (input.kind === 'response' || delivery.runStatus === 'aborted') {
      completeSwarmDelivery(input.runId, input.terminalRevision, input.claimId, 'delivered', undefined, dbh);
    }
    return { messageId, inserted: true };
  })();
}
