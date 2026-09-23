import { useEffect, useState } from 'react';
import { CheckCircle2, XCircle } from 'lucide-react';
import type { HarnessSprint, HarnessRound } from '@/types';

interface RoundHistoryProps {
  projectId: string;
}

function formatCost(usd: number): string {
  if (usd < 0.001) return '<$0.001';
  return `$${usd.toFixed(3)}`;
}

export function formatHarnessRoundCost(
  round: Pick<HarnessRound, 'coderCostUsd' | 'evaluatorCostUsd' | 'costStatus' | 'subscriptionEquivalentCost'>,
): string {
  const total = round.coderCostUsd + round.evaluatorCostUsd;
  const equivalent = Math.min(total, Math.max(0, round.subscriptionEquivalentCost ?? 0));
  const known =
    equivalent <= 0
      ? formatCost(total)
      : total - equivalent <= 1e-9
        ? `~${formatCost(total)}`
        : `${formatCost(total)} (incl. ~${formatCost(equivalent)})`;
  if (round.costStatus === 'unknown') {
    return total > 0 ? `${known} + nao estim.` : 'Nao estimado';
  }
  if (round.costStatus === 'estimated-partial' && equivalent <= 0) return `~${formatCost(total)}`;
  return known;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}m${rem.toString().padStart(2, '0')}s`;
}

export function RoundHistory({ projectId }: RoundHistoryProps) {
  const [, setCurrentSprint] = useState<HarnessSprint | null>(null);
  const [rounds, setRounds] = useState<HarnessRound[]>([]);

  useEffect(() => {
    let cancelled = false;

    async function loadData() {
      const sprints = await window.lionclaw.harness.getSprints(projectId);
      if (cancelled) return;

      const running = sprints.find((s) => s.status === 'running');
      const target = running ?? sprints.filter((s) => s.roundsUsed > 0).at(-1) ?? null;

      setCurrentSprint(target);

      if (target) {
        const roundData = await window.lionclaw.harness.getRounds(target.id);
        if (!cancelled) setRounds(roundData);
      }
    }

    loadData();

    const unsubSprint = window.lionclaw.harness.onSprintUpdate((data) => {
      const d = data as Record<string, unknown>;
      if (d.projectId === projectId) {
        loadData();
      }
    });

    return () => {
      cancelled = true;
      unsubSprint();
    };
  }, [projectId]);

  const completedRounds = rounds.filter((r) => r.completedAt != null);

  if (completedRounds.length === 0) {
    return (
      <div className="flex items-center gap-2 px-1 py-2">
        <span className="text-[11px] text-zinc-600 italic">Nenhuma rodada concluida ainda.</span>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 flex-wrap py-1">
      {completedRounds.map((round) => {
        const totalCost = round.coderCostUsd + round.evaluatorCostUsd;
        const totalDuration = round.coderDurationMs + round.evaluatorDurationMs;
        const isPass = round.verdict === 'pass';
        const isFail = round.verdict === 'fail';

        return (
          <div
            key={round.id}
            title={round.feedbackSummary ?? undefined}
            className={`flex items-center gap-1.5 px-2 py-1 rounded border text-[10px] font-mono shrink-0 ${
              isPass
                ? 'bg-green-500/10 border-green-800 text-green-400'
                : isFail
                  ? 'bg-red-500/10 border-red-900 text-red-400'
                  : 'bg-zinc-800 border-zinc-700 text-zinc-400'
            }`}
          >
            <span className="font-semibold">R{round.roundNumber}</span>

            {isPass && <CheckCircle2 size={10} className="text-green-400" />}
            {isFail && <XCircle size={10} className="text-red-400" />}

            {(totalCost > 0 || round.costStatus === 'unknown') && (
              <span className="text-[9px] opacity-70">{formatHarnessRoundCost(round)}</span>
            )}
            {totalDuration > 0 && <span className="text-[9px] opacity-70">{formatDuration(totalDuration)}</span>}
          </div>
        );
      })}
    </div>
  );
}
