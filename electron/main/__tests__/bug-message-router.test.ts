import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

const state = vi.hoisted(() => ({ home: '' }));

vi.mock('../paths', () => ({ getLionClawHome: () => state.home }));
vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  shell: {},
  app: { on: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] },
}));
vi.mock('../pipeline-shared/ipc-emitter', () => ({ emitIPC: vi.fn() }));

import { initDatabase, insertHarnessProject, getPipelinePhaseMessages } from '../db';
import {
  resolveConversationDescriptor,
  dispatchConversationMessage,
  type MessageRouterEngine,
  type RouterDispatchCtx,
} from '../pipeline-engine/message-router';
import { handlePhase12Message } from '../pipeline-engine/handlers/dev-feature';
import { getConversationGreeting, getBugConversationGreeting } from '../pipeline-engine/greetings';
import type { PipelineEngineContext, HandlerPhaseState, SpawnAgentResult } from '../pipeline-engine/handlers/context';

let tmpHome = '';
let projectPath = '';

beforeAll(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-bug-router-home-'));
  state.home = tmpHome;
  projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-bug-router-proj-'));
  initDatabase();
});

afterAll(() => {
  for (const dir of [tmpHome, projectPath]) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
});

function makeFakeEngine(): { engine: MessageRouterEngine; calls: Array<{ fn: string; args: unknown[] }> } {
  const calls: Array<{ fn: string; args: unknown[] }> = [];
  const rec =
    (fn: string) =>
    async (...args: unknown[]): Promise<void> => {
      calls.push({ fn, args });
    };
  const engine = {
    handlePhase1Message: rec('handlePhase1Message'),
    handlePhase3Message: rec('handlePhase3Message'),
    handlePhase9Message: rec('handlePhase9Message'),
    handlePhase10Message: rec('handlePhase10Message'),
    handleTechPhaseMessage: rec('handleTechPhaseMessage'),
    handlePhase12Message: rec('handlePhase12Message'),
    handleSecurityPhase4Message: rec('handleSecurityPhase4Message'),
    handleSecurityPhase5Message: rec('handleSecurityPhase5Message'),
    handleSecurityPhase6SpecReviewMessage: rec('handleSecurityPhase6SpecReviewMessage'),
    handleSecurityPhase7Message: rec('handleSecurityPhase7Message'),
    handleSecurityPhase9Message: rec('handleSecurityPhase9Message'),
    handleBugPhase1DiscoveryMessage: rec('handleBugPhase1DiscoveryMessage'),
    handleBugPhase3ConsolidationMessage: rec('handleBugPhase3ConsolidationMessage'),
    handleBugPhase5SpecValidatorMessage: rec('handleBugPhase5SpecValidatorMessage'),
    handleArchitecturePhase2TriageMessage: rec('handleArchitecturePhase2TriageMessage'),
    handleArchitecturePhase4DecisionMessage: rec('handleArchitecturePhase4DecisionMessage'),
    handleArchitecturePhase6SpecValidationMessage: rec('handleArchitecturePhase6SpecValidationMessage'),
    handleArchitecturePhase7SpecEnricherMessage: rec('handleArchitecturePhase7SpecEnricherMessage'),
    handlePhase1MessageDevV2: rec('handlePhase1MessageDevV2'),
    handlePhase3MessageDevV2: rec('handlePhase3MessageDevV2'),
    handleDevV2Phase12SpecReview: rec('handleDevV2Phase12SpecReview'),
    handleDevV2Phase13SpecEnricher: rec('handleDevV2Phase13SpecEnricher'),
    buildDesignLockPathsBlock: () => null,
  } as unknown as MessageRouterEngine;
  return { engine, calls };
}

function makeDispatchCtx(engine: MessageRouterEngine): RouterDispatchCtx {
  return {
    engine,
    projectId: 'proj-bug',
    message: 'mensagem do usuario',
    state: { continueSessions: new Map() },
    project: { pipelineType: 'bug' },
    resolveTechAgentId: (phase: number) => `tech-${phase}`,
  };
}

