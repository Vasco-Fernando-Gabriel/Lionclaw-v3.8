import { describe, it, expect } from 'vitest';
import {
  ALL_SEED_AGENTS,
  DYNAMIC_WORKFLOW_AGENT_IDS,
  DYNAMIC_WORKFLOW_SEED_AGENTS,
  DYNAMIC_WORKFLOW_SCOUT_ID,
  DYNAMIC_WORKFLOW_CODER_ID,
  DYNAMIC_WORKFLOW_FIXER_ID,
  DYNAMIC_WORKFLOW_VALIDATOR_SPEC_ID,
  DYNAMIC_WORKFLOW_VALIDATOR_REGRESSION_ID,
  DYNAMIC_WORKFLOW_VALIDATOR_TESTS_ID,
  DYNAMIC_WORKFLOW_CLOSER_ID,
  DYNAMIC_WORKFLOW_MAESTRO_ID,
  DYNAMIC_WORKFLOW_REFUTER_ID,
  dynamicWorkflowMaestro,
  SECURITY_AGENT_IDS,
  SECURITY_SEED_AGENTS,
  SECURITY_SPEC_VALIDATOR_ID,
  securitySpecValidator,
  DYNAMIC_WORKFLOW_DOC_WRITER_ID,
  DYNAMIC_WORKFLOW_AUTHORED_SEED_AGENTS,
  dynamicWorkflowDocWriter,
} from '../seed-agents';
import { AGENT_CATEGORIES } from '../../../src/lib/agent-categories';
import { CODE_WRITER_AGENT_IDS } from '../dynamic-workflows/workflow-outcome';
import { DYNAMIC_WORKFLOW_CODER_CODEX_ID } from '../seed-agents/dynamic-workflow-coder-codex';
import { DYNAMIC_WORKFLOW_CODER_GLM_ID } from '../seed-agents/dynamic-workflow-coder-glm';

const BASE_IDS = [
  'dynamic-workflow-scout',
  'dynamic-workflow-coder',
  'dynamic-workflow-fixer',
  'dynamic-workflow-validator-spec',
  'dynamic-workflow-validator-regression',
  'dynamic-workflow-validator-tests',
  'dynamic-workflow-closer',
];

const PLAN_IDS = [
  'dynamic-workflow-sprint-planner',
  'dynamic-workflow-plan-validator-coverage',
  'dynamic-workflow-plan-validator-topology',
  'dynamic-workflow-plan-validator-criteria',
];

const REFUTE_IDS = ['dynamic-workflow-refuter'];

const EXPECTED_IDS = [...BASE_IDS, ...PLAN_IDS, ...REFUTE_IDS];

const GUARD_CAPABLE_RUNTIMES = ['cloud', 'zai', 'minimax-tp'];

const WRITE_TOOLS = ['Write', 'Edit', 'Bash'];

const EM_DASH = String.fromCharCode(0x2014);

function seedById(id: string) {
  const seed = DYNAMIC_WORKFLOW_SEED_AGENTS.find((a) => a.id === id);
  if (!seed) throw new Error(`seed ${id} ausente em DYNAMIC_WORKFLOW_SEED_AGENTS`);
  return seed;
}

describe('squad seed dynamic-workflow - registry (spec 6.4 + redesign sec 4.1)', () => {
  it('expoe exatamente os 12 ids (7 papeis 6.4 + 4 do plano 4.1 + 1 refuter F2-S6)', () => {
    expect([...DYNAMIC_WORKFLOW_AGENT_IDS]).toEqual(EXPECTED_IDS);
    expect(DYNAMIC_WORKFLOW_SEED_AGENTS).toHaveLength(12);
    expect(DYNAMIC_WORKFLOW_SEED_AGENTS.map((a) => a.id)).toEqual(EXPECTED_IDS);
  });

  it('os 12 estao em ALL_SEED_AGENTS, cada um exatamente uma vez (ids unicos)', () => {
    const allIds = ALL_SEED_AGENTS.map((a) => a.id);
    for (const id of EXPECTED_IDS) {
      expect(allIds.filter((x) => x === id)).toHaveLength(1);
    }
    expect(new Set(EXPECTED_IDS).size).toBe(12);
  });

  it('todos com squad dynamic-workflow, ativos, runtime cloud default e shape padrao', () => {
    for (const seed of DYNAMIC_WORKFLOW_SEED_AGENTS) {
      expect(seed.squad).toBe('dynamic-workflow');
      expect(seed.isActive).toBe(true);
      expect(seed.runtime).toBe('cloud');
      expect(seed.name.length).toBeGreaterThan(0);
      expect(seed.description.length).toBeGreaterThan(0);
      expect(seed.model.length).toBeGreaterThan(0);
      expect(seed.systemPrompt.length).toBeGreaterThan(0);
      expect(Array.isArray(seed.allowedTools)).toBe(true);
      expect(seed.allowedTools.length).toBeGreaterThan(0);
      expect(Array.isArray(seed.mcpServers)).toBe(true);
      expect(seed.maxTurns).toBeGreaterThan(0);
    }
  });
});

