import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import type { HarnessProject, HarnessConfig } from '../../../src/types';

vi.mock('../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
}));
vi.mock('../db', () => ({
  getHarnessProject: vi.fn(() => undefined),
  listHarnessProjects: vi.fn(() => []),
  getDriveState: vi.fn(() => null),
  setDriveState: vi.fn(),
  getLatestUserTurnIndex: vi.fn(() => 0),
}));
vi.mock('../chat-push', () => ({ pushAssistantMessage: vi.fn(() => 1) }));
vi.mock('../activity-log', () => ({ recordActivity: vi.fn() }));
vi.mock('../orchestrator', () => ({ submitMessage: vi.fn() }));
vi.mock('../pipeline-control-core', () => ({ resolvePendingQuestion: vi.fn(() => null) }));

import { PipelineDriveCoordinator } from '../pipeline-drive-coordinator';

const BASE_CONFIG: HarnessConfig = {
  maxRoundsPerSprint: 3,
  usePlaywright: false,
  evaluatorAgentId: 'harness-evaluator',
  plannerAgentId: 'harness-planner',
  stack: [],
};

function devV2Project(): HarnessProject {
  return {
    id: 'proj_od',
    name: 'Demo',
    projectPath: '/tmp/demo-project',
    specPath: '/tmp/demo-project/SPEC.md',
    status: 'running',
    config: { ...BASE_CONFIG },
    currentSprintIndex: 0,
    totalSprints: 0,
    totalFeatures: 0,
    plannerInputTokens: 0,
    plannerOutputTokens: 0,
    plannerCacheTokens: 0,
    plannerCostUsd: 0,
    plannerDurationMs: 0,
    createdAt: '2026-06-10T00:00:00.000Z',
    updatedAt: '2026-06-10T00:00:00.000Z',
    pipelineType: 'development-v2',
  };
}

const coord = new PipelineDriveCoordinator(() => null);

const OD_STUDIO_PHASE = 5;

function odStudioPrompt(): string {
  return coord.buildSeededPrompt({
    project: devV2Project(),
    phase: OD_STUDIO_PHASE,
    pendingQuestion: null,
    mode: 'semi',
    controlGate: false,
    humanGate: true,
  });
}

describe('A-AC1: prompt semeado da fase OD sem briefing', () => {
  it('o prompt da fase do Open Design Studio NAO menciona briefing', () => {
    const prompt = odStudioPrompt();
    expect(prompt).toContain('esta fase e 100% do DONO, na UI');
    expect(prompt).not.toContain('briefing');
  });

  it('a fase OD NAO anuncia GO/design_session_config (faixa silenciosa) e segue sem briefing/design_prompt', () => {
    const prompt = odStudioPrompt();
    expect(prompt).not.toContain('design_session_config');
    expect(prompt).not.toContain('da o GO');
    expect(prompt).not.toContain('design_prompt');
    expect(prompt).not.toContain('briefing');
  });
});

const ROOT = process.cwd();
function readSource(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

const PROMPT_BUILDER = readSource('electron/main/prompt-builder.ts');
const JSONRPC = readSource('electron/main/local-ipc/jsonrpc-methods.ts');
const CORE = readSource('electron/main/pipeline-control-core.ts');
const SUBPROCESS = readSource('mcp-servers/lionclaw-pipeline-control/src/index.ts');

describe('A-AC1: schema das tools sem amarra de briefing (fonte)', () => {
  it('prompt-builder: NAO anuncia mais design_session_config ao orquestrador (C-03)', () => {
    const line = PROMPT_BUILDER.split('\n').find((l) => l.includes('design_session_config('));
    expect(line).toBeUndefined();
    expect(PROMPT_BUILDER.toLowerCase()).not.toContain('briefing');
  });

  it('subprocess: a tool design_session_config NAO tem campo briefing no inputSchema', () => {
    const start = SUBPROCESS.indexOf("server.tool(\n  'design_session_config'");
    expect(start).toBeGreaterThanOrEqual(0);
    const block = SUBPROCESS.slice(start, start + 1200);
    expect(block).not.toMatch(/briefing\s*:/);
  });

  it('jsonrpc: DesignSessionConfigParams NAO declara briefing (schema do runtime local)', () => {
    const start = JSONRPC.indexOf('export interface DesignSessionConfigParams {');
    expect(start).toBeGreaterThanOrEqual(0);
    const end = JSONRPC.indexOf('}', start);
    expect(end).toBeGreaterThan(start);
    const block = JSONRPC.slice(start, end);
    expect(block).not.toContain('briefing');
  });

  it('core: DesignSessionConfigRequest NAO declara briefing (schema do runtime core)', () => {
    const start = CORE.indexOf('export interface DesignSessionConfigRequest {');
    expect(start).toBeGreaterThanOrEqual(0);
    const end = CORE.indexOf('}', start);
    expect(end).toBeGreaterThan(start);
    const block = CORE.slice(start, end);
    expect(block).not.toContain('briefing');
  });
});

describe('A-AC6: design_prompt ausente do catalogo do orquestrador (fonte)', () => {
  it('prompt-builder: nao anuncia a tool design_prompt', () => {
    expect(PROMPT_BUILDER).not.toContain('design_prompt');
  });

  it('subprocess: nao registra server.tool(design_prompt)', () => {
    expect(SUBPROCESS).not.toMatch(/server\.tool\(\s*'design_prompt'/);
  });

  it('jsonrpc dispatch: nao tem case design_prompt (cai no -32601 Method not found)', () => {
    expect(JSONRPC).not.toMatch(/case\s+'design_prompt'/);
  });

  it('core: design_prompt fora de PIPELINE_WRITE_ACTIONS e sem designPromptCore/constante', () => {
    expect(CORE).not.toContain('designPromptCore');
    expect(CORE).not.toContain('DESIGN_PROMPT_DRIVE_BLOCKED');
    const start = CORE.indexOf('PIPELINE_WRITE_ACTIONS = new Set');
    expect(start).toBeGreaterThanOrEqual(0);
    const end = CORE.indexOf(']);', start);
    const block = CORE.slice(start, end);
    expect(block).not.toContain('design_prompt');
    expect(block).toContain('design_session_config');
  });
});
