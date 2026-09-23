import { describe, it, expect } from 'vitest';
import { vi } from 'vitest';
import type { HarnessProject, HarnessConfig } from '../../../src/types';
import type { PipelineType } from '../../../src/types/pipeline';

vi.mock('../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [],
  },
}));

vi.mock('../db', () => ({
  getHarnessProject: vi.fn(() => undefined),
  listHarnessProjects: vi.fn(() => []),
  getDriveState: vi.fn(() => null),
  setDriveState: vi.fn(),
  getLatestUserTurnIndex: vi.fn(() => 0),
}));

vi.mock('../chat-push', () => ({
  pushAssistantMessage: vi.fn(() => 1),
}));

vi.mock('../activity-log', () => ({
  recordActivity: vi.fn(),
}));

vi.mock('../orchestrator', () => ({
  submitMessage: vi.fn(),
}));

vi.mock('../pipeline-control-core', () => ({
  resolvePendingQuestion: vi.fn(() => null),
}));

import { PipelineDriveCoordinator } from '../pipeline-drive-coordinator';

const BASE_CONFIG: HarnessConfig = {
  maxRoundsPerSprint: 3,
  usePlaywright: false,
  evaluatorAgentId: 'harness-evaluator',
  plannerAgentId: 'harness-planner',
  stack: [],
};

function makeProject(
  over: Partial<Omit<HarnessProject, 'config'>> & { config?: Partial<HarnessConfig> } = {},
): HarnessProject {
  const { config, ...rest } = over;
  return {
    id: 'proj_x',
    name: 'Demo',
    projectPath: '/tmp/demo-project',
    specPath: '/tmp/demo-project/SPEC.md',
    status: 'running',
    config: { ...BASE_CONFIG, ...(config ?? {}) },
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
    pipelineType: 'development',
    ...rest,
  };
}

const coord = new PipelineDriveCoordinator(() => null);

function buildPrompt(
  project: HarnessProject,
  phase: number,
  over: Partial<{
    mode: 'semi' | 'full';
    controlGate: boolean;
    humanGate: boolean;
    specReviewOpen: boolean;
    pendingQuestion: string | null;
  }> = {},
): string {
  return coord.buildSeededPrompt({
    project,
    phase,
    pendingQuestion: over.pendingQuestion ?? null,
    mode: over.mode ?? 'semi',
    controlGate: over.controlGate ?? false,
    humanGate: over.humanGate ?? false,
    specReviewOpen: over.specReviewOpen ?? false,
  });
}

function typed(pipelineType: PipelineType, over: Parameters<typeof makeProject>[0] = {}): HarnessProject {
  return makeProject({ pipelineType, ...over });
}