describe('papeis read-only vs writers (spec 6.4, 7.4, 7.5)', () => {
  const READ_ONLY_IDS = [
    DYNAMIC_WORKFLOW_SCOUT_ID,
    DYNAMIC_WORKFLOW_VALIDATOR_SPEC_ID,
    DYNAMIC_WORKFLOW_VALIDATOR_REGRESSION_ID,
    DYNAMIC_WORKFLOW_VALIDATOR_TESTS_ID,
  ];

  it.each(READ_ONLY_IDS)('%s e read-only: sem Write/Edit/Bash em allowedTools', (id) => {
    const seed = seedById(id);
    for (const tool of WRITE_TOOLS) {
      expect(seed.allowedTools).not.toContain(tool);
    }
    expect(seed.allowedTools).toContain('Read');
  });

  it.each([DYNAMIC_WORKFLOW_CODER_ID, DYNAMIC_WORKFLOW_FIXER_ID])(
    '%s e writer: Write/Edit/Bash presentes em allowedTools',
    (id) => {
      const seed = seedById(id);
      for (const tool of WRITE_TOOLS) {
        expect(seed.allowedTools).toContain(tool);
      }
    },
  );

  it('scout nao propoe arquivo fora do writeSet (7.1/7.4): regra explicita no prompt', () => {
    const prompt = seedById(DYNAMIC_WORKFLOW_SCOUT_ID).systemPrompt;
    expect(prompt).toContain('writeSet');
    expect(prompt).toContain('NAO proponha criar/editar arquivo fora do writeSet');
    expect(prompt).toContain('BLOQUEIO');
  });
});

describe('writers continuation-aware + disciplina de git (spec 10.4, 8.6.1)', () => {
  it.each([DYNAMIC_WORKFLOW_CODER_ID, DYNAMIC_WORKFLOW_FIXER_ID])(
    '%s tem prompt continuation-aware (inspeciona git status/diff e CONTINUA)',
    (id) => {
      const prompt = seedById(id).systemPrompt;
      expect(prompt).toContain('git status');
      expect(prompt).toContain('git diff');
      expect(prompt).toContain('CONTINUE do ponto em que esta');
      expect(prompt).toContain('nao refaca o que ja esta feito');
    },
  );

  it.each([DYNAMIC_WORKFLOW_CODER_ID, DYNAMIC_WORKFLOW_FIXER_ID])(
    '%s proibe git de escrita (host commita) e respeita o writeSet',
    (id) => {
      const prompt = seedById(id).systemPrompt;
      expect(prompt).toContain('NUNCA rode git de escrita');
      expect(prompt).toContain('HOST');
      expect(prompt).toContain('writeSet');
    },
  );
});

describe('validadores adversariais em eixos ortogonais (spec 7.5)', () => {
  const VALIDATOR_IDS = [
    DYNAMIC_WORKFLOW_VALIDATOR_SPEC_ID,
    DYNAMIC_WORKFLOW_VALIDATOR_REGRESSION_ID,
    DYNAMIC_WORKFLOW_VALIDATOR_TESTS_ID,
  ];

  it.each(VALIDATOR_IDS)('%s retorna FINDINGS_SCHEMA (verdict + findings)', (id) => {
    const prompt = seedById(id).systemPrompt;
    expect(prompt).toContain('FINDINGS_SCHEMA');
    expect(prompt).toContain('verdict');
    expect(prompt).toContain('findings');
    expect(prompt).toContain('severity');
    expect(prompt).toContain('NAO corrige nada');
  });

  it('cada validador declara um eixo distinto (correcao / regressao / testes)', () => {
    expect(seedById(DYNAMIC_WORKFLOW_VALIDATOR_SPEC_ID).systemPrompt).toContain('criterios de aceite');
    expect(seedById(DYNAMIC_WORKFLOW_VALIDATOR_REGRESSION_ID).systemPrompt).toContain('regressao');
    const tests = seedById(DYNAMIC_WORKFLOW_VALIDATOR_TESTS_ID).systemPrompt;
    expect(tests).toContain('Cobertura e qualidade de testes');
    expect(tests).toContain('enforcement do writeSet foi desligado');
    expect(tests).not.toContain('e finding P1');
  });
});

