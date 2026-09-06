
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db', () => ({
  getAllAgents: vi.fn(() => []),
  getAgent: vi.fn(() => null),
  getSetting: vi.fn(() => undefined),
  getCompletedDocsCount: vi.fn(() => 0),
}));

vi.mock('../mcp-manager', () => ({
  getAllMCPServers: vi.fn(() => []),
  getMcpToolRegistryEntries: vi.fn(() => []),
}));

vi.mock('../skills', () => ({
  buildSkillsPromptSection: vi.fn(() => ''),
  buildAgentSkillsPromptSection: vi.fn(() => ''),
}));

vi.mock('../paths', () => ({
  getLionClawHome: () => '/nonexistent-lionclaw-home-for-tests',
}));

vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { getAllAgents, getSetting, getCompletedDocsCount } from '../db';
import {
  buildSubagentIndexSection,
  buildSubagentsSection,
  buildSystemPrompt,
  getSubagentsPromptMode,
} from '../prompt-builder';
import {
  INDEX_PIPELINE_INTERNAL_SQUADS,
  summarizeAgentDescription,
} from '../subagent-summary';
import { estimateTokens } from '../token-estimator';

const mockGetAllAgents = getAllAgents as ReturnType<typeof vi.fn>;
const mockGetSetting = getSetting as ReturnType<typeof vi.fn>;
const mockGetCompletedDocsCount = getCompletedDocsCount as ReturnType<typeof vi.fn>;

interface FixtureAgent {
  id: string;
  name: string;
  description: string;
  model: string;
  allowedTools: string[];
  skills: string[];
  isActive: boolean;
  runtime: string;
  squad?: string;
  kb_enabled?: number;
  localConfig?: { provider: string; model: string };
  externalConfig?: { provider: string; model: string };
  codexConfig?: { model: string };
}

function makeAgent(overrides: Partial<FixtureAgent> & Pick<FixtureAgent, 'id'>): FixtureAgent {
  return {
    name: `Agent ${overrides.id}`,
    description: `Especialista dedicado do dominio ${overrides.id}, cobre analise, execucao e revisao. Detalhes longos adicionais que nao entram no resumo do indice porque passam do corte.`,
    model: 'claude-sonnet-4-6',
    allowedTools: ['Read', 'Write', 'Edit', 'Bash'],
    skills: [],
    isActive: true,
    runtime: 'cloud',
    squad: '',
    ...overrides,
  };
}

const INTERNAL_SQUADS = ['harness', 'pipeline', 'security', 'feature', 'enrich'];

function fixture126(): FixtureAgent[] {
  const agents: FixtureAgent[] = [];
  for (let i = 1; i <= 48; i++) {
    agents.push(
      makeAgent({
        id: `chat-agent-${String(i).padStart(2, '0')}`,
        squad: i % 3 === 0 ? 'dev' : '',
      }),
    );
  }
  for (const squad of INTERNAL_SQUADS) {
    for (let i = 1; i <= 14; i++) {
      agents.push(makeAgent({ id: `${squad}-int-${String(i).padStart(2, '0')}`, squad }));
    }
  }
  for (let i = 1; i <= 4; i++) {
    agents.push(
      makeAgent({
        id: `local-${i}`,
        runtime: 'local',
        localConfig: { provider: 'ollama', model: 'llama3.1:8b' },
      }),
    );
  }
  for (let i = 1; i <= 3; i++) {
    agents.push(
      makeAgent({
        id: `external-${i}`,
        runtime: 'external',
        externalConfig: { provider: 'openrouter', model: 'deepseek-v3' },
      }),
    );
  }
  agents.push(
    makeAgent({ id: 'codex-1', runtime: 'codex', codexConfig: { model: 'gpt-5.2-codex' } }),
  );
  return agents;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetAllAgents.mockReturnValue(fixture126());
  mockGetSetting.mockReturnValue(undefined);
  mockGetCompletedDocsCount.mockReturnValue(0);
});

