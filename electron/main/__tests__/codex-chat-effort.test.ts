
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const { store, getSetting, setSetting } = vi.hoisted(() => {
  const s = new Map<string, string>();
  return {
    store: s,
    getSetting: vi.fn((key: string): string | undefined => s.get(key)),
    setSetting: vi.fn((key: string, value: string): void => {
      s.set(key, value);
    }),
  };
});

vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../db', () => ({
  getSetting,
  setSetting,
  getAuthRow: vi.fn(() => null),
  getDreamingTurnInterval: vi.fn(() => 20),
}));
vi.mock('../voice-engine', () => ({ DEFAULT_ELEVENLABS_VOICE_ID: 'default-voice' }));
vi.mock('../cartesia-engine', () => ({
  DEFAULT_CARTESIA_MODEL: 'sonic',
  DEFAULT_CARTESIA_SPEED: 1.0,
  DEFAULT_CARTESIA_VOICE_ID: 'cartesia-voice',
  DEFAULT_CARTESIA_LANGUAGE: 'pt',
}));
vi.mock('./_shared/chat-compaction', () => ({
  compactActiveChatSession: vi.fn().mockResolvedValue({ reason: 'noop' }),
}));
vi.mock('../agent-sync', () => ({ syncAgentsToOrchestrator: vi.fn() }));
vi.mock('../seed-agents', () => ({ listSeedAgentIds: vi.fn(() => []) }));
vi.mock('../agent-runtime/codex-session-factory', () => ({
  rollbackOfficialCodexSurfaces: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../src/constants/transcription-models', () => ({
  DEFAULT_VOICE_TRANSCRIPTION_MODEL: 'whisper-1',
  isVoiceTranscriptionModel: vi.fn(() => true),
}));
vi.mock('../tool-script/tool-script-availability', () => ({
  resolveToolScriptRegistration: vi.fn(() => ({
    register: true,
    available: true,
    enabled: true,
  })),
  applyToolScriptEnabledChange: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../tool-script/tool-script-settings', () => ({
  readToolScriptSettings: vi.fn(() => ({
    enabled: true,
    enabledTools: ['read_file'],
    timeoutMs: 300000,
    maxStdoutBytes: 50000,
    maxStderrBytes: 10000,
    maxToolCalls: 50,
  })),
}));

const handlers = new Map<string, (...args: unknown[]) => unknown>();
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    },
  },
}));

import { registerSettingsHandlers } from '../ipc/settings';
import {
  CODEX_CHAT_EFFORT_BY_MODEL,
  codexModelSupportsXhigh,
  staticEffortsFor,
  CODEX_EFFORT_ORDER,
  CODEX_EFFORT_LABELS,
} from '../../../src/constants/codex-models';
import type { AppSettings } from '../../../src/types';

function register(): void {
  registerSettingsHandlers({
    getMainWindow: () => null,
    getHarnessEngine: () => null,
  } as never);
}

async function callGet(): Promise<AppSettings> {
  const fn = handlers.get('settings:get');
  if (!fn) throw new Error('settings:get not registered');
  return (await fn()) as AppSettings;
}

async function callUpdate(patch: Partial<AppSettings>): Promise<void> {
  const fn = handlers.get('settings:update');
  if (!fn) throw new Error('settings:update not registered');
  await fn({} as never, patch);
}