describe('closer conversacional (spec 8.8)', () => {
  it('runtime e guard-capable (cloud/zai/minimax-tp, matriz 8.7)', () => {
    const closer = seedById(DYNAMIC_WORKFLOW_CLOSER_ID);
    expect(GUARD_CAPABLE_RUNTIMES).toContain(closer.runtime);
    expect(closer.runtime).toBe('cloud');
  });

  it('prompt cobre git local sob confirmacao e push sempre negado', () => {
    const prompt = seedById(DYNAMIC_WORKFLOW_CLOSER_ID).systemPrompt;
    expect(prompt).toContain('confirmacao');
    expect(prompt).toContain('git push');
    expect(prompt).toContain('SEMPRE negados');
    expect(prompt).toContain('walkthrough');
    expect(prompt).toContain('Socorro');
    expect(prompt).toContain('NAO re-executa o grafo');
    expect(prompt).toContain('NAO aprova gates');
  });
});

describe('agentes do plano (redesign por sprints, sec 4.1)', () => {
  it('os 4 do plano tem squad dynamic-workflow e estao no roster canonico', () => {
    for (const id of PLAN_IDS) {
      const seed = seedById(id);
      expect(seed.squad).toBe('dynamic-workflow');
      expect([...DYNAMIC_WORKFLOW_AGENT_IDS]).toContain(id);
    }
  });

  it.each(PLAN_IDS)('%s e read-only: so Read/Glob/Grep, sem Write/Edit/Bash', (id) => {
    const seed = seedById(id);
    for (const tool of WRITE_TOOLS) {
      expect(seed.allowedTools).not.toContain(tool);
    }
    expect(seed.allowedTools).toContain('Read');
    expect(seed.allowedTools).toContain('Glob');
    expect(seed.allowedTools).toContain('Grep');
  });

  it('sprint-planner espelha o harness-planner em espirito (O QUE nao COMO, opus, thinking)', () => {
    const seed = seedById('dynamic-workflow-sprint-planner');
    expect(seed.model).toContain('opus');
    expect(seed.thinking).toBe('enabled');
    expect(seed.thinkingBudget).toBe(16000);
    const prompt = seed.systemPrompt;
    expect(prompt).toContain('O QUE');
    expect(prompt).toContain('sprints');
    expect(prompt).toContain('sprints');
    expect(prompt).toContain('planVersion');
    expect(prompt).toContain('planHash');
  });

  const PLAN_VALIDATOR_IDS = [
    'dynamic-workflow-plan-validator-coverage',
    'dynamic-workflow-plan-validator-topology',
    'dynamic-workflow-plan-validator-criteria',
  ];

  it.each(PLAN_VALIDATOR_IDS)('%s retorna PLAN_FINDINGS_SCHEMA (verdict + findings + severity) e nao corrige', (id) => {
    const prompt = seedById(id).systemPrompt;
    expect(prompt).toContain('PLAN_FINDINGS_SCHEMA');
    expect(prompt).toContain('verdict');
    expect(prompt).toContain('findings');
    expect(prompt).toContain('severity');
    expect(prompt).toContain('NAO corrige nada');
  });

  it('cada validador de plano declara um eixo distinto (cobertura/topologia/criterios)', () => {
    expect(seedById('dynamic-workflow-plan-validator-coverage').systemPrompt).toContain('COBERTURA');
    expect(seedById('dynamic-workflow-plan-validator-topology').systemPrompt).toContain('TOPOLOGIA');
    expect(seedById('dynamic-workflow-plan-validator-criteria').systemPrompt).toContain('CRITERIOS');
  });
});

