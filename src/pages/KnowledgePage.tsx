import { useState, useEffect, useRef, useCallback } from 'react';
import {
  BookOpen,
  Upload,
  Search,
  FlaskConical,
  Settings,
  Trash2,
  RefreshCw,
  FileText,
  AlertCircle,
  CheckCircle,
  Loader2,
  ChevronDown,
  Trophy,
  Info,
  Network,
  Users,
  FolderKanban,
  Scale,
  CalendarCheck,
  BookMarked,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useKnowledgeStore } from '@/stores/knowledge-store';
import type { AgentConfig, ChunkStrategy, KnowledgeSource, BenchmarkResult } from '@/types';
import { GraphPage } from '@/pages/GraphPage';
import { NoteListView } from '@/components/graph-view/NoteListView';
import { UploadTab } from '@/components/graph-view/UploadTab';


function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

type PrimaryTabId = 'documentos' | 'upload' | 'busca' | 'benchmark' | 'configuracoes' | 'graph';
type GraphSubTabId = 'graph-view' | 'entities' | 'projects' | 'decisions' | 'meetings' | 'references' | 'graph-upload';

const PRIMARY_TAB_CONFIG: Array<{ id: PrimaryTabId; label: string; icon: typeof BookOpen }> = [
  { id: 'documentos',    label: 'Documentos',    icon: FileText },
  { id: 'upload',        label: 'Upload',        icon: Upload },
  { id: 'busca',         label: 'Busca',         icon: Search },
  { id: 'benchmark',     label: 'Benchmark',     icon: FlaskConical },
  { id: 'configuracoes', label: 'Configuracoes', icon: Settings },
  { id: 'graph',         label: 'Graph',         icon: Network },
];

const GRAPH_SUB_TAB_CONFIG: Array<{ id: GraphSubTabId; label: string; icon: typeof BookOpen }> = [
  { id: 'graph-view',    label: 'Grafo',         icon: Network },
  { id: 'entities',      label: 'Entidades',     icon: Users },
  { id: 'projects',      label: 'Projetos',      icon: FolderKanban },
  { id: 'decisions',     label: 'Decisoes',      icon: Scale },
  { id: 'meetings',      label: 'Reunioes',      icon: CalendarCheck },
  { id: 'references',    label: 'Referencias',   icon: BookMarked },
  { id: 'graph-upload',  label: 'Upload',        icon: Upload },
];

function useMgraphMode() {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    window.lionclaw.settings.get().then(s => setEnabled(!!s.mgraphMode)).catch(() => {});
  }, []);
  return enabled;
}


function StatusBadge({ status }: { status: KnowledgeSource['status'] }) {
  const map: Record<KnowledgeSource['status'], { label: string; className: string }> = {
    pending: { label: 'Pendente', className: 'bg-zinc-700 text-zinc-400' },
    processing: { label: 'Processando', className: 'bg-amber-500/20 text-amber-400' },
    completed: { label: 'Concluido', className: 'bg-green-500/20 text-green-400' },
    failed: { label: 'Erro', className: 'bg-red-500/20 text-red-400' },
  };
  const { label, className } = map[status];
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium ${className}`}>
      {label}
    </span>
  );
}


function FileTypeBadge({ type }: { type: string }) {
  const colors: Record<string, string> = {
    pdf: 'bg-red-500/20 text-red-400',
    docx: 'bg-blue-500/20 text-blue-400',
    txt: 'bg-zinc-700 text-zinc-400',
    md: 'bg-purple-500/20 text-purple-400',
    csv: 'bg-green-500/20 text-green-400',
  };
  const cls = colors[type.toLowerCase()] ?? 'bg-zinc-700 text-zinc-400';
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium uppercase ${cls}`}>
      {type}
    </span>
  );
}


function AgentSelector({
  agents,
  value,
  onChange,
  showAll = false,
}: {
  agents: AgentConfig[];
  value: string | null;
  onChange: (id: string) => void;
  showAll?: boolean;
}) {
  return (
    <div className="relative">
      <select
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value)}
        className="appearance-none bg-zinc-800 border border-zinc-700 text-zinc-100 rounded-lg px-3 py-1.5 pr-8 text-sm outline-none focus:border-amber-500/50 cursor-pointer"
      >
        {showAll ? (
          <option value="">Todos os agentes</option>
        ) : (
          <option value="" disabled>
            Selecionar agente
          </option>
        )}
        {agents.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name}
          </option>
        ))}
      </select>
      <ChevronDown size={14} className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-500 pointer-events-none" />
    </div>
  );
}


const STRATEGY_BY_TYPE: Record<string, ChunkStrategy[]> = {
  pdf: ['recursive', 'semantic', 'page', 'agentic'],
  docx: ['recursive', 'semantic', 'agentic'],
  txt: ['recursive', 'semantic', 'agentic'],
  md: ['recursive', 'semantic', 'agentic'],
  csv: ['csv', 'recursive'],
};

const STRATEGY_LABELS: Record<ChunkStrategy, string> = {
  recursive: 'Recursivo',
  semantic: 'Semantico',
  page: 'Por Pagina',
  csv: 'CSV',
  agentic: 'Agentico',
};


function scoreColor(score: number): string {
  if (score >= 0.8) return 'text-green-400';
  if (score >= 0.6) return 'text-amber-400';
  return 'text-red-400';
}

function scoreBg(score: number): string {
  if (score >= 0.8) return 'bg-green-500/20';
  if (score >= 0.6) return 'bg-amber-500/20';
  return 'bg-red-500/20';
}


