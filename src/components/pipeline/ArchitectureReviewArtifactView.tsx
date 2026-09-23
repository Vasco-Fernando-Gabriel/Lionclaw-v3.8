import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Network, AlertTriangle, CheckCircle2, GitBranch, Lightbulb, Layers, Workflow, ArrowRight } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface ArchitectureReviewArtifactViewProps {
  phase: number;
  markdownContent: string | null;
  jsonContent: string | null;
  onSelectCandidate?: (candidateId: string) => void;
  selectedCandidateId?: string | null;
}

type Layer = 'frontend' | 'ipc' | 'main' | 'data' | 'external' | 'shared';

interface MapModule {
  id: string;
  name: string;
  path?: string;
  role?: string;
  callers?: string[];
  dependencies?: string[];
  risk?: 'low' | 'medium' | 'high';
  layer?: Layer | string;
  kind?: string;
}

interface MapJson {
  runId?: string;
  summary?: string;
  domainVocabulary?: Array<{ term: string; meaning: string }>;
  modules?: MapModule[];
  flows?: Array<{ id: string; name: string; steps?: string[] }>;
  hotspots?: Array<{ id: string; title: string; paths?: string[]; reason?: string }>;
  unknowns?: string[];
}

const LAYER_ORDER: Layer[] = ['frontend', 'ipc', 'main', 'data', 'external', 'shared'];

const LAYER_META: Record<
  Layer,
  {
    label: string;
    band: string;
    pill: string;
    chip: string;
  }
> = {
  frontend: {
    label: 'Frontend / Renderer',
    band: 'border-sky-700/40 bg-sky-950/15',
    pill: 'bg-sky-900/40 text-sky-300',
    chip: 'bg-sky-900/20 border-sky-700/40 text-sky-50',
  },
  ipc: {
    label: 'IPC / Preload',
    band: 'border-violet-700/40 bg-violet-950/15',
    pill: 'bg-violet-900/40 text-violet-300',
    chip: 'bg-violet-900/20 border-violet-700/40 text-violet-50',
  },
  main: {
    label: 'Main Process / Backend',
    band: 'border-emerald-700/40 bg-emerald-950/15',
    pill: 'bg-emerald-900/40 text-emerald-300',
    chip: 'bg-emerald-900/20 border-emerald-700/40 text-emerald-50',
  },
  data: {
    label: 'Data / Persistence',
    band: 'border-amber-700/40 bg-amber-950/15',
    pill: 'bg-amber-900/40 text-amber-300',
    chip: 'bg-amber-900/20 border-amber-700/40 text-amber-50',
  },
  external: {
    label: 'External / Integrations',
    band: 'border-rose-700/40 bg-rose-950/15',
    pill: 'bg-rose-900/40 text-rose-300',
    chip: 'bg-rose-900/20 border-rose-700/40 text-rose-50',
  },
  shared: {
    label: 'Shared / Infra',
    band: 'border-zinc-700/40 bg-zinc-900/30',
    pill: 'bg-zinc-800 text-zinc-300',
    chip: 'bg-zinc-900 border-zinc-700/40 text-zinc-200',
  },
};