describe('refuter por evidencia (Fase 2, sec 4.2; F2-S6)', () => {
  it('esta no roster por papel com squad dynamic-workflow, ativo, runtime cloud', () => {
    const seed = seedById(DYNAMIC_WORKFLOW_REFUTER_ID);
    expect(DYNAMIC_WORKFLOW_REFUTER_ID).toBe('dynamic-workflow-refuter');
    expect(seed.squad).toBe('dynamic-workflow');
    expect(seed.isActive).toBe(true);
    expect(seed.runtime).toBe('cloud');
    expect([...DYNAMIC_WORKFLOW_AGENT_IDS]).toContain(DYNAMIC_WORKFLOW_REFUTER_ID);
  });

  it('e read-only PURO: allowedTools === Read/Glob/Grep, sem Write/Edit/Bash', () => {
    const seed = seedById(DYNAMIC_WORKFLOW_REFUTER_ID);
    expect(seed.allowedTools).toEqual(['Read', 'Glob', 'Grep']);
    for (const tool of WRITE_TOOLS) {
      expect(seed.allowedTools).not.toContain(tool);
    }
  });

  it('devolve REFUTE_SCHEMA com verdict real|ruido + evidencia + severityConfirmada', () => {
    const prompt = seedById(DYNAMIC_WORKFLOW_REFUTER_ID).systemPrompt;
    expect(prompt).toContain('REFUTE_SCHEMA');
    expect(prompt).toContain('verdict');
    expect(prompt).toContain('real');
    expect(prompt).toContain('ruido');
    expect(prompt).toContain('evidencia');
    expect(prompt).toContain('severityConfirmada');
  });

  it('e evidence-anchored (sem evidencia -> ruido) e NAO rebaixa severidade (Q3)', () => {
    const prompt = seedById(DYNAMIC_WORKFLOW_REFUTER_ID).systemPrompt;
    expect(prompt).toContain('Sem evidencia reproduzivel -> ruido');
    expect(prompt).toContain('NAO re-severa');
    expect(prompt).toContain('NAO corrige nada');
  });
});

describe('calibragem de severidade dos plan-validators (SM5-CONV: convergencia)', () => {
  const PLAN_VALIDATOR_IDS = [
    'dynamic-workflow-plan-validator-coverage',
    'dynamic-workflow-plan-validator-topology',
    'dynamic-workflow-plan-validator-criteria',
  ];

  it.each(PLAN_VALIDATOR_IDS)('%s tem o bloco de severidade DURO (lista fechada de P1, default P3)', (id) => {
    const prompt = seedById(id).systemPrompt;
    expect(prompt).toContain('regra DURISSIMA - calibragem SM5-R3');
    expect(prompt).toContain('lista FECHADA');
    expect(prompt).toContain('NUNCA e P1');
    expect(prompt).toContain('Default = P3');
    expect(prompt).toContain('ADVISORY');
    expect(prompt).toContain('NAO travam o plano');
  });

  it.each(PLAN_VALIDATOR_IDS)(
    '%s NAO carrega mais o marcador de calibragem antigo do V94 (OLD_MARKER da V96)',
    (id) => {
      expect(seedById(id).systemPrompt).not.toContain('Na duvida entre P1 e P2, use P2.');
    },
  );

  it('criteria rebaixa explicitamente os nits que travavam o plano (inspecao visual / mais objetivo)', () => {
    const prompt = seedById('dynamic-workflow-plan-validator-criteria').systemPrompt;
    expect(prompt).toContain('Inspecao visual sem seletor');
    expect(prompt).toContain('poderia ser MAIS objetivo');
  });

  it('topology nunca trata sizing como bloqueio (sizing JAMAIS bloqueia)', () => {
    const prompt = seedById('dynamic-workflow-plan-validator-topology').systemPrompt;
    expect(prompt).toContain('Sizing JAMAIS bloqueia');
  });

  it('coverage reserva P1 a buraco total de cobertura ou escopo inventado material', () => {
    const prompt = seedById('dynamic-workflow-plan-validator-coverage').systemPrompt;
    expect(prompt).toContain('BURACO TOTAL DE COBERTURA');
    expect(prompt).toContain('ESCOPO INVENTADO MATERIAL');
  });
});

describe('higiene dos textos', () => {
  it('zero em-dash (U+2014) em id/name/description/systemPrompt dos 12 seeds', () => {
    for (const seed of DYNAMIC_WORKFLOW_SEED_AGENTS) {
      const text = [seed.id, seed.name, seed.description, seed.systemPrompt].join('\n');
      expect(text.includes(EM_DASH)).toBe(false);
    }
  });

  it('nenhum prompt menciona o id de outro seed agent (regra de isolamento)', () => {
    const ALLOWED_MENTIONS: Record<string, readonly string[]> = {
      'dynamic-workflow-sprint-planner': ['dynamic-workflow-coder'],
    };
    for (const seed of DYNAMIC_WORKFLOW_SEED_AGENTS) {
      const allowed = ALLOWED_MENTIONS[seed.id] ?? [];
      for (const otherId of EXPECTED_IDS) {
        if (otherId === seed.id) continue;
        if (allowed.includes(otherId)) continue;
        expect(seed.systemPrompt.includes(otherId), `${seed.id} menciona ${otherId} (regra de isolamento)`).toBe(false);
      }
    }
  });
});

