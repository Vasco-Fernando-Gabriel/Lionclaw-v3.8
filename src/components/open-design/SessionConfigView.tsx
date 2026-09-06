import { useState } from 'react';
import { Loader2, PenTool, Cpu } from 'lucide-react';
import { CLAUDE_DEFAULT_MODEL, CLAUDE_MODELS } from '@/constants/claude-models';
import { CODEX_DEFAULT_MODEL, CODEX_MODELS } from '@/constants/codex-models';
import { VERTEX_DEFAULT_MODEL, VERTEX_MODEL_CATALOG } from '@/constants/vertex-gemini-models';
import type { OpenDesignSessionConfig } from '@/types/open-design';


const CUSTOM_MODEL_VALUE = '__custom__';

interface OpenDesignModelOption {
  value: string;
  label: string;
  description?: string;
}

interface OpenDesignAgentOption {
  value: string;
  label: string;
  defaultModel: string;
  customPlaceholder: string;
  models: OpenDesignModelOption[];
}

const AGENT_OPTIONS: OpenDesignAgentOption[] = [
  {
    value: 'claude',
    label: 'Claude Code (Opus/Sonnet/Haiku)',
    defaultModel: CLAUDE_DEFAULT_MODEL,
    customPlaceholder: CLAUDE_DEFAULT_MODEL,
    models: [
      ...CLAUDE_MODELS.map((m) => ({
        value: m.id,
        label: m.displayName,
        description: m.id,
      })),
      { value: 'opus', label: 'Opus (alias)', description: 'Usa o alias do Claude Code' },
      { value: 'sonnet', label: 'Sonnet (alias)', description: 'Usa o alias do Claude Code' },
      { value: 'haiku', label: 'Haiku (alias)', description: 'Usa o alias do Claude Code' },
      { value: 'default', label: 'Default do Claude Code', description: 'Usa a configuracao local do CLI' },
    ],
  },
  {
    value: 'codex',
    label: 'Codex CLI (GPT/o-series)',
    defaultModel: CODEX_DEFAULT_MODEL,
    customPlaceholder: CODEX_DEFAULT_MODEL,
    models: [
      ...CODEX_MODELS.map((m) => ({
        value: m.slug,
        label: m.label,
        description: m.description,
      })),
      { value: 'default', label: 'Default do Codex CLI', description: 'Usa a configuracao local do CLI' },
    ],
  },
  {
    value: 'gemini',
    label: 'Gemini CLI (gemini-*)',
    defaultModel: VERTEX_DEFAULT_MODEL,
    customPlaceholder: VERTEX_DEFAULT_MODEL,
    models: [
      ...VERTEX_MODEL_CATALOG.map((m) => ({
        value: m.id,
        label: m.displayName,
        description: `${m.stage} - ${m.id}`,
      })),
      { value: 'default', label: 'Default do Gemini CLI', description: 'Usa a configuracao local do CLI' },
    ],
  },
];

interface SessionConfigViewProps {
  projectId: string;
  onSaved: (cfg: OpenDesignSessionConfig) => void;
}

