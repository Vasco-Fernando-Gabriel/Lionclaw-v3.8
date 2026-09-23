import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const state = vi.hoisted(() => ({
  settings: new Map<string, string>(),
  toolScriptRegister: false,
}));

vi.mock('../tool-script/tool-script-availability', () => ({
  resolveToolScriptRegistration: vi.fn(() => ({
    register: state.toolScriptRegister,
    available: state.toolScriptRegister,
    enabled: state.toolScriptRegister,
  })),
}));

vi.mock('../db', () => ({
  getAllAgents: vi.fn(() => []),
  getAgent: vi.fn(() => null),
  getSetting: vi.fn((key: string) => state.settings.get(key)),
  getCompletedDocsCount: vi.fn(() => 0),
}));

vi.mock('../mcp-manager', () => ({
  getAllMCPServers: vi.fn(() => [
    {
      id: 'google-gmail',
      name: 'Google Gmail',
      description: 'Email do dono',
      command: 'node',
      args: ['/x/gmail.js'],
      envKeys: [],
      isActive: true,
      visibleTo: 'all',
      indexMode: 'tools',
      status: 'stopped',
    },
  ]),
  getMcpToolRegistryEntries: vi.fn(() => [
    {
      mcpId: 'google-gmail',
      toolName: 'send_email',
      description: 'Envia um email pela conta do dono',
      inputSchema: null,
      lastDiscoveredAt: '2026-01-01T00:00:00.000Z',
    },
  ]),
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

import {
  buildSystemPrompt,
  buildMcpIndexSection,
  buildPipelineControlSection,
  buildDynamicWorkflowSection,
  buildPipelineControlStub,
  buildDynamicWorkflowStub,
} from '../prompt-builder';
import { CHAT_CAPABILITIES_LEGACY_ON } from '../../../src/types';
import type { ChatFeatureToggles } from '../../../src/types';

const PIPELINE_FULL_HEADER = '## Dirigir Pipelines (tools pipeline-control)';
const WORKFLOW_FULL_HEADER = '## Dirigir Workflows Dinamicos (tools dynamic-workflow)';
const PIPELINE_STUB_HEADER = '## Dirigir Pipelines (DESLIGADO nesta sessao)';
const WORKFLOW_STUB_HEADER = '## Dirigir Workflows Dinamicos (DESLIGADO nesta sessao)';

const PIPELINE_OFF: ChatFeatureToggles = { pipelineControl: false, dynamicWorkflows: true };
const WORKFLOWS_OFF: ChatFeatureToggles = { pipelineControl: true, dynamicWorkflows: false };
const BOTH_OFF: ChatFeatureToggles = { pipelineControl: false, dynamicWorkflows: false };

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-07-03T12:00:00.000Z'));
  state.settings = new Map();
  state.toolScriptRegister = false;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('default sem capabilities — legado on/on, secoes completas', () => {
  it('prompt full-mode contem as 2 secoes COMPLETAS e nenhum stub', () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain(PIPELINE_FULL_HEADER);
    expect(prompt).toContain('pipeline_create(projectPath');
    expect(prompt).toContain(WORKFLOW_FULL_HEADER);
    expect(prompt).toContain('dynamic_workflow_author(projectPath');
    expect(prompt).not.toContain(PIPELINE_STUB_HEADER);
    expect(prompt).not.toContain(WORKFLOW_STUB_HEADER);
    expect(prompt).not.toContain('DESLIGADA nesta sessao');
  });

  it('sem capabilities == CHAT_CAPABILITIES_LEGACY_ON explicito, byte a byte', () => {
    const withoutCapabilities = buildSystemPrompt();
    const withLegacyOn = buildSystemPrompt(undefined, {
      capabilities: { ...CHAT_CAPABILITIES_LEGACY_ON },
    });
    expect(withLegacyOn).toBe(withoutCapabilities);
  });

  it('ambos=true explicito == sem capabilities, byte a byte', () => {
    const explicitOn = buildSystemPrompt(undefined, {
      capabilities: { pipelineControl: true, dynamicWorkflows: true },
    });
    expect(explicitOn).toBe(buildSystemPrompt());
  });
});

describe('capability off — stub substitui a secao completa (A.5)', () => {
  it('pipelineControl=false: stub de Pipelines presente, secao completa AUSENTE, Workflows completa fica', () => {
    const prompt = buildSystemPrompt(undefined, { capabilities: PIPELINE_OFF });
    expect(prompt).toContain(buildPipelineControlStub());
    expect(prompt).not.toContain(PIPELINE_FULL_HEADER);
    expect(prompt).not.toContain('pipeline_create(projectPath');
    expect(prompt).not.toContain('pipeline_drive');
    expect(prompt).toContain(WORKFLOW_FULL_HEADER);
    expect(prompt).toContain('dynamic_workflow_author(projectPath');
    expect(prompt).not.toContain(WORKFLOW_STUB_HEADER);
  });

  it('pipelineControl=false: o UNICO delta vs o default e stub<->secao (replace reproduz byte a byte)', () => {
    const promptOff = buildSystemPrompt(undefined, { capabilities: PIPELINE_OFF });
    const promptDefault = buildSystemPrompt();
    expect(promptOff.replace(buildPipelineControlStub(), buildPipelineControlSection())).toBe(promptDefault);
  });

  it('dynamicWorkflows=false: stub de Workflows presente, secao completa AUSENTE, Pipelines completa fica', () => {
    const prompt = buildSystemPrompt(undefined, { capabilities: WORKFLOWS_OFF });
    expect(prompt).toContain(buildDynamicWorkflowStub());
    expect(prompt).not.toContain(WORKFLOW_FULL_HEADER);
    expect(prompt).not.toContain('dynamic_workflow_author(projectPath');
    expect(prompt).toContain(PIPELINE_FULL_HEADER);
  });

  it('dynamicWorkflows=false: replace(stub -> secao completa) reproduz o default byte a byte', () => {
    const promptOff = buildSystemPrompt(undefined, { capabilities: WORKFLOWS_OFF });
    expect(promptOff.replace(buildDynamicWorkflowStub(), buildDynamicWorkflowSection())).toBe(buildSystemPrompt());
  });

  it('ambos=false: 2 stubs; replace duplo reproduz o default byte a byte', () => {
    const promptOff = buildSystemPrompt(undefined, { capabilities: BOTH_OFF });
    expect(promptOff).toContain(PIPELINE_STUB_HEADER);
    expect(promptOff).toContain(WORKFLOW_STUB_HEADER);
    expect(
      promptOff
        .replace(buildPipelineControlStub(), buildPipelineControlSection())
        .replace(buildDynamicWorkflowStub(), buildDynamicWorkflowSection()),
    ).toBe(buildSystemPrompt());
  });

  it('stubs anunciam a existencia + o chip (A.9 pedagogica), sem em-dash', () => {
    for (const stub of [buildPipelineControlStub(), buildDynamicWorkflowStub()]) {
      expect(stub).toContain('DESLIGADA nesta sessao');
      expect(stub).toContain('NAO tente dirigir');
      expect(stub).toContain('rodape do chat e reenviar');
      expect(stub).not.toContain('—');
    }
    expect(buildPipelineControlStub()).toContain('chip Pipeline');
    expect(buildDynamicWorkflowStub()).toContain('chip Workflows');
  });

  it('chatSurface kimi-sdk tambem recebe o stub (mesmo mecanismo compartilhado)', () => {
    const prompt = buildSystemPrompt(undefined, {
      chatSurface: 'kimi-sdk',
      capabilities: PIPELINE_OFF,
    });
    expect(prompt).toContain(PIPELINE_STUB_HEADER);
    expect(prompt).not.toContain(PIPELINE_FULL_HEADER);
  });
});

describe('indice MCP — capability off nao vaza para o bloco do indice', () => {
  it('buildMcpIndexSection com capability off: helper gated ausente, negocio presente', () => {
    const section = buildMcpIndexSection(BOTH_OFF);
    expect(section).toContain('google-gmail');
    expect(section).toContain('send_email');
    expect(section).not.toContain('lionclaw-pipeline-control');
    expect(section).not.toContain('lionclaw-dynamic-workflows');
  });

  it('buildMcpIndexSection sem capabilities == com LEGACY_ON, byte a byte', () => {
    expect(buildMcpIndexSection({ ...CHAT_CAPABILITIES_LEGACY_ON })).toBe(buildMcpIndexSection());
  });

  it('prompt com capability off mantem o bloco do indice (so as secoes gated mudam)', () => {
    const prompt = buildSystemPrompt(undefined, { capabilities: BOTH_OFF });
    expect(prompt).toContain('## Servidores MCP (indice via gateway)');
  });
});

describe('minimal mode — intacto', () => {
  it('minimal com capabilities off == minimal sem capabilities, byte a byte', () => {
    const withOff = buildSystemPrompt(undefined, { mode: 'minimal', capabilities: BOTH_OFF });
    const without = buildSystemPrompt(undefined, { mode: 'minimal' });
    expect(withOff).toBe(without);
  });

  it('minimal nunca contem secao completa NEM stub', () => {
    const minimal = buildSystemPrompt(undefined, { mode: 'minimal', capabilities: BOTH_OFF });
    expect(minimal).not.toContain(PIPELINE_FULL_HEADER);
    expect(minimal).not.toContain(WORKFLOW_FULL_HEADER);
    expect(minimal).not.toContain(PIPELINE_STUB_HEADER);
    expect(minimal).not.toContain(WORKFLOW_STUB_HEADER);
  });
});

const TOOLSCRIPT_HEADER = '## Executar suas tools em lote (run_tool_script)';

describe('secao run_tool_script — gatilhada por disponibilidade', () => {
  it('tool INDISPONIVEL (register=false): sem secao run_tool_script', () => {
    state.toolScriptRegister = false;
    const prompt = buildSystemPrompt();
    expect(prompt).not.toContain(TOOLSCRIPT_HEADER);
    expect(prompt).not.toContain('run_tool_script');
  });

  it('tool DISPONIVEL (register=true): full mode ganha a secao com a fronteira reducao-vs-analise', () => {
    state.toolScriptRegister = true;
    const prompt = buildSystemPrompt();
    expect(prompt).toContain(TOOLSCRIPT_HEADER);
    expect(prompt).toContain('REDUCAO MECANICA');
    expect(prompt).toContain('NAO use run_tool_script para ANALISE');
  });

  it('minimal mode nunca ganha a secao, mesmo com a tool disponivel', () => {
    state.toolScriptRegister = true;
    const minimal = buildSystemPrompt(undefined, { mode: 'minimal' });
    expect(minimal).not.toContain(TOOLSCRIPT_HEADER);
  });

  it('anuncio nao derruba o prompt se a resolucao lancar (fail-safe)', async () => {
    const mod = await import('../tool-script/tool-script-availability');
    vi.mocked(mod.resolveToolScriptRegistration).mockImplementationOnce(() => {
      throw new Error('boom');
    });
    expect(() => buildSystemPrompt()).not.toThrow();
    expect(buildSystemPrompt()).not.toContain(TOOLSCRIPT_HEADER);
  });
});

describe('pipeline control: contrato de lanes', () => {
  it('explica propriedade, limite por lane e a acao humana no Pipeline', () => {
    const prompt = buildPipelineControlSection();
    expect(prompt).toContain('cada lane de chat conduz no maximo um pipeline');
    expect(prompt).toContain('pipelines dirigidos por outra lane nao aparecem para voce e nao sao seus');
    expect(prompt).toContain(
      'Parar ou Assumir um drive e pela pagina Pipeline: nao existe tool para isso, diga ao humano',
    );
  });
});
