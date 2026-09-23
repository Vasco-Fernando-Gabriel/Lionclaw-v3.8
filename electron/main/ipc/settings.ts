import { ipcMain } from 'electron';
import { createLogger } from '../logger';
import { CODEX_EFFORT_ORDER } from '../../../src/constants/codex-models';
import { getSetting, setSetting, setOrchestratorCompactionSelection, getAuthRow, getDreamingTurnInterval } from '../db';
import { DEFAULT_ELEVENLABS_VOICE_ID } from '../voice-engine';
import {
  DEFAULT_CARTESIA_LANGUAGE,
  DEFAULT_CARTESIA_MODEL,
  DEFAULT_CARTESIA_SPEED,
  DEFAULT_CARTESIA_VOICE_ID,
} from '../cartesia-engine';
import {
  DEFAULT_CHAT_COMPACTION_TARGET_TOKENS,
  CHAT_COMPACTION_TARGET_TOKENS_SETTING_KEY,
  DEFAULT_CHAT_COMPACTION_TRIGGER_PERCENT,
  CHAT_AUTO_COMPACTION_ENABLED_SETTING_KEY,
  CHAT_TIMELINE_REINJECT_ENABLED_SETTING_KEY,
} from '../chat-compaction-defaults';
import type { IpcContext } from './context';
import type { AppSettings } from '../../../src/types';
import {
  DEFAULT_VOICE_TRANSCRIPTION_MODEL,
  isVoiceTranscriptionModel,
} from '../../../src/constants/transcription-models';
import {
  VISION_DEFAULT,
  isVisionModelForProvider,
  defaultVisionModelForProvider,
  type VisionProvider,
} from '../../../src/constants/vision-models';
import { syncAgentsToOrchestrator } from '../agent-sync';
import { readDefaultOrchestratorColumns } from '../orchestrator-selection';
import { listSeedAgentIds } from '../seed-agents';
import { PRODUCT_DEFAULT_ORCHESTRATOR } from '../orchestrator-defaults';
import { validateOrchestratorTriple } from '../orchestrator-selection-matrix';
import { smokeAudit } from '../smoke-audit';

const logger = createLogger('ipc');

