import { useState, useEffect } from 'react';
import { X, FolderOpen, FileText } from 'lucide-react';
import { useHarnessStore } from '@/stores/harness-store';
import type { AgentConfig } from '@/types';

export function NewProjectModal({ onClose }: { onClose: () => void }) {
  const { loadProjects, selectProject } = useHarnessStore();
  const [agents, setAgents] = useState<AgentConfig[]>([]);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [projectPath, setProjectPath] = useState('');
  const [specFilePath, setSpecFilePath] = useState('');
  const [plannerAgentId, setPlannerAgentId] = useState('');
  const [evaluatorAgentId, setEvaluatorAgentId] = useState('');
  const [maxRounds, setMaxRounds] = useState(3);
  const [stack, setStack] = useState('');
  const [usePlaywright, setUsePlaywright] = useState(false);
  const [plannerOutputFormat, setPlannerOutputFormat] = useState<'json' | 'markdown'>('json');
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    window.lionclaw.agents.list().then(setAgents);
  }, []);

  const isValid =
    name.trim() !== '' &&
    projectPath.trim() !== '' &&
    specFilePath.trim() !== '' &&
    plannerAgentId !== '' &&
    evaluatorAgentId !== '';

  const handleCreate = async () => {
    if (!isValid) return;
    setCreating(true);
    try {
      const result = await window.lionclaw.harness.createProject({
        name: name.trim(),
        description: description.trim() || undefined,
        projectPath: projectPath.trim(),
        specFilePath: specFilePath.trim(),
        config: {
          maxRoundsPerSprint: maxRounds,
          usePlaywright,
          evaluatorAgentId,
          plannerAgentId,
          plannerOutputFormat,
          stack: stack
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
        },
      });
      if ('error' in result) {
        return;
      }
      await loadProjects();
      selectProject(result.projectId);
      onClose();
      window.lionclaw.harness.plan(result.projectId);
    } finally {
      setCreating(false);
    }
  };

  const activeAgents = agents.filter((a) => a.isActive);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl w-full max-w-lg max-h-[90vh] overflow-y-auto p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-bold text-zinc-100">Novo Projeto Harness</h2>
          <button onClick={onClose} className="p-1 rounded hover:bg-zinc-800 text-zinc-400" title="Fechar">
            <X size={18} />
          </button>
        </div>

        <div className="space-y-4">
          <div>
            <label className="text-xs font-medium text-zinc-400 mb-1 block">Nome</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-zinc-100 focus:outline-none focus:border-amber-500"
              placeholder="Meu Projeto"
            />
          </div>

          <div>
            <label className="text-xs font-medium text-zinc-400 mb-1 block">Descricao (opcional)</label>
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-zinc-100 focus:outline-none focus:border-amber-500"
              placeholder="Breve descricao do projeto"
            />
          </div>

          <div>
            <label className="text-xs font-medium text-zinc-400 mb-1 block">Caminho do Projeto</label>
            <div className="flex gap-2">
              <input
                value={projectPath}
                onChange={(e) => setProjectPath(e.target.value)}
                className="flex-1 px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-zinc-100 focus:outline-none focus:border-amber-500"
                placeholder="/caminho/do/projeto"
              />
              <button
                type="button"
                onClick={async () => {
                  const selected = await window.lionclaw.shell.selectDirectory();
                  if (selected) setProjectPath(selected);
                }}
                className="px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-zinc-400 hover:text-zinc-100 hover:border-zinc-600 transition-colors"
                title="Selecionar pasta"
              >
                <FolderOpen size={16} />
              </button>
            </div>
          </div>

          <div>
            <label className="text-xs font-medium text-zinc-400 mb-1 block">Arquivo da SPEC</label>
            <div className="flex gap-2">
              <input
                value={specFilePath}
                onChange={(e) => setSpecFilePath(e.target.value)}
                className="flex-1 px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-zinc-100 focus:outline-none focus:border-amber-500"
                placeholder="/caminho/para/SPEC.md"
              />
              <button
                type="button"
                onClick={async () => {
                  const selected = await window.lionclaw.dialog.openFile([
                    { name: 'Spec', extensions: ['md', 'txt', 'json'] },
                  ]);
                  if (selected) setSpecFilePath(selected);
                }}
                className="px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-zinc-400 hover:text-zinc-100 hover:border-zinc-600 transition-colors"
                title="Selecionar arquivo da SPEC"
              >
                <FileText size={16} />
              </button>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-zinc-400 mb-1 block">Planner Agent</label>
              <select
                value={plannerAgentId}
                onChange={(e) => setPlannerAgentId(e.target.value)}
                className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-zinc-100 focus:outline-none focus:border-amber-500"
              >
                <option value="">Selecione...</option>
                {activeAgents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-xs font-medium text-zinc-400 mb-1 block">Evaluator Agent</label>
              <select
                value={evaluatorAgentId}
                onChange={(e) => setEvaluatorAgentId(e.target.value)}
                className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-zinc-100 focus:outline-none focus:border-amber-500"
              >
                <option value="">Selecione...</option>
                {activeAgents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-zinc-400 mb-1 block">Max Rounds / Sprint</label>
              <input
                type="number"
                value={maxRounds}
                onChange={(e) => setMaxRounds(Number(e.target.value))}
                min={1}
                max={10}
                className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-zinc-100 focus:outline-none focus:border-amber-500"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-zinc-400 mb-1 block">Stack (virgulas)</label>
              <input
                value={stack}
                onChange={(e) => setStack(e.target.value)}
                className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-zinc-100 focus:outline-none focus:border-amber-500"
                placeholder="react, typescript"
              />
            </div>
          </div>

          <div className="flex items-center gap-4">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={usePlaywright}
                onChange={(e) => setUsePlaywright(e.target.checked)}
                className="rounded border-zinc-700 bg-zinc-800 text-amber-500"
              />
              <span className="text-sm text-zinc-300">Playwright E2E</span>
            </label>

            <div className="flex items-center gap-2">
              <span className="text-xs text-zinc-400">Formato do Planner:</span>
              <div className="flex rounded-lg border border-zinc-700 overflow-hidden">
                <button
                  type="button"
                  onClick={() => setPlannerOutputFormat('json')}
                  className={`px-3 py-1 text-xs font-medium transition-colors ${
                    plannerOutputFormat === 'json'
                      ? 'bg-amber-600 text-white'
                      : 'bg-zinc-800 text-zinc-400 hover:text-zinc-200'
                  }`}
                >
                  JSON
                </button>
                <button
                  type="button"
                  onClick={() => setPlannerOutputFormat('markdown')}
                  className={`px-3 py-1 text-xs font-medium transition-colors ${
                    plannerOutputFormat === 'markdown'
                      ? 'bg-amber-600 text-white'
                      : 'bg-zinc-800 text-zinc-400 hover:text-zinc-200'
                  }`}
                >
                  Markdown
                </button>
              </div>
            </div>
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <button onClick={onClose} className="px-4 py-2 text-sm text-zinc-400 hover:text-zinc-200 transition-colors">
              Cancelar
            </button>
            <button
              onClick={handleCreate}
              disabled={creating || !isValid}
              className="px-4 py-2 bg-amber-600 hover:bg-amber-500 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg text-sm font-medium transition-colors"
            >
              {creating ? 'Criando...' : 'Criar Projeto'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