describe('buildSeededPrompt - contratos de gate por tipo (B7)', () => {
  it('architecture-review fase 2 (Triagem): menciona selectedCandidateId e a escolha via inspect', () => {
    const prompt = buildPrompt(typed('architecture-review'), 2);
    expect(prompt).toContain('selectedCandidateId');
    expect(prompt).toContain('Triagem de Alvos');
    expect(prompt).toContain('pipeline_inspect');
    expect(prompt).not.toContain('lock-and-continue');
  });

  it('architecture-review fase 4 (Decisao): menciona a exigencia de >=1 secao "## DN"', () => {
    const prompt = buildPrompt(typed('architecture-review'), 4);
    expect(prompt).toContain('## DN');
    expect(prompt).toContain('Entrevista de Decisao');
    expect(prompt).not.toContain('lock-and-continue');
  });

  it('development-v2: o gate do Design Lock e HUMANO (motorista nao aprova o lock por tool) - C-03', () => {
    const prompt = buildPrompt(typed('development-v2'), 3);
    expect(prompt).not.toContain("pipeline_approve(id, { action: 'lock-and-continue' })");
    expect(prompt).toContain('A fase do design e do DONO, na UI');
    expect(prompt).toContain('acionavel pos-lock');
    expect(prompt).not.toContain('de o GO da geracao');
    expect(prompt).not.toContain('design_session_config');
    expect(prompt).not.toContain('selectedCandidateId');
    expect(prompt).not.toContain('## DN');
  });

  it.each(['security', 'feature', 'development'] as PipelineType[])(
    '%s: linha unica sem metadata especial (nunca despeja a tabela inteira)',
    (pipelineType) => {
      const prompt = buildPrompt(typed(pipelineType), 1);
      expect(prompt).toContain('nao ha metadata especial de gate');
      expect(prompt).toContain(`(${pipelineType})`);
      expect(prompt).not.toContain('selectedCandidateId');
      expect(prompt).not.toContain('lock-and-continue');
      expect(prompt).not.toContain('## DN');
    },
  );

  it('pipelineType ausente cai no contrato do development (sem metadata)', () => {
    const prompt = buildPrompt(makeProject({ pipelineType: undefined }), 1);
    expect(prompt).toContain('nao ha metadata especial de gate');
    expect(prompt).not.toContain('selectedCandidateId');
    expect(prompt).not.toContain('lock-and-continue');
  });

  it('TB-27 bug: bloco com os DOIS desfechos e o path ABSOLUTO do plano', () => {
    const project = typed('bug', {
      projectPath: '/tmp/bugrepo',
      config: { bug: { runId: '20260727_101010-a1b2c3', outcome: 'pending' } },
    });
    const prompt = buildPrompt(project, 3);
    expect(prompt).toContain('CONTRATO DE GATES deste pipeline (bug):');
    expect(prompt).toContain("pipeline_approve(id, { action: 'approve-plan' })");
    expect(prompt).toContain("pipeline_approve(id, { action: 'close-pipeline' })");
    expect(prompt).toContain('## Desfecho');
    expect(prompt).toContain(
      '/tmp/bugrepo/.lionclaw/pipelines/bug/20260727_101010-a1b2c3/plano-de-correcao-20260727_101010-a1b2c3.md',
    );
    expect(prompt).toContain('Sprint Validator');
    expect(prompt).not.toContain('selectedCandidateId');
    expect(prompt).not.toContain('lock-and-continue');
    expect(prompt).not.toContain('## DN');
  });

  it('TB-27 bug SEM runId: a linha do plano vira "consulte pipeline_inspect", nunca o basename', () => {
    const project = typed('bug', { projectPath: '/tmp/bugrepo', config: {} });
    const prompt = buildPrompt(project, 3);
    expect(prompt).toContain('CONTRATO DE GATES deste pipeline (bug):');
    expect(prompt).toContain('consulte pipeline_inspect para o gateDocumentPath');
    expect(prompt).not.toContain('plano-de-correcao-');
  });

  it('TB-27 bug: os OUTROS tipos nao ganharam o bloco do bug (so o tipo corrente)', () => {
    for (const pipelineType of ['development', 'security', 'architecture-review'] as PipelineType[]) {
      const prompt = buildPrompt(typed(pipelineType), 1);
      expect(prompt).not.toContain('approve-plan');
      expect(prompt).not.toContain('close-pipeline');
    }
  });
});

