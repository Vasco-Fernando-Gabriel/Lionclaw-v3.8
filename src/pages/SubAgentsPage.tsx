import { useState, useEffect, useMemo } from 'react';
import { Bot, Plus, Pencil, Trash2, Power, PowerOff, Search, RefreshCw } from 'lucide-react';
import type { AgentConfig } from '@/types';
import { AgentFormModal } from '@/components/agents/AgentFormModal';
import { DeleteAgentDialog } from '@/components/agents/DeleteAgentDialog';
import { SyncAgentsModal } from '@/components/agents/SyncAgentsModal';
import { PROVIDER_PRESETS } from '@/lib/provider-presets';
import { resolveContextWindow, formatContextWindow, getEffectiveModel } from '@/lib/agent-helpers';
import { categoryLabel, sortCategories, normalizeCategory, categoryKind } from '@/lib/agent-categories';

const BADGE_BG = '#F97316';
const BADGE_FG = '#FFFFFF';
const BADGE_CLASS = 'px-1.5 py-0.5 rounded text-[10px] font-medium cursor-default';

function RuntimeBadge({ agent }: { agent: AgentConfig }) {
  if (agent.runtime === 'cloud') {
    return (
      <span
        title={`Modelo: ${agent.model}`}
        style={{ backgroundColor: BADGE_BG, color: BADGE_FG }}
        className={BADGE_CLASS}
      >
        Anthropic
      </span>
    );
  }

  if (agent.runtime === 'local') {
    const provider = agent.localConfig?.provider ?? 'local';
    const model = agent.localConfig?.model ?? '';
    return (
      <div className="flex items-center gap-1">
        <span
          title={`${provider} / ${model}`}
          style={{ backgroundColor: BADGE_BG, color: BADGE_FG }}
          className={BADGE_CLASS}
        >
          Local
        </span>
        <span className="px-1.5 py-0.5 bg-zinc-800 rounded text-[10px] text-zinc-400">
          {agent.localMode === 'smart' ? 'SMART' : 'SIMPLE'}
        </span>
      </div>
    );
  }

  if (agent.runtime === 'external' && agent.externalConfig) {
    const { provider, model } = agent.externalConfig;
    const label = PROVIDER_PRESETS[provider]?.label ?? provider;
    const cw = resolveContextWindow(agent);
    const cwText = cw !== null ? ` (${formatContextWindow(cw)})` : '';
    const tooltipText = `${model}${cwText}`;
    return (
      <span title={tooltipText} style={{ backgroundColor: BADGE_BG, color: BADGE_FG }} className={BADGE_CLASS}>
        {label}
      </span>
    );
  }

  if (agent.runtime === 'zai') {
    return (
      <div className="flex items-center gap-1">
        <span
          title={`Z.ai / ${agent.model}`}
          className={`${BADGE_CLASS} bg-cyan-600/20 text-cyan-400 border border-cyan-600/30`}
          style={undefined}
        >
          Z.ai
        </span>
        <span className="px-1.5 py-0.5 bg-zinc-800 rounded text-[10px] text-zinc-400">{agent.model}</span>
      </div>
    );
  }

  if (agent.runtime === 'minimax-tp') {
    return (
      <div className="flex items-center gap-1">
        <span
          title={`MiniMax TokenPlan / ${agent.model}`}
          className={`${BADGE_CLASS} bg-purple-600/20 text-purple-400 border border-purple-600/30`}
          style={undefined}
        >
          MiniMax TokenPlan
        </span>
        <span className="px-1.5 py-0.5 bg-zinc-800 rounded text-[10px] text-zinc-400">{agent.model}</span>
      </div>
    );
  }

  if (agent.runtime === 'codex' && agent.codexConfig) {
    const { model } = agent.codexConfig;
    return (
      <div className="flex items-center gap-1">
        <span
          title={`Codex / ${model}`}
          className={`${BADGE_CLASS} bg-purple-600/20 text-purple-400 border border-purple-600/30`}
          style={undefined}
        >
          Codex
        </span>
        <span className="px-1.5 py-0.5 bg-zinc-800 rounded text-[10px] text-zinc-400">{model}</span>
      </div>
    );
  }

  if (agent.runtime === 'kimi') {
    return (
      <div className="flex items-center gap-1">
        <span
          title={`Kimi / ${agent.model}`}
          className={`${BADGE_CLASS} bg-teal-600/20 text-teal-400 border border-teal-600/30`}
          style={undefined}
        >
          Kimi
        </span>
        <span className="px-1.5 py-0.5 bg-zinc-800 rounded text-[10px] text-zinc-400">{agent.model}</span>
      </div>
    );
  }

  if (agent.runtime === 'grok') {
    return (
      <div className="flex items-center gap-1">
        <span
          title={`Grok Build / ${agent.model}`}
          className={`${BADGE_CLASS} bg-cyan-600/20 text-cyan-400 border border-cyan-600/30`}
        >
          Grok Build
        </span>
        <span className="px-1.5 py-0.5 bg-zinc-800 rounded text-[10px] text-zinc-400">{agent.model}</span>
      </div>
    );
  }

  return null;
}

