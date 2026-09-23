import { useEffect, useState } from 'react';
import type { SwarmSettings as Settings } from '@/types/swarm';
export function SwarmSettings() {
  const [value, setValue] = useState<Settings | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    window.lionclaw.swarm
      .getSettings()
      .then((result) => {
        if (live) {
          if ('error' in result) setError(result.error);
          else setValue(result);
        }
      })
      .catch((e) => {
        if (live) setError(String(e));
      });
    return () => {
      live = false;
    };
  }, []);
  return (
    <section className="space-y-3 rounded-lg border border-zinc-800 p-4">
      <h2 className="text-sm font-medium text-zinc-200">Swarm</h2>
      <p className="text-xs text-zinc-500">Análises paralelas. Tentativas e timeouts valem para novas execuções.</p>
      {value && (
        <>
          <div className="grid grid-cols-2 gap-3">
            {(
              [
                ['concurrencyCap', 'Concorrência máxima', 1],
                ['maxAttempts', 'Tentativas por item', 1],
                ['idleTimeoutMs', 'Sem atividade (minutos)', 60000],
                ['hardTimeoutMs', 'Teto por item (minutos)', 60000],
              ] as const
            ).map(([key, label, unit]) => (
              <label key={key} className="text-xs text-zinc-400">
                {label}
                <input
                  type="number"
                  min={1}
                  step={1}
                  value={value[key] / unit}
                  className="mt-1 w-full rounded bg-zinc-900 p-2 text-zinc-100"
                  onChange={(event) => setValue({ ...value, [key]: Number(event.target.value) * unit })}
                />
              </label>
            ))}
          </div>
          <button
            disabled={busy}
            className="rounded bg-emerald-700 px-3 py-1.5 text-xs text-white disabled:opacity-50"
            onClick={async () => {
              setBusy(true);
              setError('');
              try {
                const result = await window.lionclaw.swarm.setSettings(value);
                if ('error' in result) setError(result.error);
                else setValue(result);
              } catch (e) {
                setError(String(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? 'Salvando...' : 'Salvar Swarm'}
          </button>
        </>
      )}
      {error && (
        <p role="alert" className="text-xs text-red-400">
          {error}
        </p>
      )}
    </section>
  );
}