describe('Maestro seed registrado e editavel (SPEC-010 SM-11)', () => {
  it('o Maestro esta em ALL_SEED_AGENTS (semeado no boot, aparece em SubAgents)', () => {
    const ids = ALL_SEED_AGENTS.map((a) => a.id);
    expect(ids.filter((x) => x === DYNAMIC_WORKFLOW_MAESTRO_ID)).toHaveLength(1);
    expect(DYNAMIC_WORKFLOW_MAESTRO_ID).toBe('dynamic-workflow-maestro');
  });

  it('squad dynamic-workflow (cai na aba "Workflow Dinamico", nao no fallback library)', () => {
    expect(dynamicWorkflowMaestro.squad).toBe('dynamic-workflow');
    const cat = AGENT_CATEGORIES.find((c) => c.value === 'dynamic-workflow');
    expect(cat?.kind).toBe('workflow');
  });

  it('nasce LEAN e editavel: model/effort/thinking/maxTurns preenchidos, skills/mcp vazios', () => {
    expect(dynamicWorkflowMaestro.model.length).toBeGreaterThan(0);
    expect(dynamicWorkflowMaestro.effort).toBeDefined();
    expect(dynamicWorkflowMaestro.thinking).toBeDefined();
    expect(dynamicWorkflowMaestro.maxTurns).toBeGreaterThan(0);
    expect(dynamicWorkflowMaestro.skills).toEqual([]);
    expect(dynamicWorkflowMaestro.mcpServers).toEqual([]);
    expect(dynamicWorkflowMaestro.allowedTools).toEqual(['Read', 'Glob', 'Grep']);
    expect(dynamicWorkflowMaestro.isActive).toBe(true);
  });

  it('zero em-dash (U+2014) nos textos do Maestro', () => {
    const text = [
      dynamicWorkflowMaestro.id,
      dynamicWorkflowMaestro.name,
      dynamicWorkflowMaestro.description,
      dynamicWorkflowMaestro.systemPrompt,
    ].join('\n');
    expect(text.includes(EM_DASH)).toBe(false);
  });
});

describe('categoria de UI (spec 6.4)', () => {
  it('AGENT_CATEGORIES contem dynamic-workflow com kind workflow e label fixo', () => {
    const cat = AGENT_CATEGORIES.find((c) => c.value === 'dynamic-workflow');
    expect(cat).toBeDefined();
    expect(cat?.label).toBe('Workflow Dinamico');
    expect(cat?.kind).toBe('workflow');
  });
});

describe('seed security-spec-validator - registry guardrail (SPEC-loop-fix §3 fix B)', () => {
  it('esta em ALL_SEED_AGENTS exatamente uma vez (id unico)', () => {
    const matches = ALL_SEED_AGENTS.filter((a) => a.id === SECURITY_SPEC_VALIDATOR_ID);
    expect(matches).toHaveLength(1);
    expect(SECURITY_SPEC_VALIDATOR_ID).toBe('security-spec-validator');
  });

  it('squad security, ativo, runtime cloud (shape do seed)', () => {
    const seed = ALL_SEED_AGENTS.find((a) => a.id === SECURITY_SPEC_VALIDATOR_ID);
    expect(seed).toBeDefined();
    expect(seed!.squad).toBe('security');
    expect(seed!.isActive).toBe(true);
    expect(seed!.runtime).toBe('cloud');
    expect(seed!.id).toBe(securitySpecValidator.id);
    expect(securitySpecValidator.squad).toBe('security');
    expect(securitySpecValidator.isActive).toBe(true);
    expect(securitySpecValidator.runtime).toBe('cloud');
  });

  it('presente em SECURITY_SEED_AGENTS e SECURITY_AGENT_IDS', () => {
    expect(SECURITY_SEED_AGENTS.some((a) => a.id === SECURITY_SPEC_VALIDATOR_ID)).toBe(true);
    expect([...SECURITY_AGENT_IDS]).toContain(SECURITY_SPEC_VALIDATOR_ID);
    expect(SECURITY_SEED_AGENTS.filter((a) => a.id === SECURITY_SPEC_VALIDATOR_ID)).toHaveLength(1);
    expect([...SECURITY_AGENT_IDS].filter((id) => id === SECURITY_SPEC_VALIDATOR_ID)).toHaveLength(1);
  });

  it('R6 ADR: e ADITIVO — NUNCA reusa o id de outro validador de SPEC', () => {
    expect(SECURITY_SPEC_VALIDATOR_ID).not.toBe('spec-validator');
    expect(SECURITY_SPEC_VALIDATOR_ID).not.toBe('pipe2-spec-validator');
    expect(SECURITY_SPEC_VALIDATOR_ID).not.toBe('arch-spec-validator');
  });
});

