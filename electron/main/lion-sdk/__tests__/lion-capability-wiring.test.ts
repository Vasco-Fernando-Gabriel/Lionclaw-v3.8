
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { OrchestratorSelection } from '../../orchestrator-selection';
import type { ChatFeatureToggles } from '../../../../src/types';


const settings = new Map<string, string>();

vi.mock('../../db', () => ({
  createSession: vi.fn(),
  getActiveChatSession: vi.fn(() => null),
  getAllAgents: vi.fn(() => []),
  getSession: vi.fn(() => ({ id: 'sid', title: 't', type: 'chat' })),
  getSessionMessages: vi.fn(() => []),
  insertMessage: vi.fn(() => 1),
  getTurnIndexForUserMessage: vi.fn(() => 7),
  getLatestUserTurnIndex: vi.fn(() => 0),
  updateSessionTokens: vi.fn(),
  setSessionActiveContextTokens: vi.fn(),
  clearSessionPendingSeed: vi.fn(),
  insertAuditEntry: vi.fn(),
  getPermissionBypass: vi.fn(() => false),
  getSetting: vi.fn((key: string) => settings.get(key) ?? ''),
}));

vi.mock('../../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../../pricing', () => ({ calculateCost: vi.fn(() => 0.5) }));


const BROAD_CONFIG: Record<string, { command: string; args: string[] }> = {
  'google-drive': { command: 'node', args: ['drive.js'] },
  'lionclaw-pipeline-control': { command: 'node', args: ['pipe.js'] },
  'lionclaw-dynamic-workflows': { command: 'node', args: ['dyn.js'] },
};

const REGISTRY = [
  {
    mcpId: 'google-drive',
    toolName: 'list_files',
    description: 'List files from the user Drive folder',
    inputSchema: null,
    lastDiscoveredAt: '2026-07-01T00:00:00.000Z',
  },
  {
    mcpId: 'lionclaw-pipeline-control',
    toolName: 'pipeline_drive',
    description: 'Drive de pipeline por chat',
    inputSchema: null,
    lastDiscoveredAt: '2026-07-01T00:00:00.000Z',
  },
  {
    mcpId: 'lionclaw-dynamic-workflows',
    toolName: 'dynamic_workflow_generate',
    description: 'Gera um dynamic workflow',
    inputSchema: null,
    lastDiscoveredAt: '2026-07-01T00:00:00.000Z',
  },
];

const MOCK_SERVERS = [
  { id: 'google-drive', name: 'Google Drive', description: 'Drive', isActive: true, indexMode: 'tools' as const },
  { id: 'lionclaw-pipeline-control', name: 'Pipeline Control', description: 'Pipe', isActive: true, indexMode: 'tools' as const },
  { id: 'lionclaw-dynamic-workflows', name: 'Dynamic Workflows', description: 'Dyn', isActive: true, indexMode: 'tools' as const },
];

function applyS5aFilter(
  config: Record<string, { command: string; args: string[] }>,
  capabilities?: ChatFeatureToggles,
): Record<string, { command: string; args: string[] }> {
  if (!capabilities) return { ...config };
  const gatedByServer: Record<string, keyof ChatFeatureToggles> = {
    'lionclaw-pipeline-control': 'pipelineControl',
    'lionclaw-dynamic-workflows': 'dynamicWorkflows',
  };
  const out: Record<string, { command: string; args: string[] }> = {};
  for (const [id, spec] of Object.entries(config)) {
    const gated = gatedByServer[id];
    if (gated !== undefined && capabilities[gated] === false) continue;
    out[id] = spec;
  }
  return out;
}

const getMCPConfigForAgent = vi.fn(
  async (_agentId?: string, opts?: { surface?: string; capabilities?: ChatFeatureToggles }) =>
    applyS5aFilter(BROAD_CONFIG, opts?.capabilities),
);
const getMCPToolsFromRegistry = vi.fn((ids: string[]) =>
  REGISTRY.filter((e) => ids.includes(e.mcpId)).map((e) => `mcp__${e.mcpId}__${e.toolName}`),
);
const getMcpToolRegistryEntries = vi.fn((mcpId?: string) =>
  mcpId ? REGISTRY.filter((e) => e.mcpId === mcpId) : REGISTRY,
);
const getAllMCPServers = vi.fn(() => MOCK_SERVERS);

