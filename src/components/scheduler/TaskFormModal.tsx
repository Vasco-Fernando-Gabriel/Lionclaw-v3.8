import { useState, useEffect } from 'react';
import { X } from 'lucide-react';
import type { ScheduledTask, AgentConfig, TaskInput } from '@/types';

interface Props {
  mode: 'create' | 'edit';
  task?: ScheduledTask;
  onSave: (input: TaskInput) => void;
  onClose: () => void;
}

const DAY_NAMES = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sab'];
const CRON_REFERENCE_UTC_SUNDAY = Date.UTC(2026, 0, 4);
const CRON_REFERENCE_LOCAL_SUNDAY = new Date(2026, 0, 4).getTime();

type ScheduleMode = 'recurrent' | 'once' | 'interval';

function scheduleTypeToMode(st: ScheduledTask['scheduleType']): ScheduleMode {
  if (st === 'cron') return 'recurrent';
  if (st === 'once') return 'once';
  return 'interval';
}

export function parseCronToState(cron: string): { time: string; days: number[] } {
  try {
    const parts = cron.trim().split(/\s+/);
    const minute = Number(parts[0] ?? 0);
    const hour = Number(parts[1] ?? 6);
    const dayOfWeek = parts[4] || '*';
    const cronDays = dayOfWeek === '*'
      ? [0, 1, 2, 3, 4, 5, 6]
      : dayOfWeek.split(',').map(Number).filter((n) => !isNaN(n));

    const localDates = cronDays.map((day) => new Date(CRON_REFERENCE_UTC_SUNDAY + day * 86400000 + hour * 3600000 + minute * 60000));
    const firstLocal = localDates[0] ?? new Date(CRON_REFERENCE_UTC_SUNDAY + 6 * 3600000);
    const time = `${String(firstLocal.getHours()).padStart(2, '0')}:${String(firstLocal.getMinutes()).padStart(2, '0')}`;
    const days = Array.from(new Set(localDates.map((date) => date.getDay()))).sort();

    return { time, days };
  } catch {
    return { time: '06:00', days: [1, 2, 3, 4, 5] };
  }
}

export function buildUtcCronFromLocalState(time: string, days: number[]): string {
  const [hourRaw, minuteRaw] = time.split(':');
  const hour = Number(hourRaw ?? 6);
  const minute = Number(minuteRaw ?? 0);
  const selectedDays = days.length === 7 ? [0, 1, 2, 3, 4, 5, 6] : days;

  const utcDates = selectedDays.map((day) => new Date(CRON_REFERENCE_LOCAL_SUNDAY + day * 86400000 + hour * 3600000 + minute * 60000));
  const firstUtc = utcDates[0] ?? new Date(CRON_REFERENCE_LOCAL_SUNDAY + 6 * 3600000);
  const utcMinute = String(firstUtc.getUTCMinutes());
  const utcHour = String(firstUtc.getUTCHours());
  const utcDays = Array.from(new Set(utcDates.map((date) => date.getUTCDay()))).sort();
  const dayStr = utcDays.length === 7 ? '*' : utcDays.join(',');

  return `${utcMinute} ${utcHour} * * ${dayStr}`;
}

function parseIntervalToState(ms: string): { amount: number; unit: 'minutes' | 'hours' | 'days' } {
  const val = parseInt(ms, 10);
  if (isNaN(val) || val <= 0) return { amount: 1, unit: 'hours' };

  if (val % 86400000 === 0) return { amount: val / 86400000, unit: 'days' };
  if (val % 3600000 === 0) return { amount: val / 3600000, unit: 'hours' };
  return { amount: Math.round(val / 60000), unit: 'minutes' };
}

function getSchedulePreview(
  scheduleMode: ScheduleMode,
  time: string,
  days: number[],
  onceDate: string,
  intervalAmount: number,
  intervalUnit: 'minutes' | 'hours' | 'days',
): string {
  if (scheduleMode === 'recurrent') {
    if (days.length === 7 || days.length === 0) return `Todo dia as ${time}`;
    return `${days.map((d) => DAY_NAMES[d]).join(', ')} as ${time}`;
  }
  if (scheduleMode === 'interval') {
    const unitLabel = { minutes: 'minutos', hours: 'horas', days: 'dias' }[intervalUnit];
    return `A cada ${intervalAmount} ${unitLabel}`;
  }
  if (scheduleMode === 'once' && onceDate) {
    try {
      return `Uma vez em ${new Date(onceDate).toLocaleString('pt-BR')}`;
    } catch {
      return '';
    }
  }
  return '';
}

