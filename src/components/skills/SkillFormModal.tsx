import { useState, useEffect } from 'react';
import { X } from 'lucide-react';
import type { Skill, SkillInput } from '@/types';

const AVAILABLE_TOOLS = [
  'Read', 'Write', 'Edit', 'Glob', 'Grep',
  'Bash', 'WebSearch', 'WebFetch', 'NotebookEdit',
];

const MODEL_OPTIONS = [
  { value: '', label: 'Padrao (herda do agent)' },
  { value: 'haiku', label: 'Haiku 4.5' },
  { value: 'sonnet', label: 'Sonnet 4.6' },
  { value: 'opus', label: 'Opus 4.7' },
];

interface Props {
  mode: 'create' | 'edit';
  skill?: Skill;
  existingCategories?: string[];
  onSave: (input: SkillInput) => void;
  onClose: () => void;
}

export function SkillFormModal({ mode, skill, existingCategories = [], onSave, onClose }: Props) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('');
  const [content, setContent] = useState('');
  const [allowedTools, setAllowedTools] = useState<string[]>([]);
  const [model, setModel] = useState('');
  const [context, setContext] = useState<'' | 'fork'>('');
  const [agent, setAgent] = useState('');
  const [disableModelInvocation, setDisableModelInvocation] = useState(false);
  const [userInvocable, setUserInvocable] = useState(true);

  useEffect(() => {
    if (mode === 'edit' && skill) {
      setName(skill.name);
      setDescription(skill.description);
      setCategory(skill.category || '');
      setContent(skill.content);
      setAllowedTools(skill.allowedTools || []);
      setModel(skill.model || '');
      setContext(skill.context || '');
      setAgent(skill.agent || '');
      setDisableModelInvocation(skill.disableModelInvocation);
      setUserInvocable(skill.userInvocable);
    }
  }, [mode, skill]);

  const handleToolToggle = (tool: string) => {
    setAllowedTools(prev =>
      prev.includes(tool) ? prev.filter(t => t !== tool) : [...prev, tool]
    );
  };

  const handleSubmit = () => {
    if (!name.trim() || !description.trim() || !category.trim()) return;

    const input: SkillInput = {
      name: name.trim(),
      description: description.trim(),
      category: category.trim(),
      content: content.trim(),
      allowedTools: allowedTools.length > 0 ? allowedTools : undefined,
      model: model || undefined,
      disableModelInvocation: disableModelInvocation || undefined,
      userInvocable: userInvocable === false ? false : undefined,
      context: context || undefined,
      agent: context === 'fork' && agent ? agent : undefined,
    };

    onSave(input);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="bg-zinc-900 border border-zinc-700 rounded-xl w-full max-w-2xl max-h-[90vh] flex flex-col shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-800">
          <h2 className="text-base font-semibold text-zinc-100">
            {mode === 'create' ? 'Nova Skill' : `Editando: ${skill?.name}`}
          </h2>
          <button onClick={onClose} className="p-1 rounded-lg hover:bg-zinc-800 text-zinc-500 hover:text-zinc-300">
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          {/* Name & Description */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs text-zinc-400 mb-1.5">Nome</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="minha-skill"
                disabled={mode === 'edit'}
                className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 outline-none focus:border-amber-600 disabled:opacity-50 disabled:cursor-not-allowed"
              />
            </div>
            <div>
              <label className="block text-xs text-zinc-400 mb-1.5">Modelo</label>
              <select
                value={model}
                onChange={(e) => setModel(e.target.value)}
                className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-200 outline-none focus:border-amber-600"
              >
                {MODEL_OPTIONS.map(opt => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className="block text-xs text-zinc-400 mb-1.5">Descricao</label>
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Quando usar esta skill e o que ela faz"
              className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 outline-none focus:border-amber-600"
            />
          </div>

          <div>
            <label className="block text-xs text-zinc-400 mb-1.5">Categoria *</label>
            <input
              type="text"
              list="skill-categories"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              placeholder="Selecione ou digite uma nova categoria"
              className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 outline-none focus:border-amber-600"
            />
            <datalist id="skill-categories">
              {existingCategories.map(cat => (
                <option key={cat} value={cat} />
              ))}
            </datalist>
          </div>

          {/* Configuration */}
          <div className="border border-zinc-800 rounded-lg p-4 space-y-4">
            <p className="text-xs font-medium text-zinc-400 uppercase tracking-wider">Configuracao</p>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-xs text-zinc-400 mb-1.5">Contexto</label>
                <select
                  value={context}
                  onChange={(e) => setContext(e.target.value as '' | 'fork')}
                  className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-200 outline-none focus:border-amber-600"
                >
                  <option value="">Inline (conversa atual)</option>
                  <option value="fork">Fork (subagent isolado)</option>
                </select>
              </div>
              {context === 'fork' && (
                <div>
                  <label className="block text-xs text-zinc-400 mb-1.5">Agent (fork)</label>
                  <input
                    type="text"
                    value={agent}
                    onChange={(e) => setAgent(e.target.value)}
                    placeholder="Nome do subagent"
                    className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 outline-none focus:border-amber-600"
                  />
                </div>
              )}
            </div>

            <div className="flex gap-6">
              <label className="flex items-center gap-2 text-sm text-zinc-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={!disableModelInvocation}
                  onChange={(e) => setDisableModelInvocation(!e.target.checked)}
                  className="rounded border-zinc-600 bg-zinc-800 text-amber-600 focus:ring-amber-600"
                />
                Agente pode invocar automaticamente
              </label>
              <label className="flex items-center gap-2 text-sm text-zinc-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={userInvocable}
                  onChange={(e) => setUserInvocable(e.target.checked)}
                  className="rounded border-zinc-600 bg-zinc-800 text-amber-600 focus:ring-amber-600"
                />
                Usuario pode invocar via /nome
              </label>
            </div>
          </div>

          {/* Tools */}
          <div className="border border-zinc-800 rounded-lg p-4">
            <p className="text-xs font-medium text-zinc-400 uppercase tracking-wider mb-3">Tools Permitidos</p>
            <div className="flex flex-wrap gap-2">
              {AVAILABLE_TOOLS.map(tool => (
                <button
                  key={tool}
                  onClick={() => handleToolToggle(tool)}
                  className={`px-3 py-1.5 text-xs rounded-lg border transition-colors ${
                    allowedTools.includes(tool)
                      ? 'bg-amber-600/20 border-amber-600/50 text-amber-400'
                      : 'bg-zinc-800 border-zinc-700 text-zinc-500 hover:text-zinc-300 hover:border-zinc-600'
                  }`}
                >
                  {tool}
                </button>
              ))}
            </div>
            {allowedTools.length === 0 && (
              <p className="text-xs text-zinc-600 mt-2">Nenhum selecionado = herda do agent</p>
            )}
          </div>

          {/* Content */}
          <div>
            <label className="block text-xs text-zinc-400 mb-1.5">Instrucoes (SKILL.md body)</label>
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="Instrucoes detalhadas para o agente seguir quando esta skill for ativada..."
              rows={12}
              className="w-full bg-zinc-950 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-200 font-mono placeholder:text-zinc-600 outline-none focus:border-amber-600 resize-y"
              spellCheck={false}
            />
          </div>
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-3 px-5 py-4 border-t border-zinc-800">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-zinc-400 hover:text-zinc-200 border border-zinc-700 rounded-lg transition-colors"
          >
            Cancelar
          </button>
          <button
            onClick={handleSubmit}
            disabled={!name.trim() || !description.trim() || !category.trim()}
            className="px-4 py-2 text-sm bg-amber-600 hover:bg-amber-500 disabled:bg-zinc-700 disabled:text-zinc-500 text-white rounded-lg font-medium transition-colors"
          >
            {mode === 'create' ? 'Criar' : 'Salvar'}
          </button>
        </div>
      </div>
    </div>
  );
}