describe('AC-58 — orcamento e presenca com 126 agentes', () => {
  it('fixture tem exatamente 126 agentes ativos', () => {
    expect(fixture126().length).toBe(126);
  });

  it('indice mede <= 2.200 tokens (estimateTokens chars/4)', () => {
    const section = buildSubagentIndexSection();
    expect(section.length).toBeGreaterThan(0);
    expect(estimateTokens(section)).toBeLessThanOrEqual(2200);
  });

  it('contem o id de TODO agente chat-eligible individualmente (linha propria)', () => {
    const section = buildSubagentIndexSection();
    for (let i = 1; i <= 48; i++) {
      const id = `chat-agent-${String(i).padStart(2, '0')}`;
      expect(section).toContain(`- ${id}: `);
    }
  });

  it('contem os ids de TODOS os pipeline-internos agrupados por squad (1 linha por squad)', () => {
    const section = buildSubagentIndexSection();
    for (const squad of INTERNAL_SQUADS) {
      const line = section
        .split('\n')
        .find((l) => l.startsWith(`- ${squad}: `));
      expect(line, `linha da squad ${squad}`).toBeDefined();
      for (let i = 1; i <= 14; i++) {
        expect(line).toContain(`${squad}-int-${String(i).padStart(2, '0')}`);
      }
    }
  });

  it('pipeline-internos NAO ganham linha individual de resumo', () => {
    const section = buildSubagentIndexSection();
    expect(section).not.toContain('- harness-int-01: ');
  });
});

describe('AC-65 — nota de alcance POR ROTA', () => {
  it('reflete a matriz real: Task/lion_run_subagent alcancam; call_agent/Agent recusam', () => {
    const section = buildSubagentIndexSection();
    expect(section).toContain('Task tool (cloud/compat)');
    expect(section).toContain('lion_run_subagent (kimi)');
    expect(section).toContain('call_agent (codex/lion)');
    expect(section).toContain('recusam squads internos');
  });
});

describe('sufixo [KB:n] — mesma regra kb_enabled do gate legado (AC-67)', () => {
  it('aparece quando kb_enabled != 0 e docCount > 0', () => {
    mockGetCompletedDocsCount.mockImplementation((id: string) =>
      id === 'chat-agent-01' ? 3 : 0,
    );
    const section = buildSubagentIndexSection();
    const line = section.split('\n').find((l) => l.startsWith('- chat-agent-01: '));
    expect(line).toContain('[KB:3]');
  });

  it('NAO aparece quando kb_enabled === 0, mesmo com docs', () => {
    const agents = fixture126();
    agents[0]!.kb_enabled = 0; // chat-agent-01
    mockGetAllAgents.mockReturnValue(agents);
    mockGetCompletedDocsCount.mockReturnValue(5);
    const section = buildSubagentIndexSection();
    const line = section.split('\n').find((l) => l.startsWith('- chat-agent-01: '));
    expect(line).not.toContain('[KB:');
  });

  it('NAO aparece quando docCount === 0', () => {
    const section = buildSubagentIndexSection();
    expect(section).not.toContain('[KB:');
  });
});

describe('resumo deterministico (13.2 item 1)', () => {
  it('corta na primeira sentenca quando ela vem antes de 80 chars', () => {
    expect(summarizeAgentDescription('Faz backend. E mais coisas depois.', 'X')).toBe(
      'Faz backend.',
    );
  });

  it('corta em 80 chars quando a primeira sentenca e maior', () => {
    const longa = 'a'.repeat(60) + ' ' + 'b'.repeat(60) + '.';
    const resumo = summarizeAgentDescription(longa, 'X');
    expect(resumo.length).toBeLessThanOrEqual(80);
    expect(resumo).toBe(('a'.repeat(60) + ' ' + 'b'.repeat(60)).slice(0, 80).trimEnd());
  });

  it('corta em 80 chars quando NAO ha pontuacao de sentenca', () => {
    const semPonto = 'palavra '.repeat(30).trim();
    const resumo = summarizeAgentDescription(semPonto, 'X');
    expect(resumo.length).toBeLessThanOrEqual(80);
  });

  it('fallback = name quando description vazia/whitespace', () => {
    expect(summarizeAgentDescription('', 'Nome Fallback')).toBe('Nome Fallback');
    expect(summarizeAgentDescription('   ', 'Nome Fallback')).toBe('Nome Fallback');
    expect(summarizeAgentDescription(undefined, 'Nome Fallback')).toBe('Nome Fallback');
  });

  it('colapsa whitespace interno (linha do indice nunca quebra)', () => {
    expect(summarizeAgentDescription('Faz\nbackend\te   apis.', 'X')).toBe('Faz backend e apis.');
  });
});

