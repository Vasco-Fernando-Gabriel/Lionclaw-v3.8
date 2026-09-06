import { useState, useEffect, useRef } from 'react';
import { Search, RefreshCw, ZoomIn, ZoomOut } from 'lucide-react';
import { NODE_COLORS } from './graph-styles';

const NOTE_TYPES = ['entity', 'meeting', 'decision', 'project', 'reference'] as const;

interface GraphControlsProps {
  onFilterChange: (activeTypes: Set<string>) => void;
  onSearchChange: (query: string) => void;
  onRefresh: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
}

export function GraphControls({ onFilterChange, onSearchChange, onRefresh, onZoomIn, onZoomOut }: GraphControlsProps) {
  const [activeTypes, setActiveTypes] = useState<Set<string>>(new Set(NOTE_TYPES));
  const [searchText, setSearchText] = useState('');
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const toggleType = (type: string) => {
    setActiveTypes(prev => {
      const next = new Set(prev);
      if (next.has(type)) {
        next.delete(type);
      } else {
        next.add(type);
      }
      return next;
    });
  };

  useEffect(() => {
    onFilterChange(activeTypes);
  }, [activeTypes, onFilterChange]);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      onSearchChange(searchText);
    }, 300);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [searchText, onSearchChange]);

  return (
    <div className="flex items-center gap-3 px-4 py-2 bg-zinc-900/80 border-b border-zinc-800">
      {/* Type filters */}
      <div className="flex items-center gap-1.5">
        {NOTE_TYPES.map(type => {
          const active = activeTypes.has(type);
          return (
            <button
              key={type}
              onClick={() => toggleType(type)}
              className={`flex items-center gap-1.5 px-2 py-1 rounded text-xs font-mono transition-all ${
                active
                  ? 'bg-zinc-800 text-zinc-200'
                  : 'bg-zinc-900 text-zinc-600 opacity-50'
              }`}
              title={type}
            >
              <span
                className="w-2.5 h-2.5 rounded-full shrink-0"
                style={{ backgroundColor: NODE_COLORS[type] }}
              />
              {type}
            </button>
          );
        })}
      </div>

      {/* Search */}
      <div className="flex items-center gap-2 ml-auto">
        <div className="relative">
          <Search size={14} className="absolute left-2 top-1/2 -translate-y-1/2 text-zinc-500" />
          <input
            type="text"
            placeholder="Buscar..."
            value={searchText}
            onChange={e => setSearchText(e.target.value)}
            className="pl-7 pr-3 py-1.5 w-48 bg-zinc-800 border border-zinc-700 rounded text-xs text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-zinc-600"
          />
        </div>

        <button
          onClick={onZoomIn}
          className="p-1.5 rounded hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 transition-colors"
          title="Zoom in"
        >
          <ZoomIn size={16} />
        </button>
        <button
          onClick={onZoomOut}
          className="p-1.5 rounded hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 transition-colors"
          title="Zoom out"
        >
          <ZoomOut size={16} />
        </button>
        <button
          onClick={onRefresh}
          className="p-1.5 rounded hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 transition-colors"
          title="Atualizar dados"
        >
          <RefreshCw size={16} />
        </button>
      </div>
    </div>
  );
}
