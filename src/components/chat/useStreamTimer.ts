import { useEffect, useState } from 'react';

function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000);
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export function useStreamTimer(active: boolean, startedAt: number | null): string {
  const [label, setLabel] = useState('');

  useEffect(() => {
    if (!active) {
      setLabel('');
      return;
    }
    const compute = () => {
      const elapsed = startedAt === null ? 0 : Math.max(0, Date.now() - startedAt);
      setLabel(formatElapsed(elapsed));
    };
    compute();
    const id = setInterval(compute, 1000);
    return () => clearInterval(id);
  }, [active, startedAt]);

  return label;
}
