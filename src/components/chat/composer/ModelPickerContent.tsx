import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ForwardedRef,
  type ReactNode,
} from 'react';
import { Check, RefreshCw, Search, Star } from 'lucide-react';
import type { ProviderStatusEntry, SessionOrchestrator } from '@/types';
import { ProviderIcon } from './ProviderIcon';
import { useFavoriteModels } from './use-favorite-models';
import {
  buildRuntimePickerCatalog,
  clampHighlight,
  computeVisibleModels,
  filterCatalogByProvider,
  formatContextWindowShort,
  keyOf,
  nextHighlight,
  prevHighlight,
  providerKey,
  sameProvider,
  shortcutForIndex,
  type PickerModel,
  type PickerProviderRef,
  type SidebarTab,
} from './model-picker.logic';

export interface ModelPickerContentHandle {
  visibleCount: () => number;
  selectVisibleAt: (index: number) => void;
}

export interface ModelPickerContentProps {
  selection: SessionOrchestrator | null;
  entries: readonly ProviderStatusEntry[];
  phase: 'idle' | 'loading' | 'ready' | 'error';
  error?: string | null;
  lockProvider?: PickerProviderRef | null;
  footer?: string | null;
  onRefresh: () => void;
  onSelect: (model: PickerModel) => void;
}

