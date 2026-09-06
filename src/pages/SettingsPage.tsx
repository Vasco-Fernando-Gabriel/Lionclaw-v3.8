import { useState, useEffect, useCallback } from 'react';
import { Save, CheckCircle, RotateCcw, KeyRound, Volume2, Cpu, BrainCircuit, AlertTriangle } from 'lucide-react';
import { CartesiaVoiceSelector } from '@/components/settings/CartesiaVoiceSelector';
import { VoiceSelector } from '@/components/settings/VoiceSelector';
import { GoogleOAuthSetup } from '@/components/settings/GoogleOAuthSetup';
import { ExternalProvidersPanel } from '@/components/settings/ExternalProvidersPanel';
import { OrchestratorSelector } from '@/components/settings/OrchestratorSelector';
import { CompactionModelSelector } from '@/components/settings/CompactionModelSelector';
import { CompactionTriggerSettings } from '@/components/settings/CompactionTriggerSettings';
import { TranscriptionModelSelector } from '@/components/settings/TranscriptionModelSelector';
import { VisionModelSelector } from '@/components/settings/VisionModelSelector';
import { ToolScriptSettingsCard } from '@/components/settings/ToolScriptSettingsCard';
import { PermissionsContent } from '@/pages/PermissionsPage';
import { ChannelsSettings } from '@/components/channels/ChannelsSettings';
import { useAuthStore } from '@/stores/auth-store';
import { useAppStore } from '@/stores/app-store';
import {
  useChatLayoutStore,
  CHAT_WIDTH_MODES,
  CHAT_WIDTH_LABELS,
  CHAT_WIDTH_PREVIEW_PERCENT,
} from '@/stores/chat-layout-store';
import { useChatStore } from '@/stores/chat-store';
import type { AppSettings } from '@/types';

