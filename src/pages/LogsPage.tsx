import { useState, useEffect, useRef } from 'react';
import {
  RefreshCw,
  Search,
  Terminal,
  Download,
  ChevronRight,
  ChevronDown,
  FolderOpen,
  Pause,
  Play,
  Copy,
  Check,
} from 'lucide-react';
import type { AuditEntry, AuditSource, SystemLogEntry } from '@/types';

type LogsTab = 'audit' | 'system';

const SYSTEM_LEVELS = [
  { value: 0, label: 'Todos' },
  { value: 20, label: 'Debug+' },
  { value: 30, label: 'Info+' },
  { value: 40, label: 'Warn+' },
  { value: 50, label: 'Error' },
] as const;

const AUDIT_SOURCES: { value: '' | AuditSource; label: string }[] = [
  { value: '', label: 'Todas as origens' },
  { value: 'chat', label: 'Chat' },
  { value: 'pipeline', label: 'Pipeline' },
  { value: 'harness', label: 'Harness' },
  { value: 'enrich', label: 'Enrich' },
  { value: 'workflow', label: 'Workflow' },
];

const SOURCE_COLORS: Record<AuditSource, string> = {
  chat: 'text-zinc-500',
  pipeline: 'text-amber-200/70',
  harness: 'text-violet-300/70',
  enrich: 'text-emerald-300/70',
  workflow: 'text-sky-300/70',
};

function CopyButton({ getText, label }: { getText: () => string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        navigator.clipboard.writeText(getText());
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded hover:bg-zinc-800 text-zinc-500 hover:text-zinc-300 transition-colors text-[10px]"
      title="Copiar"
    >
      {copied ? <Check size={10} className="text-emerald-300/80" /> : <Copy size={10} />}
      {label && <span>{copied ? 'Copiado' : label}</span>}
    </button>
  );
}

