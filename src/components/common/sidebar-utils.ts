import type { PhaseDefinition } from '@/types/pipeline';

export function isActiveSidebarEntry(ps: { isStreaming: boolean; phaseStatus: string }): boolean {
  return ps.isStreaming || ps.phaseStatus === 'running';
}

export function getPhaseLabel(
  currentPhase: number | null,
  phaseStatus: string,
  phases: readonly PhaseDefinition[],
): string {
  if (currentPhase === null) return phaseStatus || 'Aguardando';
  const def = phases.find((p) => p.number === currentPhase);
  return def ? `Fase ${currentPhase} - ${def.name}` : `Fase ${currentPhase}`;
}