export function SettingsPage() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [saved, setSaved] = useState(false);
  const [activeTab, setActiveTab] = useState<'orquestrador' | 'geral' | 'permissoes' | 'canais'>('orquestrador');
  const [uiFont, setUiFontState] = useState<'system' | 'dmsans' | 'lionlabs'>(
    () => (typeof localStorage !== 'undefined'
      ? ((localStorage.getItem('lionlabs:uifont') as 'system' | 'dmsans' | 'lionlabs') || 'lionlabs')
      : 'lionlabs'),
  );
  const setUiFont = (v: 'system' | 'dmsans' | 'lionlabs') => {
    setUiFontState(v);
    try { localStorage.setItem('lionlabs:uifont', v); } catch { /* noop */ }
    document.documentElement.dataset.uifont = v;
  };

  useEffect(() => {
    window.lionclaw.settings.get().then((s) => {
      setSettings(s);
    });
  }, []);

  const handleSave = async () => {
    if (!settings) return;
    await window.lionclaw.settings.update({
      ...settings,
    });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const handleSettingsPatch = useCallback(async (patch: Partial<AppSettings>) => {
    setSettings((prev) => prev ? { ...prev, ...patch } : prev);
    try {
      await window.lionclaw.settings.update(patch);
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } catch (err) {
      console.error('settings update failed:', err);
      window.lionclaw.settings.get().then((s) => setSettings(s));
    }
  }, []);

  const handleOrchestratorSettingsChange = useCallback((patch: Partial<AppSettings>) => {
    setSettings((prev) => prev ? { ...prev, ...patch } : prev);
  }, []);

  if (!settings) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="w-6 h-6 border-2 border-amber-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="max-w-2xl mx-auto space-y-6">
        <div>
          <h1 className="text-xl font-semibold text-zinc-100">Settings</h1>
          <p className="text-sm text-zinc-500 mt-1">Configuracoes gerais do LionClaw</p>
        </div>

        {/* Tab switcher */}
        <div className="flex gap-1 border-b border-zinc-800">
          <button
            onClick={() => setActiveTab('orquestrador')}
            className={`px-4 py-2 text-sm font-medium transition-colors ${
              activeTab === 'orquestrador'
                ? 'text-amber-400 border-b-2 border-amber-500 -mb-px'
                : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            Orquestrador
          </button>
          <button
            onClick={() => setActiveTab('geral')}
            className={`px-4 py-2 text-sm font-medium transition-colors ${
              activeTab === 'geral'
                ? 'text-amber-400 border-b-2 border-amber-500 -mb-px'
                : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            Geral
          </button>
          <button
            onClick={() => setActiveTab('permissoes')}
            className={`px-4 py-2 text-sm font-medium transition-colors ${
              activeTab === 'permissoes'
                ? 'text-amber-400 border-b-2 border-amber-500 -mb-px'
                : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            Permissoes
          </button>
          <button
            onClick={() => setActiveTab('canais')}
            className={`px-4 py-2 text-sm font-medium transition-colors ${
              activeTab === 'canais'
                ? 'text-amber-400 border-b-2 border-amber-500 -mb-px'
                : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            Canais
          </button>
        </div>

        {/* Tab: Minha Conta */}

        {/* Tab: Orquestrador */}
        {activeTab === 'orquestrador' && (
          <div className="space-y-8">
            {/* Escolha do SDK */}
            <section className="space-y-3">
              <h2 className="text-sm font-medium text-zinc-300">Escolha do SDK</h2>
              <OrchestratorSelector onSettingsChange={handleOrchestratorSettingsChange} />
            </section>

            {/* Compaction Model */}
            <CompactionModelSelector
              settings={settings}
              onUpdate={handleSettingsPatch}
            />

            <CompactionTriggerSettings
              settings={settings}
              onUpdate={handleSettingsPatch}
            />

            <TranscriptionModelSelector
              settings={settings}
              onUpdate={handleSettingsPatch}
            />

            <VisionModelSelector
              settings={settings}
              onUpdate={handleSettingsPatch}
            />

            {/* Provedores externos */}
            <section className="space-y-3">
              <h2 className="text-sm font-medium text-zinc-300">Provedores externos</h2>
              <ExternalProvidersPanel />
            </section>
          </div>
        )}

        {/* Tab: Geral */}
        {activeTab === 'geral' && (
          <div className="space-y-8">
            {/* API Keys */}
            <section className="space-y-3">
              <div className="bg-zinc-900 rounded-lg border border-zinc-800 p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="text-sm font-medium text-zinc-200 flex items-center gap-2">
                      <KeyRound size={16} className="text-amber-500" />
                      API Keys
                    </h3>
                    <p className="text-xs text-zinc-500 mt-1">Gerencie suas chaves de API no Vault</p>
                  </div>
                  <button
                    onClick={() => useAppStore.getState().setPage('vault')}
                    className="text-xs px-3 py-1.5 rounded-lg bg-zinc-700 hover:bg-zinc-600 text-amber-400 transition-colors flex items-center gap-1.5"
                  >
                    <KeyRound size={12} />
                    Abrir Vault
                  </button>
                </div>
              </div>
            </section>

            {/* Fonte da interface */}
            <section className="space-y-3">
              <h2 className="text-sm font-medium text-zinc-300 flex items-center gap-2">
                <span className="text-amber-500 font-semibold">Aa</span>
                Fonte da interface
              </h2>
              <div className="flex items-center justify-between bg-zinc-900 rounded-lg border border-zinc-800 px-4 py-3">
                <div>
                  <p className="text-sm text-zinc-200">Fonte da interface</p>
                  <p className="text-xs text-zinc-500 mt-0.5">
                    Escolha a fonte usada na interface. Não afeta a fonte de código.
                  </p>
                </div>
                <div className="grid grid-cols-3 rounded-lg border border-zinc-700 bg-zinc-950 p-0.5 text-xs">
                  {([
                    ['system', 'Sistema'],
                    ['dmsans', 'DM Sans'],
                    ['lionlabs', 'LionLabs'],
                  ] as const).map(([val, label]) => (
                    <button
                      key={val}
                      onClick={() => setUiFont(val)}
                      className={`px-3 py-1.5 rounded-md transition-colors ${
                        uiFont === val ? 'bg-amber-600 text-white' : 'text-zinc-400 hover:text-zinc-200'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            </section>

            {/* Layout do chat (SPEC-chat-width-toggle) */}
            <ChatLayoutSettings />

            {/* Voice */}
            <section className="space-y-3">
              <h2 className="text-sm font-medium text-zinc-300 flex items-center gap-2">
                <Volume2 size={16} className="text-amber-500" />
                Voice
              </h2>

              <div className="flex items-center justify-between bg-zinc-900 rounded-lg border border-zinc-800 px-4 py-3">
                <div>
                  <p className="text-sm text-zinc-200">Respostas em audio</p>
                  <p className="text-xs text-zinc-500 mt-0.5">
                    Quando ativado, as respostas do agente serao convertidas em audio automaticamente
                  </p>
                </div>
                <button
                  onClick={() => {
                    void handleSettingsPatch({ voiceResponseEnabled: !settings.voiceResponseEnabled });
                  }}
                  className={`relative w-11 h-6 rounded-full transition-colors ${
                    settings.voiceResponseEnabled ? 'bg-amber-600' : 'bg-zinc-700'
                  }`}
                >
                  <span
                    className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform ${
                      settings.voiceResponseEnabled ? 'translate-x-5' : 'translate-x-0'
                    }`}
                  />
                </button>
              </div>

              {settings.voiceResponseEnabled && (
                <VoiceSelector
                  selectedVoiceId={settings.voiceId}
                  onSelect={(voiceId) => {
                    void handleSettingsPatch({ voiceId });
                  }}
                />
              )}

              <div className="bg-zinc-900 rounded-lg border border-zinc-800 p-4 space-y-4">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="text-sm text-zinc-200">Chat ao vivo</p>
                    <p className="text-xs text-zinc-500 mt-0.5">
                      Provider usado apenas na conversa em tempo real.
                    </p>
                  </div>
                  <div className="grid grid-cols-2 rounded-lg border border-zinc-700 bg-zinc-950 p-0.5 text-xs">
                    {(['elevenlabs', 'cartesia'] as const).map((provider) => {
                      const active = (settings.voiceLiveProvider || 'elevenlabs') === provider;
                      return (
                        <button
                          key={provider}
                          onClick={() => {
                            void handleSettingsPatch({ voiceLiveProvider: provider });
                          }}
                          className={`px-3 py-1.5 rounded-md transition-colors ${
                            active
                              ? 'bg-amber-600 text-white'
                              : 'text-zinc-400 hover:text-zinc-200'
                          }`}
                        >
                          {provider === 'elevenlabs' ? 'ElevenLabs' : 'Cartesia'}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {(settings.voiceLiveProvider || 'elevenlabs') === 'cartesia' && (
                  <div className="space-y-3 pt-4 border-t border-zinc-800">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <p className="text-xs font-medium text-zinc-300">Voz da Cartesia</p>
                        <p className="text-xs text-zinc-500 mt-0.5">
                          Requer CARTESIA_API_KEY no Vault.
                        </p>
                      </div>
                      <button
                        onClick={() => useAppStore.getState().setPage('vault')}
                        className="text-xs px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-amber-400 transition-colors flex items-center gap-1.5"
                      >
                        <KeyRound size={12} />
                        Vault
                      </button>
                    </div>
                    <CartesiaVoiceSelector
                      selectedVoiceId={settings.cartesiaVoiceId}
                      onSelect={(cartesiaVoiceId, cartesiaVoiceLanguage) => {
                        void handleSettingsPatch({ cartesiaVoiceId, cartesiaVoiceLanguage });
                      }}
                    />
                    <div className="space-y-2 rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-3">
                      <div className="flex items-center justify-between">
                        <p className="text-xs font-medium text-zinc-300">Velocidade</p>
                        <span className="text-xs font-mono text-amber-400">
                          {(settings.cartesiaSpeed ?? 1.15).toFixed(2)}x
                        </span>
                      </div>
                      <input
                        type="range"
                        min="0.8"
                        max="1.5"
                        step="0.05"
                        value={settings.cartesiaSpeed ?? 1.15}
                        onChange={(event) => {
                          void handleSettingsPatch({ cartesiaSpeed: Number(event.target.value) });
                        }}
                        className="w-full accent-amber-500"
                      />
                      <div className="flex justify-between text-[10px] text-zinc-600">
                        <span>Mais calma</span>
                        <span>Mais rapida</span>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </section>

            {/* Integracoes */}
            <section className="space-y-3">
              <h2 className="text-sm font-medium text-zinc-300">Integracoes</h2>
              <GoogleOAuthSetup />
            </section>

            {/* Memoria */}
            <OllamaSettings settings={settings} onChange={setSettings} />
            <MgraphSettings settings={settings} onChange={setSettings} onSave={handleSave} />

            {/* Dreaming */}
            <section className="space-y-3">
              <h2 className="text-sm font-medium text-zinc-300 flex items-center gap-2">
                <BrainCircuit size={16} className="text-amber-500" />
                Dreaming
              </h2>

              <div className="bg-zinc-900 rounded-lg border border-zinc-800 divide-y divide-zinc-800">
                {/* Toggle */}
                <div className="flex items-center justify-between gap-4 px-4 py-3">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-zinc-200">Limpeza automatica do MEMORY.md</p>
                    <p className="text-xs text-zinc-500 mt-0.5">
                      A cada N interacoes do chat, audita o MEMORY.md procurando entradas obsoletas
                      (decisoes revertidas, projetos abandonados, workarounds que viraram solucao)
                      e remove ou atualiza. NAO faz compactacao — a compactacao continua acontecendo
                      separadamente quando o contexto enche.
                    </p>
                  </div>
                  <button
                    onClick={() => {
                      void handleSettingsPatch({
                        dreamingTurnBasedEnabled: !(settings.dreamingTurnBasedEnabled ?? false),
                      });
                    }}
                    className={`relative w-11 h-6 shrink-0 rounded-full transition-colors ${
                      (settings.dreamingTurnBasedEnabled ?? false) ? 'bg-amber-600' : 'bg-zinc-700'
                    }`}
                  >
                    <span
                      className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform ${
                        (settings.dreamingTurnBasedEnabled ?? false) ? 'translate-x-5' : 'translate-x-0'
                      }`}
                    />
                  </button>
                </div>

                {/* Interval */}
                <div className="flex items-center justify-between px-4 py-3">
                  <div className="pr-3">
                    <p className="text-sm text-zinc-200">A cada N interacoes do chat</p>
                    <p className="text-xs text-zinc-500 mt-0.5">
                      Conta apenas turnos user -&gt; assistant concluidos com sucesso. Erros, aborts
                      e respostas vazias nao contam. Minimo 10, maximo 500. Default: 20.
                    </p>
                  </div>
                  <input
                    type="number"
                    min={10}
                    max={500}
                    step={10}
                    value={settings.dreamingTurnBasedInterval ?? 20}
                    onChange={(e) => {
                      const val = parseInt(e.target.value, 10);
                      void handleSettingsPatch({
                        dreamingTurnBasedInterval: Number.isFinite(val) ? val : 20,
                      });
                    }}
                    className="w-24 bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-100 outline-none focus:border-amber-500/50 text-right"
                  />
                </div>
              </div>
            </section>

            {/* Sistema */}
            <section className="space-y-3">
              <h2 className="text-sm font-medium text-zinc-300">Sistema</h2>

              {/* SPEC telegram-cron-compaction 13.5: toggle do indice compacto de subagentes */}
              <div className="flex items-center justify-between gap-4 bg-zinc-900 rounded-lg border border-zinc-800 px-4 py-3">
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-zinc-200">Indice compacto de subagentes</p>
                  <p className="text-xs text-zinc-500 mt-0.5">
                    Ligado (padrao): o system prompt carrega um indice de 1 linha por agente
                    (economia de ~8k tokens por turno); a ficha completa fica disponivel sob
                    demanda via ferramenta. Desligado: volta a secao completa legada.
                  </p>
                </div>
                <button
                  onClick={() => {
                    void handleSettingsPatch({
                      subagentsPromptMode:
                        (settings.subagentsPromptMode ?? 'index') === 'full' ? 'index' : 'full',
                    });
                  }}
                  className={`relative w-11 h-6 shrink-0 rounded-full transition-colors ${
                    (settings.subagentsPromptMode ?? 'index') !== 'full' ? 'bg-amber-600' : 'bg-zinc-700'
                  }`}
                >
                  <span
                    className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform ${
                      (settings.subagentsPromptMode ?? 'index') !== 'full' ? 'translate-x-5' : 'translate-x-0'
                    }`}
                  />
                </button>
              </div>

              {/* SPEC mcp-index-invoke 5 (S7): toggle do indice compacto de MCPs */}
              <div className="flex items-center justify-between gap-4 bg-zinc-900 rounded-lg border border-zinc-800 px-4 py-3">
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-zinc-200">Indice compacto de MCPs</p>
                  <p className="text-xs text-zinc-500 mt-0.5">
                    Ligado (padrao): indice compacto (recomendado) — 1 linha por tool MCP no
                    contexto (~4k tokens) com schema sob demanda. Desligado: schemas completos
                    (modo antigo, ~15-20k tokens). Vale para conversas novas.
                  </p>
                </div>
                <button
                  onClick={() => {
                    void handleSettingsPatch({
                      mcpPromptMode:
                        (settings.mcpPromptMode ?? 'index') === 'full' ? 'index' : 'full',
                    });
                  }}
                  className={`relative w-11 h-6 shrink-0 rounded-full transition-colors ${
                    (settings.mcpPromptMode ?? 'index') !== 'full' ? 'bg-amber-600' : 'bg-zinc-700'
                  }`}
                >
                  <span
                    className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform ${
                      (settings.mcpPromptMode ?? 'index') !== 'full' ? 'translate-x-5' : 'translate-x-0'
                    }`}
                  />
                </button>
              </div>

              {/* SPEC chat-context-reduction A.7/S8: arm switch do gate de
                  capability do chat (Pipeline/Workflows). Default shadow. */}
              <div className="flex flex-col gap-2 bg-zinc-900 rounded-lg border border-zinc-800 px-4 py-3">
                <div className="flex items-center justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-zinc-200">Bloquear Pipeline/Workflows desligados</p>
                    <p className="text-xs text-zinc-500 mt-0.5">
                      Desligado (padrao, modo shadow): observa e loga o que negaria, nao bloqueia
                      nada. Ligado (modo enforce): bloqueia de fato os turnos de chat com o chip
                      Pipeline ou Workflows desligado. Vale para os proximos envios.
                    </p>
                  </div>
                  <button
                    onClick={() => {
                      void handleSettingsPatch({
                        chatCapabilityGateMode:
                          (settings.chatCapabilityGateMode ?? 'shadow') === 'enforce'
                            ? 'shadow'
                            : 'enforce',
                      });
                    }}
                    className={`relative w-11 h-6 shrink-0 rounded-full transition-colors ${
                      (settings.chatCapabilityGateMode ?? 'shadow') === 'enforce'
                        ? 'bg-amber-600'
                        : 'bg-zinc-700'
                    }`}
                  >
                    <span
                      className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform ${
                        (settings.chatCapabilityGateMode ?? 'shadow') === 'enforce'
                          ? 'translate-x-5'
                          : 'translate-x-0'
                      }`}
                    />
                  </button>
                </div>
                {(settings.chatCapabilityGateMode ?? 'shadow') === 'enforce' && (
                  <p className="flex items-start gap-1.5 text-xs text-amber-400">
                    <AlertTriangle size={13} className="shrink-0 mt-0.5" />
                    Ligue so depois de observar os logs do modo shadow. Com o enforce ligado, um
                    turno de drive interno que perca a identidade cai fail-closed.
                  </p>
                )}
              </div>

              {/* SPEC chat-context-reduction B.8 (Fase B, S4): Tool Script.
                  Toggle gravavel + motivo quando python3 ausente + limites
                  read-only. */}
              <ToolScriptSettingsCard settings={settings} onPatch={handleSettingsPatch} />

              <div className="space-y-2">
                <label className="text-xs text-zinc-400">Timeout da sessao (minutos)</label>
                <input
                  type="number"
                  value={settings.sessionTimeoutMinutes}
                  onChange={(e) => setSettings({ ...settings, sessionTimeoutMinutes: parseInt(e.target.value) || 60 })}
                  className="w-32 bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2.5 text-sm text-zinc-100 outline-none focus:border-amber-500/50"
                />
              </div>

              <div className="space-y-2 pt-4 border-t border-zinc-800">
                <h3 className="text-sm font-medium text-zinc-300">Configuracao inicial</h3>
                <button
                  onClick={async () => {
                    const confirmed = window.confirm(
                      'Isso vai resetar seu perfil, memoria e historico de conversas. Continuar?'
                    );
                    if (!confirmed) return;
                    await window.lionclaw.onboarding.reset();
                    await window.lionclaw.chat.stop();
                    useChatStore.getState().startNewSession();
                    useAuthStore.getState().checkOnboarding();
                    useAppStore.getState().setPage('chat');
                  }}
                  className="flex items-center gap-2 text-sm text-zinc-400 hover:text-amber-500 transition-colors"
                >
                  <RotateCcw size={14} />
                  Refazer configuracao inicial
                </button>
                <p className="text-xs text-zinc-600">
                  Reinicia o processo de onboarding para atualizar seu perfil e a personalidade do agente.
                </p>
              </div>
            </section>

            {/* Save button */}
            <button
              onClick={handleSave}
              className="flex items-center gap-2 bg-amber-600 hover:bg-amber-500 text-white rounded-lg px-6 py-2.5 text-sm font-medium transition-colors"
            >
              {saved ? <CheckCircle size={16} /> : <Save size={16} />}
              {saved ? 'Salvo!' : 'Salvar configuracoes'}
            </button>
          </div>
        )}

        {/* Tab: Permissoes */}
        {activeTab === 'permissoes' && (
          <div className="space-y-8">
            <PermissionsContent />
          </div>
        )}

        {/* Tab: Canais (SPEC kanban secao 8 / D8: so Telegram, portado da
            antiga ChannelsPage; IPC channels:* intocado) */}
        {activeTab === 'canais' && <ChannelsSettings />}
      </div>
    </div>
  );
}

function MgraphSettings({
  settings,
  onChange,
  onSave,
}: {
  settings: AppSettings;
  onChange: (s: AppSettings) => void;
  onSave: () => Promise<void>;
}) {
  const [showRestartDialog, setShowRestartDialog] = useState(false);
  const [showReseedConfirm, setShowReseedConfirm] = useState(false);
  const [seeding, setSeeding] = useState(false);
  const [seedProgress, setSeedProgress] = useState<{ processed: number; total: number; notesCreated: number } | null>(null);

  useEffect(() => {
    const unsub = window.lionclaw.mgraph.onSeedProgress((data) => {
      setSeedProgress(data);
      if (data.total > 0 && data.processed >= data.total) {
        setSeeding(false);
      }
    });
    return unsub;
  }, []);

  const handleToggle = async () => {
    onChange({ ...settings, mgraphMode: !settings.mgraphMode });
    setShowRestartDialog(true);
  };

  const handleReseed = async () => {
    setShowReseedConfirm(false);
    setSeeding(true);
    setSeedProgress(null);
    try {
      await window.lionclaw.mgraph.seed(true);
    } catch {
    } finally {
      setSeeding(false);
    }
  };

  return (
    <section className="space-y-3">
      <h2 className="text-sm font-medium text-zinc-300 flex items-center gap-2">
        <BrainCircuit size={16} className="text-amber-500" />
        Memoria
      </h2>

      <div className="flex items-center justify-between bg-zinc-900 rounded-lg border border-zinc-800 px-4 py-3">
        <div>
          <p className="text-sm text-zinc-200">Memory Graph</p>
          <p className="text-xs text-zinc-500 mt-0.5">
            Ativa o grafo de memoria persistente em arquivos Markdown
          </p>
        </div>
        <button
          onClick={handleToggle}
          disabled={seeding}
          className={`relative w-11 h-6 rounded-full transition-colors ${
            settings.mgraphMode ? 'bg-amber-600' : 'bg-zinc-700'
          } ${seeding ? 'opacity-50 cursor-not-allowed' : ''}`}
        >
          <span
            className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform ${
              settings.mgraphMode ? 'translate-x-5' : 'translate-x-0'
            }`}
          />
        </button>
      </div>

      {settings.mgraphMode && (
        <div className="flex items-center justify-between bg-zinc-900 rounded-lg border border-zinc-800 px-4 py-3">
          <div>
            <p className="text-sm text-zinc-200">Forcar re-seed</p>
            <p className="text-xs text-zinc-500 mt-0.5">
              Apaga todas as notas do graph e reprocessa o historico
            </p>
          </div>
          <button
            onClick={() => setShowReseedConfirm(true)}
            disabled={seeding}
            className={`px-3 py-1.5 text-xs rounded-lg transition-colors ${
              seeding
                ? 'bg-zinc-800 text-zinc-600 cursor-not-allowed'
                : 'bg-zinc-700 hover:bg-zinc-600 text-zinc-200'
            }`}
          >
            {seeding ? 'Processando...' : 'Re-seed'}
          </button>
        </div>
      )}

      {/* Seed Progress Bar */}
      {seeding && seedProgress && seedProgress.total > 0 && (
        <div className="bg-zinc-900 rounded-lg border border-zinc-800 px-4 py-3 space-y-2">
          <div className="flex items-center justify-between text-xs">
            <span className="text-zinc-300">
              Processando batch {seedProgress.processed} de {seedProgress.total} ({seedProgress.notesCreated} notas criadas)
            </span>
            <span className="text-amber-400 font-mono">
              {Math.round((seedProgress.processed / seedProgress.total) * 100)}%
            </span>
          </div>
          <div className="w-full h-1.5 bg-zinc-800 rounded-full overflow-hidden">
            <div
              className="h-full bg-amber-500 rounded-full transition-all duration-300"
              style={{ width: `${(seedProgress.processed / seedProgress.total) * 100}%` }}
            />
          </div>
        </div>
      )}

      {/* Restart Dialog */}
      {showRestartDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="bg-zinc-900 border border-zinc-700 rounded-xl p-6 max-w-sm w-full mx-4 space-y-4">
            <h3 className="text-sm font-medium text-zinc-100">Reiniciar necessario</h3>
            <p className="text-xs text-zinc-400">
              A alteracao do Memory Graph requer reiniciar o app para ter efeito.
            </p>
            <div className="flex gap-2 justify-end">
              <button
                onClick={async () => {
                  setShowRestartDialog(false);
                  await onSave();
                }}
                className="px-3 py-1.5 text-xs bg-zinc-700 hover:bg-zinc-600 text-zinc-200 rounded-lg transition-colors"
              >
                Depois
              </button>
              <button
                onClick={async () => {
                  await onSave();
                  setShowRestartDialog(false);
                  window.location.reload();
                }}
                className="px-3 py-1.5 text-xs bg-amber-600 hover:bg-amber-500 text-white rounded-lg transition-colors"
              >
                Reiniciar agora
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Re-seed Confirmation Dialog */}
      {showReseedConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="bg-zinc-900 border border-zinc-700 rounded-xl p-6 max-w-sm w-full mx-4 space-y-4">
            <h3 className="text-sm font-medium text-zinc-100">Confirmar re-seed</h3>
            <p className="text-xs text-zinc-400">
              Isso vai apagar todas as notas do graph e reprocessar todo o historico. Continuar?
            </p>
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setShowReseedConfirm(false)}
                className="px-3 py-1.5 text-xs bg-zinc-700 hover:bg-zinc-600 text-zinc-200 rounded-lg transition-colors"
              >
                Cancelar
              </button>
              <button
                onClick={handleReseed}
                className="px-3 py-1.5 text-xs bg-amber-600 hover:bg-amber-500 text-white rounded-lg transition-colors"
              >
                Confirmar
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function OllamaSettings({
  settings,
  onChange,
}: {
  settings: AppSettings;
  onChange: (s: AppSettings) => void;
}) {
  const [testStatus, setTestStatus] = useState<'idle' | 'testing' | 'ok' | 'error'>('idle');
  const [testModels, setTestModels] = useState<string[]>([]);

  const handleTest = async () => {
    setTestStatus('testing');
    try {
      const result = await window.lionclaw.ollama.check(
        settings.ollamaBaseUrl,
        settings.ollamaEmbeddingModel,
      );
      setTestStatus(result.available ? 'ok' : 'error');
      setTestModels(result.models);
    } catch {
      setTestStatus('error');
      setTestModels([]);
    }
  };

  return (
    <section className="space-y-3">
      <h2 className="text-sm font-medium text-zinc-300 flex items-center gap-2">
        <Cpu size={16} className="text-amber-500" />
        Ollama (Modelos Locais)
      </h2>

      <div className="flex items-center justify-between bg-zinc-900 rounded-lg border border-zinc-800 px-4 py-3">
        <div>
          <p className="text-sm text-zinc-200">Ativar Ollama</p>
          <p className="text-xs text-zinc-500 mt-0.5">
            Usa modelos locais para embeddings de memoria
          </p>
        </div>
        <button
          onClick={() => onChange({ ...settings, ollamaEnabled: !settings.ollamaEnabled })}
          className={`relative w-11 h-6 rounded-full transition-colors ${
            settings.ollamaEnabled ? 'bg-amber-600' : 'bg-zinc-700'
          }`}
        >
          <span
            className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform ${
              settings.ollamaEnabled ? 'translate-x-5' : 'translate-x-0'
            }`}
          />
        </button>
      </div>

      {settings.ollamaEnabled && (
        <div className="space-y-3 bg-zinc-900 rounded-lg border border-zinc-800 p-4">
          <div>
            <label className="block text-xs text-zinc-400 mb-1.5">Base URL</label>
            <input
              type="text"
              value={settings.ollamaBaseUrl}
              onChange={(e) => onChange({ ...settings, ollamaBaseUrl: e.target.value })}
              placeholder="http://localhost:11434"
              className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 outline-none focus:border-amber-600"
            />
          </div>

          <div>
            <label className="block text-xs text-zinc-400 mb-1.5">Modelo de embeddings</label>
            <input
              type="text"
              value={settings.ollamaEmbeddingModel}
              onChange={(e) => onChange({ ...settings, ollamaEmbeddingModel: e.target.value })}
              placeholder="nomic-embed-text"
              className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 outline-none focus:border-amber-600"
            />
            <p className="text-[10px] text-zinc-600 mt-1">Modelo usado para gerar vetores de busca semantica (768 dimensoes)</p>
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={handleTest}
              disabled={testStatus === 'testing'}
              className="px-3 py-1.5 text-xs bg-zinc-700 hover:bg-zinc-600 text-zinc-200 rounded-lg transition-colors disabled:opacity-50"
            >
              {testStatus === 'testing' ? 'Testando...' : 'Testar Conexao'}
            </button>
            {testStatus === 'ok' && (
              <span className="text-xs text-green-400 flex items-center gap-1">
                <CheckCircle size={12} /> Conectado
              </span>
            )}
            {testStatus === 'error' && (
              <span className="text-xs text-red-400">Falha na conexao</span>
            )}
          </div>

          {testModels.length > 0 && (
            <div>
              <p className="text-[10px] text-zinc-500 mb-1">Modelos disponiveis:</p>
              <div className="flex flex-wrap gap-1">
                {testModels.map((m) => (
                  <span key={m} className="px-1.5 py-0.5 text-[10px] bg-zinc-800 text-zinc-400 rounded">
                    {m}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function ChatLayoutSettings() {
  const width = useChatLayoutStore((s) => s.width);
  const setWidth = useChatLayoutStore((s) => s.setWidth);
  const hydrate = useChatLayoutStore((s) => s.hydrate);
  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  return (
    <section className="space-y-3">
      <h2 className="text-sm font-medium text-zinc-300">Layout do chat</h2>
      <div className="bg-zinc-900 rounded-lg border border-zinc-800 px-4 py-3 space-y-3">
        <div>
          <p className="text-sm text-zinc-200">Largura do chat</p>
          <p className="text-xs text-zinc-500 mt-0.5">
            Amplo e full-width ajudam tabelas largas em monitores wide a caber sem rolagem
            horizontal. Aplica na hora.
          </p>
        </div>
        {/* Mini-barra de preview (ilustrativa, nao e medida real do viewport) */}
        <div className="h-2 rounded-full bg-zinc-800 overflow-hidden">
          <div
            className="h-full rounded-full bg-amber-600/70 transition-all duration-200 mx-auto"
            style={{ width: `${CHAT_WIDTH_PREVIEW_PERCENT[width]}%` }}
          />
        </div>
        <div className="flex gap-1 bg-zinc-950 rounded-lg p-1 text-xs w-fit" role="radiogroup" aria-label="Largura do chat">
          {CHAT_WIDTH_MODES.map((mode) => (
            <button
              key={mode}
              role="radio"
              aria-checked={width === mode}
              onClick={() => setWidth(mode)}
              className={`px-3 py-1.5 rounded-md transition-colors ${
                width === mode ? 'bg-amber-600 text-white' : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              {CHAT_WIDTH_LABELS[mode]}
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}