function inferLayer(m: MapModule): Layer {
  if (m.layer && LAYER_ORDER.includes(m.layer as Layer)) {
    return m.layer as Layer;
  }

  const path = (m.path || '').toLowerCase().replace(/\\/g, '/');
  const role = (m.role || '').toLowerCase();

  if (path.includes('electron/preload') || path.includes('/preload/') || /(?:^|\/)preload(?:\/|\.|$)/.test(path)) {
    return 'ipc';
  }
  if (/\bcontextbridge\b/.test(role)) return 'ipc';

  if (path.endsWith('.db') || /(?:^|\/)sqlite/.test(path) || /(?:^|\/)migrations?(?:\/|-|\.)/.test(path)) {
    return 'data';
  }
  if (
    /(?:^|\/)db(?:\.ts|-migration|-handlers|\/)/.test(path) ||
    /\b(?:database|persistence|repository|sqlite)\b/.test(role)
  ) {
    return 'data';
  }

  if (
    path.includes('mcp-server') ||
    path.includes('/mcp-') ||
    path.includes('/mcp/') ||
    /(?:^|\/)mcp(?:\/|-)/.test(path)
  ) {
    return 'external';
  }
  if (
    path.includes('telegram') ||
    path.includes('ollama') ||
    path.includes('elevenlabs') ||
    path.includes('google-auth')
  ) {
    return 'external';
  }
  if (/\b(?:integration|provider|external|api client|http client)\b/.test(role)) {
    return 'external';
  }

  if (path.includes('electron/main') || path.includes('main process') || /(?:^|\/)main(?:\/|\.ts|\.js)/.test(path)) {
    return 'main';
  }
  if (
    path.includes('ipc-handlers') ||
    path.includes('pipeline-engine') ||
    path.includes('harness-engine') ||
    path.includes('orchestrator')
  ) {
    return 'main';
  }
  if (path.includes('seed-agents/') || path.includes('agent-runtime/') || path.includes('knowledge-engine')) {
    return 'main';
  }
  if (/\b(?:engine|orchestrator|backend|main process)\b/.test(role)) {
    return 'main';
  }

  if (
    path.startsWith('src/') ||
    path.includes('/components/') ||
    path.includes('/pages/') ||
    path.includes('/renderer/')
  ) {
    return 'frontend';
  }
  if (/\b(?:react|vue|angular|ui|component|page|view|renderer)\b/.test(role)) {
    return 'frontend';
  }

  return 'shared';
}

