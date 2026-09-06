import { FileText } from 'lucide-react';


const PHASE_DOC_LABELS: Record<number, string> = {
  1: 'Ver Discovery Notes',
  2: 'Ver User Stories',
  3: 'Ver User Stories',
  4: 'Ver PRD',
  5: 'Ver PRD',
  6: 'Ver SPEC',
  7: 'Ver SPEC',
  8: 'Ver Sprints',
  9: 'Ver Sprints',
};


interface PhaseDocumentButtonProps {
  phase: number;
  label?: string;
  onClick: () => void;
}


export function PhaseDocumentButton({
  phase,
  label: labelOverride,
  onClick,
}: PhaseDocumentButtonProps) {
  const label = labelOverride ?? PHASE_DOC_LABELS[phase];

  if (!label) return null;

  return (
    <button
      onClick={onClick}
      className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-medium bg-zinc-700 hover:bg-zinc-600 text-zinc-300 hover:text-zinc-100 border border-zinc-600 transition-colors shrink-0"
      title={label}
    >
      <FileText size={12} className="shrink-0" />
      <span>{label}</span>
    </button>
  );
}
