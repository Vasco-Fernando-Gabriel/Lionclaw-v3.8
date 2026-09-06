import { useState } from 'react';
import { FileCode } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface Props {
  skillName: string;
  initialContent: string;
  onSave: (content: string) => void;
  onClose: () => void;
}

export function SkillEditor({ skillName, initialContent, onSave, onClose }: Props) {
  const [content, setContent] = useState(initialContent);
  const [isSaving, setIsSaving] = useState(false);

  const handleSave = async () => {
    setIsSaving(true);
    try {
      await onSave(content);
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-zinc-800 shrink-0">
        <FileCode size={18} className="text-amber-500" />
        <h1 className="text-sm font-semibold text-zinc-200">SKILL.md: {skillName}</h1>
        <div className="flex-1" />
        <button
          onClick={onClose}
          className="px-3 py-1.5 text-xs text-zinc-400 hover:text-zinc-200 border border-zinc-700 rounded-lg transition-colors"
        >
          Cancelar
        </button>
        <button
          onClick={handleSave}
          disabled={isSaving}
          className="px-3 py-1.5 text-xs bg-amber-600 hover:bg-amber-500 disabled:bg-zinc-700 disabled:text-zinc-500 text-white rounded-lg transition-colors"
        >
          {isSaving ? 'Salvando...' : 'Salvar'}
        </button>
      </div>

      {/* Split panes */}
      <div className="flex flex-1 min-h-0">
        {/* Left: raw editor */}
        <div className="flex flex-col w-1/2 border-r border-zinc-800 min-h-0">
          <div className="px-3 py-1.5 border-b border-zinc-800 bg-zinc-900">
            <span className="text-[10px] uppercase tracking-wider text-zinc-600 font-medium">Editor</span>
          </div>
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            className="flex-1 bg-zinc-950 text-zinc-200 font-mono text-sm p-4 outline-none resize-none selectable min-h-0"
            spellCheck={false}
          />
        </div>

        {/* Right: rendered preview */}
        <div className="flex flex-col w-1/2 min-h-0">
          <div className="px-3 py-1.5 border-b border-zinc-800 bg-zinc-900">
            <span className="text-[10px] uppercase tracking-wider text-zinc-600 font-medium">Preview</span>
          </div>
          <div className="flex-1 overflow-y-auto p-4 bg-zinc-950 min-h-0">
            <div className="prose prose-invert prose-sm max-w-none
              prose-headings:text-zinc-100 prose-headings:font-semibold
              prose-p:text-zinc-300 prose-p:leading-relaxed
              prose-a:text-amber-400 prose-a:no-underline hover:prose-a:underline
              prose-code:text-amber-300 prose-code:bg-zinc-800 prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-code:text-xs
              prose-pre:bg-zinc-900 prose-pre:border prose-pre:border-zinc-800
              prose-blockquote:border-l-amber-600 prose-blockquote:text-zinc-400
              prose-strong:text-zinc-200
              prose-ul:text-zinc-300 prose-ol:text-zinc-300
              prose-li:marker:text-zinc-500
              prose-hr:border-zinc-800
              prose-table:text-zinc-300
              prose-th:text-zinc-200 prose-th:border-zinc-700
              prose-td:border-zinc-800
            ">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {content || '*Sem conteudo para exibir*'}
              </ReactMarkdown>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
