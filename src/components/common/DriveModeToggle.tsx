
interface DriveModeToggleProps {
  mode: 'semi' | 'full';
  disabled?: boolean;
  onChange: (mode: 'semi' | 'full') => void;
  size?: 'sm' | 'md';
}

const MODE_TITLE: Record<'semi' | 'full', string> = {
  semi: 'Semi: o orquestrador conduz as conversas, mas te pede OK em todo gate',
  full: 'Full: auto-aprova gates de baixo risco e so te escala os criticos (PRD, SPEC, Design Lock, codigo)',
};

export function DriveModeToggle({ mode, disabled = false, onChange, size = 'md' }: DriveModeToggleProps) {
  const pad = size === 'sm' ? 'px-1.5 py-0.5 text-[10px]' : 'px-2.5 py-1 text-xs';
  return (
    <div
      className={`inline-flex items-center rounded-lg border border-zinc-700/80 bg-zinc-900 p-0.5 ${
        disabled ? 'opacity-40' : ''
      }`}
      role="group"
      aria-label="Autonomia do drive"
    >
      {(['semi', 'full'] as const).map((m) => (
        <button
          key={m}
          type="button"
          disabled={disabled}
          onClick={(e) => {
            e.stopPropagation();
            if (m !== mode) onChange(m);
          }}
          title={MODE_TITLE[m]}
          className={`${pad} font-medium rounded-md transition-colors disabled:cursor-not-allowed ${
            m === mode
              ? 'bg-amber-600 text-white'
              : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800'
          }`}
        >
          {m}
        </button>
      ))}
    </div>
  );
}