export function SubAgentsPage() {
  const [agents, setAgents] = useState<AgentConfig[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [formModal, setFormModal] = useState<{ mode: 'create' | 'edit'; agent?: AgentConfig } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AgentConfig | null>(null);
  const [activeKind, setActiveKind] = useState<'all' | 'workflow' | 'library'>('all');
  const [activeSquad, setActiveSquad] = useState<string>('all');
  const [searchName, setSearchName] = useState('');
  const [filterModel, setFilterModel] = useState<string>('all');
  const [syncModalOpen, setSyncModalOpen] = useState(false);

  const presentSquads = useMemo(
    () => sortCategories(Array.from(new Set(agents.map((a) => normalizeCategory(a.squad)).filter(Boolean)))),
    [agents],
  );
  const kindCounts = useMemo(() => {
    let workflow = 0,
      library = 0;
    for (const a of agents) {
      if (!a.squad) {
        library++;
        continue;
      }
      if (categoryKind(a.squad) === 'workflow') workflow++;
      else library++;
    }
    return { workflow, library };
  }, [agents]);
  const subSquads = useMemo(
    () => (activeKind === 'all' ? [] : presentSquads.filter((sq) => categoryKind(sq) === activeKind)),
    [presentSquads, activeKind],
  );

  const selectKind = (kind: 'all' | 'workflow' | 'library') => {
    setActiveKind(kind);
    setActiveSquad('all');
  };

  const availableModels = useMemo(
    () => Array.from(new Set(agents.map((a) => getEffectiveModel(a)).filter(Boolean))).sort(),
    [agents],
  );

  const filtered = useMemo(() => {
    const trimmedQuery = searchName.trim().toLowerCase();
    return agents
      .filter((a) => {
        if (activeKind === 'all') return true;
        const kindOf = a.squad ? categoryKind(a.squad) : 'library';
        if (kindOf !== activeKind) return false;
        if (activeSquad === 'all') return true;
        return normalizeCategory(a.squad) === activeSquad;
      })
      .filter((a) => filterModel === 'all' || getEffectiveModel(a) === filterModel)
      .filter((a) => {
        if (!trimmedQuery) return true;
        return (
          a.name.toLowerCase().includes(trimmedQuery) || (a.description ?? '').toLowerCase().includes(trimmedQuery)
        );
      });
  }, [agents, activeKind, activeSquad, filterModel, searchName]);

  const loadAgents = async () => {
    setIsLoading(true);
    const result = await window.lionclaw.agents.list();
    setAgents(result);
    setIsLoading(false);
  };

  useEffect(() => {
    loadAgents();
  }, []);

  const toggleActive = async (agent: AgentConfig) => {
    await window.lionclaw.agents.update(agent.id, { isActive: !agent.isActive });
    loadAgents();
  };

  const handleSave = async (agentData: Omit<AgentConfig, 'sortOrder'>) => {
    if (formModal?.mode === 'edit' && formModal.agent) {
      await window.lionclaw.agents.update(formModal.agent.id, {
        ...agentData,
        localConfig: agentData.localConfig ?? null,
        externalConfig: agentData.externalConfig ?? null,
        codexConfig: agentData.codexConfig ?? null,
      });
    } else {
      await window.lionclaw.agents.create(agentData);
    }
    loadAgents();
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    await window.lionclaw.agents.delete(deleteTarget.id);
    setDeleteTarget(null);
    loadAgents();
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="w-6 h-6 border-2 border-amber-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="max-w-4xl mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="text-xl font-semibold text-zinc-100">SubAgents</h1>
            <p className="text-sm text-zinc-500 mt-1">Agentes especializados do LionClaw</p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setSyncModalOpen(true)}
              className="flex items-center gap-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 rounded-lg px-4 py-2 text-sm font-medium transition-colors border border-zinc-700"
              title="Sincronizar agentes com o orquestrador atual"
            >
              <RefreshCw size={16} />
              Sincronizar com orquestrador
            </button>
            <button
              onClick={() => setFormModal({ mode: 'create' })}
              className="flex items-center gap-2 bg-amber-600 hover:bg-amber-500 text-white rounded-lg px-4 py-2 text-sm font-medium transition-colors"
            >
              <Plus size={16} />
              Novo Agente
            </button>
          </div>
        </div>

        {/* Filters: name search + model dropdown */}
        <div className="flex flex-col sm:flex-row gap-2 mb-4">
          <div className="relative flex-1">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500 pointer-events-none" />
            <input
              type="text"
              value={searchName}
              onChange={(e) => setSearchName(e.target.value)}
              placeholder="Buscar por nome ou descricao..."
              className="w-full bg-zinc-900 border border-zinc-800 rounded-lg pl-9 pr-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-500 focus:outline-none focus:border-amber-500/50 transition-colors"
            />
          </div>
          <select
            value={filterModel}
            onChange={(e) => setFilterModel(e.target.value)}
            className="bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:border-amber-500/50 transition-colors min-w-[200px]"
          >
            <option value="all">Todos os modelos</option>
            {availableModels.map((model) => (
              <option key={model} value={model}>
                {model}
              </option>
            ))}
          </select>
        </div>

        {/* Squad tabs */}
        {presentSquads.length > 0 && (
          <div className="mb-5">
            {/* Nivel 1: tipo (Todos / Workflow / Biblioteca) */}
            <div className="flex items-center gap-1 border-b border-zinc-800">
              {(
                [
                  { key: 'all', label: 'Todos', count: agents.length },
                  { key: 'workflow', label: 'Workflow', count: kindCounts.workflow },
                  { key: 'library', label: 'Biblioteca', count: kindCounts.library },
                ] as const
              ).map((tab) => (
                <button
                  key={tab.key}
                  onClick={() => selectKind(tab.key)}
                  className={`shrink-0 whitespace-nowrap px-4 py-2 text-xs font-medium transition-colors border-b-2 -mb-px ${
                    activeKind === tab.key
                      ? 'border-amber-500 text-amber-400'
                      : 'border-transparent text-zinc-500 hover:text-zinc-300'
                  }`}
                >
                  {tab.label}
                  <span className="ml-1.5 text-[10px] opacity-60">{tab.count}</span>
                </button>
              ))}
            </div>
            {/* Nivel 2: sub-categorias do tipo ativo */}
            {activeKind !== 'all' && subSquads.length > 0 && (
              <div className="flex items-center gap-1.5 mt-3 flex-wrap">
                <button
                  onClick={() => setActiveSquad('all')}
                  className={`whitespace-nowrap px-3 py-1 rounded-full text-[11px] font-medium transition-colors border ${
                    activeSquad === 'all'
                      ? 'bg-amber-500/15 text-amber-400 border-amber-500/30'
                      : 'text-zinc-500 hover:text-zinc-300 border-zinc-800'
                  }`}
                >
                  Todas
                  <span className="ml-1.5 opacity-60">{kindCounts[activeKind]}</span>
                </button>
                {subSquads.map((sq) => {
                  const count = agents.filter((a) => normalizeCategory(a.squad) === sq).length;
                  return (
                    <button
                      key={sq}
                      onClick={() => setActiveSquad(sq)}
                      className={`whitespace-nowrap px-3 py-1 rounded-full text-[11px] font-medium transition-colors border ${
                        activeSquad === sq
                          ? 'bg-amber-500/15 text-amber-400 border-amber-500/30'
                          : 'text-zinc-500 hover:text-zinc-300 border-zinc-800'
                      }`}
                    >
                      {categoryLabel(sq)}
                      <span className="ml-1.5 opacity-60">{count}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* Agent cards */}
        {filtered.length === 0 ? (
          <div className="text-center py-12 text-sm text-zinc-500 border border-dashed border-zinc-800 rounded-xl">
            Nenhum agente encontrado com esses filtros
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {filtered.map((agent) => (
              <div
                key={agent.id}
                className={`bg-zinc-900 border rounded-xl p-4 transition-colors ${
                  agent.isActive ? 'border-zinc-800' : 'border-zinc-800/50 opacity-60'
                }`}
              >
                <div className="flex items-start justify-between mb-3">
                  <div className="flex items-center gap-3">
                    <div className="w-9 h-9 rounded-lg bg-amber-500/10 flex items-center justify-center">
                      <Bot size={18} className="text-amber-500" />
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <h3 className="text-sm font-semibold text-zinc-200">{agent.name}</h3>
                        <RuntimeBadge agent={agent} />
                      </div>
                      <p className="text-xs text-zinc-500">
                        {agent.runtime === 'local' ? (
                          <span className="text-green-400">
                            {agent.localConfig?.provider} - {agent.localConfig?.model}
                          </span>
                        ) : agent.runtime === 'external' ? (
                          <span style={{ color: '#C2410C' }}>{agent.externalConfig?.model}</span>
                        ) : agent.runtime === 'zai' ? (
                          <span className="text-cyan-400">{agent.model}</span>
                        ) : (
                          agent.model
                        )}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => toggleActive(agent)}
                      className="p-1.5 rounded-lg hover:bg-zinc-800 text-zinc-500 hover:text-zinc-300 transition-colors"
                      title={agent.isActive ? 'Desativar' : 'Ativar'}
                    >
                      {agent.isActive ? <Power size={14} /> : <PowerOff size={14} />}
                    </button>
                    <button
                      onClick={() => setFormModal({ mode: 'edit', agent })}
                      className="p-1.5 rounded-lg hover:bg-zinc-800 text-zinc-500 hover:text-zinc-300 transition-colors"
                      title="Editar"
                    >
                      <Pencil size={14} />
                    </button>
                    <button
                      onClick={() => setDeleteTarget(agent)}
                      className="p-1.5 rounded-lg hover:bg-zinc-800 text-zinc-500 hover:text-red-400 transition-colors"
                      title="Excluir"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
                <p className="text-xs text-zinc-400 mb-3">{agent.description}</p>

                {/* Tools */}
                <div className="flex flex-wrap gap-1 mb-2">
                  {agent.allowedTools.slice(0, 5).map((tool) => (
                    <span key={tool} className="px-2 py-0.5 bg-zinc-800 rounded text-[10px] text-zinc-400">
                      {tool}
                    </span>
                  ))}
                  {agent.allowedTools.length > 5 && (
                    <span className="px-2 py-0.5 bg-zinc-800 rounded text-[10px] text-zinc-400">
                      +{agent.allowedTools.length - 5}
                    </span>
                  )}
                </div>

                {/* Skills + Effort/Thinking */}
                <div className="flex items-center gap-2 text-[10px] text-zinc-500">
                  <span>Effort: {agent.effort}</span>
                  <span>|</span>
                  <span>Thinking: {agent.thinking}</span>
                  {agent.skills.length > 0 && (
                    <>
                      <span>|</span>
                      <span>Skills: {agent.skills.join(', ')}</span>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Modals */}
      {formModal && (
        <AgentFormModal
          mode={formModal.mode}
          agent={formModal.agent}
          existingSquads={presentSquads}
          onSave={handleSave}
          onClose={() => setFormModal(null)}
        />
      )}

      {deleteTarget && (
        <DeleteAgentDialog
          agentName={deleteTarget.name}
          onConfirm={handleDelete}
          onCancel={() => setDeleteTarget(null)}
        />
      )}

      <SyncAgentsModal
        open={syncModalOpen}
        onClose={() => setSyncModalOpen(false)}
        filteredAgentIds={filtered.map((a) => a.id)}
        totalAgents={agents.length}
        onComplete={loadAgents}
      />
    </div>
  );
}
