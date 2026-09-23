import { useState, useEffect, useCallback } from 'react';
import { Workflow } from 'lucide-react';

export interface SlashCommand {
  command: string;
  label: string;
  description: string;
}

interface SlashCommandPickerProps {
  commands: SlashCommand[];
  filter: string;
  onSelect: (command: string) => void;
  visible: boolean;
  onNavigate: (handler: { onKeyDown: (e: React.KeyboardEvent) => boolean }) => void;
}

export function SlashCommandPicker({ commands, filter, onSelect, visible, onNavigate }: SlashCommandPickerProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);

  const filtered = commands.filter((cmd) => cmd.label.toLowerCase().startsWith(filter.toLowerCase()));

  useEffect(() => {
    setSelectedIndex(0);
  }, [filter]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent): boolean => {
      if (!visible || filtered.length === 0) return false;

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex((i) => (i + 1) % filtered.length);
        return true;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex((i) => (i - 1 + filtered.length) % filtered.length);
        return true;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        onSelect(filtered[selectedIndex].command);
        return true;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        return true;
      }
      return false;
    },
    [visible, filtered, selectedIndex, onSelect],
  );

  useEffect(() => {
    onNavigate({ onKeyDown: handleKeyDown });
  }, [handleKeyDown, onNavigate]);

  if (!visible || filtered.length === 0) return null;

  return (
    <div className="absolute bottom-full left-0 right-0 mb-1 bg-zinc-800 border border-zinc-700 rounded-lg shadow-xl overflow-hidden z-50">
      {filtered.map((cmd, i) => (
        <button
          key={cmd.command}
          className={`w-full flex items-center gap-3 px-3 py-2.5 text-left transition-colors ${
            i === selectedIndex ? 'bg-amber-600/20' : 'hover:bg-zinc-700/50'
          }`}
          onMouseEnter={() => setSelectedIndex(i)}
          onMouseDown={(e) => {
            e.preventDefault();
            onSelect(cmd.command);
          }}
        >
          <div className="w-7 h-7 rounded-md bg-zinc-700 flex items-center justify-center shrink-0">
            <Workflow size={14} className="text-amber-500" />
          </div>
          <div className="min-w-0">
            <span className="text-sm font-medium text-zinc-100">{cmd.command}</span>
            <p className="text-xs text-zinc-400 truncate">{cmd.description}</p>
          </div>
        </button>
      ))}
    </div>
  );
}
