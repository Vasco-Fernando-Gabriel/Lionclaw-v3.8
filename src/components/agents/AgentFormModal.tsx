import { useState, useEffect, useCallback, useRef } from 'react';
import { X, Save, RefreshCw, AlertTriangle, Key, Wifi } from 'lucide-react';
import type {
  AgentConfig,
  ExternalConfig,
  ExternalProvider,
  CodexConfig,
  CodexChatReasoningEffort,
  MCPServerConfig,
  Skill,
  ProviderStatusEntry,
  KimiAvailability,
} from '@/types';
import { PROVIDER_PRESETS, MODEL_CATALOG } from '@/lib/provider-presets';
import type { CatalogedModel } from '@/lib/provider-presets';
import { AGENT_CATEGORIES, CANONICAL_CATEGORY_VALUES, normalizeCategory } from '@/lib/agent-categories';
import { ApiKeyStatusIndicator } from './ApiKeyStatusIndicator';
import type { ApiKeyStatus } from './ApiKeyStatusIndicator';
import { ContextWindowDisplay } from './ContextWindowDisplay';
import {
  CODEX_MODELS,
  CODEX_DEFAULT_MODEL,
  CODEX_EFFORT_LABELS,
  clampCodexEffortToSupported,
} from '@/constants/codex-models';
import { useCodexModelCapabilities } from '@/hooks/useCodexModelCapabilities';
import {
  KIMI_DEFAULT_MODEL as KIMI_DEFAULT_MODEL_CONST,
  getKimiModel,
  filterManagedKimiModels,
  isManagedKimiSelectionUsable,
  normalizeKimiModelSelection,
  resolveKimiStoredEffort,
} from '@/constants/kimi-models';
import { CLAUDE_COMPAT_PRESETS } from '@/constants/claude-compat-presets';
import { CLAUDE_MODELS } from '@/constants/claude-models';
import { GROK_MODELS, GROK_DEFAULT_MODEL } from '@/constants/grok-models';

const TOOL_IDS = [
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
  'NotebookEdit',
  'Bash',
  'WebSearch',
  'WebFetch',
  'Agent',
  'TodoWrite',
  'AskUserQuestion',
] as const;

const LOCAL_ALLOWED_TOOLS = ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', 'WebSearch', 'WebFetch'] as const;

const CLOUD_MODELS = CLAUDE_MODELS.map((m) => ({
  value: m.id,
  label: m.displayName,
}));

const ZAI_MODELS = CLAUDE_COMPAT_PRESETS.find((p) => p.id === 'zai')?.models ?? [];
const ZAI_DEFAULT_MODEL = ZAI_MODELS[0]?.id ?? 'glm-4.7'; // gate-allow: default do picker de agent.model, DADO por agente

const MINIMAX_TP_MODELS = CLAUDE_COMPAT_PRESETS.find((p) => p.id === 'minimax')?.models ?? [];
const MINIMAX_TP_DEFAULT_MODEL = MINIMAX_TP_MODELS[0]?.id ?? 'MiniMax-M2.7'; // gate-allow: default do picker de agent.model, DADO por agente

const KIMI_DEFAULT_MODEL = KIMI_DEFAULT_MODEL_CONST;

const EFFORT_OPTIONS = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'max', label: 'Max' },
];

const THINKING_OPTIONS = [
  { value: 'adaptive', label: 'Adaptive' },
  { value: 'enabled', label: 'Enabled' },
  { value: 'disabled', label: 'Disabled' },
];

const EXTERNAL_PROVIDERS: Array<{ value: ExternalProvider; label: string }> = [
  { value: 'openrouter', label: 'OpenRouter' },
  { value: 'openai', label: 'OpenAI' },
  { value: 'kimi', label: 'Kimi (Moonshot)' },
  { value: 'deepseek', label: 'DeepSeek' },
  { value: 'qwen', label: 'Qwen (DashScope)' },
  { value: 'minimax-payg', label: 'MiniMax (Pay-as-you-go)' },
  { value: 'gemini-agent-platform', label: 'Gemini Agent Platform' },
  { value: 'openai-compatible', label: 'Custom (OpenAI Compatible)' },
];

function modelSupportsReasoning(provider: ExternalProvider, model: string): boolean {
  if (provider === 'openai') {
    return model.startsWith('gpt-6') || model.startsWith('gpt-5.5') || model.startsWith('o');
  }
  if (provider === 'openrouter') {
    if (model.startsWith('openai/gpt-6') || model.startsWith('openai/gpt-5')) return true;
    if (model.startsWith('qwen/qwen3.6')) return true;
  }
  if (provider === 'kimi' || provider === 'deepseek' || provider === 'qwen' || provider === 'minimax-payg') {
    const catalogEntry = MODEL_CATALOG[provider]?.find((m) => m.id === model);
    if (catalogEntry?.reasoning && catalogEntry.reasoning.kind !== 'none') return true;
  }
  return false;
}

function modelHasSurchargeWarning(notes?: string): boolean {
  if (!notes) return false;
  return notes.includes('surcharge') || notes.includes('2x') || notes.includes('>272k');
}

interface AgentFormModalProps {
  mode: 'create' | 'edit';
  agent?: AgentConfig;
  existingSquads?: string[];
  onSave: (agent: Omit<AgentConfig, 'sortOrder'>) => Promise<void>;
  onClose: () => void;
}