vi.mock('../../mcp-manager', () => ({
  getMCPConfigForAgent: (...a: unknown[]) =>
    getMCPConfigForAgent(...(a as [string?, { surface?: string; capabilities?: ChatFeatureToggles }?])),
  getMCPToolsFromRegistry: (...a: unknown[]) => getMCPToolsFromRegistry(...(a as [string[]])),
  getMcpToolRegistryEntries: (...a: unknown[]) => getMcpToolRegistryEntries(...(a as [string?])),
  getAllMCPServers: () => getAllMCPServers(),
  discoverAndSaveMCPTools: vi.fn(async () => [] as string[]),
}));

const setupMCPsForSession = vi.fn(async (config: Record<string, unknown>) => ({
  client: { connections: Object.keys(config).map((serverId) => ({ serverId })) },
  tools: [] as unknown[],
}));
vi.mock('../../mcp-tool-bridge', () => ({
  setupMCPsForSession: (...a: unknown[]) =>
    setupMCPsForSession(...(a as [Record<string, unknown>])),
  teardownMCPsForSession: vi.fn(async () => {}),
  callMCPTool: vi.fn(async () => ({ content: [{ type: 'text', text: 'ok' }] })),
}));

vi.mock('../../permission-guard', () => ({
  createPermissionGuard: vi.fn(() => vi.fn(async () => ({ behavior: 'allow' }))),
}));


vi.mock('../../skills', () => ({ listSkills: vi.fn(() => []) }));
vi.mock('../../title-generator', () => ({ ensureInitialSessionTitle: vi.fn() }));
vi.mock('../../dreaming-turn-engine', () => ({ recordCompletedMainChatTurn: vi.fn() }));
vi.mock('../../onboarding', () => ({
  completeOnboardingFromConversationMessages: vi.fn(),
  completeOnboardingFromUserProfileMessage: vi.fn(() => false),
  extractAndProcessOnboardingData: vi.fn(() => null),
  resolveOnboardingCompletedFromState: vi.fn(() => false),
}));

const PIPE_FULL_SENTINEL = '## Pipeline Control\n\nPIPE-FULL-SECTION';
const PIPE_STUB_SENTINEL = '## Dirigir Pipelines (DESLIGADO nesta sessao)\n\nPIPE-STUB-SECTION';
vi.mock('../../prompt-builder', () => ({
  buildSystemPrompt: vi.fn(() => 'SYS'),
  buildPipelineControlSection: vi.fn(() => PIPE_FULL_SENTINEL),
  buildPipelineControlStub: vi.fn(() => PIPE_STUB_SENTINEL),
  getSubagentsPromptMode: vi.fn(() => 'index'),
}));
vi.mock('../../prompt-builder-repo-graph', () => ({
  getRepoGraphPromptSection: vi.fn(() => ''),
}));
vi.mock('../runtime-context', () => ({
  buildLionRuntimeContextPrompt: vi.fn(() => '## LionClaw Runtime Context\n\nRUNTIME-CONTEXT'),
}));

vi.mock('../adapters/ollama', () => ({
  createOllamaAdapter: vi.fn(() => ({ name: 'ollama', streamCompletion: vi.fn() })),
}));
vi.mock('../adapters/lmstudio', () => ({
  createLmStudioAdapter: vi.fn(() => ({ name: 'lmstudio', streamCompletion: vi.fn() })),
}));
vi.mock('../adapters/openai-compatible', () => ({
  createOpenAiCompatibleAdapter: vi.fn(() => ({
    name: 'openai-compatible',
    streamCompletion: vi.fn(),
  })),
}));
vi.mock('../adapters/google-genai', () => ({
  createGoogleGenAiAdapter: vi.fn(() => ({ name: 'google-genai', streamCompletion: vi.fn() })),
}));
vi.mock('../title', () => ({ maybeGenerateLionSessionTitle: vi.fn(async () => {}) }));