describe('TB-39a: BUG_ROUTES cobre exatamente as 4 fases conversacionais', () => {
  it('descriptor DEFINIDO para {1,3,5,7}', () => {
    for (const phase of [1, 3, 5, 7]) {
      expect(resolveConversationDescriptor('bug', phase)).toBeDefined();
    }
  });

  it('descriptor UNDEFINED para {2,4,6,8,9} (auto e loop nao aceitam mensagem manual)', () => {
    for (const phase of [2, 4, 6, 8, 9]) {
      expect(resolveConversationDescriptor('bug', phase)).toBeUndefined();
    }
  });

  it('as 4 rotas apontam para os handlers do bug (7 = handlePhase12Message com phaseNumber 7 EXPLICITO)', async () => {
    const expected: Array<[number, string]> = [
      [1, 'handleBugPhase1DiscoveryMessage'],
      [3, 'handleBugPhase3ConsolidationMessage'],
      [5, 'handleBugPhase5SpecValidatorMessage'],
      [7, 'handlePhase12Message'],
    ];
    for (const [phase, fn] of expected) {
      const { engine, calls } = makeFakeEngine();
      const outcome = await dispatchConversationMessage(makeDispatchCtx(engine), phase);
      expect(outcome).toBe('routed');
      expect(calls).toHaveLength(1);
      expect(calls[0]!.fn).toBe(fn);
    }
  });

  it('a fase 7 passa phaseNumber=7 EXPLICITO (sem ele o default do parametro seria 12)', async () => {
    const { engine, calls } = makeFakeEngine();
    await dispatchConversationMessage(makeDispatchCtx(engine), 7);
    expect(calls[0]!.args[3]).toBe(7);
    expect(calls[0]!.args[3]).not.toBe(12);
  });

  it('NENHUMA fase do bug cai em DEV_FEATURE_ROUTES', async () => {
    for (const phase of [9, 10, 12]) {
      const { engine, calls } = makeFakeEngine();
      const outcome = await dispatchConversationMessage(makeDispatchCtx(engine), phase);
      expect(outcome).toBe('none');
      expect(calls).toHaveLength(0);
    }
    for (const phase of [1, 3, 5]) {
      const { engine, calls } = makeFakeEngine();
      await dispatchConversationMessage(makeDispatchCtx(engine), phase);
      expect(calls[0]!.fn.startsWith('handleBug')).toBe(true);
    }
  });
});

describe('TB-39b: mensagem da fase 7 do bug persiste com phase_number 7, nunca 12', () => {
  it('handlePhase12Message(phaseNumber=7) grava em pipeline_messages na fase 7', async () => {
    const project = insertHarnessProject({
      name: 'Bug Router TB-39b',
      description: '',
      projectPath,
      specPath: path.join(projectPath, 'SPEC.md'),
      config: {
        maxRoundsPerSprint: 3,
        usePlaywright: false,
        evaluatorAgentId: 'harness-evaluator',
        plannerAgentId: 'harness-planner',
        stack: [],
      },
      pipelineType: 'bug',
      pipelineDocsId: null,
    });

    const handlerState: HandlerPhaseState = {
      abortController: new AbortController(),
      continueSessions: new Map(),
      currentPhase: 7,
      status: 'running',
    };

    const spawnResult: SpawnAgentResult = {
      output: 'ok',
      metrics: {
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        toolUses: 0,
        apiRequests: 1,
        costUsd: 0.001,
        durationMs: 100,
      },
      model: 'claude-sonnet-4-6',
      runtime: 'cloud',
      provider: 'anthropic',
    };

    const ctx = {
      spawnAgent: vi.fn(async (_agentId: string, _prompt: string, opts: { onText?: (c: string) => void }) => {
        opts.onText?.('Revisei os sprints contra a SPEC de correcao.');
        return spawnResult;
      }),
      accumulateMetrics: vi.fn(),
      makeConversationOnText:
        (_projectId: string, _phase: number, acc: { text: string; completed: boolean }) => (chunk: string) => {
          acc.text += chunk;
        },
      buildPriorMessagesForPhase: () => undefined,
      PHASE_COMPLETE_MARKER: '[PHASE_COMPLETE]',
    } as unknown as PipelineEngineContext;

    await handlePhase12Message(ctx, project.id, 'revisa os sprints', handlerState, 7);

    const onPhase7 = getPipelinePhaseMessages(project.id, 7);
    const onPhase12 = getPipelinePhaseMessages(project.id, 12);

    expect(onPhase7.length).toBeGreaterThanOrEqual(1);
    expect(onPhase7.some((m) => m.role === 'assistant')).toBe(true);
    expect(onPhase12).toHaveLength(0);
  });
});