export function TaskFormModal({ mode, task, onSave, onClose }: Props) {
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [subagent, setSubagent] = useState('');
  const [scheduleMode, setScheduleMode] = useState<ScheduleMode>('recurrent');
  const [time, setTime] = useState('06:00');
  const [days, setDays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [onceDate, setOnceDate] = useState('');
  const [intervalAmount, setIntervalAmount] = useState(1);
  const [intervalUnit, setIntervalUnit] = useState<'minutes' | 'hours' | 'days'>('hours');
  const [status, setStatus] = useState<'active' | 'paused'>('active');
  const [notify, setNotify] = useState(true);
  const [tagsInput, setTagsInput] = useState('');
  const [agents, setAgents] = useState<AgentConfig[]>([]);

  useEffect(() => {
    window.lionclaw.agents.list().then(setAgents).catch(() => setAgents([]));
  }, []);

  useEffect(() => {
    if (mode === 'edit' && task) {
      setName(task.name);
      setPrompt(task.prompt);
      setSubagent(task.subagent ?? '');
      setStatus(task.status === 'completed' ? 'active' : task.status);
      setNotify(task.notify);
      setTagsInput((task.tags || []).join(', '));

      const m = scheduleTypeToMode(task.scheduleType);
      setScheduleMode(m);

      if (m === 'recurrent') {
        const parsed = parseCronToState(task.scheduleValue);
        setTime(parsed.time);
        setDays(parsed.days);
      } else if (m === 'interval') {
        const parsed = parseIntervalToState(task.scheduleValue);
        setIntervalAmount(parsed.amount);
        setIntervalUnit(parsed.unit);
      } else if (m === 'once') {
        setOnceDate(task.scheduleValue);
      }
    }
  }, [mode, task]);

  const toggleDay = (day: number) => {
    setDays((prev) =>
      prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day].sort(),
    );
  };

  const toggleAllDays = () => {
    if (days.length === 7) {
      setDays([1, 2, 3, 4, 5]);
    } else {
      setDays([0, 1, 2, 3, 4, 5, 6]);
    }
  };

  function buildScheduleValue(): { type: ScheduledTask['scheduleType']; value: string } {
    if (scheduleMode === 'recurrent') {
      return { type: 'cron', value: buildUtcCronFromLocalState(time, days) };
    }
    if (scheduleMode === 'interval') {
      const ms = intervalAmount * { minutes: 60000, hours: 3600000, days: 86400000 }[intervalUnit];
      return { type: 'interval', value: String(ms) };
    }
    return { type: 'once', value: onceDate };
  }

  const handleSubmit = () => {
    if (!name.trim() || !prompt.trim()) return;

    const schedule = buildScheduleValue();
    if (!schedule.value.trim()) return;

    const input: TaskInput = {
      name: name.trim(),
      prompt: prompt.trim(),
      subagent: subagent || undefined,
      scheduleType: schedule.type,
      scheduleValue: schedule.value,
      status,
      notify,
      tags: tagsInput.split(',').map(t => t.trim()).filter(Boolean),
    };

    onSave(input);
  };

  const preview = getSchedulePreview(scheduleMode, time, days, onceDate, intervalAmount, intervalUnit);

  const isValid = name.trim() !== '' && prompt.trim() !== '' && (
    (scheduleMode === 'recurrent' && days.length > 0) ||
    (scheduleMode === 'interval' && intervalAmount > 0) ||
    (scheduleMode === 'once' && onceDate.trim() !== '')
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="bg-zinc-900 border border-zinc-700 rounded-xl w-full max-w-2xl max-h-[90vh] flex flex-col shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-800">
          <h2 className="text-base font-semibold text-zinc-100">
            {mode === 'create' ? 'Nova Tarefa' : `Editando: ${task?.name}`}
          </h2>
          <button
            onClick={onClose}
            className="p-1 rounded-lg hover:bg-zinc-800 text-zinc-500 hover:text-zinc-300"
          >
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-5">
          {/* Name */}
          <div>
            <label className="block text-xs text-zinc-400 mb-1.5">Nome</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="minha-tarefa"
              disabled={mode === 'edit'}
              className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 outline-none focus:border-amber-600 disabled:opacity-50 disabled:cursor-not-allowed"
            />
          </div>

          {/* Prompt */}
          <div>
            <label className="block text-xs text-zinc-400 mb-1.5">Prompt</label>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="O que o agente deve executar nesta tarefa..."
              rows={4}
              className="w-full bg-zinc-950 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 outline-none focus:border-amber-600 resize-y"
              spellCheck={false}
            />
          </div>

          {/* Subagent */}
          <div>
            <label className="block text-xs text-zinc-400 mb-1.5">Subagente</label>
            <select
              value={subagent}
              onChange={(e) => setSubagent(e.target.value)}
              className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-200 outline-none focus:border-amber-600"
            >
              <option value="">Orquestrador (padrao)</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </div>

          {/* Tags */}
          <div>
            <label className="block text-xs text-zinc-400 mb-1.5">Tags (opcional)</label>
            <input
              type="text"
              value={tagsInput}
              onChange={(e) => setTagsInput(e.target.value)}
              placeholder="marketing, emails, relatorio (separar por virgula)"
              className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 outline-none focus:border-amber-600"
            />
            <p className="text-[10px] text-zinc-600 mt-1">Separar por virgula. Usado para filtrar na Agenda.</p>
          </div>

          {/* Schedule */}
          <div className="border border-zinc-800 rounded-lg p-4 space-y-4">
            <p className="text-xs font-medium text-zinc-400 uppercase tracking-wider">Agendamento</p>

            {/* Schedule mode tabs */}
            <div className="flex gap-1 bg-zinc-800 rounded-lg p-1">
              {([['recurrent', 'Recorrente'], ['once', 'Uma vez'], ['interval', 'Intervalo']] as const).map(([key, label]) => (
                <button
                  key={key}
                  onClick={() => setScheduleMode(key)}
                  className={`flex-1 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                    scheduleMode === key
                      ? 'bg-amber-600 text-white'
                      : 'text-zinc-400 hover:text-zinc-200'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>

            {/* Recurrent options */}
            {scheduleMode === 'recurrent' && (
              <div className="space-y-3">
                <div>
                  <label className="block text-xs text-zinc-400 mb-1.5">Horario</label>
                  <input
                    type="time"
                    value={time}
                    onChange={(e) => setTime(e.target.value)}
                    className="bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-200 outline-none focus:border-amber-600"
                  />
                </div>
                <div>
                  <label className="block text-xs text-zinc-400 mb-1.5">Repetir</label>
                  <div className="flex gap-1.5 flex-wrap">
                    {DAY_NAMES.map((dayName, idx) => (
                      <button
                        key={idx}
                        onClick={() => toggleDay(idx)}
                        className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                          days.includes(idx)
                            ? 'bg-amber-600 text-white'
                            : 'bg-zinc-800 text-zinc-400 hover:text-zinc-200 border border-zinc-700'
                        }`}
                      >
                        {dayName}
                      </button>
                    ))}
                  </div>
                  <button
                    onClick={toggleAllDays}
                    className="mt-2 text-[11px] text-zinc-500 hover:text-zinc-300 transition-colors"
                  >
                    {days.length === 7 ? 'Dias uteis' : 'Todo dia'}
                  </button>
                </div>
              </div>
            )}

            {/* Once options */}
            {scheduleMode === 'once' && (
              <div>
                <label className="block text-xs text-zinc-400 mb-1.5">Data e hora</label>
                <input
                  type="datetime-local"
                  value={onceDate}
                  onChange={(e) => setOnceDate(e.target.value)}
                  className="bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-200 outline-none focus:border-amber-600"
                />
              </div>
            )}

            {/* Interval options */}
            {scheduleMode === 'interval' && (
              <div className="flex items-end gap-3">
                <div>
                  <label className="block text-xs text-zinc-400 mb-1.5">A cada</label>
                  <input
                    type="number"
                    min={1}
                    value={intervalAmount}
                    onChange={(e) => setIntervalAmount(Math.max(1, parseInt(e.target.value, 10) || 1))}
                    className="w-20 bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-200 outline-none focus:border-amber-600"
                  />
                </div>
                <div>
                  <select
                    value={intervalUnit}
                    onChange={(e) => setIntervalUnit(e.target.value as 'minutes' | 'hours' | 'days')}
                    className="bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-200 outline-none focus:border-amber-600"
                  >
                    <option value="minutes">minutos</option>
                    <option value="hours">horas</option>
                    <option value="days">dias</option>
                  </select>
                </div>
              </div>
            )}

            {/* Preview */}
            {preview && (
              <p className="text-xs text-amber-400/80 bg-amber-500/5 border border-amber-500/10 rounded-lg px-3 py-2">
                {preview}
              </p>
            )}
          </div>

          {/* Status & Notify */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs text-zinc-400 mb-1.5">Status</label>
              <select
                value={status}
                onChange={(e) => setStatus(e.target.value as 'active' | 'paused')}
                className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-200 outline-none focus:border-amber-600"
              >
                <option value="active">Ativo</option>
                <option value="paused">Pausado</option>
              </select>
            </div>
            <div className="flex items-end pb-2">
              <label className="flex items-center gap-2 text-sm text-zinc-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={notify}
                  onChange={(e) => setNotify(e.target.checked)}
                  className="rounded border-zinc-600 bg-zinc-800 text-amber-600 focus:ring-amber-600"
                />
                Notificar ao concluir
              </label>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-3 px-5 py-4 border-t border-zinc-800">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-zinc-400 hover:text-zinc-200 border border-zinc-700 rounded-lg transition-colors"
          >
            Cancelar
          </button>
          <button
            onClick={handleSubmit}
            disabled={!isValid}
            className="px-4 py-2 text-sm bg-amber-600 hover:bg-amber-500 disabled:bg-zinc-700 disabled:text-zinc-500 text-white rounded-lg font-medium transition-colors"
          >
            {mode === 'create' ? 'Criar' : 'Salvar'}
          </button>
        </div>
      </div>
    </div>
  );
}