vi.mock('../compaction', () => ({
  compactIfNeeded: vi.fn(async () => ({
    messages: [{ role: 'user' as const, content: 'oi' }],
    compacted: false,
  })),
}));

interface CapturedLoopOpts {
  initialMessages: Array<{ role: string; content: string }>;
  tools: Array<{ name: string }>;
}
let capturedLoopOpts: CapturedLoopOpts | null = null;
const runLionLoop = vi.fn(async (opts: CapturedLoopOpts) => {
  capturedLoopOpts = opts;
  return { finalText: 'resposta lion', ok: true, usage: { inputTokens: 1, outputTokens: 1 } };
});
vi.mock('../runtime', () => ({
  MAX_TOOL_TURNS: 5,
  runLionLoop: (...a: unknown[]) => runLionLoop(...(a as [CapturedLoopOpts])),
}));


import { executeLionSdkQuery } from '../index';
import { desktopLane, telegramLane } from '../../sdk-lane';
import {
  registerChatCapabilityTurn,
  setActiveChatTurn,
  __resetChatCapabilityContextForTests,
} from '../../chat-capability-context';
import type { SdkLane } from '../../sdk-lane';

const OLLAMA: OrchestratorSelection = {
  runtime: 'lion-sdk',
  provider: 'ollama',
  model: 'qwen3:32b',
  baseUrl: 'http://localhost:11434',
  source: 'settings',
};

const OFF: ChatFeatureToggles = { pipelineControl: false, dynamicWorkflows: false };
const ON: ChatFeatureToggles = { pipelineControl: true, dynamicWorkflows: true };
const MIXED: ChatFeatureToggles = { pipelineControl: true, dynamicWorkflows: false };

function registerDesktopTurn(capabilities: ChatFeatureToggles, turnId = 'turn-1'): void {
  registerChatCapabilityTurn({
    surface: 'chat',
    sessionId: 'sid',
    turnId,
    capabilities,
  });
  setActiveChatTurn({ sessionId: 'sid', lane: 'desktop', turnId });
}

async function runTurn(lane: SdkLane = desktopLane): Promise<{ systemPrompt: string }> {
  await executeLionSdkQuery('oi', { sessionId: 'sid' }, () => null, lane, OLLAMA);
  if (!capturedLoopOpts) throw new Error('runLionLoop nao foi chamado');
  return { systemPrompt: capturedLoopOpts.initialMessages[0].content };
}

function mcpConfigCapabilities(): unknown {
  expect(getMCPConfigForAgent).toHaveBeenCalledTimes(1);
  return (getMCPConfigForAgent.mock.calls[0][1] as { capabilities?: unknown } | undefined)
    ?.capabilities;
}

beforeEach(() => {
  vi.clearAllMocks();
  capturedLoopOpts = null;
  settings.clear();
  settings.set('onboarding_completed', 'true');
  settings.set('mcp_prompt_mode', 'full');
  __resetChatCapabilityContextForTests();
});