function TabDocumentos({
  agents,
  selectedAgentId,
  onSelectAgent,
}: {
  agents: AgentConfig[];
  selectedAgentId: string | null;
  onSelectAgent: (id: string) => void;
}) {
  const { sources, isLoading, loadSources, loadAllSources, deleteSource, reprocessSource } = useKnowledgeStore();
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [reprocessId, setReprocessId] = useState<string | null>(null);
  const [filterAgentId, setFilterAgentId] = useState<string | null>(selectedAgentId);

  useEffect(() => {
    if (filterAgentId) {
      loadSources(filterAgentId);
    } else if (agents.length > 0) {
      loadAllSources(agents.map((a) => a.id));
    }
  }, [filterAgentId, agents, loadSources, loadAllSources]);

  const handleFilterChange = useCallback(
    (id: string) => {
      if (id === '') {
        setFilterAgentId(null);
      } else {
        setFilterAgentId(id);
        onSelectAgent(id);
      }
    },
    [onSelectAgent],
  );

  const handleReload = useCallback(() => {
    if (filterAgentId) {
      loadSources(filterAgentId);
    } else if (agents.length > 0) {
      loadAllSources(agents.map((a) => a.id));
    }
  }, [filterAgentId, agents, loadSources, loadAllSources]);

  const handleDelete = useCallback(
    async (sourceId: string) => {
      setDeletingId(sourceId);
      try {
        await deleteSource(sourceId);
      } finally {
        setDeletingId(null);
        setConfirmDeleteId(null);
      }
    },
    [deleteSource],
  );

  const handleReprocess = useCallback(
    async (source: KnowledgeSource) => {
      setReprocessId(source.id);
      try {
        await reprocessSource(
          source.id,
          source.chunkStrategy as ChunkStrategy,
          source.chunkSize,
          source.chunkOverlap,
        );
      } finally {
        setReprocessId(null);
      }
    },
    [reprocessSource],
  );

  const agentNames = agents.reduce<Record<string, string>>((acc, a) => {
    acc[a.id] = a.name;
    return acc;
  }, {});

  return (
    <div className="flex flex-col flex-1 overflow-hidden">
      <div className="flex items-center gap-3 px-4 py-3 border-b border-zinc-800">
        <AgentSelector agents={agents} value={filterAgentId} onChange={handleFilterChange} showAll />
        <button
          onClick={handleReload}
          className="p-1.5 rounded-lg hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 transition-colors"
          title="Recarregar"
        >
          <RefreshCw size={14} className={isLoading ? 'animate-spin' : ''} />
        </button>
        <span className="text-xs text-zinc-500">{sources.length} documento(s)</span>
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        {isLoading ? (
          <div className="flex items-center justify-center h-48">
            <Loader2 size={24} className="animate-spin text-amber-500" />
          </div>
        ) : sources.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-48 text-zinc-600">
            <FileText size={32} className="mb-2 opacity-40" />
            <p className="text-sm">Nenhum documento indexado</p>
            <p className="text-xs mt-1">Use a aba Upload para adicionar documentos</p>
          </div>
        ) : (
          <div className="space-y-2">
            {sources.map((source) => (
              <div
                key={source.id}
                className="bg-zinc-900 border border-zinc-800 rounded-xl p-4"
              >
                <div className="flex items-start gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium text-zinc-200 truncate">
                        {source.title || source.fileName}
                      </span>
                      <FileTypeBadge type={source.fileType} />
                      <StatusBadge status={source.status} />
                      {!filterAgentId && agentNames[source.agentId] && (
                        <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-zinc-700 text-zinc-400">
                          {agentNames[source.agentId]}
                        </span>
                      )}
                    </div>
                    {source.title && (
                      <p className="text-xs text-zinc-500 mt-0.5 truncate">{source.fileName}</p>
                    )}
                    <div className="flex items-center gap-4 mt-2 flex-wrap">
                      <span className="text-[10px] text-zinc-500">
                        {formatBytes(source.fileSize)}
                      </span>
                      <span className="text-[10px] text-zinc-500">
                        {source.chunksCount} chunks
                      </span>
                      <span className="text-[10px] text-zinc-500">
                        Estrategia: {source.chunkStrategy}
                      </span>
                      {source.qualityScore != null && source.qualityScore > 0 && (
                        <span className={`text-[10px] font-medium ${scoreColor(source.qualityScore)}`}>
                          Score: {(source.qualityScore * 100).toFixed(0)}%
                        </span>
                      )}
                      {source.bestStrategy && (
                        <span className="text-[10px] text-amber-400">
                          Melhor: {source.bestStrategy}
                        </span>
                      )}
                      <span className="text-[10px] text-zinc-600">
                        {formatDate(source.createdAt)}
                      </span>
                    </div>
                    {source.status === 'failed' && source.errorMessage && (
                      <div className="flex items-center gap-1 mt-2">
                        <AlertCircle size={12} className="text-red-400 shrink-0" />
                        <span className="text-xs text-red-400">{source.errorMessage}</span>
                      </div>
                    )}
                  </div>

                  <div className="flex items-center gap-1.5 shrink-0">
                    <button
                      onClick={() => handleReprocess(source)}
                      disabled={reprocessId === source.id || source.status === 'processing'}
                      className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-xs transition-colors disabled:opacity-50"
                      title="Reprocessar"
                    >
                      <RefreshCw size={12} className={reprocessId === source.id ? 'animate-spin' : ''} />
                      Reprocessar
                    </button>

                    {confirmDeleteId === source.id ? (
                      <button
                        onClick={() => handleDelete(source.id)}
                        disabled={deletingId === source.id}
                        className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-red-500/20 hover:bg-red-500/30 border border-red-500/30 text-red-400 text-xs transition-colors animate-pulse disabled:opacity-50"
                      >
                        {deletingId === source.id ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
                        Confirmar?
                      </button>
                    ) : (
                      <button
                        onClick={() => setConfirmDeleteId(source.id)}
                        className="p-1.5 rounded-lg hover:bg-zinc-800 text-zinc-500 hover:text-red-400 transition-colors"
                        title="Deletar"
                      >
                        <Trash2 size={14} />
                      </button>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}


function TabUpload({
  agents,
  selectedAgentId,
  onSelectAgent,
}: {
  agents: AgentConfig[];
  selectedAgentId: string | null;
  onSelectAgent: (id: string) => void;
}) {
  const { isUploading, uploadProgress, uploadDocument } = useKnowledgeStore();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [title, setTitle] = useState('');
  const [strategy, setStrategy] = useState<ChunkStrategy>('recursive');
  const [chunkSize, setChunkSize] = useState(1000);
  const [chunkOverlap, setChunkOverlap] = useState(200);
  const [successMsg, setSuccessMsg] = useState('');
  const [errorMsg, setErrorMsg] = useState('');

  const fileExt = selectedFile ? selectedFile.name.split('.').pop()?.toLowerCase() ?? '' : '';
  const availableStrategies = fileExt ? (STRATEGY_BY_TYPE[fileExt] ?? ['recursive', 'semantic', 'agentic']) : [];

  useEffect(() => {
    if (fileExt && STRATEGY_BY_TYPE[fileExt]) {
      setStrategy(STRATEGY_BY_TYPE[fileExt][0]);
    }
  }, [fileExt]);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] ?? null;
    setSelectedFile(file);
    setSuccessMsg('');
    setErrorMsg('');
  };

  const handleUpload = async () => {
    if (!selectedFile || !selectedAgentId) return;
    setErrorMsg('');
    setSuccessMsg('');
    try {
      await uploadDocument(selectedAgentId, window.lionclaw.utils.getPathForFile(selectedFile), {
        strategy,
        chunkSize,
        chunkOverlap,
        title: title.trim() || undefined,
      });
      setSuccessMsg(`Documento "${selectedFile.name}" processado com sucesso.`);
      setSelectedFile(null);
      setTitle('');
      if (fileInputRef.current) fileInputRef.current.value = '';
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Erro ao processar documento');
    }
  };

  const STAGE_LABELS: Record<string, string> = {
    parsing: 'Analisando arquivo',
    chunking: 'Dividindo em chunks',
    embedding: 'Gerando embeddings',
    indexing: 'Indexando',
    completed: 'Concluido',
    failed: 'Erro',
  };

  return (
    <div className="flex-1 overflow-y-auto p-4">
      <div className="max-w-xl space-y-4">
        {/* Agent */}
        <div>
          <label className="block text-[10px] uppercase text-zinc-500 font-medium mb-1.5 tracking-wider">
            Agente
          </label>
          <AgentSelector agents={agents} value={selectedAgentId} onChange={onSelectAgent} />
        </div>

        {/* File picker */}
        <div>
          <label className="block text-[10px] uppercase text-zinc-500 font-medium mb-1.5 tracking-wider">
            Arquivo
          </label>
          <div
            onClick={() => fileInputRef.current?.click()}
            className="flex items-center gap-3 bg-zinc-800 border border-dashed border-zinc-700 hover:border-amber-500/50 rounded-xl p-4 cursor-pointer transition-colors"
          >
            <Upload size={20} className="text-zinc-500" />
            <div>
              {selectedFile ? (
                <>
                  <p className="text-sm text-zinc-200">{selectedFile.name}</p>
                  <p className="text-xs text-zinc-500">{formatBytes(selectedFile.size)}</p>
                  {selectedFile.size > 100 * 1024 * 1024 && (
                    <p className="text-xs text-amber-400 mt-0.5">Aviso: arquivo maior que 100MB</p>
                  )}
                </>
              ) : (
                <>
                  <p className="text-sm text-zinc-400">Clique para selecionar</p>
                  <p className="text-xs text-zinc-600">PDF, DOCX, TXT, MD, CSV</p>
                </>
              )}
            </div>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept=".pdf,.docx,.txt,.md,.csv"
            className="hidden"
            onChange={handleFileChange}
          />
        </div>

        {/* Title (optional) */}
        <div>
          <label className="block text-[10px] uppercase text-zinc-500 font-medium mb-1.5 tracking-wider">
            Titulo (opcional)
          </label>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Ex: Manual do produto v2"
            className="w-full bg-zinc-800 border border-zinc-700 text-zinc-100 rounded-lg px-3 py-2 text-sm outline-none focus:border-amber-500/50 placeholder:text-zinc-600"
          />
        </div>

        {/* Strategy */}
        <div>
          <label className="block text-[10px] uppercase text-zinc-500 font-medium mb-1.5 tracking-wider">
            Estrategia de chunking
          </label>
          <div className="relative">
            <select
              value={strategy}
              onChange={(e) => setStrategy(e.target.value as ChunkStrategy)}
              disabled={!selectedFile}
              className="appearance-none w-full bg-zinc-800 border border-zinc-700 text-zinc-100 rounded-lg px-3 py-2 pr-8 text-sm outline-none focus:border-amber-500/50 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {availableStrategies.length === 0 ? (
                <option value="">Selecione um arquivo primeiro</option>
              ) : (
                availableStrategies.map((s) => (
                  <option key={s} value={s}>
                    {STRATEGY_LABELS[s]}
                  </option>
                ))
              )}
            </select>
            <ChevronDown size={14} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-zinc-500 pointer-events-none" />
          </div>
        </div>

        {/* Chunk size and overlap (only for recursive strategy) */}
        {strategy === 'recursive' && (
          <>
            {/* Chunk size */}
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-[10px] uppercase text-zinc-500 font-medium tracking-wider">
                  Tamanho do chunk
                </label>
                <span className="text-xs text-zinc-400 font-mono">{chunkSize}</span>
              </div>
              <input
                type="range"
                min={300}
                max={2000}
                step={50}
                value={chunkSize}
                onChange={(e) => setChunkSize(Number(e.target.value))}
                className="w-full accent-amber-500"
              />
              <div className="flex justify-between text-[10px] text-zinc-600 mt-0.5">
                <span>300</span>
                <span>2000</span>
              </div>
            </div>

            {/* Chunk overlap */}
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-[10px] uppercase text-zinc-500 font-medium tracking-wider">
                  Sobreposicao
                </label>
                <span className="text-xs text-zinc-400 font-mono">{chunkOverlap}</span>
              </div>
              <input
                type="range"
                min={0}
                max={400}
                step={25}
                value={chunkOverlap}
                onChange={(e) => setChunkOverlap(Number(e.target.value))}
                className="w-full accent-amber-500"
              />
              <div className="flex justify-between text-[10px] text-zinc-600 mt-0.5">
                <span>0</span>
                <span>400</span>
              </div>
            </div>
          </>
        )}

        {/* Upload button */}
        <button
          onClick={handleUpload}
          disabled={!selectedFile || !selectedAgentId || isUploading}
          className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-amber-600 hover:bg-amber-500 text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isUploading ? (
            <>
              <Loader2 size={16} className="animate-spin" />
              Processando...
            </>
          ) : (
            <>
              <Upload size={16} />
              Enviar e Processar
            </>
          )}
        </button>

        {/* Progress */}
        {isUploading && uploadProgress && (
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs text-zinc-300 font-medium">
                {STAGE_LABELS[uploadProgress.stage] ?? uploadProgress.stage}
              </span>
              <span className="text-xs text-zinc-500 font-mono">{uploadProgress.progress}%</span>
            </div>
            <div className="h-1.5 bg-zinc-800 rounded-full overflow-hidden">
              <div
                className="h-full bg-amber-500 rounded-full transition-all duration-300"
                style={{ width: `${uploadProgress.progress}%` }}
              />
            </div>
            <div className="flex gap-2 mt-3">
              {(['parsing', 'chunking', 'embedding', 'indexing'] as const).map((stage) => {
                const stages = ['parsing', 'chunking', 'embedding', 'indexing'];
                const currentIdx = stages.indexOf(uploadProgress.stage);
                const stageIdx = stages.indexOf(stage);
                const isDone = stageIdx < currentIdx;
                const isCurrent = stageIdx === currentIdx;
                return (
                  <div key={stage} className="flex-1 flex flex-col items-center gap-1">
                    <div
                      className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold transition-colors ${
                        isDone
                          ? 'bg-green-500/20 text-green-400'
                          : isCurrent
                            ? 'bg-amber-500/20 text-amber-400 ring-1 ring-amber-500/40'
                            : 'bg-zinc-800 text-zinc-600'
                      }`}
                    >
                      {isDone ? <CheckCircle size={12} /> : isCurrent ? <Loader2 size={12} className="animate-spin" /> : stageIdx + 1}
                    </div>
                    <span className="text-[9px] text-zinc-600 text-center leading-tight">
                      {STAGE_LABELS[stage]}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Success / error messages */}
        {successMsg && (
          <div className="flex items-center gap-2 bg-green-500/10 border border-green-500/20 rounded-lg px-3 py-2.5">
            <CheckCircle size={14} className="text-green-400 shrink-0" />
            <p className="text-xs text-green-300">{successMsg}</p>
          </div>
        )}
        {errorMsg && (
          <div className="flex items-center gap-2 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2.5">
            <AlertCircle size={14} className="text-red-400 shrink-0" />
            <p className="text-xs text-red-300">{errorMsg}</p>
          </div>
        )}
      </div>
    </div>
  );
}


function TabBusca({
  agents,
  selectedAgentId,
  onSelectAgent,
}: {
  agents: AgentConfig[];
  selectedAgentId: string | null;
  onSelectAgent: (id: string) => void;
}) {
  const { searchResults, isSearching, searchKnowledge } = useKnowledgeStore();
  const [query, setQuery] = useState('');
  const [showDetails, setShowDetails] = useState(false);

  const handleSearch = async () => {
    if (!query.trim() || !selectedAgentId) return;
    await searchKnowledge(selectedAgentId, query);
  };

  const STRATEGY_DISPLAY: Record<string, string> = {
    hybrid_direct: 'Hibrido Direto',
    hyde_hybrid: 'HyDE + Hibrido',
    hybrid_fallback: 'Fallback Hibrido',
    not_found: 'Nao Encontrado',
  };

  return (
    <div className="flex flex-col flex-1 overflow-hidden">
      <div className="flex items-center gap-3 px-4 py-3 border-b border-zinc-800 flex-wrap">
        <AgentSelector agents={agents} value={selectedAgentId} onChange={onSelectAgent} />
        <div className="flex-1 min-w-[200px] relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
            placeholder="Consultar base de conhecimento..."
            className="w-full bg-zinc-800 border border-zinc-700 text-zinc-100 rounded-lg pl-9 pr-3 py-1.5 text-sm outline-none focus:border-amber-500/50 placeholder:text-zinc-600"
          />
        </div>
        <button
          onClick={handleSearch}
          disabled={!query.trim() || !selectedAgentId || isSearching}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-amber-600 hover:bg-amber-500 text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
        >
          {isSearching ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />}
          Buscar
        </button>
        <button
          onClick={() => setShowDetails((v) => !v)}
          className={`flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs transition-colors ${
            showDetails ? 'bg-zinc-800 text-amber-400' : 'bg-zinc-800/50 text-zinc-500 hover:text-zinc-300'
          }`}
        >
          <Info size={12} />
          Detalhes
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        {!searchResults ? (
          <div className="flex flex-col items-center justify-center h-48 text-zinc-600">
            <Search size={32} className="mb-2 opacity-40" />
            <p className="text-sm">Faca uma busca para ver resultados</p>
          </div>
        ) : !searchResults.found ? (
          searchResults.degraded ? (
            <div className="flex flex-col items-center justify-center h-48 text-amber-400">
              <AlertCircle size={32} className="mb-2 opacity-60" />
              <p className="text-sm">Busca semantica degradada</p>
              <p className="text-xs mt-1 text-zinc-500 max-w-md text-center">
                {searchResults.degradedReason ?? 'Provider de embeddings indisponivel'}
              </p>
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center h-48 text-zinc-600">
              <AlertCircle size={32} className="mb-2 opacity-40" />
              <p className="text-sm">Nenhum resultado encontrado</p>
              <p className="text-xs mt-1">Tente reformular a pergunta</p>
            </div>
          )
        ) : (
          <div className="space-y-3">
            {showDetails && (
              <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-3 flex items-center gap-4 flex-wrap text-xs text-zinc-400">
                <span>
                  Estrategia:{' '}
                  <span className="text-amber-400">{STRATEGY_DISPLAY[searchResults.strategy] ?? searchResults.strategy}</span>
                </span>
                <span>
                  Query usada:{' '}
                  <span className="text-zinc-300 italic">"{searchResults.query_used}"</span>
                </span>
                <span>
                  Latencia:{' '}
                  <span className="text-zinc-300 font-mono">{searchResults.latency_ms}ms</span>
                </span>
                <span>
                  Resultados: <span className="text-zinc-300">{searchResults.results.length}</span>
                </span>
              </div>
            )}

            {searchResults.results.map((result, idx) => (
              <div key={result.chunk_id} className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
                <div className="flex items-start justify-between gap-3 mb-2">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-[10px] text-zinc-500 font-mono">#{idx + 1}</span>
                    <span className="text-xs font-medium text-zinc-300">{result.source_name}</span>
                    <span className="text-[10px] text-zinc-600">chunk {result.chunk_index}</span>
                    <span className="text-[10px] text-zinc-600">{result.token_count} tokens</span>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {showDetails && (
                      <span className={`text-[10px] font-mono font-medium ${scoreColor(result.rerank_score)}`}>
                        {(result.rerank_score * 100).toFixed(1)}%
                      </span>
                    )}
                    <div className="w-16 h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all ${
                          result.rerank_score >= 0.8
                            ? 'bg-green-500'
                            : result.rerank_score >= 0.6
                              ? 'bg-amber-500'
                              : 'bg-red-500'
                        }`}
                        style={{ width: `${Math.min(result.rerank_score * 100, 100)}%` }}
                      />
                    </div>
                  </div>
                </div>

                <div className="prose prose-invert prose-sm max-w-none text-zinc-300 text-sm leading-relaxed">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{result.content}</ReactMarkdown>
                </div>

                {showDetails && Object.keys(result.metadata).length > 0 && (
                  <div className="mt-2 flex gap-2 flex-wrap">
                    {Object.entries(result.metadata).map(([k, v]) => (
                      <span key={k} className="text-[10px] bg-zinc-800 px-1.5 py-0.5 rounded text-zinc-500">
                        {k}: {String(v)}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}


function BenchmarkResultTable({ result }: { result: BenchmarkResult }) {
  const strategies = Object.keys(result.strategies);
  const modes = strategies.length > 0 ? Object.keys(result.strategies[strategies[0]]) : [];

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 bg-amber-500/10 border border-amber-500/20 rounded-xl p-3">
        <Trophy size={18} className="text-amber-400" />
        <div>
          <p className="text-sm font-medium text-amber-300">
            Vencedor: {result.winner}
          </p>
          <p className="text-xs text-zinc-400">
            Score: {(result.winner_score * 100).toFixed(1)}% | Tempo: {result.execution_time_s.toFixed(1)}s
          </p>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-xs border-collapse">
          <thead>
            <tr>
              <th className="text-left text-[10px] uppercase text-zinc-500 font-medium px-3 py-2 border-b border-zinc-800">
                Estrategia
              </th>
              {modes.map((mode) => (
                <th
                  key={mode}
                  className="text-center text-[10px] uppercase text-zinc-500 font-medium px-3 py-2 border-b border-zinc-800"
                >
                  {mode}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {strategies.map((strat) => (
              <tr key={strat} className="border-b border-zinc-800/50 last:border-0">
                <td className={`px-3 py-2.5 font-medium ${strat === result.winner ? 'text-amber-400' : 'text-zinc-300'}`}>
                  {strat}
                  {strat === result.winner && <span className="ml-1 text-[10px]">crown</span>}
                </td>
                {modes.map((mode) => {
                  const data = result.strategies[strat]?.[mode];
                  if (!data) {
                    return <td key={mode} className="px-3 py-2.5 text-center text-zinc-700">-</td>;
                  }
                  return (
                    <td key={mode} className="px-3 py-2.5 text-center">
                      <span className={`inline-block px-2 py-0.5 rounded font-mono font-medium ${scoreBg(data.avg_score)} ${scoreColor(data.avg_score)}`}>
                        {(data.avg_score * 100).toFixed(0)}%
                      </span>
                      <div className="text-[10px] text-zinc-600 mt-0.5">
                        LLM: {(data.llm_judge_avg * 100).toFixed(0)}%
                      </div>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex gap-3 text-[10px]">
        <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-green-500/20 inline-block" />{'Otimo (>=80%)'}</span>
        <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-amber-500/20 inline-block" />Regular (60-79%)</span>
        <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-red-500/20 inline-block" />Ruim ({'<'}60%)</span>
      </div>
    </div>
  );
}

function TabBenchmark({
  agents,
  selectedAgentId,
  onSelectAgent,
}: {
  agents: AgentConfig[];
  selectedAgentId: string | null;
  onSelectAgent: (id: string) => void;
}) {
  const { sources, benchmarkResult, benchmarkProgress, startBenchmark, loadSources, reprocessSource } =
    useKnowledgeStore();
  const [selectedSourceIds, setSelectedSourceIds] = useState<string[]>([]);
  const [totalQuestions, setTotalQuestions] = useState(10);
  const [modelJudge, setModelJudge] = useState<'sonnet' | 'opus'>('sonnet');
  const [threshold, setThreshold] = useState(0.7);
  const [isRunning, setIsRunning] = useState(false);

  const eligibleSources = sources.filter((s) => s.status === 'completed');

  useEffect(() => {
    if (selectedAgentId) loadSources(selectedAgentId);
  }, [selectedAgentId, loadSources]);

  const toggleSource = (id: string) => {
    setSelectedSourceIds((prev) =>
      prev.includes(id) ? prev.filter((s) => s !== id) : [...prev, id],
    );
  };

  const handleRun = async () => {
    if (!selectedAgentId || selectedSourceIds.length === 0) return;
    setIsRunning(true);
    try {
      await startBenchmark(selectedSourceIds, selectedAgentId, {
        totalQuestions,
        modelJudge,
        threshold,
      });
    } finally {
      setIsRunning(false);
    }
  };

  const handleApplyWinner = async () => {
    if (!benchmarkResult || !selectedAgentId) return;
    const winnerStrategy = benchmarkResult.winner as ChunkStrategy;
    for (const sourceId of selectedSourceIds) {
      const source = sources.find((s) => s.id === sourceId);
      if (source) {
        await reprocessSource(sourceId, winnerStrategy, source.chunkSize, source.chunkOverlap);
      }
    }
  };

  return (
    <div className="flex-1 overflow-y-auto p-4">
      <div className="max-w-2xl space-y-5">
        {/* Agent */}
        <div>
          <label className="block text-[10px] uppercase text-zinc-500 font-medium mb-1.5 tracking-wider">
            Agente
          </label>
          <AgentSelector agents={agents} value={selectedAgentId} onChange={onSelectAgent} />
        </div>

        {/* Document checklist */}
        <div>
          <label className="block text-[10px] uppercase text-zinc-500 font-medium mb-1.5 tracking-wider">
            Documentos ({eligibleSources.length} disponiveis)
          </label>
          {eligibleSources.length === 0 ? (
            <p className="text-xs text-zinc-600">
              Nenhum documento concluido. Faca o upload e aguarde o processamento.
            </p>
          ) : (
            <div className="space-y-1.5">
              {eligibleSources.map((source) => (
                <label
                  key={source.id}
                  className="flex items-center gap-3 bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 cursor-pointer hover:border-zinc-700 transition-colors"
                >
                  <input
                    type="checkbox"
                    checked={selectedSourceIds.includes(source.id)}
                    onChange={() => toggleSource(source.id)}
                    className="accent-amber-500 w-3.5 h-3.5"
                  />
                  <span className="text-sm text-zinc-200 flex-1 truncate">
                    {source.title || source.fileName}
                  </span>
                  <span className="text-[10px] text-zinc-500">{source.chunksCount} chunks</span>
                </label>
              ))}
            </div>
          )}
        </div>

        {/* Config */}
        <div className="grid grid-cols-1 gap-4">
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-[10px] uppercase text-zinc-500 font-medium tracking-wider">
                Numero de perguntas
              </label>
              <span className="text-xs text-zinc-400 font-mono">{totalQuestions}</span>
            </div>
            <input
              type="range"
              min={5}
              max={20}
              step={1}
              value={totalQuestions}
              onChange={(e) => setTotalQuestions(Number(e.target.value))}
              className="w-full accent-amber-500"
            />
            <div className="flex justify-between text-[10px] text-zinc-600 mt-0.5">
              <span>5</span>
              <span>20</span>
            </div>
          </div>

          <div>
            <label className="block text-[10px] uppercase text-zinc-500 font-medium mb-1.5 tracking-wider">
              Modelo Juiz
            </label>
            <div className="flex gap-2">
              {(['sonnet', 'opus'] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => setModelJudge(m)}
                  className={`px-4 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                    modelJudge === m
                      ? 'bg-amber-600/20 text-amber-400 border border-amber-600/30'
                      : 'bg-zinc-800 text-zinc-400 hover:text-zinc-200'
                  }`}
                >
                  {m.charAt(0).toUpperCase() + m.slice(1)}
                </button>
              ))}
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-[10px] uppercase text-zinc-500 font-medium tracking-wider">
                Threshold de aprovacao
              </label>
              <span className="text-xs text-zinc-400 font-mono">{(threshold * 100).toFixed(0)}%</span>
            </div>
            <input
              type="range"
              min={0.5}
              max={0.9}
              step={0.05}
              value={threshold}
              onChange={(e) => setThreshold(Number(e.target.value))}
              className="w-full accent-amber-500"
            />
            <div className="flex justify-between text-[10px] text-zinc-600 mt-0.5">
              <span>50%</span>
              <span>90%</span>
            </div>
          </div>
        </div>

        {/* Run button */}
        <button
          onClick={handleRun}
          disabled={!selectedAgentId || selectedSourceIds.length === 0 || isRunning || !!benchmarkProgress}
          className="flex items-center gap-2 px-4 py-2.5 bg-amber-600 hover:bg-amber-500 text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isRunning || benchmarkProgress ? (
            <><Loader2 size={16} className="animate-spin" /> Executando...</>
          ) : (
            <><FlaskConical size={16} /> Executar Benchmark</>
          )}
        </button>

        {/* Progress */}
        {benchmarkProgress && (
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 space-y-3">
            <div className="flex items-center gap-2">
              <Loader2 size={14} className="animate-spin text-amber-500" />
              <span className="text-sm text-zinc-200 font-medium">{benchmarkProgress.stage}</span>
            </div>

            {benchmarkProgress.strategy && (
              <div className="flex items-center gap-2">
                <span className="text-[10px] uppercase text-zinc-500 font-medium">Estrategia:</span>
                <span className="text-xs bg-amber-600/20 text-amber-400 px-2 py-0.5 rounded-md font-medium">
                  {benchmarkProgress.strategy}
                </span>
                {benchmarkProgress.mode && (
                  <span className="text-xs bg-zinc-800 text-zinc-400 px-2 py-0.5 rounded-md">
                    modo: {benchmarkProgress.mode}
                  </span>
                )}
              </div>
            )}

            <div>
              <div className="flex items-center justify-between mb-1">
                <span className="text-[10px] text-zinc-500">Progresso geral</span>
                <span className="text-xs text-zinc-500 font-mono">
                  {benchmarkProgress.current}/{benchmarkProgress.total}
                </span>
              </div>
              <div className="h-2 bg-zinc-800 rounded-full overflow-hidden">
                <div
                  className="h-full bg-gradient-to-r from-amber-600 to-amber-400 rounded-full transition-all duration-500"
                  style={{
                    width: benchmarkProgress.total > 0
                      ? `${(benchmarkProgress.current / benchmarkProgress.total) * 100}%`
                      : '0%',
                  }}
                />
              </div>
            </div>
          </div>
        )}

        {/* Results */}
        {benchmarkResult && (
          <div className="space-y-4">
            <BenchmarkResultTable result={benchmarkResult} />
            <button
              onClick={handleApplyWinner}
              className="flex items-center gap-2 px-4 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 rounded-lg text-sm transition-colors"
            >
              <CheckCircle size={14} className="text-green-400" />
              Aplicar estrategia vencedora ({benchmarkResult.winner})
            </button>
          </div>
        )}
      </div>
    </div>
  );
}


function TabConfiguracoes({
  agents,
  selectedAgentId,
  onSelectAgent,
}: {
  agents: AgentConfig[];
  selectedAgentId: string | null;
  onSelectAgent: (id: string) => void;
}) {
  const { config, loadConfig, updateConfig } = useKnowledgeStore();
  const [cohereKey, setCohereKey] = useState('');
  const [cohereSaved, setCohereSaved] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [savedFeedback, setSavedFeedback] = useState(false);

  const [localConfig, setLocalConfig] = useState({
    hydeEnabled: true,
    hydeThreshold: 0.50,
    minScore: 0.40,
    defaultStrategy: 'recursive' as ChunkStrategy,
    rerankEnabled: true,
    rerankTopK: 3,
    searchTopK: 20,
  });

  useEffect(() => {
    if (selectedAgentId) loadConfig(selectedAgentId);
  }, [selectedAgentId, loadConfig]);

  useEffect(() => {
    if (config) {
      setLocalConfig({
        hydeEnabled: config.hydeEnabled,
        hydeThreshold: config.hydeThreshold,
        minScore: config.minScore,
        defaultStrategy: config.defaultStrategy,
        rerankEnabled: config.rerankEnabled,
        rerankTopK: config.rerankTopK,
        searchTopK: config.searchTopK,
      });
    }
  }, [config]);

  const handleSaveCohereKey = async () => {
    if (!cohereKey.trim()) return;
    await window.lionclaw.vault.set('COHERE_API_KEY', cohereKey);
    setCohereSaved(true);
    setCohereKey('');
    setTimeout(() => setCohereSaved(false), 2000);
  };

  const handleSaveConfig = async () => {
    if (!selectedAgentId) return;
    setIsSaving(true);
    try {
      await updateConfig(selectedAgentId, localConfig);
      setSavedFeedback(true);
      setTimeout(() => setSavedFeedback(false), 2000);
    } finally {
      setIsSaving(false);
    }
  };

  const Toggle = ({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) => (
    <button
      onClick={() => onChange(!value)}
      className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
        value ? 'bg-amber-600' : 'bg-zinc-700'
      }`}
    >
      <span
        className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform ${
          value ? 'translate-x-4.5' : 'translate-x-0.5'
        }`}
      />
    </button>
  );

  return (
    <div className="flex-1 overflow-y-auto p-4">
      <div className="max-w-xl space-y-6">
        {/* Cohere API Key */}
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
          <h3 className="text-sm font-medium text-zinc-200 mb-3">Cohere API Key</h3>
          <p className="text-xs text-zinc-500 mb-3">
            Necessaria para reranking semantico de resultados.
          </p>
          <div className="flex gap-2">
            <input
              type="password"
              value={cohereKey}
              onChange={(e) => setCohereKey(e.target.value)}
              placeholder="co-..."
              className="flex-1 bg-zinc-800 border border-zinc-700 text-zinc-100 rounded-lg px-3 py-2 text-sm outline-none focus:border-amber-500/50 placeholder:text-zinc-600"
            />
            <button
              onClick={handleSaveCohereKey}
              disabled={!cohereKey.trim()}
              className="flex items-center gap-1.5 px-3 py-2 bg-amber-600 hover:bg-amber-500 text-white rounded-lg text-sm transition-colors disabled:opacity-50"
            >
              {cohereSaved ? <CheckCircle size={14} /> : null}
              {cohereSaved ? 'Salvo' : 'Salvar'}
            </button>
          </div>
        </div>

        {/* Per-agent config */}
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-medium text-zinc-200">Configuracao por Agente</h3>
            <AgentSelector agents={agents} value={selectedAgentId} onChange={onSelectAgent} />
          </div>

          {!selectedAgentId ? (
            <p className="text-xs text-zinc-600">Selecione um agente para configurar</p>
          ) : (
            <div className="space-y-4">
              {/* HyDE */}
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-zinc-200">HyDE</p>
                  <p className="text-[10px] text-zinc-500">Hypothetical Document Embeddings para melhorar recall</p>
                </div>
                <Toggle
                  value={localConfig.hydeEnabled}
                  onChange={(v) => setLocalConfig((c) => ({ ...c, hydeEnabled: v }))}
                />
              </div>

              {localConfig.hydeEnabled && (
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className="text-[10px] uppercase text-zinc-500 font-medium tracking-wider">
                      Threshold HyDE
                    </label>
                    <span className="text-xs text-zinc-400 font-mono">{localConfig.hydeThreshold.toFixed(2)}</span>
                  </div>
                  <p className="text-[10px] text-zinc-600 mb-2">
                    Quando o melhor resultado da busca tem score abaixo deste valor, o sistema gera um documento
                    hipotetico (via Haiku) e refaz a busca para tentar encontrar resultados mais relevantes.
                    Valores mais altos ativam HyDE com mais frequencia (mais preciso, mais lento e mais caro).
                  </p>
                  <input
                    type="range"
                    min={0.3}
                    max={0.9}
                    step={0.05}
                    value={localConfig.hydeThreshold}
                    onChange={(e) => setLocalConfig((c) => ({ ...c, hydeThreshold: Number(e.target.value) }))}
                    className="w-full accent-amber-500"
                  />
                </div>
              )}

              {/* Min score */}
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-[10px] uppercase text-zinc-500 font-medium tracking-wider">
                    Score minimo
                  </label>
                  <span className="text-xs text-zinc-400 font-mono">{localConfig.minScore.toFixed(2)}</span>
                </div>
                <input
                  type="range"
                  min={0.1}
                  max={0.8}
                  step={0.05}
                  value={localConfig.minScore}
                  onChange={(e) => setLocalConfig((c) => ({ ...c, minScore: Number(e.target.value) }))}
                  className="w-full accent-amber-500"
                />
              </div>

              {/* Default strategy */}
              <div>
                <label className="block text-[10px] uppercase text-zinc-500 font-medium mb-1.5 tracking-wider">
                  Estrategia padrao
                </label>
                <div className="relative">
                  <select
                    value={localConfig.defaultStrategy}
                    onChange={(e) => setLocalConfig((c) => ({ ...c, defaultStrategy: e.target.value as ChunkStrategy }))}
                    className="appearance-none w-full bg-zinc-800 border border-zinc-700 text-zinc-100 rounded-lg px-3 py-2 pr-8 text-sm outline-none focus:border-amber-500/50 cursor-pointer"
                  >
                    {(Object.keys(STRATEGY_LABELS) as ChunkStrategy[]).map((s) => (
                      <option key={s} value={s}>{STRATEGY_LABELS[s]}</option>
                    ))}
                  </select>
                  <ChevronDown size={14} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-zinc-500 pointer-events-none" />
                </div>
              </div>

              {/* Rerank */}
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-zinc-200">Reranking</p>
                  <p className="text-[10px] text-zinc-500">Rerankeia resultados com Cohere</p>
                </div>
                <Toggle
                  value={localConfig.rerankEnabled}
                  onChange={(v) => setLocalConfig((c) => ({ ...c, rerankEnabled: v }))}
                />
              </div>

              {localConfig.rerankEnabled && (
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className="text-[10px] uppercase text-zinc-500 font-medium tracking-wider">
                      Rerank Top K
                    </label>
                    <span className="text-xs text-zinc-400 font-mono">{localConfig.rerankTopK}</span>
                  </div>
                  <input
                    type="range"
                    min={1}
                    max={20}
                    step={1}
                    value={localConfig.rerankTopK}
                    onChange={(e) => setLocalConfig((c) => ({ ...c, rerankTopK: Number(e.target.value) }))}
                    className="w-full accent-amber-500"
                  />
                </div>
              )}

              {/* Search top K */}
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-[10px] uppercase text-zinc-500 font-medium tracking-wider">
                    Search Top K
                  </label>
                  <span className="text-xs text-zinc-400 font-mono">{localConfig.searchTopK}</span>
                </div>
                <input
                  type="range"
                  min={3}
                  max={30}
                  step={1}
                  value={localConfig.searchTopK}
                  onChange={(e) => setLocalConfig((c) => ({ ...c, searchTopK: Number(e.target.value) }))}
                  className="w-full accent-amber-500"
                />
              </div>

              <button
                onClick={handleSaveConfig}
                disabled={isSaving}
                className="flex items-center gap-2 px-4 py-2 bg-amber-600 hover:bg-amber-500 text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
              >
                {isSaving ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : savedFeedback ? (
                  <CheckCircle size={14} />
                ) : null}
                {savedFeedback ? 'Salvo' : 'Salvar configuracao'}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}


export function KnowledgePage() {
  const [tab, setTab] = useState<PrimaryTabId>('documentos');
  const [graphSubTab, setGraphSubTab] = useState<GraphSubTabId>('graph-view');
  const [agents, setAgents] = useState<AgentConfig[]>([]);
  const { selectedAgentId, setSelectedAgent } = useKnowledgeStore();
  const mgraphMode = useMgraphMode();

  useEffect(() => {
    window.lionclaw.agents.list().then(setAgents).catch(() => setAgents([]));
  }, []);

  useEffect(() => {
    if (!mgraphMode && tab === 'graph') {
      setTab('documentos');
    }
  }, [mgraphMode, tab]);

  const handleSelectAgent = useCallback(
    (id: string) => {
      setSelectedAgent(id);
    },
    [setSelectedAgent],
  );

  const visiblePrimaryTabs = mgraphMode
    ? PRIMARY_TAB_CONFIG
    : PRIMARY_TAB_CONFIG.filter((t) => t.id !== 'graph');

  const currentGraphSubTab = GRAPH_SUB_TAB_CONFIG.find((t) => t.id === graphSubTab);

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-zinc-800">
        <BookOpen size={18} className="text-amber-500" />
        <h1 className="text-sm font-semibold text-zinc-200">Conhecimento</h1>
        <div className="flex-1" />
      </div>

      {/* Primary tabs */}
      <div
        className="flex items-center gap-0.5 px-4 py-1.5 border-b border-zinc-800 overflow-x-auto"
        style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}
      >
        {visiblePrimaryTabs.map(({ id, label, icon: Icon }) => {
          const isActive = tab === id;
          return (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs transition-colors whitespace-nowrap shrink-0 ${
                isActive
                  ? 'bg-zinc-800 text-zinc-200'
                  : 'text-zinc-500 hover:text-zinc-300'
              }`}
            >
              <Icon size={12} />
              {label}
            </button>
          );
        })}
      </div>

      {/* Graph sub-tabs (second row, only when Graph tab is active) */}
      {tab === 'graph' && (
        <div
          className="flex items-center gap-0.5 px-4 py-1.5 border-b border-zinc-800 bg-zinc-900/50 overflow-x-auto"
          style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}
        >
          {GRAPH_SUB_TAB_CONFIG.map(({ id, label, icon: Icon }) => {
            const isActive = graphSubTab === id;
            return (
              <button
                key={id}
                onClick={() => setGraphSubTab(id)}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs transition-colors whitespace-nowrap shrink-0 ${
                  isActive
                    ? 'bg-zinc-800 text-zinc-200'
                    : 'text-zinc-500 hover:text-zinc-300'
                }`}
              >
                <Icon size={12} />
                {label}
              </button>
            );
          })}
        </div>
      )}

      {/* KB tab content */}
      {tab === 'documentos' && (
        <TabDocumentos
          agents={agents}
          selectedAgentId={selectedAgentId}
          onSelectAgent={handleSelectAgent}
        />
      )}
      {tab === 'upload' && (
        <TabUpload
          agents={agents}
          selectedAgentId={selectedAgentId}
          onSelectAgent={handleSelectAgent}
        />
      )}
      {tab === 'busca' && (
        <TabBusca
          agents={agents}
          selectedAgentId={selectedAgentId}
          onSelectAgent={handleSelectAgent}
        />
      )}
      {tab === 'benchmark' && (
        <TabBenchmark
          agents={agents}
          selectedAgentId={selectedAgentId}
          onSelectAgent={handleSelectAgent}
        />
      )}
      {tab === 'configuracoes' && (
        <TabConfiguracoes
          agents={agents}
          selectedAgentId={selectedAgentId}
          onSelectAgent={handleSelectAgent}
        />
      )}

      {/* Graph sub-tab content */}
      {tab === 'graph' && graphSubTab === 'graph-view' && (
        <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
          <GraphPage />
        </div>
      )}
      {tab === 'graph' && (graphSubTab === 'entities' || graphSubTab === 'projects' || graphSubTab === 'decisions' || graphSubTab === 'meetings' || graphSubTab === 'references') && currentGraphSubTab && (
        <div className="flex-1 min-h-0 flex">
          <NoteListView
            type={graphSubTab}
            icon={currentGraphSubTab.icon}
            label={currentGraphSubTab.label}
          />
        </div>
      )}
      {tab === 'graph' && graphSubTab === 'graph-upload' && (
        <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
          <UploadTab />
        </div>
      )}
    </div>
  );
}