describe('CODEX_CHAT_EFFORT_BY_MODEL (mapa de effort por modelo)', () => {
  const BASE = ['low', 'medium', 'high'];
  const WITH_XHIGH = ['low', 'medium', 'high', 'xhigh'];

  it('modelos do app COM xhigh: gpt-5.5 (generalista 5.5+) e gpt-5.3-codex (-codex 5.2+)', () => {
    expect([...CODEX_CHAT_EFFORT_BY_MODEL('gpt-5.5')]).toEqual(WITH_XHIGH);
    expect([...CODEX_CHAT_EFFORT_BY_MODEL('gpt-5.3-codex')]).toEqual(WITH_XHIGH);
  });

  it('gpt-5.4 e gpt-5.4-mini TEM xhigh (spec-gpt56: unhide — model/list 0.144.0 reporta xhigh; o piso antigo >=5.5 escondia capacidade real); gpt-5.2 segue sem', () => {
    expect([...CODEX_CHAT_EFFORT_BY_MODEL('gpt-5.4')]).toEqual(WITH_XHIGH);
    expect([...CODEX_CHAT_EFFORT_BY_MODEL('gpt-5.4-mini')]).toEqual(WITH_XHIGH);
    expect([...CODEX_CHAT_EFFORT_BY_MODEL('gpt-5.2')]).toEqual(BASE);
  });

  it('familia gpt-5.6 (spec-gpt56 S2): matriz COMPLETA selecionavel — sol/terra ate ultra, luna ate max', () => {
    expect([...CODEX_CHAT_EFFORT_BY_MODEL('gpt-5.6-sol')]).toEqual([...WITH_XHIGH, 'max', 'ultra']);
    expect([...CODEX_CHAT_EFFORT_BY_MODEL('gpt-5.6-terra')]).toEqual([...WITH_XHIGH, 'max', 'ultra']);
    expect([...CODEX_CHAT_EFFORT_BY_MODEL('gpt-5.6-luna')]).toEqual([...WITH_XHIGH, 'max']);
    expect([...staticEffortsFor('gpt-5.6-sol')]).toEqual([...WITH_XHIGH, 'max', 'ultra']);
  });

  it('gpt-6-astra: escala COMPLETA low..ultra (ground truth = model/list do codex-cli 0.153.4)', () => {
    expect([...CODEX_CHAT_EFFORT_BY_MODEL('gpt-6-astra')]).toEqual([...WITH_XHIGH, 'max', 'ultra']);
    expect([...staticEffortsFor('gpt-6-astra')]).toEqual([...WITH_XHIGH, 'max', 'ultra']);
  });

  it('labels de UI cobrem TODOS os valores da escala (AC-8: option nunca vazia) e xhigh perdeu o "(mais alto)"', () => {
    for (const effort of CODEX_EFFORT_ORDER) {
      expect(CODEX_EFFORT_LABELS[effort]).toBeTruthy();
      expect(CODEX_EFFORT_LABELS[effort]!.length).toBeGreaterThan(0);
    }
    expect(CODEX_EFFORT_LABELS['xhigh']).toBe('Xhigh');
    expect(CODEX_EFFORT_LABELS['ultra']).toContain('consumo 2 a 3x');
  });

  it('slugs legados com xhigh documentado seguem no mapa EXATO; formas compostas nao sao mais inferidas (spec-gpt56 P4: heuristica regex removida — descoberta cobre)', () => {
    expect(codexModelSupportsXhigh('codex-max')).toBe(true);
    expect(codexModelSupportsXhigh('gpt-5.2-codex')).toBe(true);
    expect(codexModelSupportsXhigh('gpt-5.2-codex-max')).toBe(false);
    expect(codexModelSupportsXhigh('gpt-9.9-fake')).toBe(false);
    expect(codexModelSupportsXhigh('gpt-5.1-codex')).toBe(false);
  });

  it('modelo desconhecido/vazio cai no default seguro (sem xhigh)', () => {
    expect([...CODEX_CHAT_EFFORT_BY_MODEL('modelo-desconhecido')]).toEqual(BASE);
    expect([...CODEX_CHAT_EFFORT_BY_MODEL('')]).toEqual(BASE);
  });

  it("NUNCA oferece 'minimal' (rejeitado com 400 pelos modelos -codex)", () => {
    for (const model of ['gpt-5.5', 'gpt-5.3-codex', 'gpt-5.2', 'codex-max', 'x']) {
      expect(CODEX_CHAT_EFFORT_BY_MODEL(model)).not.toContain('minimal');
    }
  });
});

describe('setting orchestrator_codex_effort (get default + update validado)', () => {
  beforeEach(() => {
    store.clear();
    handlers.clear();
    vi.clearAllMocks();
    register();
  });

  it("settings:get devolve default 'high' quando a key nao existe", async () => {
    const s = await callGet();
    expect(s.orchestratorCodexEffort).toBe('high');
  });

  it('round-trip: update persiste cada um dos 4 valores validos e o get reflete', async () => {
    for (const v of ['low', 'medium', 'high', 'xhigh'] as const) {
      await callUpdate({ orchestratorCodexEffort: v });
      expect(store.get('orchestrator_codex_effort')).toBe(v);
      const s = await callGet();
      expect(s.orchestratorCodexEffort).toBe(v);
    }
  });

  it('max e ultra PERSISTEM via settings:update e o get reflete (spec-gpt56 AC-1)', async () => {
    for (const v of ['max', 'ultra'] as const) {
      await callUpdate({ orchestratorCodexEffort: v as AppSettings['orchestratorCodexEffort'] });
      expect(store.get('orchestrator_codex_effort')).toBe(v);
      const s = await callGet();
      expect(s.orchestratorCodexEffort).toBe(v);
    }
  });

  it('valor invalido e IGNORADO (nao grava; valor anterior preservado)', async () => {
    await callUpdate({ orchestratorCodexEffort: 'xhigh' });
    setSetting.mockClear();
    await callUpdate({
      orchestratorCodexEffort: 'minimal' as unknown as AppSettings['orchestratorCodexEffort'],
    });
    expect(setSetting).not.toHaveBeenCalledWith('orchestrator_codex_effort', 'minimal');
    expect(store.get('orchestrator_codex_effort')).toBe('xhigh');
    await callUpdate({
      orchestratorCodexEffort: 'turbo' as unknown as AppSettings['orchestratorCodexEffort'],
    });
    expect(store.get('orchestrator_codex_effort')).toBe('xhigh');
  });

  it('NAO toca o orchestrator_effort do Claude (settings separadas)', async () => {
    await callUpdate({ orchestratorEffort: 'max' });
    await callUpdate({ orchestratorCodexEffort: 'low' });
    expect(store.get('orchestrator_effort')).toBe('max');
    expect(store.get('orchestrator_codex_effort')).toBe('low');
  });
});