describe('buildSeededPrompt - anuncio condicional do preview_open (B2)', () => {
  it('dev-v2 POS-lock: anuncia preview_open com o path canonico do artifact (via runDir)', () => {
    const project = typed('development-v2', {
      config: {
        openDesign: { enabled: true, locked: true, runDir: '/tmp/run-dir' },
      },
    });
    const prompt = buildPrompt(project, 8);
    expect(prompt).toContain('preview_open');
    expect(prompt).toContain('/tmp/run-dir/open-design/snapshots/latest/artifact/index.html');
  });

  it('dev-v2 POS-lock: artifactHtmlPath persistido tem precedencia sobre o join do runDir', () => {
    const project = typed('development-v2', {
      config: {
        openDesign: {
          enabled: true,
          locked: true,
          runDir: '/tmp/run-dir',
          artifactHtmlPath: '/tmp/run-dir/custom/artifact.html',
        },
      },
    });
    const prompt = buildPrompt(project, 8);
    expect(prompt).toContain('/tmp/run-dir/custom/artifact.html');
    expect(prompt).not.toContain('/tmp/run-dir/open-design/snapshots/latest/artifact/index.html');
  });

  it('B2-AC2: a politica "propor antes, nao abrir sem anuencia" esta no texto do anuncio', () => {
    const project = typed('development-v2', {
      config: { openDesign: { enabled: true, locked: true, runDir: '/tmp/run-dir' } },
    });
    const prompt = buildPrompt(project, 8);
    expect(prompt).toContain('PROPONHA antes');
    expect(prompt).toContain('nao abra sem o humano pedir/concordar');
  });

  it('dev-v2 PRE-lock (Discovery): NAO anuncia preview_open', () => {
    const prompt = buildPrompt(typed('development-v2'), 1);
    expect(prompt).not.toContain('preview_open');
  });

  it('dev-v2 PRE-lock na fase do studio: NAO anuncia preview_open (artifact ainda nao existe)', () => {
    const project = typed('development-v2', {
      config: { openDesign: { enabled: true, locked: false } },
    });
    const prompt = buildPrompt(project, 5);
    expect(prompt).not.toContain('preview_open');
  });

  it('fase de execucao (Coder, type loop) anuncia preview_open com guidance do projeto', () => {
    const prompt = buildPrompt(typed('development'), 13);
    expect(prompt).toContain('preview_open');
    expect(prompt).toContain('/tmp/demo-project');
  });

  it('fase de execucao em outro tipo (security Evaluator) tambem anuncia', () => {
    const prompt = buildPrompt(typed('security'), 11);
    expect(prompt).toContain('preview_open');
  });

  it('fases nao-loop / nao-pos-lock NAO anunciam (development PRD Validator)', () => {
    const prompt = buildPrompt(typed('development'), 3);
    expect(prompt).not.toContain('preview_open');
  });
});

describe('buildSeededPrompt - design_prompt nao anunciada no prompt semeado (A4)', () => {
  it('dev-v2 fase do studio: NAO anuncia design_prompt (mantem pipeline_reply)', () => {
    const prompt = buildPrompt(typed('development-v2'), 5);
    expect(prompt).not.toContain('design_prompt');
    expect(prompt).toContain('pipeline_reply(id, message)');
  });

  it('dev-v2 fora da fase do studio: ausente', () => {
    const prompt = buildPrompt(typed('development-v2'), 8);
    expect(prompt).not.toContain('design_prompt');
  });

  it('outros tipos nunca incluem design_prompt', () => {
    const prompt = buildPrompt(typed('development'), 5);
    expect(prompt).not.toContain('design_prompt');
  });
});

describe('buildSeededPrompt - design_session_config removida do prompt (C-03)', () => {
  it('dev-v2 fase do studio: NAO anuncia design_session_config nem instrui a dar GO', () => {
    const prompt = buildPrompt(typed('development-v2'), 5);
    expect(prompt).not.toContain('design_session_config');
    expect(prompt).not.toContain('da o GO');
    expect(prompt).not.toContain('GATILHO UNICO do start sob drive');
    expect(prompt).toContain('esta fase e 100% do DONO, na UI');
  });

  it('dev-v2 fora da fase do studio: linha ausente', () => {
    const prompt = buildPrompt(typed('development-v2'), 8);
    expect(prompt).not.toContain('design_session_config');
  });

  it('outros tipos nunca incluem design_session_config (mesmo numero de fase do studio)', () => {
    const prompt = buildPrompt(typed('development'), 5);
    expect(prompt).not.toContain('design_session_config');
  });
});

describe('buildSeededPrompt - gate de revisao da SPEC (specReviewOpen)', () => {
  it('specReviewOpen -> linha de revisao conversacional (reply/approve), sem a linha de fase auto', () => {
    const prompt = buildPrompt(typed('development'), 9, { mode: 'full', specReviewOpen: true });
    expect(prompt).toContain('REVISAO CONVERSACIONAL');
    expect(prompt).toContain('pipeline_reply');
    expect(prompt).toContain('pipeline_approve');
    expect(prompt).toContain('NAO encerre o turno sem decidir');
    expect(prompt).not.toContain('Fase AUTOMATICA rodando');
  });

  it('sem specReviewOpen (loop ainda rodando) -> linha de fase auto preservada', () => {
    const prompt = buildPrompt(typed('development'), 9, { mode: 'full' });
    expect(prompt).toContain('Fase AUTOMATICA rodando');
    expect(prompt).not.toContain('REVISAO CONVERSACIONAL');
  });
});

