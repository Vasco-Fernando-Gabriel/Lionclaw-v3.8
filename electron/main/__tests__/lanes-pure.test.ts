import { describe, it, expect } from 'vitest';
import {
  MAX_DESKTOP_LANES,
  buildDefaultOrchestratorColumns,
  effortSettingKeyForRuntime,
  isDynamicWorkflowDriveSessionId,
  pickFreeLaneBadge,
  planLaneMigration,
} from '../lanes';

describe('RM9: MAX_DESKTOP_LANES parametriza tudo', () => {
  it('teto = 2 nesta entrega', () => {
    expect(MAX_DESKTOP_LANES).toBe(2);
  });

  it('pickFreeLaneBadge devolve o menor badge livre e null com todas ocupadas (N=2 e N=3)', () => {
    expect(pickFreeLaneBadge([])).toBe(1);
    expect(pickFreeLaneBadge([1])).toBe(2);
    expect(pickFreeLaneBadge([2])).toBe(1);
    expect(pickFreeLaneBadge([1, 2])).toBeNull();
    expect(pickFreeLaneBadge([1, 2], 3)).toBe(3);
    expect(pickFreeLaneBadge([1, 3], 3)).toBe(2);
    expect(pickFreeLaneBadge([1, 2, 3], 3)).toBeNull();
  });

  it('badge reservado conta como ocupado (5.8)', () => {
    expect(pickFreeLaneBadge([1, ...[2]])).toBeNull();
  });
});

describe('AC-5: virada da V152 (logica pura planLaneMigration)', () => {
  it('1 ativa -> badge 1', () => {
    const plan = planLaneMigration([{ id: 'a', messageCount: 3 }]);
    expect(plan.badges).toEqual([{ id: 'a', badge: 1 }]);
    expect(plan.archive).toEqual([]);
    expect(plan.openWithoutLane).toEqual([]);
  });

  it('3 ativas com mensagens -> badges 1 e 2 pelas mais recentes; a terceira fica aberta sem lane', () => {
    const plan = planLaneMigration([
      { id: 'recente', messageCount: 5 },
      { id: 'meio', messageCount: 2 },
      { id: 'antiga', messageCount: 9 },
    ]);
    expect(plan.badges).toEqual([
      { id: 'recente', badge: 1 },
      { id: 'meio', badge: 2 },
    ]);
    expect(plan.openWithoutLane).toEqual(['antiga']);
    expect(plan.archive).toEqual([]);
  });

  it('excedente VAZIA vira archived; excedente com mensagens fica aberta sem lane', () => {
    const plan = planLaneMigration([
      { id: 'l1', messageCount: 1 },
      { id: 'l2', messageCount: 0 },
      { id: 'vazia', messageCount: 0 },
      { id: 'cheia', messageCount: 4 },
    ]);
    expect(plan.badges.map((b) => b.id)).toEqual(['l1', 'l2']);
    expect(plan.archive).toEqual(['vazia']);
    expect(plan.openWithoutLane).toEqual(['cheia']);
  });

  it('teto injetavel: com N=3 a terceira ganha badge 3', () => {
    const plan = planLaneMigration(
      [
        { id: 'a', messageCount: 1 },
        { id: 'b', messageCount: 1 },
        { id: 'c', messageCount: 1 },
        { id: 'd', messageCount: 0 },
      ],
      3,
    );
    expect(plan.badges).toEqual([
      { id: 'a', badge: 1 },
      { id: 'b', badge: 2 },
      { id: 'c', badge: 3 },
    ]);
    expect(plan.archive).toEqual(['d']);
  });

  it('sessao dw-drive-* e reconhecida como sessao de drive (fora da definicao de conversa)', () => {
    expect(isDynamicWorkflowDriveSessionId('dw-drive-run1-abc')).toBe(true);
    expect(isDynamicWorkflowDriveSessionId('b3b1d2c4')).toBe(false);
  });
});

describe('colunas de orquestrador a partir do Orquestrador padrao (settings)', () => {
  const settings = (map: Record<string, string>) => (key: string) => map[key];

  it('tripla completa vira colunas; effort vem da chave do runtime', () => {
    expect(
      buildDefaultOrchestratorColumns(
        settings({
          orchestrator_runtime: 'claude-sdk',
          orchestrator_provider: 'anthropic',
          orchestrator_model: 'claude-opus-4-7',
          orchestrator_effort: 'high',
          orchestrator_codex_effort: 'xhigh',
        }),
      ),
    ).toEqual({ runtime: 'claude-sdk', provider: 'anthropic', model: 'claude-opus-4-7', effort: 'high' });
    expect(
      buildDefaultOrchestratorColumns(
        settings({
          orchestrator_runtime: 'codex-sdk',
          orchestrator_provider: 'codex',
          orchestrator_model: 'gpt-6',
          orchestrator_codex_effort: 'xhigh',
        }),
      ),
    ).toEqual({ runtime: 'codex-sdk', provider: 'codex', model: 'gpt-6', effort: 'xhigh' });
  });

  it('tripla incompleta = null (nunca inventa)', () => {
    expect(buildDefaultOrchestratorColumns(settings({ orchestrator_runtime: 'claude-sdk' }))).toBeNull();
    expect(buildDefaultOrchestratorColumns(settings({}))).toBeNull();
  });

  it('effortSettingKeyForRuntime cobre os 4 runtimes com effort e devolve null nos demais', () => {
    expect(effortSettingKeyForRuntime('claude-sdk')).toBe('orchestrator_effort');
    expect(effortSettingKeyForRuntime('codex-sdk')).toBe('orchestrator_codex_effort');
    expect(effortSettingKeyForRuntime('kimi-sdk')).toBe('orchestrator_kimi_effort');
    expect(effortSettingKeyForRuntime('grok-sdk')).toBe('orchestrator_grok_effort');
    expect(effortSettingKeyForRuntime('claude-compat-sdk')).toBeNull();
    expect(effortSettingKeyForRuntime('cursor-sdk')).toBeNull();
    expect(effortSettingKeyForRuntime('lion-sdk')).toBeNull();
  });
});
