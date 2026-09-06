import { useState, useEffect } from 'react';
import { X, Loader2 } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

const TYPE_TO_SUBDIR: Record<string, string> = {
  entity: 'entities',
  meeting: 'meetings',
  decision: 'decisions',
  project: 'projects',
  reference: 'references',
};

interface GraphSidebarProps {
  nodeId: string;
  nodeType: string;
  onClose: () => void;
}

export function GraphSidebar({ nodeId, nodeType, onClose }: GraphSidebarProps) {
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    setContent(null);
    const subdir = TYPE_TO_SUBDIR[nodeType] || nodeType;
    const notePath = `${subdir}/${nodeId}.md`;
    window.lionclaw.mgraph.read(notePath)
      .then((result: unknown) => {
        if (result && typeof result === 'object' && 'error' in result) {
          setContent(`*Erro: ${(result as { error: string }).error}*`);
        } else if (typeof result === 'string') {
          setContent(result);
        } else {
          setContent('*Erro ao carregar nota.*');
        }
      })
      .catch(() => setContent('*Erro ao carregar nota.*'))
      .finally(() => setLoading(false));
  }, [nodeId, nodeType]);

  return (
    <div className="w-80 bg-zinc-900 border-l border-zinc-800 flex flex-col shrink-0">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-800">
        <span className="text-sm font-mono text-zinc-300 truncate">{nodeId}</span>
        <button
          onClick={onClose}
          className="p-1 rounded hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 transition-colors"
        >
          <X size={16} />
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-4 py-3">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 size={20} className="animate-spin text-zinc-500" />
          </div>
        ) : (
          <div className="prose prose-invert prose-sm max-w-none
            prose-headings:text-zinc-200 prose-headings:font-mono prose-headings:text-sm
            prose-p:text-zinc-400 prose-p:text-xs prose-p:leading-relaxed
            prose-a:text-amber-500 prose-a:no-underline hover:prose-a:underline
            prose-code:text-amber-400 prose-code:text-xs
            prose-li:text-zinc-400 prose-li:text-xs
            prose-strong:text-zinc-200
          ">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {content || ''}
            </ReactMarkdown>
          </div>
        )}
      </div>
    </div>
  );
}