function MapView({ data }: { data: MapJson }) {
  const modules = useMemo<MapModule[]>(() => data.modules ?? [], [data.modules]);
  const moduleById = useMemo(() => {
    const m = new Map<string, MapModule>();
    for (const x of modules) m.set(x.id, x);
    return m;
  }, [modules]);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const moduleRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const [lines, setLines] = useState<Array<{ x1: number; y1: number; x2: number; y2: number; kind: 'in' | 'out' }>>([]);

  const selectedModule = selectedId ? (moduleById.get(selectedId) ?? null) : null;
  const callerSet = useMemo(() => new Set(selectedModule?.callers ?? []), [selectedModule]);
  const depSet = useMemo(() => new Set(selectedModule?.dependencies ?? []), [selectedModule]);

  const byLayer = useMemo(() => {
    const acc: Record<Layer, MapModule[]> = {
      frontend: [],
      ipc: [],
      main: [],
      data: [],
      external: [],
      shared: [],
    };
    for (const m of modules) acc[inferLayer(m)].push(m);
    return acc;
  }, [modules]);

  useEffect(() => {
    if (!selectedId) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSelectedId(null);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [selectedId]);

  useLayoutEffect(() => {
    if (!selectedModule || !containerRef.current) {
      setLines([]);
      return;
    }
    const container = containerRef.current;
    const containerRect = container.getBoundingClientRect();
    const selectedEl = moduleRefs.current.get(selectedModule.id);
    if (!selectedEl) {
      setLines([]);
      return;
    }
    const sb = selectedEl.getBoundingClientRect();
    const sx = sb.left - containerRect.left + sb.width / 2;
    const sy = sb.top - containerRect.top + sb.height / 2;

    const computed: typeof lines = [];

    for (const depId of selectedModule.dependencies ?? []) {
      if (depId === selectedModule.id) continue;
      const el = moduleRefs.current.get(depId);
      if (!el) continue;
      const b = el.getBoundingClientRect();
      const tx = b.left - containerRect.left + b.width / 2;
      const ty = b.top - containerRect.top + b.height / 2;
      computed.push({ x1: sx, y1: sy, x2: tx, y2: ty, kind: 'out' });
    }

    for (const callerId of selectedModule.callers ?? []) {
      if (callerId === selectedModule.id) continue;
      const el = moduleRefs.current.get(callerId);
      if (!el) continue;
      const b = el.getBoundingClientRect();
      const fx = b.left - containerRect.left + b.width / 2;
      const fy = b.top - containerRect.top + b.height / 2;
      computed.push({ x1: fx, y1: fy, x2: sx, y2: sy, kind: 'in' });
    }

    setLines(computed);
  }, [selectedModule, tick]);

  useEffect(() => {
    if (!containerRef.current) return;
    const ro = new ResizeObserver(() => setTick((t) => t + 1));
    ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, []);

  return (
    <div className="space-y-6 p-4">
      {data.summary && (
        <section>
          <h3 className="text-sm font-semibold text-zinc-300 mb-2 flex items-center gap-2">
            <Network size={16} /> Resumo do sistema
          </h3>
          <p className="text-sm text-zinc-400 leading-relaxed">{data.summary}</p>
        </section>
      )}

      {data.domainVocabulary && data.domainVocabulary.length > 0 && (
        <details className="bg-zinc-900 rounded-lg border border-zinc-800 overflow-hidden">
          <summary className="px-3 py-2 cursor-pointer text-xs font-semibold text-zinc-300 hover:bg-zinc-800/40">
            Vocabulario de dominio ({data.domainVocabulary.length})
          </summary>
          <table className="w-full text-xs">
            <tbody>
              {data.domainVocabulary.map((v, i) => (
                <tr key={i} className="border-t border-zinc-800">
                  <td className="px-3 py-2 font-mono text-zinc-200 align-top w-1/3">{v.term}</td>
                  <td className="px-3 py-2 text-zinc-400">{v.meaning}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}

      {modules.length > 0 && (
        <section>
          <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
            <h3 className="text-sm font-semibold text-zinc-300 flex items-center gap-2">
              <Layers size={16} /> Diagrama em camadas ({modules.length} modules)
            </h3>
            <div className="text-[10px] text-zinc-500">
              {selectedId ? (
                <button
                  onClick={() => setSelectedId(null)}
                  className="px-2 py-0.5 rounded bg-zinc-800 text-zinc-300 hover:bg-zinc-700"
                >
                  Limpar selecao (ESC)
                </button>
              ) : (
                <span>Clique em um module para ver conexoes</span>
              )}
            </div>
          </div>

          {selectedModule && (
            <div className="flex items-center gap-3 text-[10px] text-zinc-500 mb-2 px-1 flex-wrap">
              <span className="flex items-center gap-1">
                <span className="w-2 h-2 rounded-full bg-yellow-400" /> selecionado
              </span>
              <span className="flex items-center gap-1">
                <span className="w-2 h-2 rounded-full bg-emerald-400" /> chamadores ({callerSet.size})
              </span>
              <span className="flex items-center gap-1">
                <span className="w-2 h-2 rounded-full bg-sky-400" /> dependencias ({depSet.size})
              </span>
            </div>
          )}

          <div className="overflow-x-auto rounded-lg border border-zinc-800 bg-zinc-950/40">
            <div ref={containerRef} className="relative min-w-fit p-3 space-y-2">
              <svg className="absolute inset-0 pointer-events-none" style={{ width: '100%', height: '100%' }}>
                <defs>
                  <marker
                    id="arch-map-arrow-out"
                    viewBox="0 0 10 10"
                    refX="9"
                    refY="5"
                    markerWidth="6"
                    markerHeight="6"
                    orient="auto"
                  >
                    <path d="M 0 0 L 10 5 L 0 10 z" fill="#38bdf8" />
                  </marker>
                  <marker
                    id="arch-map-arrow-in"
                    viewBox="0 0 10 10"
                    refX="9"
                    refY="5"
                    markerWidth="6"
                    markerHeight="6"
                    orient="auto"
                  >
                    <path d="M 0 0 L 10 5 L 0 10 z" fill="#34d399" />
                  </marker>
                </defs>
                {lines.map((l, i) => (
                  <line
                    key={i}
                    x1={l.x1}
                    y1={l.y1}
                    x2={l.x2}
                    y2={l.y2}
                    stroke={l.kind === 'out' ? '#38bdf8' : '#34d399'}
                    strokeWidth="1.5"
                    strokeDasharray={l.kind === 'in' ? '4 3' : ''}
                    opacity={0.75}
                    markerEnd={l.kind === 'out' ? 'url(#arch-map-arrow-out)' : 'url(#arch-map-arrow-in)'}
                  />
                ))}
              </svg>

              {LAYER_ORDER.map((layerId) => {
                const items = byLayer[layerId];
                if (items.length === 0) return null;
                const meta = LAYER_META[layerId];
                return (
                  <div key={layerId} className={`relative rounded-lg border p-2 ${meta.band}`}>
                    <div className="flex items-center gap-2 mb-2">
                      <span
                        className={`px-2 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide ${meta.pill}`}
                      >
                        {meta.label}
                      </span>
                      <span className="text-[10px] text-zinc-500">{items.length}</span>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {items.map((m) => {
                        const isSelected = m.id === selectedId;
                        const isCaller = callerSet.has(m.id);
                        const isDep = depSet.has(m.id);
                        const ringColor = isSelected
                          ? 'ring-2 ring-yellow-400'
                          : isCaller
                            ? 'ring-2 ring-emerald-400'
                            : isDep
                              ? 'ring-2 ring-sky-400'
                              : selectedId
                                ? 'opacity-40'
                                : '';
                        return (
                          <div
                            key={m.id}
                            ref={(el) => {
                              if (el) moduleRefs.current.set(m.id, el);
                              else moduleRefs.current.delete(m.id);
                            }}
                            onClick={() => setSelectedId((s) => (s === m.id ? null : m.id))}
                            className={`relative shrink-0 w-[180px] rounded-md border p-2 cursor-pointer transition hover:bg-zinc-800/30 ${meta.chip} ${ringColor}`}
                            title={[m.path, m.role].filter(Boolean).join('\n')}
                          >
                            <div className="flex items-center gap-1.5 min-w-0">
                              <span className="font-mono text-xs font-semibold truncate flex-1">{m.name}</span>
                              {m.risk === 'high' && (
                                <span title="risk: high" className="w-1.5 h-1.5 rounded-full bg-red-400 shrink-0" />
                              )}
                              {m.risk === 'medium' && (
                                <span
                                  title="risk: medium"
                                  className="w-1.5 h-1.5 rounded-full bg-yellow-400 shrink-0"
                                />
                              )}
                            </div>
                            {m.kind && (
                              <div className="text-[8px] text-zinc-500 uppercase tracking-wide mt-0.5">{m.kind}</div>
                            )}
                            {m.role && <div className="text-[10px] text-zinc-300/80 mt-0.5 line-clamp-2">{m.role}</div>}
                            {m.path && <div className="font-mono text-[9px] text-zinc-500 mt-1 truncate">{m.path}</div>}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {selectedModule && (
            <div className="mt-3 bg-zinc-950 border border-zinc-800 rounded-lg p-3 text-xs">
              <div className="flex items-center gap-2 mb-1 flex-wrap">
                <span className="font-mono font-semibold text-yellow-300">{selectedModule.name}</span>
                {selectedModule.path && (
                  <span className="font-mono text-[10px] text-zinc-500">{selectedModule.path}</span>
                )}
              </div>
              {selectedModule.role && <div className="text-zinc-300 mb-2">{selectedModule.role}</div>}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-[11px]">
                <div>
                  <div className="text-emerald-400 mb-1 font-semibold">Chamadores ({callerSet.size})</div>
                  {(selectedModule.callers ?? []).length === 0 && (
                    <div className="text-zinc-600 italic">nenhum mapeado</div>
                  )}
                  {(selectedModule.callers ?? []).map((c) => (
                    <div key={c} className="font-mono text-zinc-400">
                      &larr; {c}
                    </div>
                  ))}
                </div>
                <div>
                  <div className="text-sky-400 mb-1 font-semibold">Dependencias ({depSet.size})</div>
                  {(selectedModule.dependencies ?? []).length === 0 && (
                    <div className="text-zinc-600 italic">nenhuma mapeada</div>
                  )}
                  {(selectedModule.dependencies ?? []).map((d) => (
                    <div key={d} className="font-mono text-zinc-400">
                      &rarr; {d}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </section>
      )}

      {data.flows && data.flows.length > 0 && (
        <section>
          <h3 className="text-sm font-semibold text-zinc-300 mb-2 flex items-center gap-2">
            <Workflow size={16} /> Fluxos principais ({data.flows.length})
          </h3>
          <div className="space-y-2">
            {data.flows.map((f, idx) => (
              <div key={f.id || idx} className="bg-zinc-900 border border-zinc-800 rounded-lg p-3">
                <div className="flex items-center gap-2 mb-2">
                  <span className="px-2 py-0.5 rounded text-[10px] font-mono font-semibold bg-blue-900/40 text-blue-300">
                    F{idx + 1}
                  </span>
                  <span className="text-sm font-medium text-zinc-200">{f.name}</span>
                </div>
                <div className="overflow-x-auto">
                  <div className="flex items-center gap-1 min-w-fit pb-1">
                    {(f.steps ?? []).map((s, i) => (
                      <Fragment key={i}>
                        <div className="shrink-0 max-w-[280px] px-2 py-1.5 rounded-md bg-zinc-800/60 border border-zinc-700/50 text-xs text-zinc-200">
                          <span className="text-zinc-500 font-mono mr-1">{i + 1}.</span>
                          {s}
                        </div>
                        {i < (f.steps?.length ?? 0) - 1 && <ArrowRight size={14} className="text-zinc-600 shrink-0" />}
                      </Fragment>
                    ))}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {data.hotspots && data.hotspots.length > 0 && (
        <section>
          <h3 className="text-sm font-semibold text-zinc-300 mb-2 flex items-center gap-2">
            <AlertTriangle size={16} className="text-orange-400" /> Hotspots ({data.hotspots.length})
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            {data.hotspots.map((h) => (
              <div key={h.id} className="bg-orange-950/15 border border-orange-900/40 rounded-lg p-3">
                <div className="text-sm text-orange-200 font-medium">{h.title}</div>
                {h.reason && <div className="text-xs text-zinc-400 mt-1">{h.reason}</div>}
                {h.paths && h.paths.length > 0 && (
                  <div className="mt-2 space-y-0.5">
                    {h.paths.slice(0, 4).map((p, i) => (
                      <div key={i} className="font-mono text-[10px] text-zinc-500 truncate">
                        {p}
                      </div>
                    ))}
                    {h.paths.length > 4 && (
                      <div className="text-[10px] text-zinc-600 italic">+{h.paths.length - 4} mais</div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {data.unknowns && data.unknowns.length > 0 && (
        <section>
          <h3 className="text-sm font-semibold text-zinc-300 mb-2">O que nao foi mapeado</h3>
          <ul className="text-xs text-zinc-400 space-y-1 list-disc list-inside bg-zinc-900/50 rounded-lg border border-zinc-800 p-3">
            {data.unknowns.map((u, i) => (
              <li key={i}>{u}</li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

interface CandidatesJson {
  recommendedCandidateId?: string;
  selectedCandidateId?: string | null;
  candidates?: Array<{
    id: string;
    title: string;
    files?: string[];
    problem?: string;
    proposedDirection?: string;
    benefits?: { locality?: string; leverage?: string; testing?: string };
    payoff?: 'low' | 'medium' | 'high';
    risk?: 'low' | 'medium' | 'high';
    whyNow?: string;
  }>;
}

function CandidatesView({
  data,
  onSelectCandidate,
  selectedCandidateId,
}: {
  data: CandidatesJson;
  onSelectCandidate?: (candidateId: string) => void;
  selectedCandidateId?: string | null;
}) {
  const recommendedId = data.recommendedCandidateId;
  const selectedId = selectedCandidateId ?? data.selectedCandidateId ?? null;

  return (
    <div className="space-y-3 p-4">
      <h3 className="text-sm font-semibold text-zinc-300 flex items-center gap-2">
        <Lightbulb size={16} className="text-yellow-400" />
        Candidatos de aprofundamento ({data.candidates?.length ?? 0})
      </h3>
      {data.candidates?.map((c) => {
        const isRecommended = c.id === recommendedId;
        const isSelected = c.id === selectedId;
        return (
          <div
            key={c.id}
            className={`rounded-lg border p-4 ${
              isSelected
                ? 'border-green-700 bg-green-950/20'
                : isRecommended
                  ? 'border-yellow-700/60 bg-yellow-950/10'
                  : 'border-zinc-800 bg-zinc-900'
            }`}
          >
            <div className="flex items-start justify-between gap-3 mb-2">
              <div className="flex items-center gap-2 min-w-0">
                <span className="font-mono text-xs text-zinc-500">{c.id}</span>
                <span className="font-medium text-zinc-100">{c.title}</span>
                {isRecommended && (
                  <span className="px-2 py-0.5 rounded text-[10px] font-semibold uppercase bg-yellow-900/40 text-yellow-300">
                    Recomendado
                  </span>
                )}
                {isSelected && (
                  <span className="px-2 py-0.5 rounded text-[10px] font-semibold uppercase bg-green-900/40 text-green-300 flex items-center gap-1">
                    <CheckCircle2 size={10} /> Escolhido
                  </span>
                )}
              </div>
              <div className="flex gap-1 shrink-0">
                {c.payoff && (
                  <span className="px-2 py-0.5 rounded text-[10px] font-semibold bg-zinc-800 text-zinc-300">
                    payoff: {c.payoff}
                  </span>
                )}
                {c.risk && (
                  <span className="px-2 py-0.5 rounded text-[10px] font-semibold bg-zinc-800 text-zinc-300">
                    risco: {c.risk}
                  </span>
                )}
              </div>
            </div>

            {c.problem && (
              <div className="text-xs text-zinc-400 mb-2">
                <span className="text-zinc-500">Problema:</span> {c.problem}
              </div>
            )}
            {c.proposedDirection && (
              <div className="text-xs text-zinc-400 mb-2">
                <span className="text-zinc-500">Direcao:</span> {c.proposedDirection}
              </div>
            )}
            {c.benefits && (
              <div className="grid grid-cols-3 gap-2 text-[11px] text-zinc-400 mt-2">
                {c.benefits.locality && (
                  <div>
                    <span className="text-zinc-500 block">Locality</span>
                    {c.benefits.locality}
                  </div>
                )}
                {c.benefits.leverage && (
                  <div>
                    <span className="text-zinc-500 block">Leverage</span>
                    {c.benefits.leverage}
                  </div>
                )}
                {c.benefits.testing && (
                  <div>
                    <span className="text-zinc-500 block">Testing</span>
                    {c.benefits.testing}
                  </div>
                )}
              </div>
            )}
            {c.files && c.files.length > 0 && (
              <div className="mt-2 space-y-0.5">
                {c.files.slice(0, 5).map((f, i) => (
                  <div key={i} className="font-mono text-[10px] text-zinc-500 truncate">
                    {f}
                  </div>
                ))}
                {c.files.length > 5 && (
                  <div className="text-[10px] text-zinc-600 italic">+{c.files.length - 5} mais</div>
                )}
              </div>
            )}

            {/*
              Approval lateral por card: aprovar = escolher um candidato especifico.
              Quando ja ha um selectedId, escondemos o botao em TODOS os cards
              (selecionado mostra badge Escolhido; nao-selecionados ficam visualmente
              inertes) para evitar duplo-click ou troca acidental enquanto a fase 3
              (Diagnosis) inicializa em background.
            */}
            {!selectedId && onSelectCandidate && (
              <button
                onClick={() => onSelectCandidate(c.id)}
                className="mt-3 w-full px-3 py-2 rounded text-xs font-semibold bg-blue-700 hover:bg-blue-600 text-white transition"
              >
                Aprovar este alvo
              </button>
            )}
            {selectedId && !isSelected && (
              <div className="mt-3 w-full px-3 py-2 rounded text-xs text-zinc-500 italic text-center bg-zinc-950/50 border border-zinc-800">
                Outro alvo foi escolhido
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

interface DiagnosisJson {
  candidateId?: string;
  rootCause?: string;
  evidence?: Array<{ path?: string; lines?: string; finding?: string; impact?: string }>;
  dependencyCategories?: Array<{ dependency?: string; category?: string; testStrategy?: string }>;
  currentSeams?: string[];
  missingSeams?: string[];
  testingImpact?: string;
  riskOfNoChange?: string;
}

function DiagnosisView({ data }: { data: DiagnosisJson }) {
  return (
    <div className="space-y-6 p-4">
      {data.rootCause && (
        <section>
          <h3 className="text-sm font-semibold text-red-300 mb-2 flex items-center gap-2">
            <AlertTriangle size={16} /> Causa raiz
          </h3>
          <p className="text-sm text-zinc-300 bg-red-950/20 border border-red-900/40 rounded-lg p-3">
            {data.rootCause}
          </p>
        </section>
      )}

      {data.evidence && data.evidence.length > 0 && (
        <section>
          <h3 className="text-sm font-semibold text-zinc-300 mb-2">Evidencias ({data.evidence.length})</h3>
          <div className="space-y-2">
            {data.evidence.map((e, i) => (
              <div key={i} className="bg-zinc-900 border border-zinc-800 rounded-lg p-3">
                <div className="font-mono text-xs text-zinc-400">
                  {e.path}
                  {e.lines ? `:${e.lines}` : ''}
                </div>
                {e.finding && <div className="text-sm text-zinc-200 mt-1">{e.finding}</div>}
                {e.impact && <div className="text-xs text-orange-300 mt-1">Impact: {e.impact}</div>}
              </div>
            ))}
          </div>
        </section>
      )}

      {((data.currentSeams?.length ?? 0) > 0 || (data.missingSeams?.length ?? 0) > 0) && (
        <section className="grid grid-cols-2 gap-3">
          <div>
            <h4 className="text-xs font-semibold text-zinc-400 mb-2 flex items-center gap-2">
              <GitBranch size={14} /> Seams atuais
            </h4>
            <ul className="text-xs text-zinc-300 space-y-1">
              {data.currentSeams?.map((s, i) => (
                <li key={i} className="bg-zinc-900 border border-zinc-800 rounded px-2 py-1">
                  {s}
                </li>
              ))}
            </ul>
          </div>
          <div>
            <h4 className="text-xs font-semibold text-zinc-400 mb-2 flex items-center gap-2">
              <GitBranch size={14} className="text-red-400" /> Seams ausentes
            </h4>
            <ul className="text-xs text-zinc-300 space-y-1">
              {data.missingSeams?.map((s, i) => (
                <li key={i} className="bg-red-950/10 border border-red-900/30 rounded px-2 py-1">
                  {s}
                </li>
              ))}
            </ul>
          </div>
        </section>
      )}

      {data.riskOfNoChange && (
        <section>
          <h3 className="text-sm font-semibold text-zinc-300 mb-2">Risco se nada mudar</h3>
          <p className="text-sm text-zinc-400">{data.riskOfNoChange}</p>
        </section>
      )}
    </div>
  );
}

interface ParsedDecision {
  n: number;
  title: string;
  body: string;
}

function parseDecisionsMd(md: string): ParsedDecision[] {
  const decisions: ParsedDecision[] = [];
  const regex = /^##\s*D(\d+)\s*[—\-:]?\s*(.+?)$/gm;
  const matches = Array.from(md.matchAll(regex));
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const n = parseInt(m[1], 10);
    const title = m[2].trim();
    const start = m.index! + m[0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index! : md.length;
    const body = md.slice(start, end).trim();
    decisions.push({ n, title, body });
  }
  return decisions;
}

function DecisionsView({ md }: { md: string }) {
  const decisions = useMemo(() => parseDecisionsMd(md), [md]);
  if (decisions.length === 0) {
    return (
      <div className="p-4 text-sm text-zinc-500 italic">
        Nenhuma decisao apendada ainda. As decisoes aparecerao aqui em formato timeline.
      </div>
    );
  }
  return (
    <div className="p-4 space-y-3">
      <h3 className="text-sm font-semibold text-zinc-300">Timeline de decisoes ({decisions.length})</h3>
      {decisions.map((d) => (
        <div key={d.n} className="border-l-2 border-blue-700 pl-3">
          <div className="flex items-center gap-2 mb-1">
            <span className="px-2 py-0.5 rounded text-[10px] font-mono font-semibold bg-blue-900/40 text-blue-300">
              D{d.n}
            </span>
            <span className="text-sm font-medium text-zinc-200">{d.title}</span>
          </div>
          <pre className="text-xs text-zinc-400 whitespace-pre-wrap font-sans bg-zinc-900 border border-zinc-800 rounded p-2 mt-1">
            {d.body}
          </pre>
        </div>
      ))}
    </div>
  );
}

export function ArchitectureReviewArtifactView({
  phase,
  markdownContent,
  jsonContent,
  onSelectCandidate,
  selectedCandidateId,
}: ArchitectureReviewArtifactViewProps) {
  const parsedJson = useMemo(() => {
    if (!jsonContent) return null;
    try {
      return JSON.parse(jsonContent);
    } catch {
      return null;
    }
  }, [jsonContent]);

  if (phase === 1 && parsedJson) {
    return <MapView data={parsedJson as MapJson} />;
  }
  if (phase === 2 && parsedJson) {
    return (
      <CandidatesView
        data={parsedJson as CandidatesJson}
        onSelectCandidate={onSelectCandidate}
        selectedCandidateId={selectedCandidateId}
      />
    );
  }
  if (phase === 3 && parsedJson) {
    return <DiagnosisView data={parsedJson as DiagnosisJson} />;
  }
  if (phase === 4 && markdownContent) {
    return <DecisionsView md={markdownContent} />;
  }

  if (markdownContent) {
    return (
      <div className="px-5 py-4">
        <div className="phase-artifact-markdown text-sm text-zinc-300 leading-relaxed max-w-4xl mx-auto">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{markdownContent}</ReactMarkdown>
        </div>
        <style>{`
          .phase-artifact-markdown h1 { font-size: 1.25rem; font-weight: 700; color: #f4f4f5; margin-bottom: 0.75rem; padding-bottom: 0.5rem; border-bottom: 1px solid #3f3f46; }
          .phase-artifact-markdown h2 { font-size: 1.05rem; font-weight: 600; color: #e4e4e7; margin-top: 1.5rem; margin-bottom: 0.5rem; }
          .phase-artifact-markdown h3 { font-size: 0.925rem; font-weight: 600; color: #d4d4d8; margin-top: 1rem; margin-bottom: 0.375rem; }
          .phase-artifact-markdown p  { margin-bottom: 0.625rem; color: #a1a1aa; }
          .phase-artifact-markdown ul, .phase-artifact-markdown ol { margin-bottom: 0.625rem; padding-left: 1.25rem; color: #a1a1aa; }
          .phase-artifact-markdown li { margin-bottom: 0.25rem; }
          .phase-artifact-markdown code { background: #27272a; border: 1px solid #3f3f46; border-radius: 0.25rem; padding: 0.1rem 0.35rem; font-size: 0.8rem; color: #fbbf24; font-family: ui-monospace, monospace; }
          .phase-artifact-markdown pre { background: #18181b; border: 1px solid #3f3f46; border-radius: 0.5rem; padding: 0.875rem 1rem; overflow-x: auto; margin-bottom: 0.75rem; }
          .phase-artifact-markdown pre code { background: transparent; border: none; padding: 0; color: #d4d4d8; }
          .phase-artifact-markdown blockquote { border-left: 3px solid #78350f; padding-left: 0.875rem; color: #a1a1aa; margin-bottom: 0.625rem; }
          .phase-artifact-markdown table { width: 100%; border-collapse: collapse; margin-bottom: 0.875rem; font-size: 0.8rem; }
          .phase-artifact-markdown th { background: #27272a; color: #e4e4e7; padding: 0.375rem 0.625rem; text-align: left; font-weight: 600; border: 1px solid #3f3f46; }
          .phase-artifact-markdown td { padding: 0.375rem 0.625rem; border: 1px solid #3f3f46; color: #a1a1aa; }
          .phase-artifact-markdown tr:nth-child(even) td { background: #18181b; }
          .phase-artifact-markdown a { color: #fbbf24; text-decoration: underline; }
          .phase-artifact-markdown hr { border: none; border-top: 1px solid #3f3f46; margin: 1rem 0; }
          .phase-artifact-markdown strong { color: #e4e4e7; font-weight: 600; }
        `}</style>
      </div>
    );
  }
  return <div className="p-4 text-sm text-zinc-500 italic">Sem conteudo disponivel para esta fase ainda.</div>;
}