describe('buildSeededPrompt - padroes de sobrevivencia (F9-AC1)', () => {
  it.each(['development', 'development-v2', 'security', 'feature', 'architecture-review'] as PipelineType[])(
    '%s: as 3 regras de sobrevivencia estao no prompt semeado',
    (pipelineType) => {
      const prompt = buildPrompt(typed(pipelineType), 1);
      expect(prompt).toContain('PADROES DE SOBREVIVENCIA (obrigatorios):');
      expect(prompt).toContain('SEMPRE rode pipeline_inspect ANTES de agir');
      expect(prompt).toContain('Erro de TRANSPORTE (Connection closed / timeout) NAO significa falha');
      expect(prompt).toContain('ANTES de repetir uma escrita');
      expect(prompt).toContain('SIGA a instrucao');
      expect(prompt).toContain('em vez de alternar reply/approve cegamente');
    },
  );

  it('as regras aparecem tanto em modo semi quanto full', () => {
    const semi = buildPrompt(typed('development'), 1, { mode: 'semi' });
    const full = buildPrompt(typed('development'), 1, { mode: 'full', controlGate: true });
    expect(semi).toContain('PADROES DE SOBREVIVENCIA (obrigatorios):');
    expect(full).toContain('PADROES DE SOBREVIVENCIA (obrigatorios):');
  });
});

describe('buildSeededPrompt - contrato de stand-down "COMO VOCE OPERA" (W1)', () => {
  it.each(['development', 'development-v2', 'security', 'feature', 'architecture-review'] as PipelineType[])(
    'W1-AC1: o contrato REATIVO geral esta presente em %s',
    (pipelineType) => {
      const prompt = buildPrompt(typed(pipelineType), 1);
      expect(prompt).toContain('COMO VOCE OPERA:');
      expect(prompt).toContain('Voce opera em turnos REATIVOS');
      expect(prompt).toContain('NUNCA monitore, aguarde, faca polling');
      expect(prompt).toContain('leia o banco de dados direto');
      expect(prompt).toContain('.lionclaw/data/lionclaw.db');
      expect(prompt).toContain('Vigiar dentro do turno NAO acelera nada');
    },
  );

  it('W1-AC1: fase CONVERSACIONAL (development fase 1 Discovery) traz a linha de conversation', () => {
    const prompt = buildPrompt(typed('development'), 1);
    expect(prompt).toContain('Fase CONVERSACIONAL: responda com pipeline_reply');
    expect(prompt).toContain('encadeie as respostas no MESMO turno');
    expect(prompt).not.toContain('Fase AUTOMATICA rodando');
    expect(prompt).not.toContain('Fase de EXECUCAO (loop)');
    expect(prompt).not.toContain('Fase do LionDesign');
  });

  it('W1-AC1: fase AUTO (development fase 2 PRD Generator) traz a linha de auto', () => {
    const prompt = buildPrompt(typed('development'), 2);
    expect(prompt).toContain('Fase AUTOMATICA rodando: NAO ha nada a fazer');
    expect(prompt).toContain('Encerre o turno IMEDIATAMENTE');
    expect(prompt).not.toContain('Fase CONVERSACIONAL: responda com pipeline_reply');
    expect(prompt).not.toContain('Fase de EXECUCAO (loop)');
  });

  it('W1-AC1: fase LOOP (development fase 13 Coder) traz a linha de loop', () => {
    const prompt = buildPrompt(typed('development'), 13);
    expect(prompt).toContain('Fase de EXECUCAO (loop): voce sera acordado por MARCO');
    expect(prompt).toContain('nao por progresso');
    expect(prompt).not.toContain('Fase CONVERSACIONAL: responda com pipeline_reply');
    expect(prompt).not.toContain('Fase AUTOMATICA rodando');
  });

  it('W1-AC1 / C-03: fase do OPEN DESIGN (dev-v2 fase 5 Studio) traz a linha da faixa silenciosa', () => {
    const prompt = buildPrompt(typed('development-v2'), 5);
    expect(prompt).toContain('Fase do LionDesign: esta fase e 100% do DONO, na UI');
    expect(prompt).toContain('VALIDA/TRAVA o layout');
    expect(prompt).toContain('voce DORME nesta fase');
    expect(prompt).toContain('te acorda no proximo ponto acionavel');
    expect(prompt).not.toContain('apos dar o START do design');
    expect(prompt).not.toContain('Fase CONVERSACIONAL: responda com pipeline_reply');
  });

  it('W1-AC2: a lista de gatilhos de "voce SERA acordado" enumera exatamente os 4 grupos', () => {
    const prompt = buildPrompt(typed('development'), 1);
    expect(prompt).toContain('Voce SERA acordado automaticamente por um turno novo quando:');
    const triggers = [
      'a fase mudar (inclusive quando o dono travar o Design Lock);',
      'uma pergunta abrir;',
      'um erro/stall ocorrer (eu pauso e te pergunto como seguir);',
      'o humano intervir.',
    ];
    for (const t of triggers) {
      expect(prompt).toContain(t);
    }
    expect(prompt).not.toContain('geracao do design concluida');
    expect(prompt).not.toContain('artifact pronto');
    const header = 'Voce SERA acordado automaticamente por um turno novo quando:';
    const after = prompt.slice(prompt.indexOf(header) + header.length);
    const indentedBullets = (after.match(/\n {2}- [^\n]*/g) ?? []).map((b) => b.trim().slice(2));
    expect(indentedBullets.slice(0, triggers.length)).toEqual(triggers);
  });

  it('W1-AC3: o ajuste do F9 (nunca inspecione para ESPERAR) esta presente', () => {
    const prompt = buildPrompt(typed('development'), 1);
    expect(prompt).toContain('Inspecione antes de AGIR');
    expect(prompt).toContain('NUNCA inspecione para ESPERAR');
    expect(prompt).toContain('voce sera acordado por evento');
  });

  it('W1: o contrato de stand-down aparece em modo semi E full', () => {
    const semi = buildPrompt(typed('development'), 1, { mode: 'semi' });
    const full = buildPrompt(typed('development'), 1, { mode: 'full', controlGate: true });
    expect(semi).toContain('COMO VOCE OPERA:');
    expect(full).toContain('COMO VOCE OPERA:');
  });
});

