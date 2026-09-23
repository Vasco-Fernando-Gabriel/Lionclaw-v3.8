import { useEffect, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { formatContextWindowShort } from './model-picker.logic';

const EFFORT_LABELS: Record<string, string> = {
  off: 'Off',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Xhigh',
  'extra-high': 'Extra High',
  max: 'Max',
  ultra: 'Ultra',
};

const EFFORT_ORDER: readonly string[] = ['off', 'low', 'medium', 'high', 'xhigh', 'extra-high', 'max', 'ultra'];

export function effortLabel(effort: string): string {
  return EFFORT_LABELS[effort] ?? effort;
}

export function orderEffortOptions(options: readonly string[]): string[] {
  return [...options].sort((a, b) => {
    const ia = EFFORT_ORDER.indexOf(a);
    const ib = EFFORT_ORDER.indexOf(b);
    return (ia === -1 ? EFFORT_ORDER.length : ia) - (ib === -1 ? EFFORT_ORDER.length : ib);
  });
}

export interface EffortPillProps {
  effort: string | undefined;
  options: readonly string[];
  defaultReasoning: string | null;
  contextWindow?: number;
  disabled?: boolean;
  disabledReason?: string;
  onChange: (effort: string) => void;
}

export function EffortPill({
  effort,
  options,
  defaultReasoning,
  contextWindow,
  disabled,
  disabledReason,
  onChange,
}: EffortPillProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const ordered = orderEffortOptions(options);
  const showEffort = ordered.length > 0;
  const context = formatContextWindowShort(contextWindow);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  useEffect(() => {
    if (disabled && open) setOpen(false);
  }, [disabled, open]);

  if (!showEffort && !context) return null;

  const parts: string[] = [];
  if (showEffort) parts.push(effortLabel(effort ?? defaultReasoning ?? ordered[0]));
  if (context) parts.push(context);
  const label = parts.join(' · ');

  return (
    <div ref={rootRef} className="relative inline-flex">
      <button
        type="button"
        disabled={disabled || !showEffort}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Effort e contexto: ${label}`}
        title={disabledReason ?? (showEffort ? 'Reasoning effort da lane' : 'Janela de contexto do modelo')}
        onClick={() => setOpen((value) => !value)}
        data-testid="chat-lane-effort"
        className="inline-flex items-center gap-1 rounded-md border border-transparent bg-transparent px-1.5 py-0.5 text-[10px] font-medium text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-200 focus:border-amber-500/50 focus:outline-none disabled:cursor-default disabled:opacity-60"
      >
        <span className="min-w-0 truncate">{label}</span>
        {showEffort && (
          <ChevronDown
            size={11}
            className={`shrink-0 text-zinc-500 transition-transform ${open ? 'rotate-180' : ''}`}
          />
        )}
      </button>

      {open && showEffort && (
        <div
          role="menu"
          aria-label="Reasoning effort"
          className="absolute bottom-[calc(100%+6px)] right-0 z-50 flex w-[200px] flex-col gap-px rounded-lg border border-zinc-800 bg-zinc-900 p-1 text-zinc-100 shadow-xl"
        >
          <div className="px-2 pb-1 pt-1 text-[10px] font-semibold uppercase tracking-wide text-zinc-500">
            Reasoning
          </div>
          {ordered.map((option) => {
            const checked = option === (effort ?? defaultReasoning);
            return (
              <button
                key={option}
                type="button"
                role="menuitemradio"
                aria-checked={checked}
                onClick={() => {
                  onChange(option);
                  setOpen(false);
                }}
                className="flex items-center gap-2 rounded-md px-2 py-[6px] text-left text-[12px] font-medium text-zinc-100 transition-colors hover:bg-zinc-800 focus:bg-zinc-800 focus:outline-none"
              >
                <span
                  aria-hidden="true"
                  className={`grid h-[14px] w-[14px] shrink-0 place-items-center rounded-full border ${checked ? 'border-amber-400' : 'border-zinc-600'}`}
                >
                  <span
                    className={`h-[6px] w-[6px] rounded-full bg-amber-400 ${checked ? 'opacity-100' : 'opacity-0'}`}
                  />
                </span>
                <span className="min-w-0 flex-1 truncate">
                  {effortLabel(option)}
                  {option === defaultReasoning ? ' (padrao)' : ''}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
