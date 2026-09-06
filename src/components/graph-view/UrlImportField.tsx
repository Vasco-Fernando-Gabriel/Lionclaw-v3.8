import { useState } from 'react';
import { Link, Loader2 } from 'lucide-react';
import type { IngestJob } from '@/types';


function isValidUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}


interface UrlImportFieldProps {
  onJobCreated: (job: IngestJob) => void;
}

export function UrlImportField({ onJobCreated }: UrlImportFieldProps) {
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(false);

  const handleImport = async () => {
    if (!isValidUrl(url)) return;
    setLoading(true);
    try {
      const job = await window.lionclaw.mgraph.ingestUrl(url);
      onJobCreated(job);
      setUrl('');
    } catch {
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex gap-2">
      <div className="relative flex-1">
        <Link size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" />
        <input
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleImport()}
          placeholder="https://..."
          disabled={loading}
          className="w-full bg-zinc-900 border border-zinc-800 rounded-lg pl-8 pr-3 py-2 text-sm text-zinc-200 outline-none focus:border-amber-500/50 placeholder:text-zinc-600 disabled:opacity-50"
        />
      </div>
      <button
        onClick={handleImport}
        disabled={loading || !isValidUrl(url)}
        className="flex items-center gap-1.5 px-3 py-2 bg-amber-600 hover:bg-amber-500 disabled:opacity-50 disabled:pointer-events-none text-white rounded-lg text-sm transition-colors shrink-0"
      >
        {loading && <Loader2 size={14} className="animate-spin" />}
        Importar
      </button>
    </div>
  );
}