describe('buildSeededPrompt - regressao da espinha do prompt', () => {
  it('header, tools pipeline_* e regras de autonomia continuam presentes', () => {
    const prompt = buildPrompt(typed('development'), 1);
    expect(prompt).toContain('[DRIVE DE PIPELINE]');
    expect(prompt).toContain('pipeline_reply(id, message)');
    expect(prompt).toContain('pipeline_approve(id, metadata?)');
    expect(prompt).toContain('pipeline_escalate(id, message)');
    expect(prompt).toContain('pipeline_inspect(id)');
    expect(prompt).toContain('REGRAS DE AUTONOMIA E ESCALONAMENTO (obrigatorias):');
    expect(prompt).toContain('Modo SEMI');
  });

  it('C-04: instrui a nao especular a proxima fase', () => {
    const prompt = buildPrompt(typed('development'), 1);
    expect(prompt).toContain('NAO especule nem anuncie a proxima fase');
    expect(prompt).toContain('voce sera acordado quando for a hora');
  });

  it('modo full + control gate manda LER+AVALIAR+DECIDIR (com justificativa)', () => {
    const prompt = buildPrompt(typed('development'), 3, { mode: 'full', controlGate: true });
    expect(prompt).toContain('Modo FULL');
    expect(prompt).toContain('CONTROL GATE');
    expect(prompt).toContain('LEIA o artefato');
    expect(prompt).toContain('justificativa');
    expect(prompt).toContain('pipeline_escalate');
    expect(prompt).not.toContain('GATE DE ALTO RISCO');
  });

  it('modo semi + control gate manda escalar via pipeline_escalate', () => {
    const prompt = buildPrompt(typed('development'), 3, { mode: 'semi', controlGate: true });
    expect(prompt).toContain('Modo SEMI');
    expect(prompt).toContain('CONTROL GATE');
    expect(prompt).toContain('pipeline_escalate');
  });

  it('human gate (dev-v2 fase OD) instrui ceder ao humano mesmo em full', () => {
    const prompt = buildPrompt(typed('development-v2'), 5, { mode: 'full', humanGate: true });
    expect(prompt).toContain('DECISAO DO HUMANO');
    expect(prompt).toContain('pipeline_escalate');
    expect(prompt).toContain('nem em full');
  });
});

