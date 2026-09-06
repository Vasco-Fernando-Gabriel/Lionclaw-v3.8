import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import type { IngestJob } from '@/types';

const MAX_CHARS = 50_000;

interface TextIngestFieldProps {
  onJobCreated: (job: IngestJob) => void;
}

export function TextIngestField({ onJobCreated }: TextIngestFieldProps) {
  const [text, setText] = useState('');
  const [loading, setLoading] = useState(false);

  const handleProcess = async () => {
    if (!text.trim()) return;
    setLoading(true);
    try {
      const job = await window.lionclaw.mgraph.ingestText(text);
      onJobCreated(job);
      setText('');
    } catch {
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-2">
      <div className="relative">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value.slice(0, MAX_CHARS))}
          placeholder="Cole ou digite texto aqui..."
          rows={5}
          disabled={loading}
          className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2.5 text-sm text-zinc-200 outline-none focus:border-amber-500/50 placeholder:text-zinc-600 resize-none disabled:opacity-50"
        />
        <span className="absolute bottom-2.5 right-3 text-[10px] text-zinc-600 pointer-events-none">
          {text.length.toLocaleString('pt-BR')}/{MAX_CHARS.toLocaleString('pt-BR')}
        </span>
      </div>
      <div className="flex justify-end">
        <button
          onClick={handleProcess}
          disabled={loading || !text.trim()}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-amber-600 hover:bg-amber-500 disabled:opacity-50 disabled:pointer-events-none text-white rounded-lg text-sm transition-colors"
        >
          {loading && <Loader2 size={14} className="animate-spin" />}
          Processar texto
        </button>
      </div>
    </div>
  );
}
