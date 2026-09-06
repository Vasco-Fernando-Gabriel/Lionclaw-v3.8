
import { resolveContextWindow, formatContextWindow } from '@/lib/agent-helpers';
import type { AgentConfig } from '@/types';

interface ContextWindowDisplayProps {
  agent: AgentConfig;
}

export function ContextWindowDisplay({ agent }: ContextWindowDisplayProps) {
  if (agent.runtime !== 'external') return null;

  const cw = resolveContextWindow(agent);

  if (cw === null) {
    return (
      <div className="text-xs text-amber-500/80 mt-1">
        Contexto desconhecido. Informe abaixo o limite do modelo.
      </div>
    );
  }

  return (
    <div className="text-xs text-zinc-500 mt-1">
      Contexto: <strong className="text-zinc-400">{formatContextWindow(cw)}</strong>
    </div>
  );
}