function ModelPickerContentInner(
  { selection, entries, phase, error, lockProvider, footer, onRefresh, onSelect }: ModelPickerContentProps,
  ref: ForwardedRef<ModelPickerContentHandle>,
) {
  const { favorites, isFavorite, toggleFavorite } = useFavoriteModels();
  const searchInputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);
  const isSearching = query.trim().length > 0;

  const catalog = useMemo(
    () => filterCatalogByProvider(buildRuntimePickerCatalog(entries), lockProvider),
    [entries, lockProvider],
  );

  const initialTab = (): SidebarTab => {
    if (lockProvider) return providerKey(lockProvider);
    if (favorites.size > 0) return 'favorites';
    if (selection) return providerKey(selection);
    return catalog.tabs[0]?.key ?? 'favorites';
  };
  const [tab, setTab] = useState<SidebarTab>(initialTab);

  useEffect(() => {
    if (tab === 'favorites') return;
    if (catalog.tabs.some((entry) => entry.key === tab)) return;
    const fallback = lockProvider ? providerKey(lockProvider) : catalog.tabs[0]?.key;
    if (fallback && fallback !== tab) setTab(fallback);
  }, [catalog.tabs, lockProvider, tab]);

  const visibleModels = useMemo<PickerModel[]>(
    () => computeVisibleModels({ isSearching, query, tab, favorites, models: catalog.models }),
    [catalog.models, favorites, isSearching, query, tab],
  );

  const handleSelect = useCallback(
    (model: PickerModel): void => {
      if (model.available) onSelect(model);
    },
    [onSelect],
  );

  useImperativeHandle(
    ref,
    () => ({
      visibleCount: () => visibleModels.length,
      selectVisibleAt: (index: number) => {
        const model = visibleModels[index];
        if (model) handleSelect(model);
      },
    }),
    [handleSelect, visibleModels],
  );

  useEffect(() => {
    searchInputRef.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    setHighlight((current) => clampHighlight(current, visibleModels.length));
  }, [visibleModels.length]);

  useEffect(() => {
    const node = listRef.current?.querySelector<HTMLElement>(`[data-row-index="${highlight}"]`);
    node?.scrollIntoView?.({ block: 'nearest' });
  }, [highlight]);

  const handleInputKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>): void => {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setHighlight((current) => nextHighlight(current, visibleModels.length));
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setHighlight((current) => prevHighlight(current, visibleModels.length));
        return;
      }
      if (event.key === 'Enter') {
        const model = visibleModels[highlight];
        if (model) {
          event.preventDefault();
          handleSelect(model);
        }
      }
    },
    [handleSelect, highlight, visibleModels],
  );

  const showSidebar = !isSearching && !lockProvider;
  const showProviderLine = isSearching || tab === 'favorites';

  return (
    <div
      className="flex h-[360px] w-[440px] max-w-[92vw] overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900 text-zinc-100 shadow-xl"
      data-model-picker-content="true"
    >
      {showSidebar && (
        <nav
          aria-label="Providers"
          className="flex w-[136px] shrink-0 flex-col gap-px overflow-y-auto border-r border-zinc-800 bg-zinc-950/60 p-1"
        >
          {favorites.size > 0 && (
            <SidebarButton active={tab === 'favorites'} onClick={() => setTab('favorites')}>
              <Star size={13} className="fill-amber-400 text-amber-400" />
              Favoritos
            </SidebarButton>
          )}
          {catalog.tabs.map((entry) => (
            <SidebarButton
              key={entry.key}
              active={tab === entry.key}
              onClick={() => setTab(entry.key)}
              title={entry.unavailableReason}
            >
              <ProviderIcon provider={entry.provider} className="h-[14px] w-[14px] shrink-0" />
              <span className="truncate">{entry.label}</span>
              {!entry.available && <span className="ml-auto text-[9px] text-amber-400">off</span>}
            </SidebarButton>
          ))}
        </nav>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="border-b border-zinc-800 px-2 pb-1 pt-2">
          <div className="flex items-center gap-1.5 rounded-md border border-transparent bg-zinc-800/70 px-2 py-[5px] transition-colors focus-within:border-amber-500/50">
            <Search size={14} className="shrink-0 text-zinc-500" />
            <input
              ref={searchInputRef}
              type="text"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setHighlight(0);
              }}
              onKeyDown={handleInputKeyDown}
              placeholder="Buscar modelos"
              aria-label="Buscar modelos"
              autoComplete="off"
              spellCheck={false}
              className="min-w-0 flex-1 bg-transparent text-[13px] text-zinc-100 placeholder:text-zinc-500 focus:outline-none"
            />
            <button
              type="button"
              onClick={onRefresh}
              disabled={phase === 'loading'}
              title="Atualizar status dos providers"
              aria-label="Atualizar status dos providers"
              className="grid h-[20px] w-[20px] place-items-center rounded-sm text-zinc-500 transition-colors hover:text-zinc-200 disabled:opacity-50"
            >
              <RefreshCw size={12} className={phase === 'loading' ? 'animate-spin' : ''} />
            </button>
          </div>
        </div>

        <div ref={listRef} role="listbox" aria-label="Modelos" className="min-h-0 flex-1 overflow-y-auto p-1">
          {phase === 'error' && error && (
            <p className="px-2 py-1 text-[11px] text-red-400" role="alert">
              {error}
            </p>
          )}
          {visibleModels.length === 0 ? (
            <p className="px-2 py-4 text-center text-[12px] text-zinc-500">
              {phase === 'loading' && entries.length === 0 ? 'Carregando providers...' : 'Nenhum modelo encontrado.'}
            </p>
          ) : (
            visibleModels.map((model, index) => (
              <ModelRow
                key={keyOf(model)}
                index={index}
                model={model}
                highlighted={index === highlight}
                selected={Boolean(selection && sameProvider(model, selection) && selection.model === model.modelId)}
                favorite={isFavorite(model.runtime, model.modelId)}
                shortcut={shortcutForIndex(index)}
                showProvider={showProviderLine}
                onSelect={() => handleSelect(model)}
                onHover={() => setHighlight(index)}
                onToggleFavorite={() => toggleFavorite(model.runtime, model.modelId)}
              />
            ))
          )}
        </div>

        {footer && (
          <div
            className="border-t border-zinc-800 px-3 py-1.5 text-[10px] text-zinc-500"
            data-testid="model-picker-footer"
          >
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}

export const ModelPickerContent = forwardRef<ModelPickerContentHandle, ModelPickerContentProps>(
  ModelPickerContentInner,
);

interface ModelRowProps {
  index: number;
  model: PickerModel;
  highlighted: boolean;
  selected: boolean;
  favorite: boolean;
  shortcut: number | null;
  showProvider: boolean;
  onSelect: () => void;
  onHover: () => void;
  onToggleFavorite: () => void;
}

function ModelRow({
  index,
  model,
  highlighted,
  selected,
  favorite,
  shortcut,
  showProvider,
  onSelect,
  onHover,
  onToggleFavorite,
}: ModelRowProps) {
  const disabled = !model.available;
  const context = formatContextWindowShort(model.contextWindow);
  return (
    <div
      data-row-index={index}
      data-model-id={model.modelId}
      role="option"
      aria-selected={selected}
      aria-disabled={disabled}
      title={model.unavailableReason}
      onClick={disabled ? undefined : onSelect}
      onMouseMove={onHover}
      className={`group flex items-center gap-2 rounded-md px-2 py-[7px] transition-colors ${
        disabled
          ? 'cursor-not-allowed opacity-50'
          : highlighted
            ? 'cursor-pointer bg-zinc-800'
            : 'cursor-pointer hover:bg-zinc-800'
      }`}
    >
      {!showProvider && <ProviderIcon provider={model.provider} className="h-[15px] w-[15px] shrink-0" />}
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-[13px] font-medium text-zinc-100">{model.modelLabel}</span>
          {context && <span className="shrink-0 text-[10px] text-zinc-500">{context}</span>}
          {selected && <Check size={13} className="shrink-0 text-amber-400" />}
        </div>
        {showProvider && (
          <div className="mt-px flex items-center gap-1">
            <ProviderIcon provider={model.provider} className="h-[11px] w-[11px] shrink-0" />
            <span className="truncate text-[11px] text-zinc-500">{model.providerLabel}</span>
            {disabled && <span className="text-[9px] text-amber-400">off</span>}
          </div>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {shortcut !== null && (
          <kbd className="rounded-[3px] border border-zinc-700 bg-zinc-950 px-1 py-px font-mono text-[10px] leading-none text-zinc-500">
            {shortcut}
          </kbd>
        )}
        <button
          type="button"
          aria-label={favorite ? 'Remover dos favoritos' : 'Adicionar aos favoritos'}
          aria-pressed={favorite}
          title={favorite ? 'Remover dos favoritos' : 'Adicionar aos favoritos'}
          disabled={disabled}
          onClick={(event) => {
            event.stopPropagation();
            onToggleFavorite();
          }}
          className={`grid h-[20px] w-[20px] place-items-center rounded-sm text-zinc-500 transition-colors hover:bg-zinc-950 hover:text-zinc-200 ${
            favorite ? 'opacity-100' : 'opacity-60 group-hover:opacity-100'
          }`}
        >
          <Star size={13} className={favorite ? 'fill-amber-400 text-amber-400' : ''} />
        </button>
      </div>
    </div>
  );
}

function SidebarButton({
  active,
  onClick,
  title,
  children,
}: {
  active: boolean;
  onClick: () => void;
  title?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-pressed={active}
      className={`flex items-center gap-1.5 rounded-md px-2 py-[6px] text-left text-[12px] font-medium transition-colors ${
        active ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-400 hover:bg-zinc-800/70 hover:text-zinc-100'
      }`}
    >
      {children}
    </button>
  );
}