describe('wiring do effort no executeCodexSdkQuery (auditoria por fonte)', () => {
  const codexSrc = readFileSync(
    join(__dirname, '..', 'codex-sdk', 'index.ts'),
    'utf-8',
  );

  it('le a setting POR TURNO e clampa pelo modelo ativo (fallback high)', () => {
    expect(codexSrc).toMatch(
      /getSetting\("orchestrator_codex_effort"\) as CodexChatReasoningEffort\) \|\| "high"/,
    );
    expect(codexSrc).toMatch(
      /clampCodexEffortForModelDiscovered\(\s*requestedCodexEffort,\s*selection\.model,?\s*\)/,
    );
  });

  it('criacao da sessao passa o effort clampado (turno normal E recovery SC-1)', () => {
    const sites = codexSrc.match(/reasoningEffort: requestedCodexEffort,/g) ?? [];
    expect(sites.length).toBe(2);
  });

  it('reuse da thread persistente aplica setReasoningEffort?.() ANTES do reply', () => {
    expect(codexSrc).toContain('session.setReasoningEffort?.(codexEffort);');
    expect(codexSrc.indexOf('session.setReasoningEffort?.(codexEffort);')).toBeLessThan(
      codexSrc.indexOf('session.reply(prompt'),
    );
  });

  it('effort NAO entra na chave de invalidacao da thread (decisao fechada: per-turn/sticky)', () => {
    const sigStart = codexSrc.indexOf('const threadConfigSignature');
    const sigEnd = codexSrc.indexOf(';', sigStart);
    const signature = codexSrc.slice(sigStart, sigEnd);
    expect(signature.toLowerCase()).not.toContain('effort');
    expect(codexSrc).not.toMatch(/cachedEntry\.(reasoningEffort|effort)/);
  });
});

describe('wiring do effort nos AGENTES codex (auditoria por fonte)', () => {
  it('codex-executor passa reasoningEffort largo para o driver oficial', () => {
    const executorSrc = readFileSync(
      join(__dirname, '..', 'agent-runtime', 'codex-executor.ts'),
      'utf-8',
    );
    expect(executorSrc).toContain('reasoningEffortOverride: requestedEffort,');
    expect(executorSrc).toContain('reasoningEffort: requestedEffort,');
  });

  it('workflow-agent-adapter preserva o effort largo ate o driver oficial', () => {
    const adapterSrc = readFileSync(
      join(__dirname, '..', 'dynamic-workflows', 'workflow-agent-adapter.ts'),
      'utf-8',
    );
    expect(adapterSrc).toContain('input.effectiveEffort !== undefined');
    expect(adapterSrc).toContain('input.effectiveEffort ?? agentEffort;');
    expect(adapterSrc).toContain('reasoningEffortOverride: nodeEffort,');
    expect(adapterSrc).toContain("reasoningEffort: CodexSessionOptions['reasoningEffort'] = nodeEffort");
  });

  it('AgentFormModal usa a lista model-aware e clampa pra high quando o modelo nao suporta', () => {
    const modalSrc = readFileSync(
      join(__dirname, '..', '..', '..', 'src', 'components', 'agents', 'AgentFormModal.tsx'),
      'utf-8',
    );
    expect(modalSrc).toContain('discoveredEffortsFor(codexModel).map((opt)');
    expect(modalSrc).toMatch(
      /setCodexReasoningEffort\(\s*clampCodexEffortToSupported\(codexReasoningEffort, discoveredEffortsFor\(codexModel\)\),\s*\);/,
    );
    expect(modalSrc).not.toContain('CODEX_REASONING_EFFORT');
  });
});
