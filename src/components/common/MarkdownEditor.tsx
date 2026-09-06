import { Save, CheckCircle } from 'lucide-react';

interface MarkdownEditorProps {
  value: string;
  onChange: (value: string) => void;
  onSave: () => void;
  saving: boolean;
  description?: string;
}

export function MarkdownEditor({ value, onChange, onSave, saving, description }: MarkdownEditorProps) {
  return (
    <div className="flex flex-col flex-1">
      {description && (
        <div className="px-4 py-2.5 border-b border-zinc-800/50 bg-zinc-900/30">
          <p className="text-xs text-zinc-500">{description}</p>
        </div>
      )}
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="flex-1 bg-zinc-950 text-zinc-200 font-mono text-sm p-4 outline-none resize-none selectable"
        spellCheck={false}
      />
      <div className="px-4 py-2 border-t border-zinc-800">
        <button
          onClick={onSave}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-amber-600 hover:bg-amber-500 text-white rounded-lg text-xs font-medium transition-colors"
        >
          {saving ? <CheckCircle size={14} /> : <Save size={14} />}
          {saving ? 'Salvo!' : 'Salvar'}
        </button>
      </div>
    </div>
  );
}
