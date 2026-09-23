import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import type { ProviderStatusEntry, SessionOrchestrator } from '@/types';
import { ProviderIcon } from './ProviderIcon';
import { ModelPickerContent, type ModelPickerContentHandle } from './ModelPickerContent';
import {
  buildRuntimePickerCatalog,
  findPickerModel,
  providerKey,
  type PickerModel,
  type PickerProviderRef,
} from './model-picker.logic';

export interface ProviderModelPickerProps {
  selection: SessionOrchestrator | null;
  entries: readonly ProviderStatusEntry[];
  phase: 'idle' | 'loading' | 'ready' | 'error';
  error?: string | null;
  lockProvider?: PickerProviderRef | null;
  lockedFooter?: string | null;
  disabled?: boolean;
  disabledReason?: string;
  align?: 'left' | 'right';
  onOpen?: () => void;
  onRefresh: () => void;
  onSelect: (model: PickerModel) => void;
}

function isMac(): boolean {
  return typeof navigator !== 'undefined' && /mac/i.test(navigator.platform || navigator.userAgent || '');
}

export function ProviderModelPicker({
  selection,
  entries,
  phase,
  error,
  lockProvider,
  lockedFooter,
  disabled,
  disabledReason,
  align = 'right',
  onOpen,
  onRefresh,
  onSelect,
}: ProviderModelPickerProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<ModelPickerContentHandle>(null);

  const activeModel = findPickerModel(buildRuntimePickerCatalog(entries).models, selection);
  const triggerLabel = activeModel?.modelLabel ?? selection?.model ?? 'Escolher modelo';

  const close = useCallback(() => setOpen(false), []);

  const toggle = useCallback(() => {
    setOpen((value) => {
      if (!value) onOpen?.();
      return !value;
    });
  }, [onOpen]);

  const handleSelect = useCallback(
    (model: PickerModel): void => {
      onSelect(model);
      setOpen(false);
    },
    [onSelect],
  );

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
    if (!open) return;
    const onKeyDownCapture = (event: KeyboardEvent): void => {
      const modifier = isMac() ? event.metaKey : event.ctrlKey;
      if (!modifier || event.altKey || event.shiftKey) return;
      if (event.key < '1' || event.key > '9') return;
      const index = Number(event.key) - 1;
      const handle = contentRef.current;
      if (!handle) return;
      event.preventDefault();
      event.stopPropagation();
      if (index >= handle.visibleCount()) return;
      handle.selectVisibleAt(index);
      setOpen(false);
    };
    window.addEventListener('keydown', onKeyDownCapture, true);
    return () => {
      window.removeEventListener('keydown', onKeyDownCapture, true);
    };
  }, [open]);

  const lockKey = lockProvider ? providerKey(lockProvider) : '';

  return (
    <div ref={rootRef} className="relative inline-flex">
      <button
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Orquestrador da lane: ${triggerLabel}`}
        title={
          disabledReason ??
          (selection ? `${selection.runtime} / ${selection.provider} / ${selection.model}` : undefined)
        }
        onClick={toggle}
        data-testid="chat-lane-orchestrator"
        className="inline-flex max-w-[220px] cursor-pointer items-center gap-1 rounded-md border border-transparent bg-transparent px-1.5 py-0.5 text-[10px] font-medium text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-200 focus:border-amber-500/50 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
      >
        {selection && <ProviderIcon provider={selection.provider} className="h-[13px] w-[13px] shrink-0" />}
        <span className="min-w-0 truncate">{triggerLabel}</span>
        <ChevronDown size={11} className={`shrink-0 text-zinc-500 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className={`absolute bottom-[calc(100%+6px)] z-50 ${align === 'right' ? 'right-0' : 'left-0'}`}>
          <ModelPickerContent
            ref={contentRef}
            selection={selection}
            entries={entries}
            phase={phase}
            error={error}
            lockProvider={lockProvider}
            footer={lockProvider ? (lockedFooter ?? null) : null}
            onRefresh={onRefresh}
            onSelect={handleSelect}
          />
        </div>
      )}

      <DisabledCloser disabled={Boolean(disabled)} lockKey={lockKey} open={open} onClose={close} />
    </div>
  );
}

function DisabledCloser({
  disabled,
  lockKey,
  open,
  onClose,
}: {
  disabled: boolean;
  lockKey: string;
  open: boolean;
  onClose: () => void;
}): null {
  const previousLockRef = useRef(lockKey);
  useEffect(() => {
    if (disabled && open) onClose();
  }, [disabled, open, onClose]);
  useEffect(() => {
    if (previousLockRef.current !== lockKey) {
      previousLockRef.current = lockKey;
      if (open) onClose();
    }
  }, [lockKey, open, onClose]);
  return null;
}
