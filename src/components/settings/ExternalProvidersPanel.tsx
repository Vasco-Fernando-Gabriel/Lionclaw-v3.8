
import { useState, useEffect, useCallback } from 'react';
import { CheckCircle, XCircle, RefreshCw, Plug, KeyRound, Server, AlertTriangle } from 'lucide-react';
import { ClaudeCodeSection } from '@/components/settings/ClaudeCodeSection';
import { CodexSection } from '@/components/settings/CodexSection';
import { KimiSection } from '@/components/settings/KimiSection';
import { GrokSection } from '@/components/settings/GrokSection';
import { OPENAI_COMPATIBLE_PRESETS } from '@/constants/openai-compatible-presets';
import { VERTEX_MODEL_CATALOG, VERTEX_DEFAULT_MODEL } from '@/constants/vertex-gemini-models';
import { getAgentsUsingVaultKey } from '@/lib/credential-usage';
import { translateLlmError } from '@/utils/translate-llm-error';
import type {
  ProviderStatusEntry,
  OrchestratorProvider,
  OrchestratorRuntime,
  OpenAiCompatiblePreset,
  AppSettings,
} from '@/types';


interface DisconnectImpactState {
  agentNames: Array<{ name: string; runtime: string; provider?: string }>;
  onConfirm: () => Promise<void>;
}


