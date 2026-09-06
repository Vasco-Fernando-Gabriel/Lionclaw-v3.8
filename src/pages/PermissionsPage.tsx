import { useState, useEffect } from 'react';
import { AlertTriangle, DollarSign } from 'lucide-react';

const TOOL_CATALOG = [
  { id: 'Read', name: 'Ler Arquivos', description: 'Le arquivos do filesystem', category: 'filesystem', risk: 'low', extraCost: false },
  { id: 'Write', name: 'Criar Arquivos', description: 'Cria arquivos novos', category: 'filesystem', risk: 'medium', extraCost: false },
  { id: 'Edit', name: 'Editar Arquivos', description: 'Edita arquivos existentes', category: 'filesystem', risk: 'medium', extraCost: false },
  { id: 'Glob', name: 'Buscar Arquivos', description: 'Busca arquivos por pattern', category: 'filesystem', risk: 'low', extraCost: false },
  { id: 'Grep', name: 'Buscar Conteudo', description: 'Busca conteudo dentro de arquivos', category: 'filesystem', risk: 'low', extraCost: false },
  { id: 'NotebookEdit', name: 'Editar Notebooks', description: 'Edita notebooks Jupyter', category: 'filesystem', risk: 'medium', extraCost: false },
  { id: 'Bash', name: 'Terminal', description: 'Executa comandos no terminal', category: 'system', risk: 'high', extraCost: false },
  { id: 'WebSearch', name: 'Busca Web', description: 'Pesquisa na internet (~$0.01/busca)', category: 'internet', risk: 'medium', extraCost: true },
  { id: 'WebFetch', name: 'Acessar URL', description: 'Acessa e le conteudo de URLs', category: 'internet', risk: 'medium', extraCost: false },
  { id: 'Agent', name: 'SubAgentes', description: 'Delega tarefas para subagentes', category: 'orchestration', risk: 'low', extraCost: false },
  { id: 'TodoWrite', name: 'Lista de Tarefas', description: 'Gerencia lista de tarefas interna', category: 'utility', risk: 'none', extraCost: false },
  { id: 'AskUserQuestion', name: 'Perguntar ao Usuario', description: 'Faz perguntas com opcoes', category: 'interaction', risk: 'none', extraCost: false },
] as const;

type ToolCategory = typeof TOOL_CATALOG[number]['category'];

const TOOL_CATEGORY_LABELS: Record<ToolCategory, string> = {
  filesystem: 'Filesystem',
  system: 'Sistema',
  internet: 'Internet',
  orchestration: 'Orquestracao',
  utility: 'Utilidade',
  interaction: 'Interacao',
};

const CATEGORY_ORDER: ToolCategory[] = ['filesystem', 'system', 'internet', 'orchestration', 'utility', 'interaction'];

export function PermissionsContent() {
  const [toolSettings, setToolSettings] = useState<Record<string, boolean>>({});
  const [bypass, setBypass] = useState<boolean>(true);

  useEffect(() => {
    window.lionclaw.tools.getSettings().then(setToolSettings);
    window.lionclaw.tools.getBypass().then(setBypass);
  }, []);

  const handleToggleTool = async (toolId: string, enabled: boolean) => {
    const updated = await window.lionclaw.tools.setEnabled(toolId, enabled);
    setToolSettings(updated);
  };

  const handleToggleBypass = async (enabled: boolean) => {
    const updated = await window.lionclaw.tools.setBypass(enabled);
    setBypass(updated);
  };

  return (
    <div className="space-y-6">
      <p className="text-sm text-zinc-500">
        Configure quais ferramentas o agente pode utilizar (desativadas ficam indisponiveis) e o bypass de confirmacoes de acoes destrutivas.
      </p>

      <section className="bg-zinc-900 rounded-lg border border-zinc-800 p-4">
          <div className="flex items-center justify-between">
            <div className="flex-1 min-w-0 pr-4">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-zinc-200">Bypass total de permissoes</span>
                <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-medium bg-red-500/10 text-red-400 border border-red-500/20">
                  <AlertTriangle size={10} />
                  Risco alto
                </span>
              </div>
              <p className="text-xs text-zinc-500 mt-0.5">
                Ligado (padrao): o agente executa acoes destrutivas (rm, sudo, escrita em arquivos sensiveis, MCP destrutivo) sem pedir confirmacao. Desligado: cada acao destrutiva abre um popup de confirmacao antes de rodar. Nao afeta o bloqueio de comandos git.
              </p>
            </div>
            <button
              onClick={() => handleToggleBypass(!bypass)}
              className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full transition-colors duration-200 ease-in-out ${
                bypass ? 'bg-red-500' : 'bg-zinc-700'
              }`}
              role="switch"
              aria-checked={bypass}
            >
              <span
                className={`pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow ring-0 transition-transform duration-200 ease-in-out ${
                  bypass ? 'translate-x-5' : 'translate-x-0'
                }`}
                style={{ marginTop: '2px', marginLeft: bypass ? '0px' : '2px' }}
              />
            </button>
          </div>
        </section>

        {CATEGORY_ORDER.map((category) => {
          const tools = TOOL_CATALOG.filter((t) => t.category === category);
          if (tools.length === 0) return null;
          return (
            <section key={category} className="bg-zinc-900 rounded-lg border border-zinc-800 p-4">
              <h2 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-3">
                {TOOL_CATEGORY_LABELS[category]}
              </h2>
              <div className="divide-y divide-zinc-800">
                {tools.map((tool) => {
                  const enabled = toolSettings[tool.id] ?? true;
                  return (
                    <div key={tool.id} className="flex items-center justify-between py-3 first:pt-0 last:pb-0">
                      <div className="flex-1 min-w-0 pr-4">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium text-zinc-200">{tool.name}</span>
                          {tool.extraCost && (
                            <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-500/10 text-amber-400 border border-amber-500/20">
                              <DollarSign size={10} />
                              Custo extra
                            </span>
                          )}
                          {tool.risk === 'high' && (
                            <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-medium bg-red-500/10 text-red-400 border border-red-500/20">
                              <AlertTriangle size={10} />
                              Risco alto
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-zinc-500 mt-0.5">{tool.description}</p>
                      </div>
                      <button
                        onClick={() => handleToggleTool(tool.id, !enabled)}
                        className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full transition-colors duration-200 ease-in-out ${
                          enabled ? 'bg-amber-500' : 'bg-zinc-700'
                        }`}
                        role="switch"
                        aria-checked={enabled}
                      >
                        <span
                          className={`pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow ring-0 transition-transform duration-200 ease-in-out ${
                            enabled ? 'translate-x-5' : 'translate-x-0'
                          }`}
                          style={{ marginTop: '2px', marginLeft: enabled ? '0px' : '2px' }}
                        />
                      </button>
                    </div>
                  );
                })}
              </div>
            </section>
          );
        })}
    </div>
  );
}