describe('S5c lion: composicao (getMCPConfigForAgent recebe as capabilities do turno)', () => {
  it('turno desktop OFF (modo full) -> filtro recebe OFF e o setup eager NAO ve os helpers gated', async () => {
    registerDesktopTurn({ ...OFF });
    await runTurn();

    expect(mcpConfigCapabilities()).toEqual(OFF);
    expect(setupMCPsForSession).toHaveBeenCalledTimes(1);
    const setupKeys = Object.keys(setupMCPsForSession.mock.calls[0][0]);
    expect(setupKeys).toEqual(['google-drive']);
  });

  it('turno desktop ON -> filtro recebe ON e os helpers gated SEGUEM na composicao', async () => {
    registerDesktopTurn({ ...ON });
    await runTurn();

    expect(mcpConfigCapabilities()).toEqual(ON);
    const setupKeys = Object.keys(setupMCPsForSession.mock.calls[0][0]);
    expect(setupKeys).toEqual(['google-drive', 'lionclaw-pipeline-control', 'lionclaw-dynamic-workflows']);
  });

  it('toggles mistos: dynamicWorkflows OFF filtra SO o server de workflows', async () => {
    registerDesktopTurn({ ...MIXED });
    await runTurn();

    expect(mcpConfigCapabilities()).toEqual(MIXED);
    const setupKeys = Object.keys(setupMCPsForSession.mock.calls[0][0]);
    expect(setupKeys).toEqual(['google-drive', 'lionclaw-pipeline-control']);
  });

  it('modo index, turno OFF -> catalogo do registry derivado do mcpConfig FILTRADO (allowedServerIds por construcao)', async () => {
    settings.set('mcp_prompt_mode', 'index');
    registerDesktopTurn({ ...OFF });
    await runTurn();

    expect(mcpConfigCapabilities()).toEqual(OFF);
    expect(setupMCPsForSession).not.toHaveBeenCalled();
    expect(getMCPToolsFromRegistry).toHaveBeenCalledWith(['google-drive']);
  });

  it('sem turn-context (miss tolerado S3a) -> capabilities undefined e composicao INTEGRAL (byte-identico)', async () => {
    await runTurn();

    expect(mcpConfigCapabilities()).toBeUndefined();
    const setupKeys = Object.keys(setupMCPsForSession.mock.calls[0][0]);
    expect(setupKeys).toEqual(['google-drive', 'lionclaw-pipeline-control', 'lionclaw-dynamic-workflows']);
  });

  it('lane telegram (A.9/A.16) -> undefined MESMO com turno desktop OFF registrado', async () => {
    registerDesktopTurn({ ...OFF });
    await runTurn(telegramLane);

    expect(mcpConfigCapabilities()).toBeUndefined();
    const setupKeys = Object.keys(setupMCPsForSession.mock.calls[0][0]);
    expect(setupKeys).toEqual(['google-drive', 'lionclaw-pipeline-control', 'lionclaw-dynamic-workflows']);
  });
});

describe('S5c lion: prompt (secao pipeline-control condicional no systemPromptParts)', () => {
  it('pipelineControl efetivo OFF -> STUB no systemPrompt, secao completa FORA', async () => {
    registerDesktopTurn({ ...OFF });
    const { systemPrompt } = await runTurn();

    expect(systemPrompt).toContain('PIPE-STUB-SECTION');
    expect(systemPrompt).not.toContain('PIPE-FULL-SECTION');
  });

  it('pipelineControl efetivo ON -> secao COMPLETA, stub fora', async () => {
    registerDesktopTurn({ ...ON });
    const { systemPrompt } = await runTurn();

    expect(systemPrompt).toContain('PIPE-FULL-SECTION');
    expect(systemPrompt).not.toContain('PIPE-STUB-SECTION');
  });

  it('dynamicWorkflows OFF NAO adiciona secao nova (lion nao tem secao de workflows hoje)', async () => {
    registerDesktopTurn({ ...MIXED });
    const { systemPrompt } = await runTurn();

    expect(systemPrompt).toContain('PIPE-FULL-SECTION');
    expect(systemPrompt).not.toContain('PIPE-STUB-SECTION');
    expect(systemPrompt).not.toContain('Workflows Dinamicos');
  });

  it('sem turn-context -> prompt legado byte-identico ao turno ON (secao completa)', async () => {
    const legacy = await runTurn();
    const legacyPrompt = legacy.systemPrompt;

    vi.clearAllMocks();
    capturedLoopOpts = null;
    __resetChatCapabilityContextForTests();
    registerDesktopTurn({ ...ON });
    const on = await runTurn();

    expect(legacyPrompt).toEqual(on.systemPrompt);
    expect(legacyPrompt).toContain('PIPE-FULL-SECTION');
  });

  it('lane telegram -> prompt legado (secao completa) mesmo com turno desktop OFF', async () => {
    registerDesktopTurn({ ...OFF });
    const { systemPrompt } = await runTurn(telegramLane);

    expect(systemPrompt).toContain('PIPE-FULL-SECTION');
    expect(systemPrompt).not.toContain('PIPE-STUB-SECTION');
  });
});
