import { useState, useEffect, useRef, useCallback } from 'react';
import {
  Brain,
  Search,
  RefreshCw,
  Sparkles,
  User,
  Shield,
  Database,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';
import { MarkdownEditor } from '@/components/common/MarkdownEditor';
import type { DailySummary } from '@/types';


type TabId = 'soul' | 'user' | 'rules' | 'working' | 'semantic' | 'summaries';

interface TabConfig {
  id: TabId;
  label: string;
  icon: typeof Brain;
  description: string;
}


const TABS: TabConfig[] = [
  {
    id: 'soul',
    label: 'Soul',
    icon: Sparkles,
    description: 'Este e o prompt principal do agente. Edite livremente para customizar a personalidade, tom e comportamento do LionClaw.',
  },
  {
    id: 'user',
    label: 'User',
    icon: User,
    description: 'Informacoes sobre voce. Preferencias, perfil profissional, projetos ativos.',
  },
  {
    id: 'rules',
    label: 'Regras',
    icon: Shield,
    description: 'Regras de seguranca e comportamento que o agente sempre segue.',
  },
  {
    id: 'working',
    label: 'Memoria',
    icon: Database,
    description: 'Memoria de trabalho. Atualizada automaticamente pelo pipeline de compactacao.',
  },
  {
    id: 'semantic',
    label: 'Semantica',
    icon: Search,
    description: '',
  },
  {
    id: 'summaries',
    label: 'Resumos',
    icon: Brain,
    description: '',
  },
];

const EDITABLE_TABS: TabId[] = ['soul', 'user', 'rules', 'working'];

const SESSION_STORAGE_KEY = 'cerebro-active-tab';


export function MemoryPage() {
  const [tab, setTab] = useState<TabId>(() => {
    return (sessionStorage.getItem(SESSION_STORAGE_KEY) as TabId) || 'soul';
  });

  useEffect(() => {
    sessionStorage.setItem(SESSION_STORAGE_KEY, tab);
  }, [tab]);


  const [soulContent, setSoulContent] = useState('');
  const [userContent, setUserContent] = useState('');
  const [rulesContent, setRulesContent] = useState('');
  const [workingMemory, setWorkingMemory] = useState('');

  const savedSnapshots = useRef<Record<string, string>>({
    soul: '',
    user: '',
    rules: '',
    working: '',
  });

  const [savedFeedback, setSavedFeedback] = useState<TabId | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<Array<{ content: string; topic?: string }>>([]);
  const [summaries, setSummaries] = useState<DailySummary[]>([]);
  const [isCompacting, setIsCompacting] = useState(false);

  useEffect(() => {
    Promise.all([
      window.lionclaw.soul.get(),
      window.lionclaw.user.get(),
      window.lionclaw.rules.getGlobal(),
      window.lionclaw.memory.getWorkingMemory(),
    ]).then(([soul, user, rules, memory]) => {
      setSoulContent(soul);
      setUserContent(user);
      setRulesContent(rules);
      setWorkingMemory(memory);
      savedSnapshots.current = { soul, user, rules, working: memory };
      setIsLoading(false);
    });
  }, []);

  const getContent = useCallback((tabId: TabId): string => {
    switch (tabId) {
      case 'soul':    return soulContent;
      case 'user':    return userContent;
      case 'rules':   return rulesContent;
      case 'working': return workingMemory;
      default:        return '';
    }
  }, [soulContent, userContent, rulesContent, workingMemory]);

  const isDirty = useCallback((tabId: TabId): boolean => {
    if (!EDITABLE_TABS.includes(tabId)) return false;
    return getContent(tabId) !== savedSnapshots.current[tabId];
  }, [getContent]);

  const showSavedFeedback = (tabId: TabId) => {
    setSavedFeedback(tabId);
    setTimeout(() => setSavedFeedback(null), 2000);
  };

  const handleSave = async (tabId: TabId) => {
    const content = getContent(tabId);
    switch (tabId) {
      case 'soul':    await window.lionclaw.soul.update(content);               break;
      case 'user':    await window.lionclaw.user.update(content);               break;
      case 'rules':   await window.lionclaw.rules.updateGlobal(content);        break;
      case 'working': await window.lionclaw.memory.updateWorkingMemory(content); break;
    }
    savedSnapshots.current[tabId] = content;
    showSavedFeedback(tabId);
  };

  const handleSearch = async () => {
    if (!searchQuery.trim()) return;
    const results = await window.lionclaw.memory.searchSemantic(searchQuery, 20);
    setSearchResults(results);
  };

  const handleLoadSummaries = async () => {
    const result = await window.lionclaw.memory.getDailySummaries();
    setSummaries(result);
  };

  const handleCompact = async () => {
    setIsCompacting(true);
    try {
      await window.lionclaw.memory.triggerCompaction();
    } finally {
      setIsCompacting(false);
    }
  };

  const setters: Record<string, (v: string) => void> = {
    soul:    setSoulContent,
    user:    setUserContent,
    rules:   setRulesContent,
    working: setWorkingMemory,
  };


  const tabsRef = useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  const checkScroll = useCallback(() => {
    const el = tabsRef.current;
    if (!el) return;
    setCanScrollLeft(el.scrollLeft > 2);
    setCanScrollRight(el.scrollLeft < el.scrollWidth - el.clientWidth - 2);
  }, []);

  useEffect(() => {
    const el = tabsRef.current;
    if (!el) return;
    checkScroll();
    el.addEventListener('scroll', checkScroll);
    window.addEventListener('resize', checkScroll);
    return () => {
      el.removeEventListener('scroll', checkScroll);
      window.removeEventListener('resize', checkScroll);
    };
  }, [checkScroll]);

  useEffect(() => {
    setTimeout(checkScroll, 50);
  }, [checkScroll]);

  const scrollTabsLeft = () => {
    tabsRef.current?.scrollBy({ left: -200, behavior: 'smooth' });
  };

  const scrollTabsRight = () => {
    tabsRef.current?.scrollBy({ left: 200, behavior: 'smooth' });
  };


  const visibleTabs = TABS;


  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="w-6 h-6 border-2 border-amber-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  const currentTabConfig = visibleTabs.find((t) => t.id === tab);


  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-zinc-800">
        <Brain size={18} className="text-amber-500" />
        <h1 className="text-sm font-semibold text-zinc-200">Cerebro</h1>
        <div className="flex-1" />
        <button
          onClick={handleCompact}
          disabled={isCompacting}
          className="flex items-center gap-1.5 px-3 py-1.5 border border-zinc-700 text-zinc-300 hover:bg-zinc-800 rounded-lg text-xs transition-colors disabled:opacity-50"
        >
          <RefreshCw size={12} className={isCompacting ? 'animate-spin' : ''} />
          Compactar
        </button>
      </div>

      {/* Scrollable Tab Bar */}
      <div className="flex items-center border-b border-zinc-800 bg-zinc-900/50">
        {/* Left arrow */}
        <button
          onClick={scrollTabsLeft}
          disabled={!canScrollLeft}
          className="shrink-0 px-1 py-2 text-zinc-500 hover:text-zinc-300 disabled:opacity-0 disabled:pointer-events-none transition-opacity"
          aria-label="Scroll tabs para esquerda"
        >
          <ChevronLeft size={14} />
        </button>

        {/* Tabs container */}
        <div
          ref={tabsRef}
          className="flex-1 flex items-center gap-0.5 overflow-x-auto scrollbar-hide p-1"
          style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}
        >
          {visibleTabs.map((cfg) => {
            const { id, label, icon: Icon } = cfg;
            const dirty = isDirty(id);
            const isActive = tab === id;
            const isSoul = id === 'soul';

            return (
              <div key={id} className="flex items-center shrink-0">
                <button
                  onClick={() => {
                    setTab(id);
                    if (id === 'summaries') handleLoadSummaries();
                  }}
                  className={`flex items-center gap-1 px-2.5 py-1 rounded-md text-xs transition-colors whitespace-nowrap ${
                    isActive
                      ? isSoul
                        ? 'bg-amber-600/20 text-amber-400 border border-amber-600/30'
                        : 'bg-zinc-800 text-zinc-200'
                      : isSoul
                        ? 'text-amber-500/60 hover:text-amber-400'
                        : 'text-zinc-500 hover:text-zinc-300'
                  }`}
                >
                  <Icon size={12} />
                  {label}
                  {dirty && (
                    <span className="w-1.5 h-1.5 rounded-full bg-amber-500 ml-0.5" />
                  )}
                </button>
              </div>
            );
          })}
        </div>

        {/* Right arrow */}
        <button
          onClick={scrollTabsRight}
          disabled={!canScrollRight}
          className="shrink-0 px-1 py-2 text-zinc-500 hover:text-zinc-300 disabled:opacity-0 disabled:pointer-events-none transition-opacity"
          aria-label="Scroll tabs para direita"
        >
          <ChevronRight size={14} />
        </button>
      </div>

      {/* ── Content ── */}

      {/* Editable tabs: Soul, User, Rules, Working Memory */}
      {EDITABLE_TABS.includes(tab) && currentTabConfig && (
        <MarkdownEditor
          value={getContent(tab)}
          onChange={setters[tab]}
          onSave={() => handleSave(tab)}
          saving={savedFeedback === tab}
          description={currentTabConfig.description}
        />
      )}

      {/* Semantic Search */}
      {tab === 'semantic' && (
        <div className="flex flex-col flex-1 min-h-0 p-4">
          <div className="flex gap-2 mb-4">
            <div className="relative flex-1">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                placeholder="Buscar na memoria semantica..."
                className="w-full bg-zinc-900 border border-zinc-800 rounded-lg pl-9 pr-3 py-2 text-sm text-zinc-100 outline-none focus:border-amber-500/50"
              />
            </div>
            <button onClick={handleSearch} className="px-4 py-2 bg-amber-600 hover:bg-amber-500 text-white rounded-lg text-sm">
              Buscar
            </button>
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto space-y-2">
            {searchResults.length === 0 ? (
              <p className="text-sm text-zinc-600 text-center py-8">
                {searchQuery ? 'Nenhum resultado encontrado' : 'Faca uma busca para ver memorias'}
              </p>
            ) : (
              searchResults.map((r, i) => (
                <div key={i} className="bg-zinc-900 border border-zinc-800 rounded-lg p-3">
                  {r.topic && <span className="text-[10px] text-amber-500 font-medium uppercase">{r.topic}</span>}
                  <p className="text-sm text-zinc-300 mt-1 selectable">{r.content}</p>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {/* Summaries */}
      {tab === 'summaries' && (
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {summaries.length === 0 ? (
            <p className="text-sm text-zinc-600 text-center py-8">Nenhum resumo diario gerado</p>
          ) : (
            summaries.map((s) => (
              <div key={s.id} className="bg-zinc-900 border border-zinc-800 rounded-lg p-4">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm font-medium text-zinc-200">{s.date}</span>
                  <span className="text-[10px] text-zinc-500">{s.messageCount} mensagens</span>
                </div>
                <p className="text-sm text-zinc-400 selectable">{s.summary}</p>
                {s.decisions.length > 0 && (
                  <div className="mt-2">
                    <span className="text-[10px] text-amber-500 font-medium">DECISOES:</span>
                    <ul className="text-xs text-zinc-500 mt-1 space-y-0.5">
                      {s.decisions.map((d, i) => <li key={i}>- {d}</li>)}
                    </ul>
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      )}

    </div>
  );
}