export function registerSettingsHandlers(ctx: IpcContext): void {
  const { getHarnessEngine } = ctx;

  ipcMain.handle('settings:get', async (): Promise<AppSettings> => {
    const orchestratorRuntime =
      (getSetting('orchestrator_runtime') as AppSettings['orchestratorRuntime']) ||
      PRODUCT_DEFAULT_ORCHESTRATOR.runtime;
    const orchestratorProvider =
      (getSetting('orchestrator_provider') as AppSettings['orchestratorProvider']) ||
      PRODUCT_DEFAULT_ORCHESTRATOR.provider;
    const orchestratorModel = getSetting('orchestrator_model') || PRODUCT_DEFAULT_ORCHESTRATOR.model;
    const orchestratorEffort = (getSetting('orchestrator_effort') as AppSettings['orchestratorEffort']) || 'high';
    const orchestratorCodexEffort =
      (getSetting('orchestrator_codex_effort') as AppSettings['orchestratorCodexEffort']) || 'high';
    const orchestratorKimiEffort =
      (getSetting('orchestrator_kimi_effort') as AppSettings['orchestratorKimiEffort']) || 'max';
    const orchestratorGrokEffort =
      (getSetting('orchestrator_grok_effort') as AppSettings['orchestratorGrokEffort']) || 'high';
    const chatWidthModeRaw = getSetting('chat_width_mode');
    const chatWidthMode: AppSettings['chatWidthMode'] =
      chatWidthModeRaw === 'amplo' || chatWidthModeRaw === 'full-width' ? chatWidthModeRaw : 'compacto';
    const chatStaleLaneDaysRaw = Number.parseInt(getSetting('chat_stale_lane_days') || '', 10);
    const chatStaleLaneDays =
      Number.isFinite(chatStaleLaneDaysRaw) && chatStaleLaneDaysRaw >= 1 ? chatStaleLaneDaysRaw : 7;
    const grokBinaryPath = getSetting('grok_binary_path') || undefined;
    const grokMaxConcurrencyRaw = Number.parseInt(getSetting('grok_max_concurrency') || '3', 10);
    const grokMaxConcurrency = Number.isFinite(grokMaxConcurrencyRaw)
      ? Math.min(8, Math.max(1, grokMaxConcurrencyRaw))
      : 3;
    const orchestratorOllamaBaseUrl = getSetting('orchestrator_ollama_base_url') || undefined;
    const orchestratorLmStudioBaseUrl = getSetting('orchestrator_lmstudio_base_url') || undefined;
    const orchestratorOpenAiCompatPresetRaw = getSetting('orchestrator_openai_compat_preset');
    const orchestratorOpenAiCompatPreset =
      (orchestratorOpenAiCompatPresetRaw as AppSettings['orchestratorOpenAiCompatPreset']) || undefined;
    const orchestratorOpenAiCompatBaseUrl = getSetting('orchestrator_openai_compat_base_url') || undefined;
    const orchestratorOpenAiCompatApiKeyRef = getSetting('orchestrator_openai_compat_api_key_ref') || undefined;
    const orchestratorZaiApiKeyRef = getSetting('orchestrator_zai_api_key_ref') || undefined;
    const orchestratorMinimaxApiKeyRef = getSetting('orchestrator_minimax_api_key_ref') || undefined;
    const orchestratorVertexApiKeyRef = getSetting('orchestrator_vertex_api_key_ref') || undefined;
    const orchestratorVertexLocation = getSetting('orchestrator_vertex_location') || undefined;
    const orchestratorVertexProjectId = getSetting('orchestrator_vertex_project_id') || undefined;
    const orchestratorVertexAuthMode =
      (getSetting('orchestrator_vertex_auth_mode') as AppSettings['orchestratorVertexAuthMode']) || undefined;
    const orchestratorCompactionRuntime =
      (getSetting('orchestrator_compaction_runtime') as AppSettings['orchestratorCompactionRuntime']) || undefined;
    const orchestratorCompactionProvider =
      (getSetting('orchestrator_compaction_provider') as AppSettings['orchestratorCompactionProvider']) || undefined;
    const orchestratorCompactionModel = getSetting('orchestrator_compaction_model') || undefined;
    const orchestratorContextWindowTokensRaw = parseInt(getSetting('orchestrator_context_window_tokens') || '', 10);
    const orchestratorCompactionThresholdPercentRaw = parseInt(
      getSetting('orchestrator_compaction_threshold_percent') || String(DEFAULT_CHAT_COMPACTION_TRIGGER_PERCENT),
      10,
    );
    const orchestratorContextWindowTokens =
      Number.isFinite(orchestratorContextWindowTokensRaw) && orchestratorContextWindowTokensRaw > 0
        ? orchestratorContextWindowTokensRaw
        : undefined;
    const orchestratorCompactionThresholdPercent = Number.isFinite(orchestratorCompactionThresholdPercentRaw)
      ? Math.min(95, Math.max(50, orchestratorCompactionThresholdPercentRaw))
      : DEFAULT_CHAT_COMPACTION_TRIGGER_PERCENT;
    const chatCompactionTargetTokensRaw = parseInt(getSetting(CHAT_COMPACTION_TARGET_TOKENS_SETTING_KEY) || '', 10);
    const chatCompactionTargetTokens =
      Number.isFinite(chatCompactionTargetTokensRaw) && chatCompactionTargetTokensRaw > 0
        ? chatCompactionTargetTokensRaw
        : DEFAULT_CHAT_COMPACTION_TARGET_TOKENS;
    const chatAutoCompactionEnabled = getSetting(CHAT_AUTO_COMPACTION_ENABLED_SETTING_KEY) !== 'false';
    const chatTimelineReinjectEnabled = getSetting(CHAT_TIMELINE_REINJECT_ENABLED_SETTING_KEY) === 'true';
    const voiceTranscriptionModelRaw = getSetting('voice_transcription_model') || DEFAULT_VOICE_TRANSCRIPTION_MODEL;
    const voiceTranscriptionModel = isVoiceTranscriptionModel(voiceTranscriptionModelRaw)
      ? voiceTranscriptionModelRaw
      : DEFAULT_VOICE_TRANSCRIPTION_MODEL;

    const visionProviderRaw = (getSetting('vision_provider') || '').trim();
    const visionProvider: VisionProvider =
      visionProviderRaw === 'openai' || visionProviderRaw === 'anthropic' ? visionProviderRaw : VISION_DEFAULT.provider;
    const visionModelRaw = (getSetting('vision_model') || '').trim();
    const visionModel = isVisionModelForProvider(visionProvider, visionModelRaw)
      ? visionModelRaw
      : defaultVisionModelForProvider(visionProvider);

    const orchestratorSetupCompletedRaw = getSetting('orchestrator_setup_completed');
    let orchestratorSetupCompleted: boolean;
    if (orchestratorSetupCompletedRaw === 'true') {
      orchestratorSetupCompleted = true;
    } else if (orchestratorSetupCompletedRaw === '') {
      orchestratorSetupCompleted = false;
    } else {
      orchestratorSetupCompleted = getAuthRow() != null;
    }

    const { resolveToolScriptRegistration } = await import('../tool-script/tool-script-availability');
    const { readToolScriptSettings } = await import('../tool-script/tool-script-settings');
    const toolScriptDecision = resolveToolScriptRegistration();
    const toolScriptSettings = readToolScriptSettings();

    return {
      defaultModel: orchestratorModel,
      orchestratorRuntime,
      orchestratorProvider,
      orchestratorModel,
      orchestratorEffort,
      orchestratorCodexEffort,
      orchestratorKimiEffort,
      orchestratorGrokEffort,
      chatWidthMode,
      chatStaleLaneDays,
      grokBinaryPath,
      grokMaxConcurrency,
      orchestratorOllamaBaseUrl,
      orchestratorLmStudioBaseUrl,
      orchestratorOpenAiCompatPreset,
      orchestratorOpenAiCompatBaseUrl,
      orchestratorOpenAiCompatApiKeyRef,
      orchestratorZaiApiKeyRef,
      orchestratorMinimaxApiKeyRef,
      orchestratorVertexApiKeyRef,
      orchestratorVertexLocation,
      orchestratorVertexProjectId,
      orchestratorVertexAuthMode,
      orchestratorCompactionRuntime,
      orchestratorCompactionProvider,
      orchestratorCompactionModel,
      orchestratorContextWindowTokens,
      orchestratorCompactionThresholdPercent,
      chatCompactionTargetTokens,
      chatAutoCompactionEnabled,
      chatTimelineReinjectEnabled,
      orchestratorSetupCompleted,
      language: 'pt-BR',
      sessionTimeoutMinutes: parseInt(getSetting('session_timeout') || '60', 10),
      compactionSchedule: getSetting('compaction_schedule') || '0 23 * * *',
      maxWorkingMemoryTokens: parseInt(getSetting('max_memory_tokens') || '2000', 10),
      rawMessageRetentionDays: parseInt(getSetting('message_retention_days') || '7', 10),
      maxSessionTokens: parseInt(getSetting('max_session_tokens') || '200000', 10),
      voiceResponseEnabled: getSetting('voice_response_enabled') === 'true',
      voiceId: getSetting('voice_id') || DEFAULT_ELEVENLABS_VOICE_ID,
      voiceLiveProvider: getSetting('voice_live_provider') === 'cartesia' ? 'cartesia' : 'elevenlabs',
      cartesiaVoiceId: getSetting('cartesia_voice_id') || DEFAULT_CARTESIA_VOICE_ID,
      cartesiaVoiceLanguage: getSetting('cartesia_voice_language') || DEFAULT_CARTESIA_LANGUAGE,
      cartesiaModel: getSetting('cartesia_model') || DEFAULT_CARTESIA_MODEL,
      cartesiaSpeed:
        Number.parseFloat(getSetting('cartesia_speed') || String(DEFAULT_CARTESIA_SPEED)) || DEFAULT_CARTESIA_SPEED,
      voiceTranscriptionModel,
      visionProvider,
      visionModel,
      ollamaEnabled: getSetting('ollama_enabled') === 'true',
      ollamaBaseUrl: getSetting('ollama_base_url') || 'http://localhost:11434',
      ollamaEmbeddingModel: getSetting('ollama_embedding_model') || 'nomic-embed-text',
      ollamaCompactionModel: getSetting('ollama_compaction_model') || '',
      mgraphMode: getSetting('mgraph_mode') === 'true',
      subagentsPromptMode: getSetting('subagents_prompt_mode') === 'full' ? 'full' : 'index',
      mcpPromptMode: getSetting('mcp_prompt_mode') === 'full' ? 'full' : 'index',
      chatCapabilityGateMode: getSetting('chat_capability_gate_mode') === 'enforce' ? 'enforce' : 'shadow',
      dreamingTurnBasedEnabled: getSetting('dreaming_turn_based_enabled') === 'true',
      dreamingTurnBasedInterval: getDreamingTurnInterval(),
      dreamingTurnBasedModel: getSetting('dreaming_turn_based_model') || '',
      toolScriptEnabled: toolScriptSettings.enabled,
      toolScriptAvailable: toolScriptDecision.available,
      ...(toolScriptDecision.available ? {} : { toolScriptAvailabilityReason: toolScriptDecision.reason }),
      toolScriptTools: [...toolScriptSettings.enabledTools],
      toolScriptTimeoutMs: toolScriptSettings.timeoutMs,
      toolScriptMaxStdoutBytes: toolScriptSettings.maxStdoutBytes,
      toolScriptMaxStderrBytes: toolScriptSettings.maxStderrBytes,
      toolScriptMaxToolCalls: toolScriptSettings.maxToolCalls,
    };
  });

  ipcMain.handle('settings:update', async (_event, settings: Partial<AppSettings>) => {
    const touchesTriple =
      settings.orchestratorRuntime !== undefined ||
      settings.orchestratorProvider !== undefined ||
      settings.orchestratorModel !== undefined ||
      settings.defaultModel !== undefined;
    if (touchesTriple) {
      const mergedRuntime =
        settings.orchestratorRuntime ?? getSetting('orchestrator_runtime') ?? PRODUCT_DEFAULT_ORCHESTRATOR.runtime;
      const mergedProvider =
        settings.orchestratorProvider ?? getSetting('orchestrator_provider') ?? PRODUCT_DEFAULT_ORCHESTRATOR.provider;
      const mergedModel =
        settings.orchestratorModel ??
        settings.defaultModel ??
        getSetting('orchestrator_model') ??
        PRODUCT_DEFAULT_ORCHESTRATOR.model;
      const missing: string[] = [];
      if (!mergedRuntime) missing.push('runtime');
      if (!mergedProvider) missing.push('provider');
      if (!mergedModel) missing.push('model');
      if (missing.length > 0) {
        smokeAudit('settings_rejected', { missingField: missing.join(',') });
        logger.warn({ missing }, 'settings:update recusado: triple orchestrator_* incompleto');
        return {
          error: `Orquestrador incompleto: preencha ${missing.join(', ')} antes de salvar.`,
        };
      }

      const tripleError = await validateOrchestratorTriple(
        mergedRuntime as AppSettings['orchestratorRuntime'],
        mergedProvider as AppSettings['orchestratorProvider'],
        mergedModel,
      );
      if (tripleError) {
        return {
          error: `Selecao incompativel: ${tripleError}`,
        };
      }
      if (mergedRuntime === 'grok-sdk' || mergedRuntime === 'kimi-sdk') {
        const { checkProvider } = await import('../provider-availability');
        const availability = await checkProvider(
          mergedRuntime as AppSettings['orchestratorRuntime'],
          mergedProvider as AppSettings['orchestratorProvider'],
        );
        if (availability.usable !== true) {
          return {
            error: availability.reason
              ? `Provider indisponivel: ${availability.reason}`
              : `Provider ${mergedProvider} ainda nao esta utilizavel.`,
          };
        }
      }
    }

    const touchesCompactionTriple =
      settings.orchestratorCompactionRuntime !== undefined ||
      settings.orchestratorCompactionProvider !== undefined ||
      settings.orchestratorCompactionModel !== undefined;
    let compactionSelectionToPersist: { runtime: string; provider: string; model: string } | null | undefined;
    if (touchesCompactionTriple) {
      const mergedRuntime =
        settings.orchestratorCompactionRuntime ?? getSetting('orchestrator_compaction_runtime') ?? '';
      const mergedProvider =
        settings.orchestratorCompactionProvider ?? getSetting('orchestrator_compaction_provider') ?? '';
      const mergedModel = settings.orchestratorCompactionModel ?? getSetting('orchestrator_compaction_model') ?? '';
      const populated = [mergedRuntime, mergedProvider, mergedModel].filter((value) => value.length > 0).length;

      if (populated !== 0 && populated !== 3) {
        return {
          error: 'Compactacao incompleta: selecione runtime, provider e modelo, ou use Auto.',
        };
      }
      if (populated === 3) {
        const tripleError = await validateOrchestratorTriple(
          mergedRuntime as AppSettings['orchestratorRuntime'],
          mergedProvider as AppSettings['orchestratorProvider'],
          mergedModel,
        );
        if (tripleError) {
          return {
            error: `Selecao de compactacao incompativel: ${tripleError}`,
          };
        }
        if (mergedRuntime === 'grok-sdk' || mergedRuntime === 'kimi-sdk') {
          const { checkProvider } = await import('../provider-availability');
          const availability = await checkProvider(
            mergedRuntime as AppSettings['orchestratorRuntime'],
            mergedProvider as AppSettings['orchestratorProvider'],
          );
          if (availability.usable !== true) {
            return {
              error: availability.reason
                ? `Provider de compactacao indisponivel: ${availability.reason}`
                : `Provider de compactacao ${mergedProvider} ainda nao esta utilizavel.`,
            };
          }
        }
        compactionSelectionToPersist = {
          runtime: mergedRuntime,
          provider: mergedProvider,
          model: mergedModel,
        };
      } else {
        compactionSelectionToPersist = null;
      }
    }

    if (settings.defaultModel && settings.orchestratorModel === undefined) {
      logger.warn('defaultModel deprecated, use orchestratorModel');
      setSetting('orchestrator_model', settings.defaultModel);
    }
    if (settings.sessionTimeoutMinutes) setSetting('session_timeout', String(settings.sessionTimeoutMinutes));
    if (settings.compactionSchedule) setSetting('compaction_schedule', settings.compactionSchedule);
    if (settings.maxWorkingMemoryTokens) setSetting('max_memory_tokens', String(settings.maxWorkingMemoryTokens));
    if (settings.rawMessageRetentionDays)
      setSetting('message_retention_days', String(settings.rawMessageRetentionDays));
    if ((settings as Record<string, unknown>).maxSessionTokens !== undefined) {
      setSetting('max_session_tokens', String((settings as Record<string, unknown>).maxSessionTokens));
    }
    if (settings.voiceResponseEnabled !== undefined) {
      setSetting('voice_response_enabled', settings.voiceResponseEnabled ? 'true' : 'false');
    }
    if (settings.voiceId !== undefined) {
      setSetting('voice_id', settings.voiceId || '');
    }
    if (settings.voiceLiveProvider !== undefined) {
      setSetting('voice_live_provider', settings.voiceLiveProvider === 'cartesia' ? 'cartesia' : 'elevenlabs');
    }
    if (settings.cartesiaVoiceId !== undefined) {
      setSetting('cartesia_voice_id', settings.cartesiaVoiceId || '');
    }
    if (settings.cartesiaVoiceLanguage !== undefined) {
      setSetting('cartesia_voice_language', settings.cartesiaVoiceLanguage || DEFAULT_CARTESIA_LANGUAGE);
    }
    if (settings.cartesiaModel !== undefined) {
      setSetting('cartesia_model', settings.cartesiaModel || DEFAULT_CARTESIA_MODEL);
    }
    if (settings.cartesiaSpeed !== undefined) {
      const speed = Number(settings.cartesiaSpeed);
      const safeSpeed = Number.isFinite(speed) ? Math.min(1.5, Math.max(0.6, speed)) : DEFAULT_CARTESIA_SPEED;
      setSetting('cartesia_speed', String(safeSpeed));
    }
    if (settings.voiceTranscriptionModel !== undefined) {
      const model = isVoiceTranscriptionModel(settings.voiceTranscriptionModel)
        ? settings.voiceTranscriptionModel
        : DEFAULT_VOICE_TRANSCRIPTION_MODEL;
      setSetting('voice_transcription_model', model);
    }
    if (settings.visionProvider !== undefined || settings.visionModel !== undefined) {
      const effectiveProvider: VisionProvider =
        settings.visionProvider === 'openai' || settings.visionProvider === 'anthropic'
          ? settings.visionProvider
          : ((getSetting('vision_provider') || VISION_DEFAULT.provider) as VisionProvider);
      if (settings.visionProvider !== undefined) {
        setSetting('vision_provider', effectiveProvider);
      }
      if (settings.visionModel !== undefined) {
        const model = isVisionModelForProvider(effectiveProvider, settings.visionModel)
          ? settings.visionModel
          : defaultVisionModelForProvider(effectiveProvider);
        setSetting('vision_model', model);
      } else if (settings.visionProvider !== undefined) {
        const currentModel = (getSetting('vision_model') || '').trim();
        if (!isVisionModelForProvider(effectiveProvider, currentModel)) {
          setSetting('vision_model', defaultVisionModelForProvider(effectiveProvider));
        }
      }
    }
    if (settings.ollamaEnabled !== undefined) {
      setSetting('ollama_enabled', settings.ollamaEnabled ? 'true' : 'false');
    }
    if (settings.ollamaBaseUrl !== undefined) {
      setSetting('ollama_base_url', settings.ollamaBaseUrl);
    }
    if (settings.ollamaEmbeddingModel !== undefined) {
      setSetting('ollama_embedding_model', settings.ollamaEmbeddingModel);
    }
    if (settings.ollamaCompactionModel !== undefined) {
      setSetting('ollama_compaction_model', settings.ollamaCompactionModel);
    }
    if (settings.mgraphMode !== undefined) {
      setSetting('mgraph_mode', settings.mgraphMode ? 'true' : 'false');
    }
    if (settings.subagentsPromptMode !== undefined) {
      setSetting('subagents_prompt_mode', settings.subagentsPromptMode === 'full' ? 'full' : 'index');
    }
    if (settings.mcpPromptMode !== undefined) {
      setSetting('mcp_prompt_mode', settings.mcpPromptMode === 'full' ? 'full' : 'index');
    }
    if (settings.chatCapabilityGateMode !== undefined) {
      setSetting('chat_capability_gate_mode', settings.chatCapabilityGateMode === 'enforce' ? 'enforce' : 'shadow');
    }
    if (settings.orchestratorRuntime !== undefined) {
      setSetting('orchestrator_runtime', settings.orchestratorRuntime);
    }
    if (settings.orchestratorProvider !== undefined) {
      setSetting('orchestrator_provider', settings.orchestratorProvider);
    }
    if (settings.orchestratorModel !== undefined) {
      setSetting('orchestrator_model', settings.orchestratorModel);
    }
    if (settings.orchestratorEffort !== undefined) {
      setSetting('orchestrator_effort', settings.orchestratorEffort);
    }
    if (settings.orchestratorCodexEffort !== undefined) {
      const v = settings.orchestratorCodexEffort;
      if ((CODEX_EFFORT_ORDER as readonly string[]).includes(v)) {
        setSetting('orchestrator_codex_effort', v);
      } else {
        logger.warn({ value: v }, 'orchestrator_codex_effort invalido; update ignorado');
      }
    }
    if (settings.orchestratorKimiEffort !== undefined) {
      const value = settings.orchestratorKimiEffort;
      if (value === 'low' || value === 'high' || value === 'max') {
        setSetting('orchestrator_kimi_effort', value);
      } else {
        logger.warn({ value }, 'orchestrator_kimi_effort invalido; update ignorado');
      }
    }
    if (settings.orchestratorGrokEffort !== undefined) {
      const value = settings.orchestratorGrokEffort;
      if (value === 'low' || value === 'medium' || value === 'high') {
        setSetting('orchestrator_grok_effort', value);
      } else {
        logger.warn({ value }, 'orchestrator_grok_effort invalido; update ignorado');
      }
    }
    if (settings.chatWidthMode !== undefined) {
      const value = settings.chatWidthMode;
      if (value === 'compacto' || value === 'amplo' || value === 'full-width') {
        setSetting('chat_width_mode', value);
      } else {
        logger.warn({ value }, 'chat_width_mode invalido; update ignorado');
      }
    }
    if (settings.chatStaleLaneDays !== undefined) {
      const value = Number(settings.chatStaleLaneDays);
      if (Number.isFinite(value) && value >= 1) {
        setSetting('chat_stale_lane_days', String(Math.floor(value)));
      } else {
        logger.warn({ value }, 'chat_stale_lane_days invalido; update ignorado');
      }
    }
    if (settings.grokBinaryPath !== undefined) {
      setSetting('grok_binary_path', settings.grokBinaryPath.trim());
    }
    if (settings.grokMaxConcurrency !== undefined) {
      const value = Math.floor(Number(settings.grokMaxConcurrency));
      setSetting('grok_max_concurrency', String(Number.isFinite(value) ? Math.min(8, Math.max(1, value)) : 3));
    }
    if (settings.orchestratorOllamaBaseUrl !== undefined) {
      setSetting('orchestrator_ollama_base_url', settings.orchestratorOllamaBaseUrl);
    }
    if (settings.orchestratorLmStudioBaseUrl !== undefined) {
      setSetting('orchestrator_lmstudio_base_url', settings.orchestratorLmStudioBaseUrl);
    }
    if (settings.orchestratorOpenAiCompatPreset !== undefined) {
      setSetting('orchestrator_openai_compat_preset', settings.orchestratorOpenAiCompatPreset);
    }
    if (settings.orchestratorOpenAiCompatBaseUrl !== undefined) {
      setSetting('orchestrator_openai_compat_base_url', settings.orchestratorOpenAiCompatBaseUrl);
    }
    if (settings.orchestratorOpenAiCompatApiKeyRef !== undefined) {
      setSetting('orchestrator_openai_compat_api_key_ref', settings.orchestratorOpenAiCompatApiKeyRef);
    }
    if (settings.orchestratorZaiApiKeyRef !== undefined) {
      setSetting('orchestrator_zai_api_key_ref', settings.orchestratorZaiApiKeyRef);
    }
    if (settings.orchestratorMinimaxApiKeyRef !== undefined) {
      setSetting('orchestrator_minimax_api_key_ref', settings.orchestratorMinimaxApiKeyRef);
    }
    if (compactionSelectionToPersist !== undefined) {
      setOrchestratorCompactionSelection(compactionSelectionToPersist);
    }
    if (settings.orchestratorContextWindowTokens !== undefined) {
      const value = Number(settings.orchestratorContextWindowTokens);
      setSetting(
        'orchestrator_context_window_tokens',
        Number.isFinite(value) && value > 0 ? String(Math.floor(value)) : '',
      );
    }
    if (settings.orchestratorCompactionThresholdPercent !== undefined) {
      const value = Number(settings.orchestratorCompactionThresholdPercent);
      const clamped = Number.isFinite(value)
        ? Math.min(95, Math.max(50, Math.floor(value)))
        : DEFAULT_CHAT_COMPACTION_TRIGGER_PERCENT;
      setSetting('orchestrator_compaction_threshold_percent', String(clamped));
    }
    if (settings.chatCompactionTargetTokens !== undefined) {
      const value = Number(settings.chatCompactionTargetTokens);
      const sanitized = Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_CHAT_COMPACTION_TARGET_TOKENS;
      setSetting(CHAT_COMPACTION_TARGET_TOKENS_SETTING_KEY, String(sanitized));
    }
    if (settings.chatAutoCompactionEnabled !== undefined) {
      setSetting(CHAT_AUTO_COMPACTION_ENABLED_SETTING_KEY, settings.chatAutoCompactionEnabled ? 'true' : 'false');
    }
    if (settings.chatTimelineReinjectEnabled !== undefined) {
      setSetting(CHAT_TIMELINE_REINJECT_ENABLED_SETTING_KEY, settings.chatTimelineReinjectEnabled ? 'true' : 'false');
    }
    if (settings.orchestratorSetupCompleted !== undefined) {
      const wasCompleted = getSetting('orchestrator_setup_completed') === 'true';
      const willBeCompleted = !!settings.orchestratorSetupCompleted;

      setSetting('orchestrator_setup_completed', willBeCompleted ? 'true' : '');

      if (!wasCompleted && willBeCompleted) {
        const alreadySynced = getSetting('seed_agents_initial_runtime_sync_completed') === 'true';
        if (!alreadySynced) {
          try {
            const seedIds = listSeedAgentIds();
            const defaultSelection = readDefaultOrchestratorColumns();
            const result = await syncAgentsToOrchestrator(
              {
                agentIds: seedIds,
                mode: 'initial-onboarding',
                ...(defaultSelection ? { selection: defaultSelection } : {}),
              },
              { getHarnessEngine },
            );
            if (!result.blocked && result.summary.failed === 0) {
              setSetting('seed_agents_initial_runtime_sync_completed', 'true');
            } else {
              logger.warn(
                {
                  blocked: result.blocked,
                  summary: !result.blocked ? result.summary : undefined,
                },
                'Initial seed sync did not fully succeed; flag NOT persisted, user can retry via manual button',
              );
            }
          } catch (err) {
            logger.error(
              { err: err instanceof Error ? err.message : String(err) },
              'Initial seed sync threw; user must use manual button',
            );
          }
        }
      }
    }
    if (settings.dreamingTurnBasedEnabled !== undefined) {
      setSetting('dreaming_turn_based_enabled', settings.dreamingTurnBasedEnabled ? 'true' : 'false');
    }
    if (settings.dreamingTurnBasedInterval !== undefined) {
      const raw = settings.dreamingTurnBasedInterval;
      const parsed = Number.isFinite(raw) ? Math.trunc(raw) : NaN;
      const clamped = Number.isNaN(parsed) ? 20 : Math.min(500, Math.max(10, parsed));
      if (clamped !== raw) {
        logger.warn({ raw, clamped }, 'dreaming_turn_based_interval clamped on settings:update');
      }
      setSetting('dreaming_turn_based_interval', String(clamped));
    }
    if (settings.dreamingTurnBasedModel !== undefined) {
      setSetting('dreaming_turn_based_model', settings.dreamingTurnBasedModel);
    }
    if (settings.toolScriptEnabled !== undefined) {
      const wasEnabled = getSetting('tool_script_enabled') !== 'false';
      const willBeEnabled = !!settings.toolScriptEnabled;
      setSetting('tool_script_enabled', willBeEnabled ? 'true' : 'false');
      if (wasEnabled !== willBeEnabled) {
        try {
          const { applyToolScriptEnabledChange } = await import('../tool-script/tool-script-availability');
          await applyToolScriptEnabledChange(willBeEnabled);
        } catch (err) {
          logger.error(
            { err: err instanceof Error ? err.message : String(err) },
            'apply do toggle do Tool Script falhou (setting gravado; restart resolve)',
          );
        }
      }
    }

    return { success: true };
  });

  ipcMain.handle('settings:set-api-key', async (_event, key: string) => {
    const { setApiKey } = await import('../secrets-vault');
    await setApiKey(key);
  });
}