export function LogsPage() {
  const [tab, setTab] = useState<LogsTab>('audit');
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [search, setSearch] = useState('');
  const [sourceFilter, setSourceFilter] = useState<'' | AuditSource>('');
  const [isLoading, setIsLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const liveIdRef = useRef(-1);
  const auditFiltersRef = useRef<{ source: '' | AuditSource }>({ source: sourceFilter });
  auditFiltersRef.current = { source: sourceFilter };

  const [sysEntries, setSysEntries] = useState<SystemLogEntry[]>([]);
  const [sysModules, setSysModules] = useState<string[]>([]);
  const [logFilePath, setLogFilePath] = useState('');
  const [sysSearch, setSysSearch] = useState('');
  const [sysMinLevel, setSysMinLevel] = useState(30);
  const [sysModule, setSysModule] = useState('');
  const [sysPaused, setSysPaused] = useState(false);
  const [sysExpandedSeq, setSysExpandedSeq] = useState<number | null>(null);
  const sysFiltersRef = useRef({ minLevel: sysMinLevel, module: sysModule, search: sysSearch, paused: sysPaused });
  sysFiltersRef.current = { minLevel: sysMinLevel, module: sysModule, search: sysSearch, paused: sysPaused };

  const loadLogs = async () => {
    setIsLoading(true);
    const result = await window.lionclaw.logs.query({
      search: search || undefined,
      source: sourceFilter || undefined,
      limit: 200,
    });
    setEntries(result);
    setIsLoading(false);
  };

  const loadSystemLogs = async () => {
    setIsLoading(true);
    const result = await window.lionclaw.logs.querySystem({
      search: sysSearch || undefined,
      minLevel: sysMinLevel || undefined,
      module: sysModule || undefined,
      limit: 500,
    });
    setSysEntries(result.entries);
    setSysModules(result.modules);
    setLogFilePath(result.logFilePath);
    setIsLoading(false);
  };

  useEffect(() => {
    loadLogs();
    const unsub = window.lionclaw.logs.stream((entry) => {
      const f = auditFiltersRef.current;
      if (f.source && entry.source !== f.source) return;
      liveIdRef.current -= 1;
      const liveEntry = entry.id > 0 ? entry : { ...entry, id: liveIdRef.current };
      setEntries((prev) => [liveEntry, ...prev].slice(0, 500));
    });
    return unsub;
  }, []);

  useEffect(() => {
    if (tab === 'audit') loadLogs();
  }, [sourceFilter]);

  useEffect(() => {
    if (tab !== 'system') return;
    loadSystemLogs();
    const unsub = window.lionclaw.logs.streamSystem((entry) => {
      const f = sysFiltersRef.current;
      if (f.paused) return;
      if (f.minLevel && entry.level < f.minLevel) return;
      if (f.module && entry.module !== f.module) return;
      if (f.search) {
        const haystack = `${entry.module ?? ''} ${entry.msg ?? ''} ${entry.extra ?? ''}`.toLowerCase();
        if (!haystack.includes(f.search.toLowerCase())) return;
      }
      setSysEntries((prev) => [entry, ...prev].slice(0, 1000));
    });
    return unsub;
  }, [tab]);

  useEffect(() => {
    if (tab === 'system') loadSystemLogs();
  }, [sysMinLevel, sysModule]);

  const handleExport = async (format: 'csv' | 'json') => {
    const filters = { search: search || undefined, source: sourceFilter || undefined, limit: 10000, offset: 0 };
    const data =
      format === 'csv' ? await window.lionclaw.logs.exportCSV(filters) : await window.lionclaw.logs.exportJSON(filters);
    const blob = new Blob([data], { type: format === 'csv' ? 'text/csv' : 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `lionclaw-logs-${new Date().toISOString().split('T')[0]}.${format}`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const getEventColor = (type: string) => {
    switch (type) {
      case 'tool_call':
        return 'text-sky-300/80';
      case 'tool_result':
        return 'text-emerald-300/80';
      case 'tool_blocked':
        return 'text-rose-300/80';
      case 'error':
        return 'text-rose-300/90';
      case 'confirm_request':
        return 'text-amber-200/80';
      case 'confirm_response':
        return 'text-violet-300/80';
      default:
        return 'text-zinc-400';
    }
  };

  const getEventBg = (type: string) => {
    switch (type) {
      case 'error':
        return 'bg-rose-500/[0.04] border-l-2 border-rose-400/20';
      case 'confirm_request':
        return 'bg-amber-400/[0.04] border-l-2 border-amber-300/20';
      default:
        return '';
    }
  };

  const getLevelColor = (level: number) => {
    if (level >= 50) return 'text-rose-300/90';
    if (level >= 40) return 'text-amber-200/80';
    if (level >= 30) return 'text-sky-300/70';
    return 'text-zinc-500';
  };

  const getLevelBg = (level: number) => {
    if (level >= 50) return 'bg-rose-500/[0.04] border-l-2 border-rose-400/20';
    if (level >= 40) return 'bg-amber-400/[0.04] border-l-2 border-amber-300/20';
    return '';
  };

  const getSummaryText = (entry: AuditEntry): string => {
    if (entry.eventType === 'error') {
      return entry.output || entry.input || 'Erro sem detalhes';
    }
    const parts: string[] = [];
    if (entry.input) parts.push(entry.input.substring(0, 120));
    if (entry.output && !entry.input) parts.push(entry.output.substring(0, 120));
    return parts.join(' ');
  };

  const hasDetails = (entry: AuditEntry): boolean => {
    return !!(entry.input || entry.output || entry.sessionId);
  };

  const auditEntryAsText = (entry: AuditEntry): string => {
    const lines = [
      `[${entry.createdAt}] [${entry.eventType}]${entry.source ? ` [${entry.source}]` : ''}${entry.toolName ? ` ${entry.toolName}` : ''}`,
    ];
    if (entry.subagent) lines.push(`agente: ${entry.subagent}`);
    if (entry.sessionId) lines.push(`session: ${entry.sessionId}`);
    if (entry.input) lines.push(`input: ${entry.input}`);
    if (entry.output) lines.push(`output: ${entry.output}`);
    if (entry.durationMs !== undefined && entry.durationMs !== null) lines.push(`duracao: ${entry.durationMs}ms`);
    return lines.join('\n');
  };

  const systemEntryAsText = (entry: SystemLogEntry): string => {
    const head = `[${new Date(entry.time).toISOString()}] [${entry.levelLabel}]${entry.module ? ` [${entry.module}]` : ''} ${entry.msg ?? ''}`;
    return entry.extra ? `${head}\n${formatExtra(entry.extra)}` : head;
  };

  const formatExtra = (extra: string): string => {
    try {
      return JSON.stringify(JSON.parse(extra), null, 2);
    } catch {
      return extra;
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-zinc-800">
        <Terminal size={18} className="text-amber-500" />
        <h1 className="text-sm font-semibold text-zinc-200">Logs</h1>
        <div className="flex items-center gap-1 ml-2">
          <button
            onClick={() => setTab('audit')}
            className={`px-2.5 py-1 rounded-lg text-xs transition-colors ${tab === 'audit' ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'}`}
          >
            Audit
          </button>
          <button
            onClick={() => setTab('system')}
            className={`px-2.5 py-1 rounded-lg text-xs transition-colors ${tab === 'system' ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'}`}
          >
            Sistema
          </button>
        </div>
        <div className="flex-1" />
        {tab === 'audit' ? (
          <div className="flex items-center gap-2">
            <select
              value={sourceFilter}
              onChange={(e) => setSourceFilter(e.target.value as '' | AuditSource)}
              className="bg-zinc-900 border border-zinc-800 rounded-lg px-2 py-1.5 text-xs text-zinc-100 outline-none focus:border-amber-500/50"
            >
              {AUDIT_SOURCES.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
            <div className="relative">
              <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-500" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && loadLogs()}
                placeholder="Buscar..."
                className="bg-zinc-900 border border-zinc-800 rounded-lg pl-8 pr-3 py-1.5 text-xs text-zinc-100 outline-none focus:border-amber-500/50 w-44"
              />
            </div>
            <button
              onClick={() => handleExport('csv')}
              className="flex items-center gap-1 px-2 py-1.5 rounded-lg hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 transition-colors text-xs"
              title="Exportar CSV"
            >
              <Download size={12} />
              CSV
            </button>
            <button
              onClick={() => handleExport('json')}
              className="flex items-center gap-1 px-2 py-1.5 rounded-lg hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 transition-colors text-xs"
              title="Exportar JSON"
            >
              <Download size={12} />
              JSON
            </button>
            <button
              onClick={loadLogs}
              className="p-1.5 rounded-lg hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 transition-colors"
            >
              <RefreshCw size={14} className={isLoading ? 'animate-spin' : ''} />
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <select
              value={sysMinLevel}
              onChange={(e) => setSysMinLevel(Number(e.target.value))}
              className="bg-zinc-900 border border-zinc-800 rounded-lg px-2 py-1.5 text-xs text-zinc-100 outline-none focus:border-amber-500/50"
            >
              {SYSTEM_LEVELS.map((l) => (
                <option key={l.value} value={l.value}>
                  {l.label}
                </option>
              ))}
            </select>
            <select
              value={sysModule}
              onChange={(e) => setSysModule(e.target.value)}
              className="bg-zinc-900 border border-zinc-800 rounded-lg px-2 py-1.5 text-xs text-zinc-100 outline-none focus:border-amber-500/50 max-w-40"
            >
              <option value="">Todos os modulos</option>
              {sysModules.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
            <div className="relative">
              <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-500" />
              <input
                type="text"
                value={sysSearch}
                onChange={(e) => setSysSearch(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && loadSystemLogs()}
                placeholder="Buscar..."
                className="bg-zinc-900 border border-zinc-800 rounded-lg pl-8 pr-3 py-1.5 text-xs text-zinc-100 outline-none focus:border-amber-500/50 w-40"
              />
            </div>
            <button
              onClick={() => setSysPaused((p) => !p)}
              className={`flex items-center gap-1 px-2 py-1.5 rounded-lg hover:bg-zinc-800 transition-colors text-xs ${sysPaused ? 'text-amber-200/90' : 'text-zinc-400 hover:text-zinc-200'}`}
              title={sysPaused ? 'Retomar stream ao vivo' : 'Pausar stream ao vivo'}
            >
              {sysPaused ? <Play size={12} /> : <Pause size={12} />}
              {sysPaused ? 'Pausado' : 'Ao vivo'}
            </button>
            {logFilePath && (
              <button
                onClick={() => window.lionclaw.shell.showInFolder(logFilePath)}
                className="flex items-center gap-1 px-2 py-1.5 rounded-lg hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 transition-colors text-xs"
                title={logFilePath}
              >
                <FolderOpen size={12} />
                Arquivo
              </button>
            )}
            <button
              onClick={loadSystemLogs}
              className="p-1.5 rounded-lg hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 transition-colors"
            >
              <RefreshCw size={14} className={isLoading ? 'animate-spin' : ''} />
            </button>
          </div>
        )}
      </div>

      {/* Log entries — `selectable` reativa a selecao de texto (o body e user-select: none) */}
      <div className="flex-1 overflow-y-auto font-mono text-xs p-3 space-y-0.5 bg-zinc-950 selectable">
        {tab === 'audit' ? (
          <>
            {entries.map((entry) => (
              <div key={entry.id} className={`group rounded ${getEventBg(entry.eventType)}`}>
                {/* Main row */}
                <div
                  className={`flex items-center gap-2 py-0.5 px-2 rounded ${hasDetails(entry) ? 'cursor-pointer hover:bg-zinc-900/50' : ''}`}
                  onClick={() => hasDetails(entry) && setExpandedId(expandedId === entry.id ? null : entry.id)}
                >
                  {hasDetails(entry) ? (
                    expandedId === entry.id ? (
                      <ChevronDown size={10} className="text-zinc-600 shrink-0" />
                    ) : (
                      <ChevronRight size={10} className="text-zinc-600 shrink-0" />
                    )
                  ) : (
                    <span className="w-[10px] shrink-0" />
                  )}
                  <span className="text-zinc-600 shrink-0">
                    {new Date(entry.createdAt).toLocaleTimeString('pt-BR')}
                  </span>
                  <span className={`shrink-0 w-28 ${getEventColor(entry.eventType)}`}>[{entry.eventType}]</span>
                  {entry.source && entry.source !== 'chat' && (
                    <span className={`shrink-0 ${SOURCE_COLORS[entry.source] ?? 'text-zinc-500'}`}>{entry.source}</span>
                  )}
                  {entry.toolName && <span className="text-cyan-300/70 shrink-0">{entry.toolName}</span>}
                  <span className="text-zinc-500 truncate min-w-0">{getSummaryText(entry)}</span>
                  {entry.approved !== undefined && (
                    <span className={`shrink-0 ${entry.approved ? 'text-emerald-300/80' : 'text-rose-300/80'}`}>
                      {entry.approved ? 'APPROVED' : 'DENIED'}
                    </span>
                  )}
                  <span className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                    <CopyButton getText={() => auditEntryAsText(entry)} />
                  </span>
                </div>

                {/* Expanded details */}
                {expandedId === entry.id && (
                  <div className="ml-8 px-3 py-2 mb-1 bg-zinc-900/60 rounded border border-zinc-800/50 space-y-1.5">
                    <div className="flex items-center gap-2">
                      {entry.source && (
                        <div>
                          <span className="text-zinc-600">origem: </span>
                          <span className={SOURCE_COLORS[entry.source] ?? 'text-zinc-400'}>{entry.source}</span>
                        </div>
                      )}
                      <div className="flex-1" />
                      <CopyButton getText={() => auditEntryAsText(entry)} label="Copiar tudo" />
                    </div>
                    {entry.sessionId && (
                      <div>
                        <span className="text-zinc-600">session: </span>
                        <span className="text-zinc-400">{entry.sessionId}</span>
                      </div>
                    )}
                    {entry.subagent && (
                      <div>
                        <span className="text-zinc-600">agente: </span>
                        <span className="text-amber-200/80">{entry.subagent}</span>
                      </div>
                    )}
                    {entry.input && (
                      <div>
                        <span className="text-zinc-600">input: </span>
                        <CopyButton getText={() => entry.input ?? ''} label="Copiar" />
                        <pre className="text-zinc-300 whitespace-pre-wrap break-all mt-0.5 max-h-40 overflow-y-auto">
                          {entry.input}
                        </pre>
                      </div>
                    )}
                    {entry.output && (
                      <div>
                        <span className="text-zinc-600">output: </span>
                        <CopyButton getText={() => entry.output ?? ''} label="Copiar" />
                        <pre className="text-zinc-300 whitespace-pre-wrap break-all mt-0.5 max-h-40 overflow-y-auto">
                          {entry.output}
                        </pre>
                      </div>
                    )}
                    {entry.durationMs !== undefined && entry.durationMs !== null && (
                      <div>
                        <span className="text-zinc-600">duracao: </span>
                        <span className="text-zinc-400">{entry.durationMs}ms</span>
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
            {entries.length === 0 && !isLoading && (
              <div className="text-center text-zinc-600 py-8">Nenhum log encontrado</div>
            )}
          </>
        ) : (
          <>
            {sysEntries.map((entry) => (
              <div key={entry.seq} className={`group rounded ${getLevelBg(entry.level)}`}>
                <div
                  className={`flex items-center gap-2 py-0.5 px-2 rounded ${entry.extra ? 'cursor-pointer hover:bg-zinc-900/50' : ''}`}
                  onClick={() => entry.extra && setSysExpandedSeq(sysExpandedSeq === entry.seq ? null : entry.seq)}
                >
                  {entry.extra ? (
                    sysExpandedSeq === entry.seq ? (
                      <ChevronDown size={10} className="text-zinc-600 shrink-0" />
                    ) : (
                      <ChevronRight size={10} className="text-zinc-600 shrink-0" />
                    )
                  ) : (
                    <span className="w-[10px] shrink-0" />
                  )}
                  <span className="text-zinc-600 shrink-0">{new Date(entry.time).toLocaleTimeString('pt-BR')}</span>
                  <span className={`shrink-0 w-14 uppercase ${getLevelColor(entry.level)}`}>{entry.levelLabel}</span>
                  {entry.module && <span className="text-cyan-300/70 shrink-0">{entry.module}</span>}
                  <span className="text-zinc-400 truncate min-w-0">{entry.msg}</span>
                  <span className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                    <CopyButton getText={() => systemEntryAsText(entry)} />
                  </span>
                </div>
                {sysExpandedSeq === entry.seq && entry.extra && (
                  <div className="ml-8 px-3 py-2 mb-1 bg-zinc-900/60 rounded border border-zinc-800/50">
                    <div className="flex justify-end">
                      <CopyButton getText={() => systemEntryAsText(entry)} label="Copiar tudo" />
                    </div>
                    <pre className="text-zinc-300 whitespace-pre-wrap break-all max-h-60 overflow-y-auto">
                      {formatExtra(entry.extra)}
                    </pre>
                  </div>
                )}
              </div>
            ))}
            {sysEntries.length === 0 && !isLoading && (
              <div className="text-center text-zinc-600 py-8">
                Nenhum log de sistema nesta sessao com os filtros atuais
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
