import { useState, useEffect, useRef } from 'react';
import {
  X,
  Folder,
  Loader2,
  ChevronRight,
  ChevronLeft,
  FileText,
  GitBranch,
  Shield,
  Code,
  Network,
  Bug,
} from 'lucide-react';
import { usePipelineStore } from '@/stores/pipeline-store';
import type { PipelineType } from '@/types';

interface EntryPoint {
  phase: number;
  label: string;
  description: string;
}

const DEV_ENTRY_POINTS: EntryPoint[] = [
  {
    phase: 1,
    label: 'Discovery',
    description: 'Comecar do zero — entrevista de produto, PRD, SPEC e implementacao',
  },
  {
    phase: 9,
    label: 'Spec Builder',
    description: 'Ja tem PRD + decisoes tecnicas — gerar, validar e enriquecer a SPEC',
  },
  {
    phase: 11,
    label: 'Planner',
    description: 'Ja tem SPEC aprovada — gerar sprints e planejar a implementacao',
  },
];

const SECURITY_ENTRY_POINTS: EntryPoint[] = [
  {
    phase: 1,
    label: 'Scan Completo',
    description: 'Profiling + auditoria + validacao + correcao automatizada',
  },
  {
    phase: 5,
    label: 'SPEC a partir de relatorio',
    description: 'Ja tem um Security-*.md — gerar SPEC e corrigir',
  },
];

const FEATURE_ENTRY_POINTS: EntryPoint[] = [
  {
    phase: 1,
    label: 'Feature Discovery',
    description: 'Explorar o repo, discutir a feature, gerar PRD, SPEC e implementacao',
  },
];

const ARCHITECTURE_ENTRY_POINTS: EntryPoint[] = [
  {
    phase: 1,
    label: 'Mapeamento Completo',
    description: 'Mapeia arquitetura, escolhe alvo, diagnostica, fecha decisoes, gera SPEC e implementa',
  },
];

const BUG_ENTRY_POINTS: EntryPoint[] = [
  {
    phase: 1,
    label: 'Bug Discovery',
    description: 'Relatar o bug — diagnostico, tres analises em paralelo, plano de correcao e implementacao',
  },
];

const DEV_V2_ENTRY_POINTS: EntryPoint[] = [
  {
    phase: 1,
    label: 'Discovery',
    description: 'Comecar do zero com LionDesign — discovery, design, PRD, SPEC e implementacao',
  },
];

interface PipelineTypeOption {
  type: PipelineType;
  label: string;
  description: string;
  icon: React.ReactNode;
  idleIconClass?: string;
}

const PIPELINE_TYPES: PipelineTypeOption[] = [
  {
    type: 'development',
    label: 'Development Pipeline',
    description: 'Discovery, PRD, SPEC e implementacao de produto.',
    icon: <GitBranch size={20} />,
  },
  {
    type: 'development-v2',
    label: 'Development 2.0',
    description: 'Inclui LionDesign antes das decisoes tecnicas.',
    icon: <GitBranch size={20} />,
  },
  {
    type: 'security',
    label: 'Security Audit',
    description: 'Auditoria multi-agente de seguranca e qualidade.',
    icon: <Shield size={20} />,
  },
  {
    type: 'feature',
    label: 'Feature Pipeline',
    description: 'Adicionar uma feature a um projeto/repositorio existente.',
    icon: <Code size={20} />,
  },
  {
    type: 'architecture-review',
    label: 'Architecture Review',
    description: 'Mapeia arquitetura, escolhe alvo, fecha decisoes e gera SPEC implementavel.',
    icon: <Network size={20} />,
  },
  {
    type: 'bug',
    label: 'Bug Pipe',
    description: 'Do relato do bug ate a correcao. Diagnostico, tres analises em paralelo e plano de correcao.',
    icon: <Bug size={20} />,
    idleIconClass: 'text-red-400',
  },
];

const TYPES_WITH_SUGGESTED_PATHS = new Set<PipelineType>(['development', 'development-v2', 'feature']);

interface FieldErrors {
  name?: string;
  description?: string;
  projectPath?: string;
}

interface NewPipelineModalProps {
  onClose: () => void;
  onCreated: (projectId: string, startPhase: number) => Promise<void>;
}

