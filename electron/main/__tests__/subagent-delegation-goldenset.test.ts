
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));
vi.mock('../db', () => ({
  getAllAgents: vi.fn(() => []),
  getAgent: vi.fn(() => null),
  getSetting: vi.fn(() => undefined),
  getCompletedDocsCount: vi.fn(() => 0),
}));
vi.mock('../mcp-manager', () => ({ getAllMCPServers: vi.fn(() => []) }));
vi.mock('../skills', () => ({
  buildSkillsPromptSection: vi.fn(() => ''),
  buildAgentSkillsPromptSection: vi.fn(() => ''),
}));
vi.mock('../paths', () => ({
  getLionClawHome: () => '/nonexistent-lionclaw-home-for-tests',
}));

import { getAllAgents } from '../db';
import { buildSubagentIndexSection, buildSubagentsSection } from '../prompt-builder';
import { buildLionSubagentCatalogPrompt } from '../lion-sdk/prompt';
import type { AgentConfig } from '../../../src/types';

const mockGetAllAgents = getAllAgents as ReturnType<typeof vi.fn>;

const GOLDEN_SET: Array<{
  prompt: string;
  expectedAgentId: string;
  triggers: string[];
}> = [
  {
    prompt: 'Pesquise a fundo as opcoes de biblioteca de PDF e compare com fontes',
    expectedAgentId: 'deep-researcher',
    triggers: ['pesquisa', 'fontes'],
  },
  {
    prompt: 'Implemente o endpoint de checkout no backend com testes',
    expectedAgentId: 'backend-developer',
    triggers: ['backend', 'APIs'],
  },
  {
    prompt: 'Revise este diff procurando bugs de correcao',
    expectedAgentId: 'code-reviewer',
    triggers: ['Revisa', 'bugs'],
  },
  {
    prompt: 'Audite a seguranca deste modulo de autenticacao',
    expectedAgentId: 'security-auditor',
    triggers: ['seguranca', 'vulnerabilidades'],
  },
  {
    prompt: 'Traduza este documento para ingles',
    expectedAgentId: 'translator-local',
    triggers: ['Traduz'],
  },
  {
    prompt: 'Escreva a documentacao de usuario da feature nova',
    expectedAgentId: 'docs-writer',
    triggers: ['documentacao'],
  },
];

const GOLDEN_AGENTS = [
  {
    id: 'deep-researcher',
    name: 'Deep Researcher',
    description:
      'Faz pesquisa profunda multi-fontes com verificacao adversarial e sintese com citacoes. Ideal para comparativos e decisoes tecnicas.',
    runtime: 'cloud',
    squad: '',
  },
  {
    id: 'backend-developer',
    name: 'Backend Developer',
    description:
      'Especialista em backend, APIs, bancos e servicos; implementa endpoints com testes. Cobre Node, SQL e integracao.',
    runtime: 'cloud',
    squad: 'dev',
  },
  {
    id: 'code-reviewer',
    name: 'Code Reviewer',
    description:
      'Revisa diffs procurando bugs de correcao, regressoes e simplificacoes. Nao escreve features.',
    runtime: 'cloud',
    squad: '',
  },
  {
    id: 'security-auditor',
    name: 'Security Auditor',
    description:
      'Audita seguranca: vulnerabilidades, OWASP, segredos expostos e isolamento. Retorna findings acionaveis.',
    runtime: 'cloud',
    squad: '',
  },
  {
    id: 'translator-local',
    name: 'Translator Local',
    description: 'Traduz textos entre pt/en/es rodando localmente, custo zero.',
    runtime: 'local',
    squad: '',
    localConfig: { provider: 'ollama', model: 'llama3.1:8b' },
  },
  {
    id: 'docs-writer',
    name: 'Docs Writer',
    description:
      'Escreve documentacao de usuario e tecnica clara, com exemplos e estrutura consistente.',
    runtime: 'cloud',
    squad: '',
  },
].map((a) => ({
  model: 'claude-sonnet-4-6',
  allowedTools: ['Read', 'Write'],
  skills: [],
  isActive: true,
  ...a,
}));

beforeEach(() => {
  vi.clearAllMocks();
  mockGetAllAgents.mockReturnValue(GOLDEN_AGENTS);
});

describe('AC-60 (estatico) — indice compacto carrega id + gatilhos de cada alvo', () => {
  it('cada agente-alvo tem linha propria no indice com os gatilhos no resumo', () => {
    const index = buildSubagentIndexSection();
    for (const entry of GOLDEN_SET) {
      const line = index
        .split('\n')
        .find((l) => l.startsWith(`- ${entry.expectedAgentId}: `));
      expect(line, `linha do alvo ${entry.expectedAgentId}`).toBeDefined();
      for (const trigger of entry.triggers) {
        expect(
          line!.toLowerCase(),
          `gatilho "${trigger}" no resumo de ${entry.expectedAgentId}`,
        ).toContain(trigger.toLowerCase());
      }
    }
  });

  it('a secao legada (toggle full) contem os MESMOS ids-alvo (rollback nao muda alvo)', () => {
    const legacy = buildSubagentsSection();
    for (const entry of GOLDEN_SET) {
      expect(legacy).toContain(entry.expectedAgentId);
    }
  });

  it('o catalogo lion compactado carrega id + gatilhos (runtime lion)', () => {
    const chatEligible = GOLDEN_AGENTS as unknown as AgentConfig[];
    const catalog = buildLionSubagentCatalogPrompt(chatEligible, 'index');
    for (const entry of GOLDEN_SET) {
      const line = catalog
        .split('\n')
        .find((l) => l.startsWith(`- ${entry.expectedAgentId}: `));
      expect(line, `linha do alvo ${entry.expectedAgentId} no catalogo lion`).toBeDefined();
      for (const trigger of entry.triggers) {
        expect(line!.toLowerCase()).toContain(trigger.toLowerCase());
      }
    }
  });
});