describe('sub-blocos local/external/codex em dieta 1-linha (13.2 item 4)', () => {
  it('usa uma rota canônica e mantém 1 linha por agente com runtime/modelo', () => {
    const section = buildSubagentIndexSection();
    expect(section).toContain('## Subagentes não-Cloud (via lionclaw-agents.call_agent)');
    expect(section).toContain('(local/claude-sonnet-4-6)');
    expect(section).toContain('(external/claude-sonnet-4-6)');
    expect(section).toContain('(codex/claude-sonnet-4-6)');
    expect(section).not.toContain('run_local_agent');
    expect(section).not.toContain('run_external_agent');
    expect(section).not.toContain('run_codex_agent');
  });

  it('sem dupla listagem: cada id chat-eligible cloud aparece exatamente 1 vez', () => {
    const section = buildSubagentIndexSection();
    const occurrences = section.split('- chat-agent-01: ').length - 1;
    expect(occurrences).toBe(1);
  });
});

describe('ponteiro de expansao por CAPACIDADE (neutro, 13.2 item 3)', () => {
  it('aponta para list_agents/agent_details sem nomear prefixo de runtime', () => {
    const section = buildSubagentIndexSection();
    expect(section).toContain('onde houver list_agents/agent_details, consulte antes de delegar');
    expect(section).not.toContain('mcp__lionclaw-agents__agent_details');
  });

  it('quando-delegar condensado presente', () => {
    const section = buildSubagentIndexSection();
    expect(section).toContain('## Quando delegar');
    expect(section).toContain('lionclaw-agents.call_agent');
    expect(section).toContain('não selecione ferramenta pelo provider');
  });
});

describe('AC-66 — toggle subagents_prompt_mode', () => {
  it("default (chave ausente) = 'index'", () => {
    expect(getSubagentsPromptMode()).toBe('index');
  });

  it("'full' restaura a secao legada no buildSystemPrompt", () => {
    mockGetSetting.mockImplementation((key: string) =>
      key === 'subagents_prompt_mode' ? 'full' : undefined,
    );
    const legacy = buildSubagentsSection();
    const prompt = buildSystemPrompt();
    expect(prompt).toContain(legacy);
    expect(prompt).not.toContain('# Subagentes (indice compacto)');
  });

  it("'index' (default) usa o indice no buildSystemPrompt e NAO a secao legada", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain('# Subagentes (indice compacto)');
    expect(prompt).not.toContain('# Subagentes Cloud');
  });

  it('secao full preserva detalhes e usa a rota canônica (snapshot de bytes)', () => {
    mockGetAllAgents.mockReturnValue([
      makeAgent({
        id: 'cloud-a',
        name: 'Cloud A',
        description: 'Agente cloud A.',
        skills: ['skill-x'],
      }),
      makeAgent({
        id: 'local-a',
        name: 'Local A',
        description: 'Agente local A.',
        runtime: 'local',
        localConfig: { provider: 'ollama', model: 'llama3' },
      }),
    ]);
    expect(buildSubagentsSection()).toMatchSnapshot();
  });
});

describe('alinhamento de squads internos (AC-63 companheiro)', () => {
  it('INDEX_PIPELINE_INTERNAL_SQUADS == conjunto canonico {harness,pipeline,security,feature,enrich}', () => {
    expect([...INDEX_PIPELINE_INTERNAL_SQUADS].sort()).toEqual(
      ['enrich', 'feature', 'harness', 'pipeline', 'security'],
    );
  });
});

describe('AC-68 — indice herdado pelas lanes (mesmo buildSystemPrompt full)', () => {
  it('buildSystemPrompt minimal mode NAO carrega indice nem secao legada (fronteira intacta)', () => {
    const minimal = buildSystemPrompt(undefined, { mode: 'minimal' });
    expect(minimal).not.toContain('# Subagentes (indice compacto)');
    expect(minimal).not.toContain('# Subagentes Cloud');
  });
});
