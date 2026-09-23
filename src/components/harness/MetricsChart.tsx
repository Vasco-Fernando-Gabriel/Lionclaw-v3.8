interface ChartDataItem {
  label: string;
  value: number;
  color?: string;
  formattedValue?: string;
  title?: string;
}

interface MetricsChartProps {
  data: ChartDataItem[];
  maxValue?: number;
  formatValue?: (v: number) => string;
}

export function MetricsChart({ data, maxValue, formatValue }: MetricsChartProps) {
  const computed = maxValue ?? Math.max(...data.map((d) => d.value), 0.0001);

  const defaultFormat = (v: number) => String(v);
  const fmt = formatValue ?? defaultFormat;

  const BAR_COLORS = [
    'bg-amber-500',
    'bg-blue-500',
    'bg-emerald-500',
    'bg-purple-500',
    'bg-rose-500',
    'bg-cyan-500',
    'bg-orange-500',
    'bg-indigo-500',
  ];

  return (
    <div className="space-y-2">
      {data.map((item, idx) => {
        const pct = computed > 0 ? Math.min((item.value / computed) * 100, 100) : 0;
        const barColor = item.color ?? BAR_COLORS[idx % BAR_COLORS.length];

        return (
          <div key={item.label} className="flex items-center gap-3">
            <span className="text-xs text-zinc-400 truncate shrink-0" style={{ width: '9rem' }} title={item.label}>
              {item.label}
            </span>
            <div className="flex-1 bg-zinc-800 rounded h-6 overflow-hidden">
              <div
                className={`h-6 rounded ${barColor} transition-all duration-500`}
                style={{ width: `${pct}%`, minWidth: pct > 0 ? '0.25rem' : '0' }}
              />
            </div>
            <span className="text-xs text-zinc-300 shrink-0 w-32 text-right" title={item.title}>
              {item.formattedValue ?? fmt(item.value)}
            </span>
          </div>
        );
      })}
    </div>
  );
}