export function AgentFormModal({ mode, agent, existingSquads = [], onSave, onClose }: AgentFormModalProps) {
  const { effortsFor: discoveredEffortsFor, visibleModels } = useCodexModelCapabilities();
  const codexModelOptions = (() => {
    const options = CODEX_MODELS.map((m) => ({ ...m }));
    for (const cap of visibleModels ?? []) {
      if (options.some((o) => o.slug.toLowerCase() === cap.id.toLowerCase())) continue;
      options.push({ slug: cap.id, label: cap.displayName || cap.id, description: cap.description });
    }
    return options;
  })();
  const [name, setName] = useState(agent?.name || '');
  const [description, setDescription] = useState(agent?.description || '');
  const [runtime, setRuntime] = useState<AgentConfig['runtime']>(agent?.runtime || 'cloud');
  const [systemPrompt, setSystemPrompt] = useState(agent?.systemPrompt || '');
  const [allowedTools, setAllowedTools] = useState<Set<string>>(new Set(agent?.allowedTools || []));
  const [mcpServers, setMcpServers] = useState<Set<string>>(new Set(agent?.mcpServers || []));
  const [skills, setSkills] = useState<Set<string>>(new Set(agent?.skills || []));
  const [squad, setSquad] = useState<string>(agent?.squad || '');
  const [effort, setEffort] = useState<AgentConfig['effort']>(agent?.effort || 'medium');
  const [thinking, setThinking] = useState<AgentConfig['thinking']>(agent?.thinking || 'adaptive');
  const [thinkingBudget, setThinkingBudget] = useState<string>(agent?.thinkingBudget?.toString() || '');

  const [cloudModel, setCloudModel] = useState<string>(
    agent?.runtime === 'cloud' ? agent?.model || 'claude-sonnet-4-6' : 'claude-sonnet-4-6', // gate-allow: default do picker de agent.model (cloud), DADO por agente (SPEC 4.6)
  );
  const [maxTurns, setMaxTurns] = useState<string>(agent?.maxTurns?.toString() || '');

  const [zaiModel, setZaiModel] = useState<string>(
    agent?.runtime === 'zai' ? agent.model || ZAI_DEFAULT_MODEL : ZAI_DEFAULT_MODEL,
  );
  const [zaiStatus, setZaiStatus] = useState<ProviderStatusEntry | null>(null);
  const [zaiChecking, setZaiChecking] = useState(false);

  const [minimaxTpModel, setMinimaxTpModel] = useState<string>(
    agent?.runtime === 'minimax-tp' ? agent.model || MINIMAX_TP_DEFAULT_MODEL : MINIMAX_TP_DEFAULT_MODEL,
  );
  const [minimaxTpStatus, setMinimaxTpStatus] = useState<ProviderStatusEntry | null>(null);
  const [minimaxTpChecking, setMinimaxTpChecking] = useState(false);

  const [kimiModel, setKimiModel] = useState<string>(
    agent?.runtime === 'kimi' ? agent.model || KIMI_DEFAULT_MODEL : KIMI_DEFAULT_MODEL,
  );
  const [grokModel, setGrokModel] = useState<string>(
    agent?.runtime === 'grok' ? agent.model || GROK_DEFAULT_MODEL : GROK_DEFAULT_MODEL,
  );

  const [localProvider, setLocalProvider] = useState<string>(agent?.localConfig?.provider || 'ollama');
  const [localBaseUrl, setLocalBaseUrl] = useState(agent?.localConfig?.baseUrl || 'http://localhost:11434');
  const [localModel, setLocalModel] = useState(agent?.localConfig?.model || '');
  const [localTemperature, setLocalTemperature] = useState<string>(
    agent?.localConfig?.temperature?.toString() || '0.7',
  );
  const [localMaxTokens] = useState<string>(agent?.localConfig?.maxTokens?.toString() || '');
  const [localMode, setLocalMode] = useState<'simple' | 'smart'>(agent?.localMode || 'simple');
  const [maxToolRounds, setMaxToolRounds] = useState<string>(agent?.maxToolRounds?.toString() || '5');
  const [availableLocalModels, setAvailableLocalModels] = useState<string[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);

  const [extProvider, setExtProvider] = useState<ExternalProvider>(agent?.externalConfig?.provider || 'openrouter');
  const [extBaseUrl, setExtBaseUrl] = useState<string>(
    agent?.externalConfig?.baseUrl || PROVIDER_PRESETS['openrouter']?.baseUrl || '',
  );
  const [extModel, setExtModel] = useState<string>(
    agent?.externalConfig?.model || PROVIDER_PRESETS['openrouter']?.defaultModel || '',
  );
  const [extApiKeyInput, setExtApiKeyInput] = useState<string>('');
  const [extApiKeyRef, setExtApiKeyRef] = useState<string>(
    agent?.externalConfig?.apiKeyRef || PROVIDER_PRESETS['openrouter']?.vaultKey || '',
  );
  const [extTemperature, setExtTemperature] = useState<string>(
    agent?.externalConfig?.temperature?.toString() ?? (agent?.runtime === 'external' ? '0.7' : ''),
  );
  const [extMaxTokens, setExtMaxTokens] = useState<string>(
    agent?.externalConfig?.maxTokens?.toString() ?? (agent?.runtime === 'external' ? '8000' : ''),
  );
  const [extCustomVaultSlug, setExtCustomVaultSlug] = useState<string>('');
  const [extExtraHeaders, setExtExtraHeaders] = useState<string>(
    agent?.externalConfig?.extraHeaders ? JSON.stringify(agent.externalConfig.extraHeaders, null, 2) : '',
  );
  const [extContextWindow, setExtContextWindow] = useState<string>(
    agent?.externalConfig?.contextWindow?.toString() || '',
  );
  const [extMaxToolRounds, setExtMaxToolRounds] = useState<string>(
    agent?.runtime === 'external' && agent.maxToolRounds ? agent.maxToolRounds.toString() : '50',
  );

  const [codexModel, setCodexModel] = useState<string>(agent?.codexConfig?.model || CODEX_DEFAULT_MODEL);
  const [codexReasoningEffort, setCodexReasoningEffort] = useState<CodexChatReasoningEffort>(
    agent?.codexConfig?.reasoningEffort || 'medium',
  );

  useEffect(() => {
    if (runtime !== 'codex') return;
    if (discoveredEffortsFor(codexModel).includes(codexReasoningEffort)) return;
    setCodexReasoningEffort(clampCodexEffortToSupported(codexReasoningEffort, discoveredEffortsFor(codexModel)));
  }, [runtime, codexModel, codexReasoningEffort, discoveredEffortsFor]);

  const [codexStatus, setCodexStatus] = useState<{
    installed: boolean;
    version: string | null;
    authenticated: boolean;
  } | null>(null);
  const [codexTestResult, setCodexTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [codexTesting, setCodexTesting] = useState(false);

  const refreshCodexStatus = useCallback(async () => {
    try {
      const status = await window.lionclaw.codex.status();
      setCodexStatus(status);
    } catch {
      setCodexStatus({ installed: false, version: null, authenticated: false });
    }
  }, []);

  useEffect(() => {
    if (runtime === 'codex') void refreshCodexStatus();
  }, [runtime, refreshCodexStatus]);

  const [kimiStatus, setKimiStatus] = useState<KimiAvailability | null>(null);

  const refreshKimiStatus = useCallback(async () => {
    try {
      const status = await window.lionclaw.kimi.status();
      setKimiStatus(status);
      setKimiModel((current) => normalizeKimiModelSelection(current));
    } catch {
      setKimiStatus({
        installed: false,
        version: null,
        authenticated: false,
        authMode: 'none',
        managedProviderVerified: false,
        modelAvailable: false,
        availableModels: [],
        usable: false,
        reason: 'Nao foi possivel verificar o runtime Kimi.',
      });
    }
  }, []);

  useEffect(() => {
    void refreshKimiStatus();
  }, [refreshKimiStatus]);

  const [grokStatus, setGrokStatus] = useState<Awaited<ReturnType<typeof window.lionclaw.grok.status>> | null>(null);
  const refreshGrokStatus = useCallback(async () => {
    try {
      setGrokStatus(await window.lionclaw.grok.status());
    } catch {
      setGrokStatus(null);
    }
  }, []);

  useEffect(() => {
    void refreshGrokStatus();
  }, [refreshGrokStatus]);

  useEffect(() => {
    if (runtime === 'grok' && effort === 'max') setEffort('high');
  }, [runtime, effort]);

  useEffect(() => {
    if (runtime !== 'kimi') return;
    const effective = resolveKimiStoredEffort(kimiModel, effort);
    if (effective !== undefined && effective !== effort) setEffort(effective);
  }, [runtime, kimiModel, effort]);

  const refreshZaiStatus = useCallback(async () => {
    setZaiChecking(true);
    try {
      const status = await window.lionclaw.provider.check({
        runtime: 'claude-compat-sdk',
        provider: 'zai',
      });
      if ('error' in status) {
        setZaiStatus({
          runtime: 'claude-compat-sdk',
          provider: 'zai',
          connected: false,
          available: false,
          reason: status.error,
        });
      } else {
        setZaiStatus(status);
      }
    } finally {
      setZaiChecking(false);
    }
  }, []);

  useEffect(() => {
    if (runtime === 'zai') void refreshZaiStatus();
  }, [runtime, refreshZaiStatus]);

  const refreshMinimaxTpStatus = useCallback(async () => {
    setMinimaxTpChecking(true);
    try {
      const status = await window.lionclaw.provider.check({
        runtime: 'claude-compat-sdk',
        provider: 'minimax',
      });
      if ('error' in status) {
        setMinimaxTpStatus({
          runtime: 'claude-compat-sdk',
          provider: 'minimax',
          connected: false,
          available: false,
          reason: (status as { error: string }).error,
        });
      } else {
        setMinimaxTpStatus(status);
      }
    } finally {
      setMinimaxTpChecking(false);
    }
  }, []);

  useEffect(() => {
    if (runtime === 'minimax-tp') void refreshMinimaxTpStatus();
  }, [runtime, refreshMinimaxTpStatus]);

  const handleCodexLogin = useCallback(async () => {
    await window.lionclaw.codex.openLogin();
  }, []);

  const handleCodexTest = useCallback(async () => {
    setCodexTesting(true);
    try {
      const result = await window.lionclaw.codex.test();
      setCodexTestResult(result);
      if (result.ok) await refreshCodexStatus();
    } finally {
      setCodexTesting(false);
    }
  }, [refreshCodexStatus]);

  const [apiKeyStatus, setApiKeyStatus] = useState<ApiKeyStatus>('unconfigured');
  const [apiKeyError, setApiKeyError] = useState<string>('');

  const [globalTools, setGlobalTools] = useState<string[]>([]);
  const [availableMCP, setAvailableMCP] = useState<MCPServerConfig[]>([]);
  const [availableSkills, setAvailableSkills] = useState<Skill[]>([]);
  const [saving, setSaving] = useState(false);

  const initializedRef = useRef(false);

  useEffect(() => {
    if (initializedRef.current) return;
    initializedRef.current = true;

    Promise.all([window.lionclaw.tools.getEnabled(), window.lionclaw.mcp.list(), window.lionclaw.skills.list()]).then(
      ([tools, mcp, sk]) => {
        setGlobalTools(tools);
        setAvailableMCP(mcp.filter((s) => s.isActive));
        setAvailableSkills(sk);
      },
    );

    if (agent?.runtime === 'external' && agent.externalConfig?.apiKeyRef) {
      window.lionclaw.vault.check(agent.externalConfig.apiKeyRef).then((configured) => {
        setApiKeyStatus(configured ? 'saved' : 'unconfigured');
      });
      if (agent.externalConfig.provider === 'openai-compatible') {
        const ref = agent.externalConfig.apiKeyRef;
        const match = /^HARNESS_CUSTOM_(.+)_KEY$/.exec(ref);
        if (match) setExtCustomVaultSlug(match[1].toLowerCase());
      }
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const fetchLocalModels = useCallback(
    async (provider: string, baseUrl: string) => {
      setLoadingModels(true);
      setModelsError(null);
      try {
        const result = await window.lionclaw.ollama.listModels(provider, baseUrl);
        if (result.error) {
          setModelsError(result.error);
          setAvailableLocalModels([]);
        } else {
          setAvailableLocalModels(result.models);
          if (result.models.length > 0 && !localModel) {
            setLocalModel(result.models[0]);
          }
        }
      } catch {
        setModelsError('Falha ao conectar');
        setAvailableLocalModels([]);
      } finally {
        setLoadingModels(false);
      }
    },
    [localModel],
  );

  useEffect(() => {
    if (runtime === 'local' && localBaseUrl) {
      fetchLocalModels(localProvider, localBaseUrl);
    }
  }, [runtime, localProvider, localBaseUrl, fetchLocalModels]);

  useEffect(() => {
    if (runtime !== 'external') return;
    if (!extApiKeyRef) return;
    if (apiKeyStatus === 'ok' || apiKeyStatus === 'testing' || apiKeyStatus === 'error') return;
    let cancelled = false;
    window.lionclaw.vault.check(extApiKeyRef).then((configured) => {
      if (cancelled) return;
      setApiKeyStatus(configured ? 'saved' : 'unconfigured');
    });
    return () => {
      cancelled = true;
    };
  }, [runtime, extApiKeyRef, apiKeyStatus]);

  const handleProviderChange = (provider: ExternalProvider) => {
    setExtProvider(provider);
    setApiKeyStatus('unconfigured');
    setApiKeyError('');
    setExtApiKeyInput('');

    if (!extTemperature || extTemperature.trim().length === 0) {
      setExtTemperature('0.7');
    }
    if (!extMaxTokens || extMaxTokens.trim().length === 0) {
      setExtMaxTokens('8000');
    }
    if (!maxToolRounds || maxToolRounds.trim().length === 0 || maxToolRounds === '5') {
      setMaxToolRounds('50');
    }

    if (provider === 'openai-compatible') {
      setExtBaseUrl('');
      setExtModel('');
      setExtApiKeyRef('');
      setExtExtraHeaders('');
    } else {
      const preset = PROVIDER_PRESETS[provider];
      setExtBaseUrl(preset?.baseUrl || '');
      setExtModel(preset?.defaultModel || '');
      setExtApiKeyRef(preset?.vaultKey || '');
      setExtExtraHeaders(preset?.extraHeaders ? JSON.stringify(preset.extraHeaders, null, 2) : '');

      if (preset?.vaultKey) {
        window.lionclaw.vault.check(preset.vaultKey).then((configured) => {
          if (configured) setApiKeyStatus('saved');
        });
      }
    }
  };

  const handleSaveAndTestKey = async () => {
    const keyValue = extApiKeyInput.trim();
    if (!keyValue) return;

    const vaultKey = resolveVaultKey();
    if (!vaultKey) return;

    setApiKeyStatus('testing');
    setApiKeyError('');

    try {
      if (extProvider === 'openai-compatible') {
        const entryLabel = extCustomVaultSlug ? `Custom Provider (${extCustomVaultSlug})` : 'Custom Provider API Key';
        const result = await window.lionclaw.vault.registerAndSet(
          {
            key: vaultKey,
            label: entryLabel,
            description: 'API key para provider customizado OpenAI-compatible',
            service: 'LionClaw-Custom',
            required: false,
          },
          keyValue,
        );
        if ('error' in result) {
          setApiKeyStatus('error');
          setApiKeyError(result.error);
          return;
        }
      } else if (extProvider === 'gemini-agent-platform') {
        const result = await window.lionclaw.provider.connect({
          provider: 'vertex-ai',
          apiKey: keyValue,
        });
        if ('error' in result) {
          setApiKeyStatus('error');
          setApiKeyError(result.error);
          return;
        }
      } else {
        await window.lionclaw.vault.set(vaultKey, keyValue);
      }

      const testResult = await window.lionclaw.provider.testConnection(extProvider, extBaseUrl, vaultKey);

      if (testResult.ok) {
        setApiKeyStatus('ok');
        setExtApiKeyInput('');
      } else {
        setApiKeyStatus('error');
        setApiKeyError('error' in testResult ? testResult.error : 'Falha no teste de conexao.');
      }
    } catch (err) {
      setApiKeyStatus('error');
      setApiKeyError(err instanceof Error ? err.message : 'Erro inesperado.');
    }
  };

  const handleTestKey = async () => {
    const vaultKey = resolveVaultKey();
    if (!vaultKey) return;

    setApiKeyStatus('testing');
    setApiKeyError('');

    try {
      const testResult = await window.lionclaw.provider.testConnection(extProvider, extBaseUrl, vaultKey);
      if (testResult.ok) {
        setApiKeyStatus('ok');
      } else {
        setApiKeyStatus('error');
        setApiKeyError('error' in testResult ? testResult.error : 'Falha no teste de conexao.');
      }
    } catch (err) {
      setApiKeyStatus('error');
      setApiKeyError(err instanceof Error ? err.message : 'Erro inesperado.');
    }
  };

  const resolveVaultKey = (): string => {
    if (extProvider === 'openai-compatible') {
      const slug = extCustomVaultSlug
        .trim()
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, '_');
      return slug ? `HARNESS_CUSTOM_${slug}_KEY` : '';
    }
    return extApiKeyRef || PROVIDER_PRESETS[extProvider]?.vaultKey || '';
  };

  const toggleTool = (tool: string) => {
    const next = new Set(allowedTools);
    if (next.has(tool)) next.delete(tool);
    else next.add(tool);
    setAllowedTools(next);
  };

  const toggleMCP = (id: string) => {
    const next = new Set(mcpServers);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setMcpServers(next);
  };

  const toggleSkill = (skillName: string) => {
    const next = new Set(skills);
    if (next.has(skillName)) next.delete(skillName);
    else next.add(skillName);
    setSkills(next);
  };

  const baseFieldsValid =
    name.trim().length >= 2 &&
    name.trim().length <= 50 &&
    description.trim().length >= 5 &&
    systemPrompt.trim().length >= 10;

  const externalKeyBlocking = runtime === 'external' && apiKeyStatus !== 'ok';
  const zaiKeyBlocking = runtime === 'zai' && (!zaiStatus || !zaiStatus.connected);
  const minimaxTpKeyBlocking = runtime === 'minimax-tp' && (!minimaxTpStatus || !minimaxTpStatus.connected);
  const availableKimiModels = filterManagedKimiModels(kimiStatus?.availableModels ?? []);
  const kimiModelAvailable = availableKimiModels.some((model) => model.slug === kimiModel);
  const kimiBlocking = runtime === 'kimi' && !isManagedKimiSelectionUsable(kimiStatus, kimiModel);
  const grokBlocking = runtime === 'grok' && grokStatus?.usable !== true;

  const isValid =
    baseFieldsValid &&
    !externalKeyBlocking &&
    !zaiKeyBlocking &&
    !minimaxTpKeyBlocking &&
    !kimiBlocking &&
    !grokBlocking;

  const catalogModels: CatalogedModel[] = extProvider !== 'openai-compatible' ? (MODEL_CATALOG[extProvider] ?? []) : [];

  const selectedMcpTools = Array.from(allowedTools).filter((t) => t.startsWith('mcp__'));

  const selectedCatalogModel = catalogModels.find((m) => m.id === extModel);
  const reasoningSupported = modelSupportsReasoning(extProvider, extModel);
  const hasSurcharge = modelHasSurchargeWarning(selectedCatalogModel?.notes);

  const agentSnapshot: AgentConfig = {
    id: '',
    name: name || '',
    description: '',
    systemPrompt: '',
    model:
      runtime === 'minimax-tp'
        ? minimaxTpModel
        : runtime === 'kimi'
          ? kimiModel
          : runtime === 'grok'
            ? grokModel
            : runtime === 'zai'
              ? zaiModel
              : cloudModel,
    allowedTools: [],
    mcpServers: [],
    isActive: true,
    sortOrder: 0,
    effort,
    thinking,
    skills: [],
    runtime,
    externalConfig: runtime === 'external' ? buildExternalConfig() : undefined,
  };

  function buildExternalConfig(): ExternalConfig {
    const vaultKey = resolveVaultKey();
    let parsedHeaders: Record<string, string> | undefined;
    if (extProvider === 'openai-compatible') {
      try {
        parsedHeaders = extExtraHeaders.trim() ? (JSON.parse(extExtraHeaders) as Record<string, string>) : undefined;
      } catch {
        parsedHeaders = undefined;
      }
    } else {
      parsedHeaders = PROVIDER_PRESETS[extProvider]?.extraHeaders;
    }

    const isGemini = extProvider === 'gemini-agent-platform';

    return {
      provider: extProvider,
      protocol: isGemini ? 'google-genai' : 'openai-compatible',
      baseUrl: isGemini ? undefined : extBaseUrl,
      model: extModel,
      apiKeyRef: vaultKey,
      temperature: extTemperature ? parseFloat(extTemperature) : undefined,
      maxTokens: extMaxTokens ? parseInt(extMaxTokens, 10) : undefined,
      extraHeaders: parsedHeaders,
      contextWindow:
        extProvider === 'openai-compatible' && extContextWindow ? parseInt(extContextWindow, 10) : undefined,
    };
  }

  function buildCodexConfig(): CodexConfig | undefined {
    if (runtime !== 'codex') return undefined;
    return {
      model: codexModel,
      sandbox: 'workspace-write',
      reasoningEffort: codexReasoningEffort,
    };
  }

  const handleSave = async () => {
    if (!isValid || saving) return;
    setSaving(true);
    try {
      const externalCfg = runtime === 'external' ? buildExternalConfig() : undefined;

      await onSave({
        id:
          agent?.id ||
          name
            .trim()
            .toLowerCase()
            .replace(/\s+/g, '-')
            .replace(/[^a-z0-9-]/g, ''),
        name: name.trim(),
        description: description.trim(),
        systemPrompt: systemPrompt.trim(),
        model:
          runtime === 'local'
            ? 'haiku'
            : runtime === 'codex'
              ? codexModel
              : runtime === 'minimax-tp'
                ? minimaxTpModel
                : runtime === 'kimi'
                  ? kimiModel
                  : runtime === 'grok'
                    ? grokModel
                    : runtime === 'zai'
                      ? zaiModel
                      : cloudModel,
        allowedTools:
          runtime === 'local' && localMode === 'simple' ? [] : runtime === 'codex' ? [] : Array.from(allowedTools),
        mcpServers: runtime === 'local' || runtime === 'codex' ? [] : Array.from(mcpServers),
        isActive: agent?.isActive ?? true,
        effort,
        thinking,
        thinkingBudget: thinking === 'enabled' && thinkingBudget ? parseInt(thinkingBudget, 10) : undefined,
        maxTurns: runtime !== 'external' && runtime !== 'codex' && maxTurns ? parseInt(maxTurns, 10) : undefined,
        skills: runtime === 'local' || runtime === 'codex' ? [] : Array.from(skills),
        runtime,
        localConfig:
          runtime === 'local'
            ? {
                provider: localProvider as 'ollama' | 'lmstudio' | 'openai-compatible',
                baseUrl: localBaseUrl,
                model: localModel,
                temperature: localTemperature ? parseFloat(localTemperature) : undefined,
                maxTokens: localMaxTokens ? parseInt(localMaxTokens, 10) : undefined,
              }
            : undefined,
        localMode: runtime === 'local' ? localMode : undefined,
        maxToolRounds:
          runtime === 'external'
            ? parseInt(extMaxToolRounds, 10) || 5
            : runtime === 'local' && localMode === 'smart'
              ? parseInt(maxToolRounds, 10) || 5
              : undefined,
        externalConfig: externalCfg,
        codexConfig: buildCodexConfig(),
        squad: normalizeCategory(squad),
      });
      onClose();
    } finally {
      setSaving(false);
    }
  };

  const vaultKeyResolved = resolveVaultKey();
  const canSaveKey =
    extApiKeyInput.trim().length > 0 &&
    (extProvider !== 'openai-compatible' || extCustomVaultSlug.trim().length > 0) &&
    (extProvider === 'gemini-agent-platform' || extBaseUrl.trim().length > 0);

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50">
      <div className="w-full max-w-lg mx-4 max-h-[90vh] rounded-xl border border-zinc-700 bg-zinc-900 flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-800">
          <h3 className="text-sm font-semibold text-zinc-100">
            {mode === 'create' ? 'Novo Subagente' : `Editar: ${agent?.name}`}
          </h3>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-zinc-800 text-zinc-500 hover:text-zinc-300 transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
          {/* Name, Description, Squad */}
          <div className="space-y-3">
            <div>
              <label className="block text-xs text-zinc-400 mb-1">Nome</label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Ex: Coder"
                maxLength={50}
                className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 outline-none focus:border-amber-500/50 transition-colors"
              />
            </div>
            <div>
              <label className="block text-xs text-zinc-400 mb-1">Descricao</label>
              <input
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Ex: Especialista em codigo e arquitetura"
                maxLength={200}
                className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 outline-none focus:border-amber-500/50 transition-colors"
              />
            </div>
            <div>
              <label className="block text-xs text-zinc-400 mb-1">Squad</label>
              <input
                list="squad-options"
                value={squad}
                onChange={(e) => setSquad(e.target.value)}
                placeholder="Ex: backend, frontend, quality"
                className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 outline-none focus:border-amber-500/50 transition-colors"
              />
              <datalist id="squad-options">
                {/* Categorias canonicas (mesma lista em qualquer instalacao) */}
                {AGENT_CATEGORIES.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
                {/* Categorias custom que ja existem no banco mas nao sao canonicas */}
                {existingSquads
                  .filter((sq) => !CANONICAL_CATEGORY_VALUES.includes(sq))
                  .map((sq) => (
                    <option key={sq} value={sq} />
                  ))}
              </datalist>
            </div>
          </div>

          {/* Runtime Selector */}
          <div>
            <label className="block text-xs text-zinc-400 mb-1">Runtime</label>
            <select
              value={runtime}
              onChange={(e) => setRuntime(e.target.value as AgentConfig['runtime'])}
              className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 outline-none focus:border-amber-500/50 transition-colors"
            >
              <option value="cloud">Cloud (Claude SDK)</option>
              <option value="zai">Z.ai (GLM via assinatura)</option>
              <option value="minimax-tp">MiniMax TokenPlan</option>
              <option value="kimi" disabled={kimiStatus?.usable !== true}>
                Kimi (assinatura via CLI)
              </option>
              <option value="grok" disabled={grokStatus?.usable !== true}>
                Grok Build (assinatura via CLI)
              </option>
              <option value="local">Local (Ollama / LM Studio)</option>
              <option value="external">External (OpenRouter, OpenAI, Custom)</option>
              <option value="codex">Codex (OpenAI via OAuth)</option>
            </select>
          </div>

          {/* CLOUD SECTION */}
          {runtime === 'cloud' && (
            <div>
              <h4 className="text-xs font-medium text-zinc-300 mb-3 uppercase tracking-wide">Modelo e Performance</h4>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-zinc-400 mb-1">Modelo</label>
                  <select
                    value={cloudModel}
                    onChange={(e) => setCloudModel(e.target.value)}
                    className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 outline-none focus:border-amber-500/50 transition-colors"
                  >
                    {CLOUD_MODELS.map((m) => (
                      <option key={m.value} value={m.value}>
                        {m.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-zinc-400 mb-1">Effort</label>
                  <select
                    value={effort}
                    onChange={(e) => setEffort(e.target.value as AgentConfig['effort'])}
                    className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 outline-none focus:border-amber-500/50 transition-colors"
                  >
                    {EFFORT_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-zinc-400 mb-1">Thinking</label>
                  <select
                    value={thinking}
                    onChange={(e) => setThinking(e.target.value as AgentConfig['thinking'])}
                    className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 outline-none focus:border-amber-500/50 transition-colors"
                  >
                    {THINKING_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </div>
                {thinking === 'enabled' && (
                  <div>
                    <label className="block text-xs text-zinc-400 mb-1">Budget (tokens)</label>
                    <input
                      type="number"
                      value={thinkingBudget}
                      onChange={(e) => setThinkingBudget(e.target.value)}
                      placeholder="Ex: 10000"
                      className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 outline-none focus:border-amber-500/50 transition-colors"
                    />
                  </div>
                )}
                <div>
                  <label className="block text-xs text-zinc-400 mb-1">Max Turnos</label>
                  <input
                    type="number"
                    value={maxTurns}
                    onChange={(e) => setMaxTurns(e.target.value)}
                    placeholder="Sem limite"
                    min={1}
                    max={100}
                    className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 outline-none focus:border-amber-500/50 transition-colors"
                  />
                </div>
              </div>
            </div>
          )}

          {/* Z.AI SECTION */}
          {runtime === 'zai' && (
            <div className="space-y-4 p-3 rounded-lg border border-zinc-700 bg-zinc-800/30">
              <h5 className="text-xs font-medium text-cyan-400 uppercase tracking-wide">Configuracao Z.ai</h5>

              <div>
                <label className="block text-xs text-zinc-400 mb-1">Modelo GLM</label>
                <select
                  value={zaiModel}
                  onChange={(e) => setZaiModel(e.target.value)}
                  className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 outline-none focus:border-amber-500/50 transition-colors"
                >
                  {ZAI_MODELS.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.displayName}
                    </option>
                  ))}
                </select>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-zinc-400 mb-1">Effort</label>
                  <select
                    value={effort}
                    onChange={(e) => setEffort(e.target.value as AgentConfig['effort'])}
                    className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 outline-none focus:border-amber-500/50 transition-colors"
                  >
                    {EFFORT_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-zinc-400 mb-1">Thinking</label>
                  <select
                    value={thinking}
                    onChange={(e) => setThinking(e.target.value as AgentConfig['thinking'])}
                    className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 outline-none focus:border-amber-500/50 transition-colors"
                  >
                    {THINKING_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </div>
                {thinking === 'enabled' && (
                  <div>
                    <label className="block text-xs text-zinc-400 mb-1">Budget (tokens)</label>
                    <input
                      type="number"
                      value={thinkingBudget}
                      onChange={(e) => setThinkingBudget(e.target.value)}
                      placeholder="Ex: 10000"
                      className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 outline-none focus:border-amber-500/50 transition-colors"
                    />
                  </div>
                )}
                <div>
                  <label className="block text-xs text-zinc-400 mb-1">Max Turnos</label>
                  <input
                    type="number"
                    value={maxTurns}
                    onChange={(e) => setMaxTurns(e.target.value)}
                    placeholder="Sem limite"
                    min={1}
                    max={100}
                    className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 outline-none focus:border-amber-500/50 transition-colors"
                  />
                </div>
              </div>

              <div className="p-2 rounded-lg bg-zinc-800 border border-zinc-700">
                {zaiChecking ? (
                  <p className="text-xs text-zinc-500">Verificando Z.ai...</p>
                ) : zaiStatus?.connected ? (
                  <div className="flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-green-500" />
                    <p className="text-xs text-green-400">Z.ai conectado via Vault global</p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <div className="flex items-center gap-2">
                      <span className="w-2 h-2 rounded-full bg-red-500" />
                      <p className="text-xs text-red-400">Z.ai nao conectado</p>
                    </div>
                    {zaiStatus?.reason && <p className="text-[10px] text-zinc-500">{zaiStatus.reason}</p>}
                  </div>
                )}
              </div>

              <button
                type="button"
                onClick={refreshZaiStatus}
                disabled={zaiChecking}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-zinc-700 hover:bg-zinc-600 text-xs text-zinc-100 transition-colors disabled:opacity-50"
              >
                {zaiChecking ? 'Verificando...' : 'Reverificar conexao'}
              </button>

              <div className="p-2 rounded-lg bg-zinc-800/50 border border-zinc-700/50">
                <p className="text-xs text-zinc-500">
                  Usa o Claude Agent SDK em processo separado apontando para Z.ai. Tools, MCPs e Skills do LionClaw
                  continuam disponiveis para este runtime.
                </p>
              </div>
            </div>
          )}

          {/* MINIMAX TOKENPLAN SECTION */}
          {runtime === 'minimax-tp' && (
            <div className="space-y-4 p-3 rounded-lg border border-zinc-700 bg-zinc-800/30">
              <h5 className="text-xs font-medium text-purple-400 uppercase tracking-wide">
                Configuracao MiniMax TokenPlan
              </h5>

              <div>
                <label className="block text-xs text-zinc-400 mb-1">Modelo</label>
                <select
                  value={minimaxTpModel}
                  onChange={(e) => setMinimaxTpModel(e.target.value)}
                  className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 outline-none focus:border-amber-500/50 transition-colors"
                >
                  {MINIMAX_TP_MODELS.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.displayName}
                      {m.supportTier === 'parameter-only' && ' (parameter-only)'}
                      {m.supportTier === 'highspeed-only' && ' (highspeed only)'}
                    </option>
                  ))}
                </select>
                {(() => {
                  const sel = MINIMAX_TP_MODELS.find((m) => m.id === minimaxTpModel);
                  if (sel?.notes) {
                    return <p className="text-xs text-yellow-600 mt-1">{sel.notes}</p>;
                  }
                  return null;
                })()}
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-zinc-400 mb-1">Effort</label>
                  <select
                    value={effort}
                    onChange={(e) => setEffort(e.target.value as AgentConfig['effort'])}
                    className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 outline-none focus:border-amber-500/50 transition-colors"
                  >
                    {EFFORT_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-zinc-400 mb-1">Thinking</label>
                  <select
                    value={thinking}
                    onChange={(e) => setThinking(e.target.value as AgentConfig['thinking'])}
                    className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 outline-none focus:border-amber-500/50 transition-colors"
                  >
                    {THINKING_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </div>
                {thinking === 'enabled' && (
                  <div>
                    <label className="block text-xs text-zinc-400 mb-1">Budget (tokens)</label>
                    <input
                      type="number"
                      value={thinkingBudget}
                      onChange={(e) => setThinkingBudget(e.target.value)}
                      placeholder="Ex: 10000"
                      className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 outline-none focus:border-amber-500/50 transition-colors"
                    />
                  </div>
                )}
                <div>
                  <label className="block text-xs text-zinc-400 mb-1">Max Turnos</label>
                  <input
                    type="number"
                    value={maxTurns}
                    onChange={(e) => setMaxTurns(e.target.value)}
                    placeholder="Sem limite"
                    min={1}
                    max={100}
                    className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 outline-none focus:border-amber-500/50 transition-colors"
                  />
                </div>
              </div>

              <div className="p-2 rounded-lg bg-zinc-800 border border-zinc-700">
                {minimaxTpChecking ? (
                  <p className="text-xs text-zinc-500">Verificando MiniMax TokenPlan...</p>
                ) : minimaxTpStatus?.connected ? (
                  <div className="flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-green-500" />
                    <p className="text-xs text-green-400">MiniMax TokenPlan conectado via Vault global</p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <div className="flex items-center gap-2">
                      <span className="w-2 h-2 rounded-full bg-red-500" />
                      <p className="text-xs text-red-400">
                        {minimaxTpStatus?.reason === 'secret-missing'
                          ? 'Chave removida do Vault - reconectar em Settings'
                          : 'Nao conectado - configurar em Settings > Provedores externos'}
                      </p>
                    </div>
                    {minimaxTpStatus?.reason && minimaxTpStatus.reason !== 'secret-missing' && (
                      <p className="text-[10px] text-zinc-500">{minimaxTpStatus.reason}</p>
                    )}
                  </div>
                )}
              </div>

              <button
                type="button"
                onClick={refreshMinimaxTpStatus}
                disabled={minimaxTpChecking}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-zinc-700 hover:bg-zinc-600 text-xs text-zinc-100 transition-colors disabled:opacity-50"
              >
                {minimaxTpChecking ? 'Verificando...' : 'Reverificar conexao'}
              </button>

              <div className="p-2 rounded-lg bg-purple-900/20 border border-purple-700/30">
                <p className="text-xs text-purple-300">
                  Usando key compartilhada com Settings &gt; MiniMax TokenPlan. Configurada via Provedores externos.
                </p>
              </div>

              <div className="p-2 rounded-lg bg-zinc-800/50 border border-zinc-700/50">
                <p className="text-xs text-zinc-500">
                  Usa o Claude Agent SDK em processo separado apontando para MiniMax. Tools, MCPs e Skills do LionClaw
                  continuam disponiveis para este runtime. Custo exibido e estimativa equivalente pay-as-you-go.
                </p>
              </div>
            </div>
          )}

          {/* KIMI SECTION: modelo e effort sao model-aware; K2.7 e boolean-only. */}
          {runtime === 'kimi' && (
            <div className="space-y-4 p-3 rounded-lg border border-zinc-700 bg-zinc-800/30">
              <h5 className="text-xs font-medium text-teal-400 uppercase tracking-wide">Configuracao Kimi</h5>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-zinc-400 mb-1">Modelo</label>
                  <select
                    value={kimiModelAvailable ? kimiModel : ''}
                    onChange={(e) => setKimiModel(e.target.value)}
                    disabled={kimiStatus?.usable !== true || availableKimiModels.length === 0}
                    className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 outline-none focus:border-amber-500/50 transition-colors"
                  >
                    {!kimiModelAvailable && (
                      <option value="" disabled>
                        {availableKimiModels.length === 0
                          ? 'Nenhum modelo managed disponivel'
                          : 'Selecione um modelo disponivel'}
                      </option>
                    )}
                    {availableKimiModels.map((m) => (
                      <option key={m.slug} value={m.slug}>
                        {m.label}: {m.description}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-zinc-400 mb-1">Reasoning effort</label>
                  {getKimiModel(kimiModel)?.efforts.length ? (
                    <select
                      value={resolveKimiStoredEffort(kimiModel, effort)}
                      onChange={(e) => setEffort(e.target.value as AgentConfig['effort'])}
                      className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 outline-none focus:border-amber-500/50 transition-colors"
                    >
                      {getKimiModel(kimiModel)?.efforts.map((option) => (
                        <option key={option} value={option}>
                          {option}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      value="Thinking on (fixo do modelo)"
                      readOnly
                      disabled
                      aria-label="Reasoning Kimi booleano"
                      className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-400 disabled:cursor-not-allowed disabled:opacity-70"
                    />
                  )}
                </div>
              </div>

              {/* Indicador de status (live via IPC). Espelha o bloco do Codex.
                  Kimi e full assinatura: o unico estado conectado e 'subscription'. */}
              <div className="p-2 rounded-lg bg-zinc-800 border border-zinc-700">
                {kimiStatus === null ? (
                  <p className="text-xs text-zinc-500">Verificando status do Kimi...</p>
                ) : !kimiStatus.installed ? (
                  <div className="flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-red-500" />
                    <p className="text-xs text-red-400">Kimi CLI nao instalado</p>
                  </div>
                ) : kimiStatus.authMode === 'none' || !kimiStatus.authenticated ? (
                  <div className="flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-yellow-500" />
                    <p className="text-xs text-yellow-400">
                      Kimi instalado{kimiStatus.version ? ` (${kimiStatus.version})` : ''}: nao autenticado
                    </p>
                  </div>
                ) : !kimiStatus.managedProviderVerified ? (
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="w-2 h-2 rounded-full bg-yellow-500" />
                      <p className="text-xs text-yellow-400">Sessao oficial do Kimi nao reconhecida</p>
                    </div>
                    {kimiStatus.reason && <p className="text-[10px] text-zinc-500">{kimiStatus.reason}</p>}
                  </div>
                ) : !kimiStatus.modelAvailable || !kimiStatus.usable ? (
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="w-2 h-2 rounded-full bg-yellow-500" />
                      <p className="text-xs text-yellow-400">Nenhum modelo Kimi managed compativel disponivel</p>
                    </div>
                    {kimiStatus.reason && <p className="text-[10px] text-zinc-500">{kimiStatus.reason}</p>}
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-green-500" />
                    <p className="text-xs text-green-400">
                      Kimi conectado via assinatura
                      {kimiStatus.version ? ` (${kimiStatus.version})` : ''}
                    </p>
                  </div>
                )}
              </div>

              <div className="p-2 rounded-lg bg-zinc-800/50 border border-zinc-700/50">
                <p className="text-xs text-zinc-500">
                  Runtime Kimi nativo via CLI, full assinatura. Autentique em Configuracoes &gt; Provedores externos
                  &gt; Kimi CLI (/login). O custo exibido e uma estimativa equivalente pay-as-you-go.
                </p>
              </div>
            </div>
          )}

          {runtime === 'grok' && (
            <div className="space-y-4 p-3 rounded-lg border border-zinc-700 bg-zinc-800/30">
              <h5 className="text-xs font-medium text-cyan-400 uppercase tracking-wide">Configuracao Grok Build</h5>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-zinc-400 mb-1">Modelo</label>
                  <select
                    value={grokModel}
                    onChange={(event) => setGrokModel(event.target.value)}
                    className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100"
                  >
                    {GROK_MODELS.map((model) => (
                      <option key={model.slug} value={model.slug}>
                        {model.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-zinc-400 mb-1">Effort</label>
                  <select
                    value={effort}
                    onChange={(event) => setEffort(event.target.value as AgentConfig['effort'])}
                    className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100"
                  >
                    <option value="low">Low</option>
                    <option value="medium">Medium</option>
                    <option value="high">High</option>
                  </select>
                </div>
              </div>
              <div className="p-2 rounded-lg bg-zinc-800 border border-zinc-700">
                {grokStatus?.usable ? (
                  <p className="text-xs text-green-400">
                    Grok Build conectado e pronto ({grokStatus.version ?? 'versao desconhecida'})
                  </p>
                ) : (
                  <p className="text-xs text-amber-400">
                    Conecte e valide o Grok Build em Configuracoes &gt; Provedores externos antes de salvar.
                  </p>
                )}
              </div>
              <p className="text-xs text-zinc-500">
                Grok via ACP oficial. Subagentes, MCPs, Skills, permissões, métricas e cancelamento continuam
                orquestrados pelo LionClaw.
              </p>
            </div>
          )}

          {/* LOCAL SECTION */}
          {runtime === 'local' && (
            <div className="space-y-3 p-3 rounded-lg border border-zinc-700 bg-zinc-800/30">
              <h5 className="text-xs font-medium text-amber-400 uppercase tracking-wide">Configuracao Local</h5>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-zinc-400 mb-1">Provider</label>
                  <select
                    value={localProvider}
                    onChange={(e) => {
                      setLocalProvider(e.target.value);
                      if (e.target.value === 'ollama') setLocalBaseUrl('http://localhost:11434');
                      else if (e.target.value === 'lmstudio') setLocalBaseUrl('http://localhost:1234');
                    }}
                    className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 outline-none focus:border-amber-500/50 transition-colors"
                  >
                    <option value="ollama">Ollama</option>
                    <option value="lmstudio">LM Studio</option>
                    <option value="openai-compatible">OpenAI Compatible</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-zinc-400 mb-1">Base URL</label>
                  <input
                    value={localBaseUrl}
                    onChange={(e) => setLocalBaseUrl(e.target.value)}
                    className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 outline-none focus:border-amber-500/50 transition-colors"
                  />
                </div>
                <div>
                  <label className="block text-xs text-zinc-400 mb-1 flex items-center gap-2">
                    Modelo
                    <button
                      type="button"
                      onClick={() => fetchLocalModels(localProvider, localBaseUrl)}
                      disabled={loadingModels}
                      className="text-zinc-500 hover:text-amber-400 transition-colors"
                      title="Atualizar lista de modelos"
                    >
                      <RefreshCw size={10} className={loadingModels ? 'animate-spin' : ''} />
                    </button>
                  </label>
                  {availableLocalModels.length > 0 ? (
                    <select
                      value={localModel}
                      onChange={(e) => setLocalModel(e.target.value)}
                      className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 outline-none focus:border-amber-500/50 transition-colors"
                    >
                      {!localModel && <option value="">Selecione um modelo</option>}
                      {availableLocalModels.map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <div className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm">
                      {loadingModels ? (
                        <span className="text-zinc-500">Buscando modelos...</span>
                      ) : modelsError ? (
                        <span className="text-red-400">{modelsError}</span>
                      ) : (
                        <span className="text-zinc-500">Nenhum modelo encontrado</span>
                      )}
                    </div>
                  )}
                </div>
                <div>
                  <label className="block text-xs text-zinc-400 mb-1">Temperature</label>
                  <input
                    type="number"
                    step="0.1"
                    min="0"
                    max="2"
                    value={localTemperature}
                    onChange={(e) => setLocalTemperature(e.target.value)}
                    className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 outline-none focus:border-amber-500/50 transition-colors"
                  />
                </div>
              </div>

              {/* Modo de Execucao */}
              <div className="pt-2 border-t border-zinc-700/50">
                <label className="block text-xs text-zinc-400 mb-2">Modo de Execucao</label>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setLocalMode('simple')}
                    className={`flex-1 px-3 py-2 rounded-lg border text-xs font-medium transition-colors ${
                      localMode === 'simple'
                        ? 'border-amber-500/50 bg-amber-500/10 text-amber-300'
                        : 'border-zinc-700 bg-zinc-800/50 text-zinc-500 hover:text-zinc-300'
                    }`}
                  >
                    Simple
                    <span className="block text-[10px] font-normal mt-0.5 opacity-70">Text-in, text-out</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setLocalMode('smart')}
                    className={`flex-1 px-3 py-2 rounded-lg border text-xs font-medium transition-colors ${
                      localMode === 'smart'
                        ? 'border-amber-500/50 bg-amber-500/10 text-amber-300'
                        : 'border-zinc-700 bg-zinc-800/50 text-zinc-500 hover:text-zinc-300'
                    }`}
                  >
                    Smart
                    <span className="block text-[10px] font-normal mt-0.5 opacity-70">Com tool calling</span>
                  </button>
                </div>
              </div>

              {localMode === 'smart' && (
                <div>
                  <label className="block text-xs text-zinc-400 mb-1">Max Tool Rounds</label>
                  <input
                    type="number"
                    value={maxToolRounds}
                    onChange={(e) => setMaxToolRounds(e.target.value)}
                    min={1}
                    className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 outline-none focus:border-amber-500/50 transition-colors"
                  />
                  <p className="text-[10px] text-zinc-600 mt-1">Limite de rounds de tool calling por request.</p>
                </div>
              )}
            </div>
          )}

          {/* EXTERNAL SECTION */}
          {runtime === 'external' && (
            <div className="space-y-4 p-3 rounded-lg border border-zinc-700 bg-zinc-800/30">
              <h5 className="text-xs font-medium text-blue-400 uppercase tracking-wide">Configuracao External</h5>

              {/* Provider */}
              <div>
                <label className="block text-xs text-zinc-400 mb-1">Provider</label>
                <select
                  value={extProvider}
                  onChange={(e) => handleProviderChange(e.target.value as ExternalProvider)}
                  className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 outline-none focus:border-amber-500/50 transition-colors"
                >
                  {EXTERNAL_PROVIDERS.map((p) => (
                    <option key={p.value} value={p.value}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </div>

              {/* Base URL — hidden for gemini-agent-platform (SDK Google manages endpoint) */}
              {extProvider !== 'gemini-agent-platform' && (
                <div>
                  <label className="block text-xs text-zinc-400 mb-1">Base URL</label>
                  <input
                    value={extBaseUrl}
                    onChange={(e) => setExtBaseUrl(e.target.value)}
                    placeholder="https://openrouter.ai/api/v1"
                    className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 outline-none focus:border-amber-500/50 transition-colors"
                    readOnly={extProvider !== 'openai-compatible'}
                  />
                  {extProvider !== 'openai-compatible' && (
                    <p className="text-[10px] text-zinc-600 mt-1">Auto-preenchido pelo preset do provider.</p>
                  )}
                </div>
              )}

              {/* Custom-only: vault key slug */}
              {extProvider === 'openai-compatible' && (
                <div>
                  <label className="block text-xs text-zinc-400 mb-1">
                    Nome da chave no Vault (prefixo HARNESS_CUSTOM_)
                  </label>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-zinc-500 whitespace-nowrap">HARNESS_CUSTOM_</span>
                    <input
                      value={extCustomVaultSlug}
                      onChange={(e) => setExtCustomVaultSlug(e.target.value.replace(/[^a-zA-Z0-9_]/g, ''))}
                      placeholder="MEUPROVIDER"
                      className="flex-1 bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 outline-none focus:border-amber-500/50 transition-colors uppercase"
                    />
                    <span className="text-xs text-zinc-500 whitespace-nowrap">_KEY</span>
                  </div>
                  {extCustomVaultSlug && (
                    <p className="text-[10px] text-zinc-500 mt-1">
                      Vault key: HARNESS_CUSTOM_{extCustomVaultSlug.toUpperCase()}_KEY
                    </p>
                  )}
                </div>
              )}

              {/* Gemini: shared key note */}
              {extProvider === 'gemini-agent-platform' && (
                <div className="p-2 rounded-lg bg-blue-500/10 border border-blue-500/30">
                  <p className="text-xs text-blue-300">
                    Usando key compartilhada com Settings &gt; Vertex Gemini. A referencia fica congelada no agente apos
                    salvar.
                  </p>
                </div>
              )}

              {/* API Key */}
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-xs text-zinc-400">API Key</label>
                  <ApiKeyStatusIndicator status={apiKeyStatus} errorMessage={apiKeyError} />
                </div>
                <input
                  type="password"
                  value={extApiKeyInput}
                  onChange={(e) => {
                    setExtApiKeyInput(e.target.value);
                    if (apiKeyStatus !== 'unconfigured') setApiKeyStatus('unconfigured');
                  }}
                  placeholder={
                    apiKeyStatus === 'ok' || apiKeyStatus === 'saved'
                      ? 'Key configurada. Cole nova key para atualizar.'
                      : 'Cole sua API key aqui'
                  }
                  className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 outline-none focus:border-amber-500/50 transition-colors"
                />
                <div className="flex gap-2 mt-2">
                  <button
                    type="button"
                    onClick={handleSaveAndTestKey}
                    disabled={!canSaveKey || apiKeyStatus === 'testing'}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-zinc-700 hover:bg-zinc-600 text-xs text-zinc-200 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <Key size={11} />
                    Salvar no Vault e Testar
                  </button>
                  {(apiKeyStatus === 'saved' || apiKeyStatus === 'ok' || apiKeyStatus === 'error') &&
                    vaultKeyResolved && (
                      <button
                        type="button"
                        onClick={handleTestKey}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-zinc-700 hover:bg-zinc-600 text-xs text-zinc-200 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        <Wifi size={11} />
                        Testar conexao
                      </button>
                    )}
                </div>
              </div>

              {/* Model */}
              <div>
                <label className="block text-xs text-zinc-400 mb-1">Modelo</label>
                {extProvider === 'openai-compatible' ? (
                  <div className="space-y-2">
                    <input
                      value={extModel}
                      onChange={(e) => setExtModel(e.target.value)}
                      placeholder="Ex: mistral-nemo, llama3:8b, gpt-4o-mini..."
                      className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 outline-none focus:border-amber-500/50 transition-colors"
                    />
                    <button
                      type="button"
                      onClick={() => fetchLocalModels('openai-compatible', extBaseUrl)}
                      disabled={!extBaseUrl || loadingModels}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-zinc-700 hover:bg-zinc-600 text-xs text-zinc-300 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      <RefreshCw size={10} className={loadingModels ? 'animate-spin' : ''} />
                      Carregar lista de /v1/models
                    </button>
                    {availableLocalModels.length > 0 && (
                      <select
                        value={extModel}
                        onChange={(e) => setExtModel(e.target.value)}
                        className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 outline-none focus:border-amber-500/50 transition-colors"
                      >
                        <option value="">Selecione da lista</option>
                        {availableLocalModels.map((m) => (
                          <option key={m} value={m}>
                            {m}
                          </option>
                        ))}
                      </select>
                    )}
                  </div>
                ) : (
                  <select
                    value={extModel}
                    onChange={(e) => setExtModel(e.target.value)}
                    className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 outline-none focus:border-amber-500/50 transition-colors"
                  >
                    {catalogModels.map((m) => (
                      <option key={m.id} value={m.id} title={m.notes}>
                        {m.label}
                      </option>
                    ))}
                  </select>
                )}

                {/* Surcharge warning */}
                {hasSurcharge && (
                  <div className="flex items-start gap-1.5 mt-2 p-2 rounded-lg bg-amber-500/10 border border-amber-500/30">
                    <AlertTriangle size={12} className="text-amber-400 mt-0.5 shrink-0" />
                    <p className="text-xs text-amber-400">
                      Atencao: este modelo cobra valor adicional acima de 272k tokens de contexto.
                    </p>
                  </div>
                )}

                {/* Notes tooltip (rendered as visible text for non-surcharge notes) */}
                {selectedCatalogModel?.notes && !hasSurcharge && (
                  <p className="text-[10px] text-zinc-500 mt-1">{selectedCatalogModel.notes}</p>
                )}

                {/* Context window display */}
                <ContextWindowDisplay agent={agentSnapshot} />

                {/* Custom: context window manual input */}
                {extProvider === 'openai-compatible' && (
                  <div className="mt-3">
                    <label className="block text-xs text-zinc-400 mb-1">Janela de contexto (tokens)</label>
                    <input
                      type="number"
                      value={extContextWindow}
                      onChange={(e) => setExtContextWindow(e.target.value)}
                      placeholder="Ex: 128000"
                      className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 outline-none focus:border-amber-500/50 transition-colors"
                    />
                    <p className="text-[10px] text-zinc-600 mt-1">
                      Consulte a documentacao do provider. Sem este valor, o LionClaw nao pode avisar antes de estourar
                      o contexto.
                    </p>
                  </div>
                )}
              </div>

              {/* Extra Headers (Custom only) */}
              {extProvider === 'openai-compatible' && (
                <div>
                  <label className="block text-xs text-zinc-400 mb-1">Headers extras (JSON)</label>
                  <textarea
                    value={extExtraHeaders}
                    onChange={(e) => setExtExtraHeaders(e.target.value)}
                    placeholder={'{"Header-Name": "valor"}'}
                    rows={3}
                    className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 outline-none focus:border-amber-500/50 transition-colors resize-y font-mono"
                  />
                </div>
              )}

              {/* Temperature + MaxTokens */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-zinc-400 mb-1">Temperature</label>
                  <input
                    type="number"
                    step="0.1"
                    min="0"
                    max="2"
                    value={extTemperature}
                    onChange={(e) => setExtTemperature(e.target.value)}
                    placeholder="Ex: 0.7"
                    className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 outline-none focus:border-amber-500/50 transition-colors"
                  />
                </div>
                <div>
                  <label className="block text-xs text-zinc-400 mb-1">Max tokens de saida</label>
                  <input
                    type="number"
                    value={extMaxTokens}
                    onChange={(e) => setExtMaxTokens(e.target.value)}
                    placeholder="Sem limite"
                    className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 outline-none focus:border-amber-500/50 transition-colors"
                  />
                </div>
              </div>

              {/* Max Tool Rounds (replaces maxTurns for external) */}
              <div>
                <label className="block text-xs text-zinc-400 mb-1">Max rounds de tool calling</label>
                <input
                  type="number"
                  value={extMaxToolRounds}
                  onChange={(e) => setExtMaxToolRounds(e.target.value)}
                  min={1}
                  className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 outline-none focus:border-amber-500/50 transition-colors"
                />
                <p className="text-[10px] text-zinc-600 mt-1">
                  Limita quantas vezes o agente pode chamar ferramentas por requisicao.
                </p>
              </div>

              {/* Reasoning params (effort, thinking) — visible but disabled when not supported */}
              <div className="pt-2 border-t border-zinc-700/50 space-y-3">
                <p className="text-xs text-zinc-400 font-medium">Parametros de Reasoning</p>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs text-zinc-400 mb-1">Effort</label>
                    <select
                      value={effort}
                      onChange={(e) => setEffort(e.target.value as AgentConfig['effort'])}
                      disabled={!reasoningSupported}
                      title={!reasoningSupported ? 'Modelo nao suporta thinking explicito.' : undefined}
                      className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 outline-none focus:border-amber-500/50 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      {EFFORT_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs text-zinc-400 mb-1">Thinking</label>
                    <select
                      value={thinking}
                      onChange={(e) => setThinking(e.target.value as AgentConfig['thinking'])}
                      disabled={!reasoningSupported}
                      title={!reasoningSupported ? 'Modelo nao suporta thinking explicito.' : undefined}
                      className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 outline-none focus:border-amber-500/50 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      {THINKING_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  {reasoningSupported && thinking === 'enabled' && (
                    <div>
                      <label className="block text-xs text-zinc-400 mb-1">Budget (tokens)</label>
                      <input
                        type="number"
                        value={thinkingBudget}
                        onChange={(e) => setThinkingBudget(e.target.value)}
                        placeholder="Ex: 10000"
                        className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 outline-none focus:border-amber-500/50 transition-colors"
                      />
                    </div>
                  )}
                </div>
                {!reasoningSupported && extModel && (
                  <p className="text-[10px] text-zinc-500">
                    Modelo nao suporta thinking explicito. Os campos acima sao ignorados na execucao.
                  </p>
                )}
              </div>
            </div>
          )}

          {/* CODEX SECTION */}
          {runtime === 'codex' && (
            <div className="space-y-4 p-3 rounded-lg border border-zinc-700 bg-zinc-800/30">
              <h5 className="text-xs font-medium text-purple-400 uppercase tracking-wide">Configuracao Codex</h5>

              {/* Model */}
              <div>
                <label className="block text-xs text-zinc-400 mb-1">Modelo</label>
                <select
                  value={codexModel}
                  onChange={(e) => setCodexModel(e.target.value)}
                  className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 outline-none focus:border-amber-500/50 transition-colors"
                >
                  {/* spec-gpt56 S3: discovered-first — modelos anunciados pelo
                      CLI (nao-hidden) unidos ao catalogo estatico; um modelo
                      futuro do model/list aparece sem release do app. */}
                  {codexModelOptions.map((m) => (
                    <option key={m.slug} value={m.slug}>
                      {m.label} - {m.description}
                    </option>
                  ))}
                </select>
              </div>

              {/* Reasoning Effort */}
              <div>
                <label className="block text-xs text-zinc-400 mb-1">Reasoning Effort</label>
                <select
                  value={codexReasoningEffort}
                  onChange={(e) => setCodexReasoningEffort(e.target.value as typeof codexReasoningEffort)}
                  className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 outline-none focus:border-amber-500/50 transition-colors"
                >
                  {discoveredEffortsFor(codexModel).map((opt) => (
                    <option key={opt} value={opt}>
                      {CODEX_EFFORT_LABELS[opt] ?? opt}
                    </option>
                  ))}
                </select>
              </div>

              {/* Status indicator (live via IPC) */}
              <div className="p-2 rounded-lg bg-zinc-800 border border-zinc-700">
                {codexStatus === null ? (
                  <p className="text-xs text-zinc-500">Verificando status do Codex...</p>
                ) : !codexStatus.installed ? (
                  <div className="flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-red-500" />
                    <p className="text-xs text-red-400">Codex CLI nao instalado</p>
                  </div>
                ) : !codexStatus.authenticated ? (
                  <div className="flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-yellow-500" />
                    <p className="text-xs text-yellow-400">
                      Codex instalado{codexStatus.version ? ` (${codexStatus.version})` : ''} — nao autenticado
                    </p>
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-green-500" />
                    <p className="text-xs text-green-400">
                      Codex conectado{codexStatus.version ? ` (${codexStatus.version})` : ''}
                    </p>
                  </div>
                )}
                {codexTestResult && (
                  <p className={`text-xs mt-1 ${codexTestResult.ok ? 'text-green-400' : 'text-red-400'}`}>
                    {codexTestResult.message}
                  </p>
                )}
              </div>

              {/* Action buttons */}
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={handleCodexLogin}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-purple-600 hover:bg-purple-500 text-xs text-white transition-colors"
                >
                  Conectar Codex
                </button>
                <button
                  type="button"
                  onClick={handleCodexTest}
                  disabled={codexTesting}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-zinc-700 hover:bg-zinc-600 text-xs text-zinc-100 transition-colors disabled:opacity-50"
                >
                  {codexTesting ? 'Testando...' : 'Testar conexao'}
                </button>
              </div>

              {/* Informative message about LionClaw permissions vs Codex sandbox */}
              <div className="p-2 rounded-lg bg-zinc-800/50 border border-zinc-700/50">
                <p className="text-xs text-zinc-500">
                  Codex usa ferramentas nativas (read/write/exec) dentro do sandbox `workspace-write` (escreve so dentro
                  do projeto). Tools e MCPs do LionClaw sao ignorados neste runtime, e o permission-guard e bypassado.
                </p>
              </div>
            </div>
          )}

          {/* Skills/KB warning for Codex */}
          {runtime === 'codex' && (skills.size > 0 || mcpServers.size > 0) && (
            <div className="flex items-start gap-2 p-3 rounded-lg bg-yellow-500/10 border border-yellow-500/30">
              <AlertTriangle size={14} className="text-yellow-400 mt-0.5 shrink-0" />
              <p className="text-xs text-yellow-400">
                Skills e Knowledge Base nao funcionam no runtime Codex -- serao ignorados na execucao. Considere remover
                ou trocar de runtime.
              </p>
            </div>
          )}

          {/* Tools */}
          {!(runtime === 'local' && localMode === 'simple') && runtime !== 'codex' && (
            <div>
              <h4 className="text-xs font-medium text-zinc-300 mb-3 uppercase tracking-wide">Ferramentas</h4>
              <div className="flex flex-wrap gap-2">
                {runtime === 'local' ? (
                  LOCAL_ALLOWED_TOOLS.map((id) => (
                    <button
                      key={id}
                      onClick={() => toggleTool(id)}
                      className={`px-2.5 py-1.5 rounded-lg border text-xs transition-colors ${
                        allowedTools.has(id)
                          ? 'border-amber-500/50 bg-amber-500/10 text-amber-300'
                          : 'border-zinc-700 bg-zinc-800/50 text-zinc-500 hover:text-zinc-300'
                      }`}
                    >
                      {id}
                    </button>
                  ))
                ) : (
                  <>
                    {TOOL_IDS.filter((id) => globalTools.includes(id)).map((id) => (
                      <button
                        key={id}
                        onClick={() => toggleTool(id)}
                        className={`px-2.5 py-1.5 rounded-lg border text-xs transition-colors ${
                          allowedTools.has(id)
                            ? 'border-amber-500/50 bg-amber-500/10 text-amber-300'
                            : 'border-zinc-700 bg-zinc-800/50 text-zinc-500 hover:text-zinc-300'
                        }`}
                      >
                        {id}
                      </button>
                    ))}
                    {globalTools.length === 0 && (
                      <span className="text-xs text-zinc-600">Carregando ferramentas...</span>
                    )}
                  </>
                )}
              </div>
            </div>
          )}

          {/* MCP Servers */}
          {runtime !== 'local' && runtime !== 'codex' && availableMCP.length > 0 && (
            <div>
              <h4 className="text-xs font-medium text-zinc-300 mb-3 uppercase tracking-wide">MCP Servers</h4>
              <div className="flex flex-wrap gap-2">
                {availableMCP.map((server) => (
                  <button
                    key={server.id}
                    onClick={() => toggleMCP(server.id)}
                    className={`px-2.5 py-1.5 rounded-lg border text-xs transition-colors ${
                      mcpServers.has(server.id)
                        ? 'border-amber-500/50 bg-amber-500/10 text-amber-300'
                        : 'border-zinc-700 bg-zinc-800/50 text-zinc-500 hover:text-zinc-300'
                    }`}
                  >
                    {server.name}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Skills */}
          {runtime !== 'local' && runtime !== 'codex' && availableSkills.length > 0 && (
            <div>
              <h4 className="text-xs font-medium text-zinc-300 mb-3 uppercase tracking-wide">Skills</h4>
              <div className="flex flex-wrap gap-2">
                {availableSkills.map((skill) => (
                  <button
                    key={skill.name}
                    onClick={() => toggleSkill(skill.name)}
                    className={`px-2.5 py-1.5 rounded-lg border text-xs transition-colors ${
                      skills.has(skill.name)
                        ? 'border-amber-500/50 bg-amber-500/10 text-amber-300'
                        : 'border-zinc-700 bg-zinc-800/50 text-zinc-500 hover:text-zinc-300'
                    }`}
                    title={skill.description}
                  >
                    {skill.name}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* System Prompt */}
          <div>
            <h4 className="text-xs font-medium text-zinc-300 mb-3 uppercase tracking-wide">
              {runtime === 'local' ? 'RULES.md do Agente' : 'System Prompt'}
            </h4>
            <textarea
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              placeholder={
                runtime === 'local'
                  ? 'Ex: Voce e um agente especializado em...\nResponda SEMPRE em portugues brasileiro.'
                  : 'Ex: Voce e um especialista em...'
              }
              rows={runtime === 'local' ? 12 : 6}
              className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 outline-none focus:border-amber-500/50 transition-colors resize-y font-mono"
            />
          </div>
        </div>

        {/* MCP warning banner for external runtime */}
        {runtime === 'external' && selectedMcpTools.length > 0 && (
          <div className="px-5 py-2 bg-yellow-100 border-t border-yellow-400 text-yellow-800">
            <div className="flex items-start gap-2">
              <AlertTriangle size={14} className="mt-0.5 shrink-0 text-yellow-700" />
              <p className="text-xs">
                Atencao: o runtime External nao suporta MCP. As {selectedMcpTools.length} tool
                {selectedMcpTools.length !== 1 ? 's' : ''} MCP selecionada{selectedMcpTools.length !== 1 ? 's' : ''}{' '}
                serao ignoradas em runtime.
              </p>
            </div>
          </div>
        )}

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-zinc-800">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg border border-zinc-700 text-zinc-300 hover:bg-zinc-800 text-sm transition-colors"
          >
            Cancelar
          </button>
          <div title={externalKeyBlocking ? 'Configure e teste a API key antes de salvar o agente.' : undefined}>
            <button
              onClick={handleSave}
              disabled={!isValid || saving}
              className="flex items-center gap-2 px-4 py-2 rounded-lg bg-amber-600 hover:bg-amber-500 text-white text-sm font-medium transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
            >
              <Save size={14} />
              {saving ? 'Salvando...' : 'Salvar'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