function DisconnectImpactDialog({
  state,
  onCancel,
}: {
  state: DisconnectImpactState;
  onCancel: () => void;
}) {
  const [busy, setBusy] = useState(false);

  const handleConfirm = async () => {
    setBusy(true);
    try {
      await state.onConfirm();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50">
      <div className="w-full max-w-sm mx-4 rounded-xl border border-zinc-700 bg-zinc-900 p-5 space-y-4">
        <div className="flex items-start gap-3">
          <AlertTriangle size={18} className="text-yellow-400 mt-0.5 shrink-0" />
          <div>
            <h3 className="text-sm font-semibold text-zinc-100 mb-1">Remover credencial?</h3>
            <p className="text-xs text-zinc-400">
              Os seguintes agentes referenciam esta chave e vao falhar ao executar:
            </p>
            <ul className="mt-2 space-y-1">
              {state.agentNames.map((a) => (
                <li key={a.name} className="text-xs text-amber-300 font-medium">
                  {a.name}
                  {a.provider && (
                    <span className="text-zinc-500 font-normal ml-1">
                      ({a.runtime} / {a.provider})
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        </div>
        <div className="flex gap-2 justify-end">
          <button
            onClick={onCancel}
            disabled={busy}
            className="px-3 py-1.5 rounded-lg border border-zinc-700 text-zinc-300 hover:bg-zinc-800 text-xs transition-colors disabled:opacity-50"
          >
            Cancelar
          </button>
          <button
            onClick={() => void handleConfirm()}
            disabled={busy}
            className="px-3 py-1.5 rounded-lg bg-red-600 hover:bg-red-500 text-white text-xs transition-colors disabled:opacity-50"
          >
            {busy ? 'Desconectando...' : 'Desconectar mesmo assim'}
          </button>
        </div>
      </div>
    </div>
  );
}

function findStatus(
  statuses: ProviderStatusEntry[],
  runtime: OrchestratorRuntime,
  provider: OrchestratorProvider,
): ProviderStatusEntry | undefined {
  return statuses.find((s) => s.runtime === runtime && s.provider === provider);
}

function StatusBadge({ status }: { status?: ProviderStatusEntry }) {
  if (!status) {
    return (
      <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] bg-zinc-800 text-zinc-500">
        desconhecido
      </span>
    );
  }
  if (status.connected) {
    return (
      <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] bg-green-950 text-green-400 border border-green-800">
        <CheckCircle size={10} /> conectado
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] bg-zinc-950 text-zinc-400 border border-zinc-800">
      <XCircle size={10} /> desconectado
    </span>
  );
}

export function ExternalProvidersPanel() {
  const [statuses, setStatuses] = useState<ProviderStatusEntry[]>([]);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const result = await window.lionclaw.provider.listStatuses();
      if (Array.isArray(result)) {
        setStatuses(result);
      }
      const s = await window.lionclaw.settings.get();
      setSettings(s);
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-zinc-300 flex items-center gap-2">
          <Plug size={16} className="text-amber-500" />
          Provedores externos
        </h2>
        <button
          onClick={refresh}
          disabled={refreshing}
          title="Recarregar status"
          className="text-zinc-500 hover:text-zinc-300 transition-colors disabled:opacity-40"
        >
          <RefreshCw size={13} className={refreshing ? 'animate-spin' : ''} />
        </button>
      </div>

      <p className="text-xs text-zinc-500">
        Configure os runtimes via CLI e os provedores que requerem credenciais ou URL local.
        A auth do Claude (Anthropic) continua no Vault; a secao abaixo e diagnostico e config
        do binario do Claude Code CLI.
      </p>

      <div className="space-y-4">
        {/* Claude Code CLI: runtime nativo (diagnostico/config do binario do SDK). */}
        <ClaudeCodeSection />

        {/* Codex OAuth: delegated to existing CodexSection. */}
        <CodexSection />

        {/* Kimi nativo (assinatura via CLI): SPEC-011 §10. */}
        <KimiSection />

        <GrokSection />

        {/* Cursor (@cursor/sdk, User API key): SPEC cursor-runtime F1 item 6. */}
        <CursorSection
          status={findStatus(statuses, 'cursor-sdk', 'cursor')}
          onChanged={refresh}
        />

        <ClaudeCompatSection
          provider="zai"
          label="Z.ai (Anthropic-compat, GLM)"
          placeholder="cole sua chave Z.ai"
          status={findStatus(statuses, 'claude-compat-sdk', 'zai')}
          settings={settings}
          onChanged={refresh}
        />

        <ClaudeCompatSection
          provider="minimax"
          label="Minimax TokenPlan"
          tooltip="Use a chave do Token Plan, gerada em platform.minimax.io > Account > Token Plan. Nao confundir com a API key pay-as-you-go."
          placeholder="cole sua chave Minimax Token Plan"
          status={findStatus(statuses, 'claude-compat-sdk', 'minimax')}
          settings={settings}
          onChanged={refresh}
        />

        <OllamaSection
          status={findStatus(statuses, 'lion-sdk', 'ollama')}
          settings={settings}
          onChanged={refresh}
        />

        <LmStudioSection
          status={findStatus(statuses, 'lion-sdk', 'lmstudio')}
          settings={settings}
          onChanged={refresh}
        />

        <OpenAiCompatSection
          status={findStatus(statuses, 'lion-sdk', 'openai-compatible')}
          settings={settings}
          onChanged={refresh}
        />

        <VertexGeminiSection
          status={findStatus(statuses, 'lion-sdk', 'vertex-ai')}
          settings={settings}
          onChanged={refresh}
        />
      </div>
    </section>
  );
}


function ClaudeCompatSection({
  provider,
  label,
  placeholder,
  tooltip,
  status,
  settings,
  onChanged,
}: {
  provider: 'zai' | 'minimax';
  label: string;
  placeholder: string;
  tooltip?: string;
  status?: ProviderStatusEntry;
  settings: AppSettings | null;
  onChanged: () => Promise<void> | void;
}) {
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [testMsg, setTestMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [impactDialog, setImpactDialog] = useState<DisconnectImpactState | null>(null);
  const connected = status?.connected === true;

  const save = async () => {
    if (!apiKey.trim()) return;
    setBusy(true);
    setTestMsg(null);
    try {
      const res = await window.lionclaw.provider.connect({
        provider,
        apiKey: apiKey.trim(),
      });
      if ('error' in res) {
        setTestMsg({ ok: false, text: translateLlmError({ error: res.error }).body });
      } else {
        setApiKey('');
        setTestMsg({ ok: true, text: 'Chave salva.' });
        await onChanged();
      }
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    setBusy(true);
    setTestMsg(null);
    try {
      const res = await window.lionclaw.provider.check({
        runtime: 'claude-compat-sdk',
        provider,
      });
      if ('error' in res) {
        setTestMsg({ ok: false, text: translateLlmError({ error: res.error }).body });
      } else {
        setTestMsg({
          ok: res.connected,
          text: res.connected ? 'Conectado.' : res.reason ?? 'Nao conectado.',
        });
      }
      await onChanged();
    } finally {
      setBusy(false);
    }
  };

  const performDisconnect = async () => {
    setBusy(true);
    setTestMsg(null);
    setImpactDialog(null);
    try {
      const res = await window.lionclaw.provider.disconnect({ provider });
      if ('error' in res) {
        setTestMsg({ ok: false, text: translateLlmError({ error: res.error }).body });
      } else {
        setTestMsg({ ok: true, text: 'Desconectado.' });
        await onChanged();
      }
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    const vaultKey =
      provider === 'zai'
        ? (settings?.orchestratorZaiApiKeyRef ?? 'ORCHESTRATOR_ZAI_API_KEY')
        : (settings?.orchestratorMinimaxApiKeyRef ?? 'ORCHESTRATOR_MINIMAX_API_KEY');

    const usage = await getAgentsUsingVaultKey(vaultKey);
    if (usage.agentsReferencing.length > 0) {
      setImpactDialog({
        agentNames: usage.agentsReferencing,
        onConfirm: performDisconnect,
      });
    } else {
      await performDisconnect();
    }
  };

  return (
    <>
      {impactDialog !== null && (
        <DisconnectImpactDialog
          state={impactDialog}
          onCancel={() => setImpactDialog(null)}
        />
      )}
      <div className="bg-zinc-900 rounded-lg border border-zinc-800 p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm text-zinc-200" title={tooltip}>
            <KeyRound size={14} className="text-amber-500" />
            {label}
          </div>
          <StatusBadge status={status} />
        </div>

        {tooltip && (
          <p className="text-[11px] text-zinc-500 leading-relaxed">{tooltip}</p>
        )}

        <div className="space-y-1">
          <label className="block text-xs text-zinc-400">API Key</label>
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={connected ? '*** chave armazenada no Vault ***' : placeholder}
            className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 outline-none focus:border-amber-600"
          />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={save}
            disabled={busy || !apiKey.trim()}
            className="px-3 py-1.5 text-xs rounded-lg bg-amber-600 hover:bg-amber-500 text-white transition-colors disabled:opacity-50"
          >
            {busy ? 'Salvando...' : 'Salvar'}
          </button>
          <button
            onClick={test}
            disabled={busy}
            className="px-3 py-1.5 text-xs rounded-lg bg-zinc-700 hover:bg-zinc-600 text-zinc-200 transition-colors disabled:opacity-50"
          >
            Test connection
          </button>
          {connected && (
            <button
              onClick={() => void disconnect()}
              disabled={busy}
              className="px-3 py-1.5 text-xs rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 border border-zinc-700 transition-colors disabled:opacity-50"
            >
              Desconectar
            </button>
          )}
        </div>

        {testMsg && (
          <p className={`text-xs ${testMsg.ok ? 'text-green-400' : 'text-red-400'}`}>
            {testMsg.text}
          </p>
        )}
      </div>
    </>
  );
}


function CursorSection({
  status,
  onChanged,
}: {
  status?: ProviderStatusEntry;
  onChanged: () => Promise<void> | void;
}) {
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [testMsg, setTestMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [impactDialog, setImpactDialog] = useState<DisconnectImpactState | null>(null);
  const connected = status?.connected === true;

  const save = async () => {
    if (!apiKey.trim()) return;
    setBusy(true);
    setTestMsg(null);
    try {
      const res = await window.lionclaw.provider.connect({
        provider: 'cursor',
        apiKey: apiKey.trim(),
      });
      if ('error' in res) {
        setTestMsg({ ok: false, text: translateLlmError({ error: res.error }).body });
      } else {
        setApiKey('');
        setTestMsg({ ok: true, text: 'Chave salva.' });
        await onChanged();
      }
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    setBusy(true);
    setTestMsg(null);
    try {
      const res = await window.lionclaw.provider.check({
        runtime: 'cursor-sdk',
        provider: 'cursor',
      });
      if ('error' in res) {
        setTestMsg({ ok: false, text: translateLlmError({ error: res.error }).body });
      } else {
        setTestMsg({
          ok: res.connected,
          text: res.connected ? 'Conectado.' : res.reason ?? 'Nao conectado.',
        });
      }
      await onChanged();
    } finally {
      setBusy(false);
    }
  };

  const performDisconnect = async () => {
    setBusy(true);
    setTestMsg(null);
    setImpactDialog(null);
    try {
      const res = await window.lionclaw.provider.disconnect({ provider: 'cursor' });
      if ('error' in res) {
        setTestMsg({ ok: false, text: translateLlmError({ error: res.error }).body });
      } else {
        setTestMsg({ ok: true, text: 'Desconectado.' });
        await onChanged();
      }
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    const usage = await getAgentsUsingVaultKey('CURSOR_API_KEY');
    if (usage.agentsReferencing.length > 0) {
      setImpactDialog({
        agentNames: usage.agentsReferencing,
        onConfirm: performDisconnect,
      });
    } else {
      await performDisconnect();
    }
  };

  return (
    <>
      {impactDialog !== null && (
        <DisconnectImpactDialog
          state={impactDialog}
          onCancel={() => setImpactDialog(null)}
        />
      )}
      <div className="bg-zinc-900 rounded-lg border border-zinc-800 p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm text-zinc-200">
            <KeyRound size={14} className="text-amber-500" />
            Cursor (User API key)
          </div>
          <StatusBadge status={status} />
        </div>

        <p className="text-[11px] text-zinc-500 leading-relaxed">
          Gere a User API key em cursor.com/dashboard (aba API). A cobranca real e o plano
          de assinatura do Cursor (limites por multiplicador de agent); o custo em USD
          exibido pelo LionClaw e uma estimativa equivalente-API.
        </p>

        <div className="space-y-1">
          <label className="block text-xs text-zinc-400">API Key</label>
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={connected ? '*** chave armazenada no Vault ***' : 'key_...'}
            className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 outline-none focus:border-amber-600"
          />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={save}
            disabled={busy || !apiKey.trim()}
            className="px-3 py-1.5 text-xs rounded-lg bg-amber-600 hover:bg-amber-500 text-white transition-colors disabled:opacity-50"
          >
            {busy ? 'Salvando...' : 'Salvar'}
          </button>
          <button
            onClick={test}
            disabled={busy}
            className="px-3 py-1.5 text-xs rounded-lg bg-zinc-700 hover:bg-zinc-600 text-zinc-200 transition-colors disabled:opacity-50"
          >
            Test connection
          </button>
          {connected && (
            <button
              onClick={() => void disconnect()}
              disabled={busy}
              className="px-3 py-1.5 text-xs rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 border border-zinc-700 transition-colors disabled:opacity-50"
            >
              Desconectar
            </button>
          )}
        </div>

        {testMsg && (
          <p className={`text-xs ${testMsg.ok ? 'text-green-400' : 'text-red-400'}`}>
            {testMsg.text}
          </p>
        )}
      </div>
    </>
  );
}


function VertexGeminiSection({
  status,
  settings,
  onChanged,
}: {
  status?: ProviderStatusEntry;
  settings: AppSettings | null;
  onChanged: () => Promise<void> | void;
}) {
  const [apiKey, setApiKey] = useState('');
  const [testModel, setTestModel] = useState<string>(VERTEX_DEFAULT_MODEL);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testMsg, setTestMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [impactDialog, setImpactDialog] = useState<DisconnectImpactState | null>(null);
  const connected = status?.connected === true;

  const save = async () => {
    if (!apiKey.trim() && !connected) {
      setTestMsg({ ok: false, text: 'API key obrigatoria.' });
      return;
    }
    setBusy(true);
    setTestMsg(null);
    try {
      const res = await window.lionclaw.provider.connect({
        provider: 'vertex-ai',
        apiKey: apiKey.trim() || undefined,
      });
      if ('error' in res) {
        setTestMsg({ ok: false, text: translateLlmError({ error: res.error }).body });
      } else {
        setApiKey('');
        setTestMsg({ ok: true, text: 'Salvo.' });
        await onChanged();
      }
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    setTesting(true);
    setTestMsg(null);
    try {
      const res = await window.lionclaw.provider.testVertexAi({
        apiKey: apiKey.trim() || undefined,
        model: testModel,
      });
      if (!res.ok) {
        setTestMsg({ ok: false, text: translateLlmError({ error: res.error }).body });
      } else {
        setTestMsg({
          ok: true,
          text:
            typeof res.models === 'number'
              ? `Conectado (${res.models} modelos).`
              : 'Conectado.',
        });
      }
      await onChanged();
    } finally {
      setTesting(false);
    }
  };

  const performDisconnect = async () => {
    setBusy(true);
    setTestMsg(null);
    setImpactDialog(null);
    try {
      const res = await window.lionclaw.provider.disconnect({ provider: 'vertex-ai' });
      if ('error' in res) {
        setTestMsg({ ok: false, text: translateLlmError({ error: res.error }).body });
      } else {
        setTestMsg({ ok: true, text: 'Desconectado.' });
        await onChanged();
      }
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    const vaultKey = 'ORCHESTRATOR_VERTEX_API_KEY';
    const usage = await getAgentsUsingVaultKey(vaultKey);
    if (usage.agentsReferencing.length > 0) {
      setImpactDialog({
        agentNames: usage.agentsReferencing,
        onConfirm: performDisconnect,
      });
    } else {
      await performDisconnect();
    }
  };

  const busyOrTesting = busy || testing;


  return (
    <>
      {impactDialog !== null && (
        <DisconnectImpactDialog
          state={impactDialog}
          onCancel={() => setImpactDialog(null)}
        />
      )}
      <div className="bg-zinc-900 rounded-lg border border-zinc-800 p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm text-zinc-200">
            <KeyRound size={14} className="text-amber-500" />
              Gemini Agent Platform (API key)
          </div>
          <StatusBadge status={status} />
        </div>

        {/* Billing warning -- SPEC §12.3 lines 836-838. */}
        <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-amber-950/40 border border-amber-900/60">
          <AlertTriangle size={13} className="text-amber-400 mt-0.5 shrink-0" />
          <p className="text-[11px] text-amber-200/90 leading-relaxed">
            API keys can use project quota and can create billable usage. Add Google API key
            restrictions in Google Cloud.
          </p>
        </div>

        <div className="space-y-1">
          <label className="block text-xs text-zinc-400">API Key</label>
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={connected ? '*** chave armazenada no Vault ***' : 'cole sua API key do Google Cloud'}
            className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 outline-none focus:border-amber-600"
          />
          {connected && settings?.orchestratorVertexApiKeyRef && (
            <p className="text-[10px] text-zinc-600">
              Ref no Vault: <span className="text-zinc-500">{settings.orchestratorVertexApiKeyRef}</span>
            </p>
          )}
        </div>

        <div className="space-y-1">
          <label className="block text-xs text-zinc-400">Modelo de teste</label>
          <select
            value={testModel}
            onChange={(e) => setTestModel(e.target.value)}
            className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-200 outline-none focus:border-amber-600"
          >
            {VERTEX_MODEL_CATALOG.map((m) => (
              <option key={m.id} value={m.id}>
                {m.displayName}
              </option>
            ))}
          </select>
          <p className="text-[10px] text-zinc-600">
            Usado apenas para Test connection. O modelo do chat eh escolhido no Orquestrador principal.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={save}
            disabled={busyOrTesting || (!connected && !apiKey.trim())}
            className="px-3 py-1.5 text-xs rounded-lg bg-amber-600 hover:bg-amber-500 text-white transition-colors disabled:opacity-50"
          >
            {busy ? 'Salvando...' : connected ? 'Atualizar' : 'Connect'}
          </button>
          <button
            onClick={test}
            disabled={busyOrTesting}
            className="px-3 py-1.5 text-xs rounded-lg bg-zinc-700 hover:bg-zinc-600 text-zinc-200 transition-colors disabled:opacity-50 inline-flex items-center gap-1.5"
          >
            {testing && <RefreshCw size={11} className="animate-spin" />}
            {testing ? 'Testando...' : 'Test connection'}
          </button>
          {connected && (
            <button
              onClick={() => void disconnect()}
              disabled={busyOrTesting}
              className="px-3 py-1.5 text-xs rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 border border-zinc-700 transition-colors disabled:opacity-50"
            >
              Desconectar
            </button>
          )}
        </div>

        {testMsg && (
          <p className={`text-xs ${testMsg.ok ? 'text-green-400' : 'text-red-400'}`}>
            {testMsg.text}
          </p>
        )}
      </div>
    </>
  );
}


function OllamaSection({
  status,
  settings,
  onChanged,
}: {
  status?: ProviderStatusEntry;
  settings: AppSettings | null;
  onChanged: () => Promise<void> | void;
}) {
  const [baseUrl, setBaseUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [testMsg, setTestMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    setBaseUrl(settings?.orchestratorOllamaBaseUrl ?? 'http://localhost:11434');
  }, [settings?.orchestratorOllamaBaseUrl]);

  const save = async () => {
    setBusy(true);
    setTestMsg(null);
    try {
      const res = await window.lionclaw.provider.connect({
        provider: 'ollama',
        baseUrl: baseUrl.trim() || 'http://localhost:11434',
      });
      if ('error' in res) {
        setTestMsg({ ok: false, text: translateLlmError({ error: res.error }).body });
      } else {
        await onChanged();
      }
    } finally {
      setBusy(false);
    }
  };

  const ping = async () => {
    setBusy(true);
    setTestMsg(null);
    try {
      await window.lionclaw.provider.connect({
        provider: 'ollama',
        baseUrl: baseUrl.trim() || 'http://localhost:11434',
      });
      const res = await window.lionclaw.provider.check({
        runtime: 'lion-sdk',
        provider: 'ollama',
      });
      if ('error' in res) {
        setTestMsg({ ok: false, text: translateLlmError({ error: res.error }).body });
      } else {
        setTestMsg({
          ok: res.connected,
          text: res.connected
            ? `Ping OK (${res.models?.length ?? 0} modelos).`
            : res.reason ?? 'Ping falhou.',
        });
      }
      await onChanged();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="bg-zinc-900 rounded-lg border border-zinc-800 p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm text-zinc-200">
          <Server size={14} className="text-amber-500" />
          Ollama Local
        </div>
        <StatusBadge status={status} />
      </div>

      <div className="space-y-1">
        <label className="block text-xs text-zinc-400">Base URL</label>
        <input
          type="text"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder="http://localhost:11434"
          className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 outline-none focus:border-amber-600"
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={save}
          disabled={busy}
          className="px-3 py-1.5 text-xs rounded-lg bg-amber-600 hover:bg-amber-500 text-white transition-colors disabled:opacity-50"
        >
          {busy ? 'Salvando...' : 'Salvar'}
        </button>
        <button
          onClick={ping}
          disabled={busy}
          className="px-3 py-1.5 text-xs rounded-lg bg-zinc-700 hover:bg-zinc-600 text-zinc-200 transition-colors disabled:opacity-50"
        >
          Test ping
        </button>
      </div>

      {testMsg && (
        <p className={`text-xs ${testMsg.ok ? 'text-green-400' : 'text-red-400'}`}>
          {testMsg.text}
        </p>
      )}
    </div>
  );
}


function LmStudioSection({
  status,
  settings,
  onChanged,
}: {
  status?: ProviderStatusEntry;
  settings: AppSettings | null;
  onChanged: () => Promise<void> | void;
}) {
  const [baseUrl, setBaseUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [testMsg, setTestMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    setBaseUrl(settings?.orchestratorLmStudioBaseUrl ?? 'http://localhost:1234');
  }, [settings?.orchestratorLmStudioBaseUrl]);

  const save = async () => {
    setBusy(true);
    setTestMsg(null);
    try {
      const res = await window.lionclaw.provider.connect({
        provider: 'lmstudio',
        baseUrl: baseUrl.trim() || 'http://localhost:1234',
      });
      if ('error' in res) {
        setTestMsg({ ok: false, text: translateLlmError({ error: res.error }).body });
      } else {
        await onChanged();
      }
    } finally {
      setBusy(false);
    }
  };

  const ping = async () => {
    setBusy(true);
    setTestMsg(null);
    try {
      await window.lionclaw.provider.connect({
        provider: 'lmstudio',
        baseUrl: baseUrl.trim() || 'http://localhost:1234',
      });
      const res = await window.lionclaw.provider.check({
        runtime: 'lion-sdk',
        provider: 'lmstudio',
      });
      if ('error' in res) {
        setTestMsg({ ok: false, text: translateLlmError({ error: res.error }).body });
      } else {
        setTestMsg({
          ok: res.connected,
          text: res.connected
            ? `Ping OK (${res.models?.length ?? 0} modelos).`
            : res.reason ?? 'Ping falhou.',
        });
      }
      await onChanged();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="bg-zinc-900 rounded-lg border border-zinc-800 p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm text-zinc-200">
          <Server size={14} className="text-amber-500" />
          LM Studio Local
        </div>
        <StatusBadge status={status} />
      </div>

      <div className="space-y-1">
        <label className="block text-xs text-zinc-400">Base URL</label>
        <input
          type="text"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder="http://localhost:1234"
          className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 outline-none focus:border-amber-600"
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={save}
          disabled={busy}
          className="px-3 py-1.5 text-xs rounded-lg bg-amber-600 hover:bg-amber-500 text-white transition-colors disabled:opacity-50"
        >
          {busy ? 'Salvando...' : 'Salvar'}
        </button>
        <button
          onClick={ping}
          disabled={busy}
          className="px-3 py-1.5 text-xs rounded-lg bg-zinc-700 hover:bg-zinc-600 text-zinc-200 transition-colors disabled:opacity-50"
        >
          Test ping
        </button>
      </div>

      {testMsg && (
        <p className={`text-xs ${testMsg.ok ? 'text-green-400' : 'text-red-400'}`}>
          {testMsg.text}
        </p>
      )}
    </div>
  );
}


function OpenAiCompatSection({
  status,
  settings,
  onChanged,
}: {
  status?: ProviderStatusEntry;
  settings: AppSettings | null;
  onChanged: () => Promise<void> | void;
}) {
  const [preset, setPreset] = useState<OpenAiCompatiblePreset>('kimi');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [testMsg, setTestMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [impactDialog, setImpactDialog] = useState<DisconnectImpactState | null>(null);
  const connected = status?.connected === true;

  useEffect(() => {
    if (!settings) return;
    const persistedPreset = settings.orchestratorOpenAiCompatPreset;
    const persistedBaseUrl = settings.orchestratorOpenAiCompatBaseUrl;
    const isLegacyKimiCnDefault =
      (persistedPreset === undefined || persistedPreset === 'kimi') &&
      persistedBaseUrl?.includes('api.moonshot.cn');
    const nextPreset: OpenAiCompatiblePreset = isLegacyKimiCnDefault
      ? 'kimi'
      : persistedPreset ?? 'kimi';
    setPreset(nextPreset);
    if (persistedBaseUrl && !isLegacyKimiCnDefault) {
      setBaseUrl(persistedBaseUrl);
    } else {
      const entry = OPENAI_COMPATIBLE_PRESETS.find((p) => p.id === nextPreset);
      setBaseUrl(entry?.baseUrl ?? '');
    }
  }, [
    settings?.orchestratorOpenAiCompatPreset,
    settings?.orchestratorOpenAiCompatBaseUrl,
    settings,
  ]);

  const handlePresetChange = (nextPreset: OpenAiCompatiblePreset) => {
    setPreset(nextPreset);
    const entry = OPENAI_COMPATIBLE_PRESETS.find((p) => p.id === nextPreset);
    setBaseUrl(entry?.baseUrl ?? '');
  };

  const save = async () => {
    if (!apiKey.trim() && !connected) return;
    if (!baseUrl.trim()) {
      setTestMsg({ ok: false, text: 'baseUrl obrigatorio.' });
      return;
    }
    setBusy(true);
    setTestMsg(null);
    try {
      const res = await window.lionclaw.provider.connect({
        provider: 'openai-compatible',
        apiKey: apiKey.trim() || undefined,
        baseUrl: baseUrl.trim(),
        preset,
      });
      if ('error' in res) {
        setTestMsg({ ok: false, text: translateLlmError({ error: res.error }).body });
      } else {
        setApiKey('');
        setTestMsg({ ok: true, text: 'Salvo.' });
        await onChanged();
      }
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    if (!baseUrl.trim()) {
      setTestMsg({ ok: false, text: 'baseUrl obrigatorio.' });
      return;
    }
    setBusy(true);
    setTestMsg(null);
    try {
      if (apiKey.trim()) {
        const res = await window.lionclaw.provider.testOpenAiCompatible({
          baseUrl: baseUrl.trim(),
          apiKey: apiKey.trim(),
          preset,
        });
        if (!res.ok) {
          setTestMsg({ ok: false, text: translateLlmError({ error: res.error }).body });
        } else {
          setTestMsg({
            ok: true,
            text: `Conectado (${res.models} modelos).`,
          });
        }
      } else {
        const res = await window.lionclaw.provider.check({
          runtime: 'lion-sdk',
          provider: 'openai-compatible',
        });
        if ('error' in res) {
          setTestMsg({ ok: false, text: translateLlmError({ error: res.error }).body });
        } else {
          setTestMsg({
            ok: res.connected,
            text: res.connected
              ? `Conectado (${res.models?.length ?? 0} modelos).`
              : res.reason ?? 'Nao conectado.',
          });
        }
        await onChanged();
      }
    } finally {
      setBusy(false);
    }
  };

  const performDisconnect = async () => {
    setBusy(true);
    setTestMsg(null);
    setImpactDialog(null);
    try {
      const res = await window.lionclaw.provider.disconnect({
        provider: 'openai-compatible',
      });
      if ('error' in res) {
        setTestMsg({ ok: false, text: translateLlmError({ error: res.error }).body });
      } else {
        setTestMsg({ ok: true, text: 'Desconectado.' });
        await onChanged();
      }
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    const vaultKey =
      settings?.orchestratorOpenAiCompatApiKeyRef ?? 'ORCHESTRATOR_OPENAI_COMPAT_API_KEY';

    const usage = await getAgentsUsingVaultKey(vaultKey);
    if (usage.agentsReferencing.length > 0) {
      setImpactDialog({
        agentNames: usage.agentsReferencing,
        onConfirm: performDisconnect,
      });
    } else {
      await performDisconnect();
    }
  };

  return (
    <>
      {impactDialog !== null && (
        <DisconnectImpactDialog
          state={impactDialog}
          onCancel={() => setImpactDialog(null)}
        />
      )}
      <div className="bg-zinc-900 rounded-lg border border-zinc-800 p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm text-zinc-200">
            <KeyRound size={14} className="text-amber-500" />
            OpenAI-compatible (Kimi/Qwen/DeepSeek/MiniMax Pay-as-you-go/Custom)
          </div>
          <StatusBadge status={status} />
        </div>

        <div className="space-y-1">
          <label className="block text-xs text-zinc-400">Preset</label>
          <select
            value={preset}
            onChange={(e) => handlePresetChange(e.target.value as OpenAiCompatiblePreset)}
            className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-200 outline-none focus:border-amber-600"
          >
            {OPENAI_COMPATIBLE_PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.displayName}
              </option>
            ))}
          </select>
        </div>

        <div className="space-y-1">
          <label className="block text-xs text-zinc-400">Base URL</label>
          <input
            type="text"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://..."
            className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 outline-none focus:border-amber-600"
          />
          <p className="text-[10px] text-zinc-600">
            O adapter normaliza /v1 final automaticamente.
          </p>
        </div>

        <div className="space-y-1">
          <label className="block text-xs text-zinc-400">API Key</label>
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={connected ? '*** chave armazenada no Vault ***' : 'cole sua chave'}
            className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 outline-none focus:border-amber-600"
          />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={save}
            disabled={busy || (!apiKey.trim() && !connected) || !baseUrl.trim()}
            className="px-3 py-1.5 text-xs rounded-lg bg-amber-600 hover:bg-amber-500 text-white transition-colors disabled:opacity-50"
          >
            {busy ? 'Salvando...' : 'Salvar'}
          </button>
          <button
            onClick={test}
            disabled={busy}
            className="px-3 py-1.5 text-xs rounded-lg bg-zinc-700 hover:bg-zinc-600 text-zinc-200 transition-colors disabled:opacity-50"
          >
            Test connection
          </button>
          {connected && (
            <button
              onClick={() => void disconnect()}
              disabled={busy}
              className="px-3 py-1.5 text-xs rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 border border-zinc-700 transition-colors disabled:opacity-50"
            >
              Desconectar
            </button>
          )}
        </div>

        {testMsg && (
          <p className={`text-xs ${testMsg.ok ? 'text-green-400' : 'text-red-400'}`}>
            {testMsg.text}
          </p>
        )}
      </div>
    </>
  );
}