describe('buildSeededPrompt - truncacao head+tail do pendingQuestion (fix C)', () => {
  const HEAD = 6000;
  const TAIL = 3000;
  const MARKER = '[...saida truncada - use pipeline_inspect para o texto completo...]';
  const FFFD = '�';
  const HIGH = '\uD83D';
  const LOW = '\uDE00';
  const EMOJI = HIGH + LOW;

  function hasLoneSurrogate(s: string): boolean {
    return /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);
  }

  it('(a) input longo: head + tail sentinelas presentes com o marcador entre elas', () => {
    const HEAD_SENTINEL = 'CABECA_DISTINTA_DO_INICIO';
    const TAIL_SENTINEL = 'CAUDA_DISTINTA_DO_FIM';
    const filler = 'x'.repeat(10000);
    const pendingQuestion = `${HEAD_SENTINEL}${filler}${TAIL_SENTINEL}`;
    expect(pendingQuestion.length).toBeGreaterThan(HEAD + TAIL);

    const prompt = buildPrompt(typed('development'), 1, { pendingQuestion });

    expect(prompt).toContain(HEAD_SENTINEL);
    expect(prompt).toContain(TAIL_SENTINEL);
    expect(prompt).toContain(MARKER);
    const headIdx = prompt.indexOf(HEAD_SENTINEL);
    const markerIdx = prompt.indexOf(MARKER);
    const tailIdx = prompt.indexOf(TAIL_SENTINEL);
    expect(headIdx).toBeLessThan(markerIdx);
    expect(markerIdx).toBeLessThan(tailIdx);
  });

  it('(b) input curto (<= 9000): passthrough completo, sem marcador', () => {
    const pendingQuestion = `INICIO_CURTO${'y'.repeat(500)}FIM_CURTO`;
    expect(pendingQuestion.length).toBeLessThanOrEqual(HEAD + TAIL);

    const prompt = buildPrompt(typed('development'), 1, { pendingQuestion });

    expect(prompt).toContain(pendingQuestion);
    expect(prompt).not.toContain(MARKER);
  });

  it("(b') length === 9000 (HEAD+TAIL) ainda e passthrough, sem marcador", () => {
    const pendingQuestion = 'z'.repeat(HEAD + TAIL);
    expect(pendingQuestion.length).toBe(HEAD + TAIL);

    const prompt = buildPrompt(typed('development'), 1, { pendingQuestion });

    expect(prompt).toContain(pendingQuestion);
    expect(prompt).not.toContain(MARKER);
  });

  it('(c) emoji straddling o corte do HEAD e do TAIL: sem U+FFFD e sem surrogate orfao', () => {
    const headPart = 'a'.repeat(HEAD - 1) + EMOJI;
    expect(headPart.charCodeAt(HEAD - 1)).toBe(0xd83d);

    const middle = 'b'.repeat(5000);

    const tailPart = EMOJI + 'c'.repeat(TAIL - 1);

    const pendingQuestion = headPart + middle + tailPart;
    expect(pendingQuestion.length).toBeGreaterThan(HEAD + TAIL);
    expect(pendingQuestion.charCodeAt(pendingQuestion.length - TAIL)).toBe(0xde00);

    const prompt = buildPrompt(typed('development'), 1, { pendingQuestion });

    expect(prompt).toContain(MARKER);
    expect(prompt).not.toContain(FFFD);
    expect(hasLoneSurrogate(prompt)).toBe(false);
  });

  it("(c') passthrough: high surrogate orfao no fim e removido, sem U+FFFD", () => {
    const pendingQuestion = 'd'.repeat(100) + HIGH;
    expect(pendingQuestion.length).toBeLessThanOrEqual(HEAD + TAIL);

    const prompt = buildPrompt(typed('development'), 1, { pendingQuestion });

    expect(prompt).not.toContain(MARKER);
    expect(prompt).not.toContain(FFFD);
    expect(hasLoneSurrogate(prompt)).toBe(false);
  });
});