export function SessionConfigView({ projectId, onSaved }: SessionConfigViewProps) {
  const [agentId, setAgentId] = useState<string>('claude');
  const [model, setModel] = useState<string>(CLAUDE_DEFAULT_MODEL);
  const [customModel, setCustomModel] = useState<string>('');
  const [reasoning, setReasoning] = useState<'low' | 'medium' | 'high' | ''>('');
  const [designSystemId, setDesignSystemId] = useState<string>('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const agentMeta = AGENT_OPTIONS.find((a) => a.value === agentId) ?? AGENT_OPTIONS[0]!;
  const selectedModel = agentMeta.models.find((entry) => entry.value === model);
  const resolvedModel = model === CUSTOM_MODEL_VALUE ? customModel.trim() : model.trim();

  const handleAgentChange = (next: string): void => {
    setAgentId(next);
    const meta = AGENT_OPTIONS.find((a) => a.value === next);
    if (meta) {
      setModel(meta.defaultModel);
      setCustomModel('');
    }
  };

  const handleSubmit = async (): Promise<void> => {
    setSaving(true);
    setError(null);
    try {
      const cfg: OpenDesignSessionConfig = {
        agentId,
        model: resolvedModel,
        reasoning: reasoning === '' ? undefined : reasoning,
        designSystemId: designSystemId.trim() === '' ? undefined : designSystemId.trim(),
        memoryEnabled: false,
        mcpServerIds: [],
        locale: 'pt-BR',
        configuredAt: new Date().toISOString(),
      };
      const result = await window.lionclaw.openDesign.setSessionConfig(projectId, cfg);
      if ('error' in result) {
        setError(result.error);
        return;
      }
      onSaved(cfg);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const canSubmit = agentId.trim() !== '' && resolvedModel !== '' && !saving;

  return (
    <div className="flex flex-col items-center justify-center flex-1 px-6 py-8 overflow-y-auto">
      <div className="w-full max-w-lg space-y-5">
        <div className="flex items-center gap-3">
          <PenTool size={22} className="text-amber-400 shrink-0" />
          <div>
            <h2 className="text-base font-semibold text-zinc-100">Sessao de Design</h2>
            <p className="text-xs text-zinc-500 mt-0.5">
              Escolha o runtime e depois um modelo compativel com ele.
            </p>
          </div>
        </div>

        <div className="bg-zinc-900 border border-zinc-800 rounded-xl px-4 py-3 space-y-3">
          <div>
            <label className="block text-[11px] text-zinc-500 mb-1">Agente</label>
            <div className="flex items-center gap-2">
              <Cpu size={13} className="text-zinc-500 shrink-0" />
              <select
                value={agentId}
                onChange={(e) => handleAgentChange(e.target.value)}
                className="flex-1 bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-1.5 text-xs text-zinc-200 focus:outline-none focus:border-zinc-500"
              >
                {AGENT_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className="block text-[11px] text-zinc-500 mb-1">Modelo</label>
            <select
              value={model}
              onChange={(e) => {
                setModel(e.target.value);
                if (e.target.value !== CUSTOM_MODEL_VALUE) setCustomModel('');
              }}
              className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-1.5 text-xs text-zinc-200 focus:outline-none focus:border-zinc-500"
            >
              {agentMeta.models.map((entry) => (
                <option key={entry.value} value={entry.value}>
                  {entry.label} - {entry.value}
                </option>
              ))}
              <option value={CUSTOM_MODEL_VALUE}>Modelo customizado...</option>
            </select>
            <div className="mt-1 text-[10px] text-zinc-600">
              {selectedModel?.description ?? 'Informe exatamente o slug aceito pelo CLI do agente.'}
            </div>
            {model === CUSTOM_MODEL_VALUE && (
              <input
                type="text"
                value={customModel}
                onChange={(e) => setCustomModel(e.target.value)}
                placeholder={agentMeta.customPlaceholder}
                className="mt-2 w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-1.5 text-xs text-zinc-200 focus:outline-none focus:border-zinc-500 font-mono"
              />
            )}
          </div>

          <div>
            <label className="block text-[11px] text-zinc-500 mb-1">Reasoning (opcional)</label>
            <select
              value={reasoning}
              onChange={(e) => setReasoning(e.target.value as 'low' | 'medium' | 'high' | '')}
              className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-1.5 text-xs text-zinc-200 focus:outline-none focus:border-zinc-500"
            >
              <option value="">(default do agente)</option>
              <option value="low">low</option>
              <option value="medium">medium</option>
              <option value="high">high</option>
            </select>
          </div>

          <div>
            <label className="block text-[11px] text-zinc-500 mb-1">Design system (opcional)</label>
            <input
              type="text"
              value={designSystemId}
              onChange={(e) => setDesignSystemId(e.target.value)}
              placeholder="ex: lc-default, shadcn-zinc, ..."
              className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-1.5 text-xs text-zinc-200 focus:outline-none focus:border-zinc-500 font-mono"
            />
          </div>

          {/*
            Controles escondidos nesta sprint (SPEC L622-630):
            - mcpServerIds: precisa de patch no daemon do OD para filtrar MCP
              por run; sem isso, salvar no DB do LionClaw eh controle falso.
            - memoryEnabled: idem — memoria por projeto depende de patch.
            Patches reais entram em Sprint 3. Locale fixado em pt-BR ate
            decisao por projeto ser exposta como UX.
          */}
        </div>

        <div className="text-[10px] text-zinc-600">
          Locale: <span className="font-mono">pt-BR</span> — o agente vai responder em portugues brasileiro por padrao. Credenciais ficam no Vault do LionClaw ou no onboarding do LionDesign; nada de tokens neste formulario.
        </div>

        {error && (
          <div className="p-3 bg-red-500/10 border border-red-500/30 rounded-lg text-xs text-red-300">
            {error}
          </div>
        )}

        <button
          onClick={() => void handleSubmit()}
          disabled={!canSubmit}
          className="w-full flex items-center justify-center gap-2 px-5 py-2 text-xs font-semibold bg-amber-600 hover:bg-amber-500 text-white rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {saving ? (
            <>
              <Loader2 size={13} className="animate-spin" />
              Salvando...
            </>
          ) : (
            'Iniciar sessao de design'
          )}
        </button>
      </div>
    </div>
  );
}