export function NewPipelineModal({ onClose, onCreated }: NewPipelineModalProps) {
  const { createProject, projects } = usePipelineStore();

  const [step, setStep] = useState<0 | 1 | 2>(0);

  const [pipelineType, setPipelineType] = useState<PipelineType | null>(null);

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [projectPath, setProjectPath] = useState('');

  const [suggestedSpecPath, setSuggestedSpecPath] = useState<string | null>(null);
  const [suggestedPrdPath, setSuggestedPrdPath] = useState<string | null>(null);

  const [selectedPhase, setSelectedPhase] = useState<number>(1);

  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [creating, setCreating] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const nameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (step === 1) {
      nameInputRef.current?.focus();
    }
  }, [step]);

  useEffect(() => {
    if (pipelineType === 'security') {
      setSelectedPhase(SECURITY_ENTRY_POINTS[0].phase);
    } else if (pipelineType === 'feature') {
      setSelectedPhase(FEATURE_ENTRY_POINTS[0].phase);
    } else if (pipelineType === 'architecture-review') {
      setSelectedPhase(ARCHITECTURE_ENTRY_POINTS[0].phase);
    } else if (pipelineType === 'development-v2') {
      setSelectedPhase(DEV_V2_ENTRY_POINTS[0].phase);
    } else if (pipelineType === 'bug') {
      setSelectedPhase(BUG_ENTRY_POINTS[0].phase);
    } else {
      setSelectedPhase(DEV_ENTRY_POINTS[0].phase);
    }
  }, [pipelineType]);

  useEffect(() => {
    const path = projectPath.trim();
    const useSuggested = pipelineType !== null && TYPES_WITH_SUGGESTED_PATHS.has(pipelineType);
    if (!path || !useSuggested) {
      setSuggestedSpecPath(null);
      setSuggestedPrdPath(null);
      return;
    }
    const base = path.replace(/\/$/, '');
    setSuggestedSpecPath(`${base}/SPEC.md`);
    setSuggestedPrdPath(`${base}/PRD.md`);
  }, [projectPath, pipelineType]);

  const handlePickDirectory = async () => {
    const dir = await window.lionclaw.shell.selectDirectory();
    if (dir) setProjectPath(dir);
  };

  const validateStep1 = (): FieldErrors => {
    const errors: FieldErrors = {};

    const trimmedName = name.trim();
    if (!trimmedName) {
      errors.name = 'Nome e obrigatorio.';
    } else if (trimmedName.length < 3) {
      errors.name = 'Nome deve ter pelo menos 3 caracteres.';
    } else if (trimmedName.length > 100) {
      errors.name = 'Nome deve ter no maximo 100 caracteres.';
    } else {
      const duplicate = projects.some((p) => p.name.toLowerCase() === trimmedName.toLowerCase());
      if (duplicate) {
        errors.name = 'Ja existe um pipeline com esse nome.';
      }
    }

    if (description.trim().length > 500) {
      errors.description = 'Descricao deve ter no maximo 500 caracteres.';
    }

    if (!projectPath.trim()) {
      errors.projectPath = 'Caminho do projeto e obrigatorio.';
    }

    return errors;
  };

  const [touched, setTouched] = useState<Record<string, boolean>>({});

  const liveErrors = validateStep1();
  const isStep1Valid = Object.keys(liveErrors).length === 0;

  const visibleErrors: FieldErrors = {};
  for (const key of Object.keys(liveErrors) as Array<keyof FieldErrors>) {
    if (touched[key] || fieldErrors[key]) {
      visibleErrors[key] = liveErrors[key];
    }
  }

  const handleNextFromStep0 = () => {
    if (pipelineType !== null) {
      setStep(1);
    }
  };

  const handleNextFromStep1 = () => {
    setFieldErrors(liveErrors);
    setTouched({ name: true, description: true, projectPath: true });
    if (Object.keys(liveErrors).length === 0) {
      setStep(2);
    }
  };

  const handleCreate = async () => {
    setCreating(true);
    setSubmitError(null);

    try {
      const useSuggestedPaths = pipelineType !== null && TYPES_WITH_SUGGESTED_PATHS.has(pipelineType);
      const projectId = await createProject({
        name: name.trim(),
        description: description.trim(),
        projectPath: projectPath.trim(),
        startPhase: selectedPhase,
        specPath: useSuggestedPaths ? (suggestedSpecPath ?? undefined) : undefined,
        prdPath: useSuggestedPaths ? (suggestedPrdPath ?? undefined) : undefined,
        pipelineType: pipelineType ?? 'development',
      });

      await onCreated(projectId, selectedPhase);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setSubmitError(msg);
      setCreating(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') onClose();
  };

  const entryPoints =
    pipelineType === 'security'
      ? SECURITY_ENTRY_POINTS
      : pipelineType === 'feature'
        ? FEATURE_ENTRY_POINTS
        : pipelineType === 'architecture-review'
          ? ARCHITECTURE_ENTRY_POINTS
          : pipelineType === 'development-v2'
            ? DEV_V2_ENTRY_POINTS
            : pipelineType === 'bug'
              ? BUG_ENTRY_POINTS
              : DEV_ENTRY_POINTS;

  const stepLabel =
    step === 0 ? 'Tipo de pipeline (1/3)' : step === 1 ? 'Dados do projeto (2/3)' : 'Ponto de entrada (3/3)';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onKeyDown={handleKeyDown}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bg-zinc-900 border border-zinc-800 rounded-2xl w-full max-w-md mx-4 shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-800">
          <div>
            <h2 className="text-sm font-bold text-zinc-100">Novo Pipeline</h2>
            <p className="text-xs text-zinc-500 mt-0.5">{stepLabel}</p>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-zinc-800 text-zinc-500 hover:text-zinc-300 transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        {/* Step indicator dots */}
        <div className="flex items-center justify-center gap-2 pt-4 pb-1">
          <div
            className={`w-2 h-2 rounded-full transition-colors ${step === 0 ? 'bg-amber-500' : step > 0 ? 'bg-green-500' : 'bg-zinc-700'}`}
          />
          <div
            className={`w-2 h-2 rounded-full transition-colors ${step === 1 ? 'bg-amber-500' : step > 1 ? 'bg-green-500' : 'bg-zinc-700'}`}
          />
          <div className={`w-2 h-2 rounded-full transition-colors ${step === 2 ? 'bg-amber-500' : 'bg-zinc-700'}`} />
        </div>

        {/* Body */}
        <div className="px-5 py-4 space-y-4">
          {step === 0 ? (
            <div className="space-y-2">
              {PIPELINE_TYPES.map((opt) => (
                <button
                  key={opt.type}
                  onClick={() => setPipelineType(opt.type)}
                  className={`w-full text-left p-3.5 rounded-xl border transition-all ${
                    pipelineType === opt.type
                      ? 'bg-amber-500/10 border-amber-500/50'
                      : 'bg-zinc-800/50 border-zinc-700 hover:border-zinc-600'
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <span
                      className={`shrink-0 ${pipelineType === opt.type ? 'text-amber-400' : (opt.idleIconClass ?? 'text-zinc-500')}`}
                    >
                      {opt.icon}
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-1.5">
                          <span className="text-xs font-semibold text-zinc-100">{opt.label}</span>
                        </div>
                        <div
                          className={`w-4 h-4 rounded-full border-2 flex items-center justify-center transition-colors ${
                            pipelineType === opt.type ? 'border-amber-500 bg-amber-500' : 'border-zinc-600'
                          }`}
                        >
                          {pipelineType === opt.type && <div className="w-1.5 h-1.5 rounded-full bg-white" />}
                        </div>
                      </div>
                      <p className="text-[11px] text-zinc-500 mt-0.5">{opt.description}</p>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          ) : step === 1 ? (
            <>
              {/* Name */}
              <div>
                <label className="block text-xs font-medium text-zinc-400 mb-1.5">
                  Nome do projeto <span className="text-red-400">*</span>
                </label>
                <input
                  ref={nameInputRef}
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onBlur={() => setTouched((prev) => ({ ...prev, name: true }))}
                  placeholder="Meu Projeto"
                  className={`w-full bg-zinc-800 border rounded-lg px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 outline-none focus:border-amber-500/60 transition-colors ${
                    visibleErrors.name ? 'border-red-500/60' : 'border-zinc-700'
                  }`}
                />
                {visibleErrors.name && (
                  <p className="mt-1 text-red-400" style={{ fontSize: '12px' }}>
                    {visibleErrors.name}
                  </p>
                )}
              </div>

              {/* Description */}
              <div>
                <label className="block text-xs font-medium text-zinc-400 mb-1.5">
                  Descricao <span className="text-zinc-600">(opcional)</span>
                </label>
                <input
                  type="text"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  onBlur={() => setTouched((prev) => ({ ...prev, description: true }))}
                  placeholder="Breve descricao do projeto"
                  className={`w-full bg-zinc-800 border rounded-lg px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 outline-none focus:border-amber-500/60 transition-colors ${
                    visibleErrors.description ? 'border-red-500/60' : 'border-zinc-700'
                  }`}
                />
                {visibleErrors.description && (
                  <p className="mt-1 text-red-400" style={{ fontSize: '12px' }}>
                    {visibleErrors.description}
                  </p>
                )}
                <p className="text-[11px] text-zinc-600 mt-1 text-right">{description.length}/500</p>
              </div>

              {/* Project path */}
              <div>
                <label className="block text-xs font-medium text-zinc-400 mb-1.5">
                  Caminho do projeto <span className="text-red-400">*</span>
                </label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={projectPath}
                    onChange={(e) => setProjectPath(e.target.value)}
                    onBlur={() => setTouched((prev) => ({ ...prev, projectPath: true }))}
                    placeholder="/Users/eu/meu-projeto"
                    className={`flex-1 min-w-0 bg-zinc-800 border rounded-lg px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 outline-none focus:border-amber-500/60 transition-colors font-mono text-xs ${
                      visibleErrors.projectPath ? 'border-red-500/60' : 'border-zinc-700'
                    }`}
                  />
                  <button
                    onClick={() => {
                      void handlePickDirectory();
                    }}
                    className="shrink-0 flex items-center gap-1.5 px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-lg text-xs text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700 transition-colors"
                    title="Selecionar pasta"
                  >
                    <Folder size={14} />
                    Escolher
                  </button>
                </div>
                {visibleErrors.projectPath && (
                  <p className="mt-1 text-red-400" style={{ fontSize: '12px' }}>
                    {visibleErrors.projectPath}
                  </p>
                )}

                {/* Suggested path hints — development and development-v2 pipelines */}
                {(pipelineType === 'development' || pipelineType === 'development-v2') &&
                  projectPath.trim() &&
                  (suggestedSpecPath || suggestedPrdPath) && (
                    <div className="mt-2 space-y-1">
                      {suggestedSpecPath && (
                        <div className="flex items-center gap-1.5 text-[11px] text-zinc-500">
                          <FileText size={11} />
                          <span>SPEC.md — Caminho sugerido, sera verificado ao criar</span>
                        </div>
                      )}
                      {suggestedPrdPath && (
                        <div className="flex items-center gap-1.5 text-[11px] text-zinc-500">
                          <FileText size={11} />
                          <span>PRD.md — Caminho sugerido, sera verificado ao criar</span>
                        </div>
                      )}
                    </div>
                  )}
              </div>
            </>
          ) : (
            <>
              {/* Step 2: Entry point selection */}
              <div className="space-y-2">
                {entryPoints.map((ep) => (
                  <button
                    key={ep.phase}
                    onClick={() => setSelectedPhase(ep.phase)}
                    className={`w-full text-left p-3.5 rounded-xl border transition-all ${
                      selectedPhase === ep.phase
                        ? 'bg-amber-500/10 border-amber-500/50'
                        : 'bg-zinc-800/50 border-zinc-700 hover:border-zinc-600'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold text-zinc-100">{ep.label}</span>
                      <div
                        className={`w-4 h-4 rounded-full border-2 flex items-center justify-center transition-colors ${
                          selectedPhase === ep.phase ? 'border-amber-500 bg-amber-500' : 'border-zinc-600'
                        }`}
                      >
                        {selectedPhase === ep.phase && <div className="w-1.5 h-1.5 rounded-full bg-white" />}
                      </div>
                    </div>
                    <p className="text-[11px] text-zinc-500 mt-1">{ep.description}</p>
                  </button>
                ))}
              </div>

              {/* Submit error */}
              {submitError && (
                <div className="px-3 py-2.5 bg-red-500/10 border border-red-500/30 rounded-lg">
                  <p className="text-xs text-red-300">{submitError}</p>
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-between gap-2 px-5 py-4 border-t border-zinc-800">
          {step === 0 ? (
            <>
              <button
                onClick={onClose}
                className="px-4 py-2 text-xs font-medium text-zinc-400 hover:text-zinc-200 bg-zinc-800 hover:bg-zinc-700 rounded-lg transition-colors"
              >
                Cancelar
              </button>
              <button
                onClick={handleNextFromStep0}
                disabled={pipelineType === null}
                className="flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-amber-600 hover:bg-amber-500 rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Proximo
                <ChevronRight size={14} />
              </button>
            </>
          ) : step === 1 ? (
            <>
              <button
                onClick={() => setStep(0)}
                className="flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-zinc-400 hover:text-zinc-200 bg-zinc-800 hover:bg-zinc-700 rounded-lg transition-colors"
              >
                <ChevronLeft size={14} />
                Voltar
              </button>
              <button
                onClick={handleNextFromStep1}
                disabled={!isStep1Valid}
                className="flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-amber-600 hover:bg-amber-500 rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Proximo
                <ChevronRight size={14} />
              </button>
            </>
          ) : (
            <>
              <button
                onClick={() => setStep(1)}
                disabled={creating}
                className="flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-zinc-400 hover:text-zinc-200 bg-zinc-800 hover:bg-zinc-700 rounded-lg transition-colors disabled:opacity-40"
              >
                <ChevronLeft size={14} />
                Voltar
              </button>
              <button
                onClick={() => {
                  void handleCreate();
                }}
                disabled={creating}
                className="flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-amber-600 hover:bg-amber-500 rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {creating ? (
                  <>
                    <Loader2 size={13} className="animate-spin" />
                    Criando...
                  </>
                ) : (
                  'Criar Pipeline'
                )}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