describe('seed dynamic-workflow-doc-writer - registry (fechamento S1)', () => {
  it('esta em ALL_SEED_AGENTS exatamente uma vez, via DYNAMIC_WORKFLOW_AUTHORED_SEED_AGENTS', () => {
    const matches = ALL_SEED_AGENTS.filter((a) => a.id === DYNAMIC_WORKFLOW_DOC_WRITER_ID);
    expect(matches).toHaveLength(1);
    expect(DYNAMIC_WORKFLOW_DOC_WRITER_ID).toBe('dynamic-workflow-doc-writer');
    expect(DYNAMIC_WORKFLOW_AUTHORED_SEED_AGENTS.some((a) => a.id === DYNAMIC_WORKFLOW_DOC_WRITER_ID)).toBe(true);
    expect([...DYNAMIC_WORKFLOW_AGENT_IDS]).not.toContain(DYNAMIC_WORKFLOW_DOC_WRITER_ID);
  });

  it('squad dynamic-workflow, workspace-write SEM Bash (writer de texto), runtime cloud', () => {
    expect(dynamicWorkflowDocWriter.squad).toBe('dynamic-workflow');
    expect(dynamicWorkflowDocWriter.access).toBe('workspace-write');
    expect(dynamicWorkflowDocWriter.allowBash).toBe(false);
    expect(dynamicWorkflowDocWriter.allowedCommands).toEqual([]);
    expect(dynamicWorkflowDocWriter.allowNetwork).toBe(false);
    expect(dynamicWorkflowDocWriter.runtime).toBe('cloud');
    expect(dynamicWorkflowDocWriter.isActive).toBe(true);
    expect(dynamicWorkflowDocWriter.allowedTools).toContain('Write');
    expect(dynamicWorkflowDocWriter.allowedTools).toContain('Edit');
    expect(dynamicWorkflowDocWriter.allowedTools).not.toContain('Bash');
  });

  it('prompt e de escritor de documentos: nao toca codigo-fonte e respeita o writeSet', () => {
    const prompt = dynamicWorkflowDocWriter.systemPrompt;
    expect(prompt).toContain('DOCUMENTOS');
    expect(prompt).toMatch(/NAO toca codigo-fonte/);
    expect(prompt).toContain('writeSet');
  });

  it('higiene: zero em-dash e nenhuma mencao a outro seed agent (regra de isolamento)', () => {
    const text = [
      dynamicWorkflowDocWriter.id,
      dynamicWorkflowDocWriter.name,
      dynamicWorkflowDocWriter.description,
      dynamicWorkflowDocWriter.systemPrompt,
    ].join('\n');
    expect(text.includes(EM_DASH)).toBe(false);
    for (const otherId of EXPECTED_IDS) {
      expect(
        dynamicWorkflowDocWriter.systemPrompt.includes(otherId),
        `doc-writer menciona ${otherId} (regra de isolamento)`,
      ).toBe(false);
    }
  });
});

describe('L1.5: CODE_WRITER_AGENT_IDS cruza com os seeds writers de codigo', () => {
  it('coder, coder-codex, coder-glm e fixer estao na lista; doc-writer nao', () => {
    expect([...CODE_WRITER_AGENT_IDS].sort()).toEqual(
      [
        DYNAMIC_WORKFLOW_CODER_ID,
        DYNAMIC_WORKFLOW_CODER_CODEX_ID,
        DYNAMIC_WORKFLOW_CODER_GLM_ID,
        DYNAMIC_WORKFLOW_FIXER_ID,
      ].sort(),
    );
    expect(CODE_WRITER_AGENT_IDS.has(DYNAMIC_WORKFLOW_DOC_WRITER_ID)).toBe(false);
  });
});
