import { useState, useEffect, useMemo } from 'react';
import {
  Zap,
  Plus,
  Pencil,
  Trash2,
  FileCode,
  GitFork,
  Bot,
  Wrench,
  Wand2,
  ChevronDown,
  ChevronRight,
} from 'lucide-react';
import { SkillFormModal } from '@/components/skills/SkillFormModal';
import { SkillEditor } from '@/components/skills/SkillEditor';
import { useAppStore } from '@/stores/app-store';
import type { Skill, SkillInput } from '@/types';

const UNCATEGORIZED = 'Sem Categoria';

export function SkillsPage() {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [editingSkill, setEditingSkill] = useState<Skill | undefined>();
  const [rawEditing, setRawEditing] = useState<string | null>(null);
  const [rawContent, setRawContent] = useState('');
  const [collapsedCategories, setCollapsedCategories] = useState<Set<string>>(new Set());

  const loadSkills = async () => {
    setIsLoading(true);
    const result = await window.lionclaw.skills.list();
    setSkills(result);
    setIsLoading(false);
  };

  useEffect(() => {
    loadSkills();
  }, []);

  const grouped = useMemo(() => {
    const map = new Map<string, Skill[]>();
    for (const skill of skills) {
      const cat = skill.category || UNCATEGORIZED;
      if (!map.has(cat)) map.set(cat, []);
      map.get(cat)!.push(skill);
    }
    const sorted = [...map.entries()].sort(([a], [b]) => {
      if (a === UNCATEGORIZED) return 1;
      if (b === UNCATEGORIZED) return -1;
      return a.localeCompare(b, 'pt-BR');
    });
    return sorted;
  }, [skills]);

  const existingCategories = useMemo(() => {
    const cats = new Set<string>();
    for (const skill of skills) {
      if (skill.category) cats.add(skill.category);
    }
    return [...cats].sort((a, b) => a.localeCompare(b, 'pt-BR'));
  }, [skills]);

  const toggleCategory = (cat: string) => {
    setCollapsedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });
  };

  const handleCreate = async (input: SkillInput) => {
    await window.lionclaw.skills.create(input);
    setShowModal(false);
    loadSkills();
  };

  const handleUpdate = async (input: SkillInput) => {
    if (!editingSkill) return;
    await window.lionclaw.skills.update(editingSkill.name, input);
    setEditingSkill(undefined);
    setShowModal(false);
    loadSkills();
  };

  const handleDelete = async (name: string) => {
    await window.lionclaw.skills.delete(name);
    loadSkills();
  };

  const handleEditRaw = (skill: Skill) => {
    setRawEditing(skill.name);
    setRawContent(skill.rawContent);
  };

  if (rawEditing) {
    return (
      <SkillEditor
        skillName={rawEditing}
        initialContent={rawContent}
        onSave={async (content: string) => {
          setRawContent(content);
          await window.lionclaw.skills.updateRaw(rawEditing, content);
          setRawEditing(null);
          loadSkills();
        }}
        onClose={() => setRawEditing(null)}
      />
    );
  }

  const renderSkillCard = (skill: Skill) => (
    <div key={skill.name} className="bg-zinc-900 border border-zinc-800 rounded-lg px-4 py-3">
      <div className="flex items-start gap-3">
        <Zap size={16} className="text-amber-500 shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <p className="text-sm font-medium text-zinc-200">{skill.name}</p>
            {skill.context === 'fork' && (
              <span className="flex items-center gap-1 px-1.5 py-0.5 text-[10px] bg-purple-900/40 text-purple-400 border border-purple-800/50 rounded">
                <GitFork size={10} />
                fork
              </span>
            )}
            {skill.disableModelInvocation && (
              <span className="px-1.5 py-0.5 text-[10px] bg-zinc-800 text-zinc-500 border border-zinc-700 rounded">
                manual
              </span>
            )}
            {skill.model && (
              <span className="flex items-center gap-1 px-1.5 py-0.5 text-[10px] bg-blue-900/30 text-blue-400 border border-blue-800/50 rounded">
                <Bot size={10} />
                {skill.model}
              </span>
            )}
          </div>
          <p className="text-xs text-zinc-500 mt-0.5">{skill.description}</p>
          {skill.allowedTools && skill.allowedTools.length > 0 && (
            <div className="flex items-center gap-1.5 mt-2">
              <Wrench size={10} className="text-zinc-600" />
              <div className="flex flex-wrap gap-1">
                {skill.allowedTools.map((tool) => (
                  <span key={tool} className="px-1.5 py-0.5 text-[10px] bg-zinc-800 text-zinc-400 rounded">
                    {tool}
                  </span>
                ))}
              </div>
            </div>
          )}
          {skill.agent && <p className="text-[10px] text-zinc-600 mt-1">Agent: {skill.agent}</p>}
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => handleEditRaw(skill)}
            className="p-1.5 rounded-lg hover:bg-zinc-800 text-zinc-500 hover:text-zinc-300"
            title="Editar SKILL.md"
          >
            <FileCode size={14} />
          </button>
          <button
            onClick={() => {
              setEditingSkill(skill);
              setShowModal(true);
            }}
            className="p-1.5 rounded-lg hover:bg-zinc-800 text-zinc-500 hover:text-zinc-300"
            title="Editar"
          >
            <Pencil size={14} />
          </button>
          <button
            onClick={() => handleDelete(skill.name)}
            className="p-1.5 rounded-lg hover:bg-zinc-800 text-zinc-500 hover:text-red-400"
            title="Excluir"
          >
            <Trash2 size={14} />
          </button>
        </div>
      </div>
    </div>
  );

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="max-w-4xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-xl font-semibold text-zinc-100">Skills</h1>
            <p className="text-sm text-zinc-500 mt-1">Habilidades reutilizaveis do agente</p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                setEditingSkill(undefined);
                setShowModal(true);
              }}
              className="flex items-center gap-2 bg-zinc-700 hover:bg-zinc-600 text-zinc-200 rounded-lg px-4 py-2 text-sm font-medium transition-colors"
            >
              <Plus size={16} />
              Nova Skill
            </button>
            <button
              onClick={() => {
                const { setPendingChat, setPage } = useAppStore.getState();
                setPendingChat(
                  'Quero criar uma nova skill para o LionClaw. Inicie o processo de criacao assistida - me faca perguntas sobre o que a skill deve fazer, quando ativar, formato de saida, etc.',
                  'skill-creator',
                );
                setPage('chat');
              }}
              className="flex items-center gap-2 bg-amber-600 hover:bg-amber-500 text-white rounded-lg px-4 py-2 text-sm font-medium transition-colors"
            >
              <Wand2 size={16} />
              Criar com Assistente
            </button>
          </div>
        </div>

        {isLoading ? (
          <div className="flex justify-center py-12">
            <div className="w-6 h-6 border-2 border-amber-500 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : skills.length === 0 ? (
          <div className="text-center py-12 text-zinc-600">
            <Zap size={32} className="mx-auto mb-3 opacity-50" />
            <p className="text-sm">Nenhuma skill criada</p>
            <p className="text-xs mt-1">Crie pelo dashboard ou peca ao agente no chat</p>
          </div>
        ) : (
          <div className="space-y-4">
            {grouped.map(([category, categorySkills]) => {
              const isCollapsed = collapsedCategories.has(category);
              return (
                <div key={category}>
                  <button
                    onClick={() => toggleCategory(category)}
                    className="flex items-center gap-2 mb-2 group w-full text-left"
                  >
                    {isCollapsed ? (
                      <ChevronRight size={14} className="text-zinc-500 group-hover:text-zinc-300" />
                    ) : (
                      <ChevronDown size={14} className="text-zinc-500 group-hover:text-zinc-300" />
                    )}
                    <span className="text-xs font-semibold text-zinc-400 uppercase tracking-wider group-hover:text-zinc-300">
                      {category}
                    </span>
                    <span className="text-[10px] text-zinc-600 ml-1">{categorySkills.length}</span>
                  </button>
                  {!isCollapsed && <div className="space-y-2 ml-5">{categorySkills.map(renderSkillCard)}</div>}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {showModal && (
        <SkillFormModal
          mode={editingSkill ? 'edit' : 'create'}
          skill={editingSkill}
          existingCategories={existingCategories}
          onSave={editingSkill ? handleUpdate : handleCreate}
          onClose={() => {
            setShowModal(false);
            setEditingSkill(undefined);
          }}
        />
      )}
    </div>
  );
}