describe('TB-39c: getConversationGreeting com pipelineType bug', () => {
  const projectName = 'Meu Projeto';
  const bug = { pipelineType: 'bug' };

  it('fase 1: texto literal da secao 4.14, SEM PRD.md e SEM stories-requisitos.md', () => {
    const g = getConversationGreeting(1, projectName, bug);
    expect(g).toBe(
      `Projeto "${projectName}" (bug). Inicie o diagnostico do bug. ` +
        `Faca as tres perguntas que mais reduzem incerteza e investigue o repo em paralelo. ` +
        `Descreva o PROBLEMA, nunca a solucao. ` +
        `Nao procure PRD.md nem stories-requisitos.md; este pipeline parte do relato do usuario.`,
    );
    expect(g).toContain('Nao procure PRD.md nem stories-requisitos.md');
    expect(g.replace('Nao procure PRD.md nem stories-requisitos.md', '')).not.toContain('PRD.md');
    expect(g.replace('Nao procure PRD.md nem stories-requisitos.md', '')).not.toContain('stories-requisitos.md');
  });

  it('fase 3: consolidacao com refutacao bloqueante e campo "## Desfecho"', () => {
    const g = getConversationGreeting(3, projectName, bug);
    expect(g).toBe(
      `Projeto "${projectName}" (bug). Consolide as tres analises paralelas num plano de correcao unico, ` +
        `resolva contradicoes e apresente ao usuario. ` +
        `Trate a refutacao adversarial como bloqueante. Preencha o campo "## Desfecho".`,
    );
  });

  it('fase 5: validacao da SPEC de correcao, sem requisito novo', () => {
    const g = getConversationGreeting(5, projectName, bug);
    expect(g).toBe(
      `Projeto "${projectName}" (bug). Inicie a validacao da SPEC de correcao. ` +
        `Audite contra o plano de correcao aprovado e contra o codigo real. ` +
        `Corrija gaps objetivos, pergunte o que exige decisao e NAO adicione requisito novo.`,
    );
  });

  it('fase 7: validacao do plano de sprints com testes de regressao', () => {
    const g = getConversationGreeting(7, projectName, bug);
    expect(g).toBe(
      `Projeto "${projectName}" (bug). Inicie a validacao do plano de sprints. ` +
        `Revise se os sprints implementam a SPEC de correcao e se cobrem os testes de regressao.`,
    );
  });

  it('demais fases caem no default do bug (nunca no fallback do development)', () => {
    for (const phase of [2, 4, 6, 8, 9]) {
      const g = getConversationGreeting(phase, projectName, bug);
      expect(g).toBe(`Inicie a fase ${phase} do projeto "${projectName}" (bug).`);
      expect(g).not.toContain('PRD.md');
      expect(g).not.toContain('stories-requisitos.md');
    }
  });

  it('getBugConversationGreeting e a fonte unica dos 4 textos', () => {
    for (const phase of [1, 3, 5, 7, 2, 99]) {
      expect(getConversationGreeting(phase, projectName, bug)).toBe(getBugConversationGreeting(phase, projectName));
    }
  });
});
