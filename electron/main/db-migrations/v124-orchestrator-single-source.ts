import type Database from 'better-sqlite3';
import { CLAUDE_DEFAULT_MODEL } from '../../../src/constants/claude-models';
import { CODEX_DEFAULT_MODEL } from '../../../src/constants/codex-models';
import { KIMI_DEFAULT_MODEL } from '../../../src/constants/kimi-models';
import { CLAUDE_COMPAT_PRESETS } from '../../../src/constants/claude-compat-presets';
import { PRODUCT_DEFAULT_ORCHESTRATOR } from '../orchestrator-defaults';
import type { OrchestratorProvider, OrchestratorRuntime } from '../../../src/types';

type V124OrchestratorRuntime = Exclude<OrchestratorRuntime, 'grok-sdk' | 'cursor-sdk'>;


const MODEL_ALIAS_TO_SLUG: Readonly<Record<string, string>> = {
  opus: 'claude-opus-4-7',
  sonnet: 'claude-sonnet-4-6',
  haiku: 'claude-haiku-4-5-20251001',
};

function resolveModelAlias(model: string): string {
  return MODEL_ALIAS_TO_SLUG[model] ?? model;
}

function inferRuntimeFromModel(modelId: string): V124OrchestratorRuntime {
  if (modelId.startsWith('claude-')) return 'claude-sdk';
  if (modelId.startsWith('gpt-')) return 'codex-sdk';
  if (modelId.startsWith('glm-')) return 'claude-compat-sdk';
  if (modelId.startsWith('MiniMax-')) return 'claude-compat-sdk';
  return 'lion-sdk';
}

function defaultProviderForRuntime(runtime: V124OrchestratorRuntime): OrchestratorProvider {
  switch (runtime) {
    case 'claude-sdk':
      return 'anthropic';
    case 'claude-compat-sdk':
      return 'zai';
    case 'codex-sdk':
      return 'codex';
    case 'kimi-sdk':
      return 'kimi';
    case 'lion-sdk':
      return 'ollama';
    default: {
      const _exhaustive: never = runtime;
      return _exhaustive;
    }
  }
}

function defaultModelForRuntime(runtime: V124OrchestratorRuntime): string {
  switch (runtime) {
    case 'claude-sdk':
      return CLAUDE_DEFAULT_MODEL;
    case 'codex-sdk':
      return CODEX_DEFAULT_MODEL;
    case 'kimi-sdk':
      return KIMI_DEFAULT_MODEL;
    case 'claude-compat-sdk':
      return CLAUDE_COMPAT_PRESETS[0]?.models[0]?.id ?? '';
    case 'lion-sdk':
      return '';
    default: {
      const _exhaustive: never = runtime;
      return _exhaustive;
    }
  }
}

function isNonEmpty(value: string | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function applyMigrationV124(db: Database.Database): void {
  const readSetting = (key: string): string | undefined => {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row?.value;
  };

  const writeSetting = (key: string, value: string): void => {
    db.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).run(key, value);
  };

  const run = db.transaction(() => {
    const runtime = readSetting('orchestrator_runtime');
    const provider = readSetting('orchestrator_provider');
    const model = readSetting('orchestrator_model');
    const legacyDefault = readSetting('default_model');

    if (isNonEmpty(runtime) && isNonEmpty(provider) && isNonEmpty(model)) {
    } else if (isNonEmpty(runtime)) {
      const runtimeTyped = runtime as V124OrchestratorRuntime;
      if (!isNonEmpty(provider)) {
        writeSetting('orchestrator_provider', defaultProviderForRuntime(runtimeTyped));
      }
      if (!isNonEmpty(model)) {
        writeSetting('orchestrator_model', defaultModelForRuntime(runtimeTyped));
      }
    } else if (isNonEmpty(legacyDefault)) {
      const resolvedModel = resolveModelAlias(legacyDefault.trim());
      const inferredRuntime = inferRuntimeFromModel(resolvedModel);
      writeSetting('orchestrator_runtime', inferredRuntime);
      writeSetting('orchestrator_provider', defaultProviderForRuntime(inferredRuntime));
      writeSetting('orchestrator_model', resolvedModel);
    } else {
      writeSetting('orchestrator_runtime', PRODUCT_DEFAULT_ORCHESTRATOR.runtime);
      writeSetting('orchestrator_provider', PRODUCT_DEFAULT_ORCHESTRATOR.provider);
      writeSetting('orchestrator_model', PRODUCT_DEFAULT_ORCHESTRATOR.model);
    }

    db.prepare(`DELETE FROM settings WHERE key = 'default_model'`).run();
  });

  run();
}

export const __V124_INTERNAL = {
  MODEL_ALIAS_TO_SLUG,
  inferRuntimeFromModel,
  defaultProviderForRuntime,
  defaultModelForRuntime,
  resolveModelAlias,
};
