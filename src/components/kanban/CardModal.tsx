import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { X, Paperclip, Pencil, Trash2, Archive, ArchiveRestore, Check } from 'lucide-react';
import type { KanbanAttachment, KanbanCardDetail, KanbanCardEvent, KanbanCardPatch } from '@/types/kanban';
import { KANBAN_COLUMNS } from '@/types/kanban';
import { useKanbanStore } from '@/stores/kanban-store';
import { AttachmentViewer } from './AttachmentViewer';
import { TYPE_BADGE_CLASS, PRIORITY_BADGE_CLASS, SEVERITY_BADGE_CLASS, formatDateTime } from './kanban-ui';

const EVENT_LABELS: Record<string, string> = {
  created: 'criou o card',
  moved: 'moveu',
  delivered: 'entregou',
  edited: 'editou',
  reopened: 'reabriu',
  archived: 'arquivou',
  unarchived: 'desarquivou',
  'attachment-added': 'anexou arquivo',
  'attachment-removed': 'removeu anexo',
};

function actorLabel(event: KanbanCardEvent): string {
  if (event.actor !== 'lioncode') return event.actor;
  return event.actorDetail ? `LionCode · ${event.actorDetail}` : 'LionCode';
}

interface CardModalProps {
  detail: KanbanCardDetail;
  onClose: () => void;
}

const inputClass =
  'bg-zinc-950 border border-zinc-700 rounded-lg px-2.5 py-1.5 text-[13px] text-zinc-200 outline-none focus:border-amber-500 w-full';

function EditableSection({
  label,
  value,
  markdown,
  editing,
  onStartEdit,
  onStopEdit,
  onSave,
}: {
  label: string;
  value: string | null;
  markdown?: boolean;
  editing: boolean;
  onStartEdit: () => void;
  onStopEdit: () => void;
  onSave: (v: string | null) => Promise<void>;
}) {
  const [draft, setDraft] = useState('');

  if (!editing && !value) return null;

  return (
    <div className="mt-4">
      <div className="flex items-center gap-2 mb-1.5">
        <span className="text-[10.5px] uppercase tracking-wider text-zinc-500 font-semibold">{label}</span>
        {!editing && (
          <button
            onClick={() => {
              setDraft(value ?? '');
              onStartEdit();
            }}
            className="p-0.5 rounded text-zinc-600 hover:text-zinc-300 transition-colors"
            title={`Editar ${label.toLowerCase()}`}
          >
            <Pencil size={11} />
          </button>
        )}
      </div>
      {editing ? (
        <div className="space-y-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={5}
            className={`${inputClass} font-mono text-xs resize-y`}
            autoFocus
          />
          <div className="flex gap-2">
            <button
              onClick={() => {
                void onSave(draft.trim() === '' ? null : draft).then(onStopEdit);
              }}
              className="px-2.5 py-1 rounded-md text-xs font-medium bg-amber-600 hover:bg-amber-500 text-white transition-colors"
            >
              Salvar
            </button>
            <button
              onClick={onStopEdit}
              className="px-2.5 py-1 rounded-md text-xs text-zinc-400 hover:text-zinc-200 transition-colors"
            >
              Cancelar
            </button>
          </div>
        </div>
      ) : markdown ? (
        <div
          className="bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2.5 prose prose-invert prose-sm max-w-none
          prose-p:text-zinc-300 prose-p:leading-relaxed prose-headings:text-zinc-200
          prose-a:text-amber-500 prose-code:text-amber-400 prose-code:text-xs
          prose-li:text-zinc-300 prose-strong:text-zinc-100"
        >
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{value ?? ''}</ReactMarkdown>
        </div>
      ) : (
        <div className="bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2.5 text-[13px] text-zinc-300 leading-relaxed whitespace-pre-wrap">
          {value}
        </div>
      )}
    </div>
  );
}

export function CardModal({ detail, onClose }: CardModalProps) {
  const { card, events, attachments } = detail;
  const store = useKanbanStore();

  const [editingFields, setEditingFields] = useState(false);
  const [editingSection, setEditingSection] = useState<string | null>(null);
  const [fieldsDraft, setFieldsDraft] = useState<KanbanCardPatch>({});
  const [moveTo, setMoveTo] = useState<string>(card.boardColumn);
  const [moveReason, setMoveReason] = useState('');
  const [commitInput, setCommitInput] = useState('');
  const [viewing, setViewing] = useState<KanbanAttachment | null>(null);

  const patchCard = async (patch: KanbanCardPatch) => {
    await store.updateCard(card.boardPrefix, card.localId, patch);
    await store.refreshOpenCard();
  };

  const fieldDefs: Array<[string, string | null]> = [
    ['Coluna', card.boardColumn],
    ['Tipo', card.type],
    ['Prioridade', card.priority],
    ['Complexidade', card.complexity],
    ...(card.type === 'Bug' ? ([['Severidade', card.severity]] as Array<[string, string | null]>) : []),
    ['Início', card.startDate],
    ['Limite', card.dueDate],
    ['Commit / PR', card.commitUrl],
    ['Documento', card.docRef],
  ];
  const missing = fieldDefs.filter(([, v]) => !v).map(([l]) => l);
  if (!card.problem) missing.push('Problema que resolve');
  if (!card.acceptanceCriteria) missing.push('Critério de aceite');
  if (card.type === 'Bug' && !card.reproduction) missing.push('Reprodução');
  if (card.type === 'Feature' && !card.acceptanceTests) missing.push('Testes de aceite');

  const startFieldsEdit = () => {
    setFieldsDraft({
      title: card.title,
      type: card.type,
      priority: card.priority,
      complexity: card.complexity,
      severity: card.severity,
      startDate: card.startDate,
      dueDate: card.dueDate,
      commitUrl: card.commitUrl,
      docRef: card.docRef,
    });
    setEditingFields(true);
  };

  const saveFields = async () => {
    await patchCard(fieldsDraft);
    setEditingFields(false);
  };

  const handleAttach = async () => {
    const filePath = await window.lionclaw.dialog.openFile();
    if (!filePath) return;
    await store.attachFile(card.boardPrefix, card.localId, filePath);
    await store.refreshOpenCard();
  };

  const handleRemoveAttachment = async (att: KanbanAttachment) => {
    if (!window.confirm(`Remover o anexo "${att.filename}"? O arquivo copiado sera deletado.`)) return;
    await store.removeAttachment(att.id);
    await store.refreshOpenCard();
  };

  const handleDelete = async () => {
    if (
      !window.confirm(
        `Deletar DE VERDADE o card ${card.boardPrefix}-${card.localId}? Historico e anexos serao apagados. Para sumir do board sem perder nada, use Arquivar.`,
      )
    )
      return;
    await store.deleteCardHard(card.boardPrefix, card.localId);
  };

  const selectDraft = (field: 'type' | 'priority' | 'complexity' | 'severity', options: string[]) => (
    <select
      value={(fieldsDraft[field] as string | null) ?? ''}
      onChange={(e) => setFieldsDraft((d) => ({ ...d, [field]: e.target.value || null }))}
      className={inputClass}
    >
      <option value="">(vazio)</option>
      {options.map((o) => (
        <option key={o} value={o}>
          {o}
        </option>
      ))}
    </select>
  );

  return (
    <div className="fixed inset-0 z-50 bg-black/65 flex items-center justify-center p-6" onClick={onClose}>
      <div
        className="bg-zinc-900 border border-zinc-700 rounded-2xl w-full max-w-3xl max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Head */}
        <div className="flex items-start gap-3 px-6 pt-5 pb-3 shrink-0">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-[11px] font-bold text-amber-500 tracking-wide">
                {card.boardPrefix}-{card.localId}
              </span>
              {card.archived && (
                <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-zinc-700/60 text-zinc-400">arquivado</span>
              )}
              <div className="flex gap-1.5">
                {card.type && (
                  <span
                    className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${TYPE_BADGE_CLASS[card.type] ?? ''}`}
                  >
                    {card.type}
                  </span>
                )}
                {card.priority && (
                  <span
                    className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${PRIORITY_BADGE_CLASS[card.priority] ?? ''}`}
                  >
                    {card.priority}
                  </span>
                )}
                {card.severity && (
                  <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${SEVERITY_BADGE_CLASS}`}>
                    {card.severity}
                  </span>
                )}
              </div>
            </div>
            <h2 className="text-lg text-zinc-50 leading-snug mt-1">{card.title}</h2>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-md hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 transition-colors shrink-0"
            title="Fechar"
          >
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div className="overflow-y-auto px-6 pb-5">
          {/* Campos (grid) — edicao por secao */}
          <div className="flex items-center gap-2 mb-1.5">
            <span className="text-[10.5px] uppercase tracking-wider text-zinc-500 font-semibold">Campos</span>
            {!editingFields && (
              <button
                onClick={startFieldsEdit}
                className="p-0.5 rounded text-zinc-600 hover:text-zinc-300 transition-colors"
                title="Editar campos"
              >
                <Pencil size={11} />
              </button>
            )}
          </div>
          {editingFields ? (
            <div className="space-y-3 bg-zinc-950 border border-zinc-800 rounded-lg p-3">
              <div>
                <label className="block text-[10px] uppercase tracking-wider text-zinc-500 font-semibold mb-1">
                  Título
                </label>
                <input
                  type="text"
                  value={fieldsDraft.title ?? ''}
                  onChange={(e) => setFieldsDraft((d) => ({ ...d, title: e.target.value }))}
                  className={inputClass}
                />
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <div>
                  <label className="block text-[10px] uppercase tracking-wider text-zinc-500 font-semibold mb-1">
                    Tipo
                  </label>
                  {selectDraft('type', ['Bug', 'Feature', 'Débito técnico', 'Chore'])}
                </div>
                <div>
                  <label className="block text-[10px] uppercase tracking-wider text-zinc-500 font-semibold mb-1">
                    Prioridade
                  </label>
                  {selectDraft('priority', ['Crítica', 'Alta', 'Média', 'Baixa'])}
                </div>
                <div>
                  <label className="block text-[10px] uppercase tracking-wider text-zinc-500 font-semibold mb-1">
                    Complexidade
                  </label>
                  {selectDraft('complexity', ['Baixa', 'Média', 'Alta'])}
                </div>
                <div>
                  <label className="block text-[10px] uppercase tracking-wider text-zinc-500 font-semibold mb-1">
                    Severidade
                  </label>
                  {selectDraft('severity', ['S1', 'S2', 'S3', 'S4'])}
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[10px] uppercase tracking-wider text-zinc-500 font-semibold mb-1">
                    Início
                  </label>
                  <input
                    type="date"
                    value={fieldsDraft.startDate ?? ''}
                    onChange={(e) => setFieldsDraft((d) => ({ ...d, startDate: e.target.value || null }))}
                    className={inputClass}
                  />
                </div>
                <div>
                  <label className="block text-[10px] uppercase tracking-wider text-zinc-500 font-semibold mb-1">
                    Limite
                  </label>
                  <input
                    type="date"
                    value={fieldsDraft.dueDate ?? ''}
                    onChange={(e) => setFieldsDraft((d) => ({ ...d, dueDate: e.target.value || null }))}
                    className={inputClass}
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[10px] uppercase tracking-wider text-zinc-500 font-semibold mb-1">
                    Commit / PR
                  </label>
                  <input
                    type="text"
                    value={fieldsDraft.commitUrl ?? ''}
                    onChange={(e) => setFieldsDraft((d) => ({ ...d, commitUrl: e.target.value || null }))}
                    className={`${inputClass} font-mono text-xs`}
                  />
                </div>
                <div>
                  <label className="block text-[10px] uppercase tracking-wider text-zinc-500 font-semibold mb-1">
                    Documento
                  </label>
                  <input
                    type="text"
                    value={fieldsDraft.docRef ?? ''}
                    onChange={(e) => setFieldsDraft((d) => ({ ...d, docRef: e.target.value || null }))}
                    className={`${inputClass} font-mono text-xs`}
                  />
                </div>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => void saveFields()}
                  className="px-2.5 py-1 rounded-md text-xs font-medium bg-amber-600 hover:bg-amber-500 text-white transition-colors"
                >
                  Salvar
                </button>
                <button
                  onClick={() => setEditingFields(false)}
                  className="px-2.5 py-1 rounded-md text-xs text-zinc-400 hover:text-zinc-200 transition-colors"
                >
                  Cancelar
                </button>
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-2.5">
              {fieldDefs
                .filter(([, v]) => v)
                .map(([label, value]) => (
                  <div key={label}>
                    <p className="text-[10px] uppercase tracking-wider text-zinc-500 font-semibold">{label}</p>
                    {label === 'Commit / PR' && value && value.startsWith('http') ? (
                      <a
                        href={value}
                        target="_blank"
                        rel="noreferrer"
                        className="text-[13px] text-amber-400 hover:underline break-all font-mono"
                      >
                        {value.replace(/.*\//, '').slice(0, 12)}
                      </a>
                    ) : (
                      <p className="text-[13px] text-zinc-200 break-all">{value}</p>
                    )}
                  </div>
                ))}
            </div>
          )}
          {missing.length > 0 && (
            <p className="text-xs text-zinc-600 italic mt-2.5">Nao preenchido: {missing.join(' · ')}</p>
          )}

          {/* Secoes de texto (edicao inline por secao) */}
          {(
            [
              {
                key: 'problem',
                label: 'Problema que resolve',
                value: card.problem,
                markdown: false,
                applies: true,
                save: (v: string | null) => patchCard({ problem: v }),
              },
              {
                key: 'acceptanceCriteria',
                label: 'Critério de aceite',
                value: card.acceptanceCriteria,
                markdown: false,
                applies: true,
                save: (v: string | null) => patchCard({ acceptanceCriteria: v }),
              },
              {
                key: 'reproduction',
                label: 'Reprodução (bug)',
                value: card.reproduction,
                markdown: false,
                applies: card.type === 'Bug',
                save: (v: string | null) => patchCard({ reproduction: v }),
              },
              {
                key: 'acceptanceTests',
                label: 'Testes de aceite (feature)',
                value: card.acceptanceTests,
                markdown: false,
                applies: card.type === 'Feature',
                save: (v: string | null) => patchCard({ acceptanceTests: v }),
              },
              {
                key: 'body',
                label: 'Corpo',
                value: card.body,
                markdown: true,
                applies: true,
                save: (v: string | null) => patchCard({ body: v }),
              },
            ] as const
          )
            .filter((s) => s.applies)
            .map((s) => (
              <EditableSection
                key={s.key}
                label={s.label}
                value={s.value}
                markdown={s.markdown}
                editing={editingSection === s.key}
                onStartEdit={() => setEditingSection(s.key)}
                onStopEdit={() => setEditingSection(null)}
                onSave={s.save}
              />
            ))}

          {/* Preencher secao vazia: chips discretos que abrem o editor da secao */}
          <div className="mt-4 flex flex-wrap gap-1.5">
            {(
              [
                ['problem', 'Problema', card.problem, true],
                ['acceptanceCriteria', 'Critério de aceite', card.acceptanceCriteria, true],
                ['reproduction', 'Reprodução', card.reproduction, card.type === 'Bug'],
                ['acceptanceTests', 'Testes de aceite', card.acceptanceTests, card.type === 'Feature'],
                ['body', 'Corpo', card.body, true],
              ] as Array<[string, string, string | null, boolean]>
            )
              .filter(([key, , value, applies]) => applies && !value && editingSection !== key)
              .map(([key, label]) => (
                <button
                  key={key}
                  onClick={() => setEditingSection(key)}
                  className="px-2 py-0.5 rounded-md text-[11px] border border-dashed border-zinc-700 text-zinc-500 hover:text-zinc-300 hover:border-zinc-500 transition-colors"
                >
                  + {label}
                </button>
              ))}
          </div>

          {/* Anexos */}
          <div className="mt-5">
            <span className="text-[10.5px] uppercase tracking-wider text-zinc-500 font-semibold">Anexos</span>
            <div className="flex flex-wrap gap-2 mt-1.5">
              {attachments.map((att) => (
                <span
                  key={att.id}
                  className="inline-flex items-center gap-1.5 bg-zinc-950 border border-zinc-700 rounded-lg pl-2.5 pr-1.5 py-1 text-xs text-zinc-300"
                >
                  <button
                    onClick={() => setViewing(att)}
                    className="inline-flex items-center gap-1.5 hover:text-amber-400 transition-colors"
                    title="Abrir no viewer"
                  >
                    <Paperclip size={11} className="text-amber-500" />
                    {att.filename}
                  </button>
                  <button
                    onClick={() => void handleRemoveAttachment(att)}
                    className="p-0.5 rounded text-zinc-600 hover:text-red-400 transition-colors"
                    title="Remover anexo"
                  >
                    <X size={11} />
                  </button>
                </span>
              ))}
              <button
                onClick={() => void handleAttach()}
                className="px-2.5 py-1 rounded-lg text-xs font-medium border border-zinc-700 text-zinc-300 hover:bg-zinc-800 transition-colors"
              >
                + Anexar
              </button>
            </div>
          </div>

          {/* Timeline */}
          <div className="mt-5">
            <span className="text-[10.5px] uppercase tracking-wider text-zinc-500 font-semibold">Histórico</span>
            <div className="border-l-2 border-zinc-800 ml-1 pl-3.5 mt-2 space-y-2.5">
              {events.map((ev) => (
                <div key={ev.id} className="relative text-xs text-zinc-500">
                  <span className="absolute -left-[19px] top-1 w-1.5 h-1.5 rounded-full bg-zinc-600" />
                  <span className="text-zinc-300 font-medium">
                    {EVENT_LABELS[ev.event] ?? ev.event}
                    {ev.fromColumn && ev.toColumn ? ` ${ev.fromColumn} -> ${ev.toColumn}` : ''}
                  </span>
                  {' · '}
                  <span className="text-amber-500">{actorLabel(ev)}</span>
                  {' · '}
                  {formatDateTime(ev.createdAt)}
                  {ev.reason && <p className="text-zinc-600 break-all">motivo: {ev.reason}</p>}
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Foot: acoes */}
        <div className="border-t border-zinc-800 px-6 py-3 flex items-center gap-2 flex-wrap shrink-0">
          <select value={moveTo} onChange={(e) => setMoveTo(e.target.value)} className={`${inputClass} w-auto`}>
            {KANBAN_COLUMNS.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <input
            type="text"
            value={moveReason}
            onChange={(e) => setMoveReason(e.target.value)}
            placeholder="motivo (opcional)"
            className={`${inputClass} w-36`}
          />
          <button
            onClick={() => {
              void store.moveCard(card.boardPrefix, card.localId, moveTo, moveReason.trim() || null).then(() => {
                setMoveReason('');
                void store.refreshOpenCard();
              });
            }}
            className="px-3 py-1.5 rounded-lg text-xs font-semibold border border-zinc-700 text-zinc-200 hover:bg-zinc-800 transition-colors"
          >
            Mover
          </button>
          <input
            type="text"
            value={commitInput}
            onChange={(e) => setCommitInput(e.target.value)}
            placeholder="URL do commit ou hash"
            className={`${inputClass} w-52 font-mono text-xs`}
          />
          <button
            onClick={() => {
              void store.deliverCard(card.boardPrefix, card.localId, commitInput.trim()).then((ok) => {
                if (ok) {
                  setCommitInput('');
                  void store.refreshOpenCard();
                }
              });
            }}
            disabled={commitInput.trim() === ''}
            title={commitInput.trim() === '' ? 'Informe URL ou hash do commit para entregar' : undefined}
            className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-amber-600 hover:bg-amber-500 text-white transition-colors disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center gap-1.5"
          >
            <Check size={12} /> Entregar
          </button>
          <span className="flex-1" />
          {card.archived ? (
            <button
              onClick={() => {
                void store.unarchiveCard(card.boardPrefix, card.localId).then(() => store.refreshOpenCard());
              }}
              className="px-3 py-1.5 rounded-lg text-xs font-semibold border border-zinc-700 text-zinc-200 hover:bg-zinc-800 transition-colors inline-flex items-center gap-1.5"
            >
              <ArchiveRestore size={12} /> Desarquivar
            </button>
          ) : (
            <button
              onClick={() => {
                void store.archiveCard(card.boardPrefix, card.localId).then(() => store.refreshOpenCard());
              }}
              className="px-3 py-1.5 rounded-lg text-xs font-semibold border border-zinc-700 text-zinc-300 hover:bg-zinc-800 transition-colors inline-flex items-center gap-1.5"
            >
              <Archive size={12} /> Arquivar
            </button>
          )}
          <button
            onClick={() => void handleDelete()}
            className="px-3 py-1.5 rounded-lg text-xs font-semibold border border-red-900/60 text-red-400 hover:bg-red-950/40 transition-colors inline-flex items-center gap-1.5"
            title="Delete real (historico e anexos apagados)"
          >
            <Trash2 size={12} /> Deletar
          </button>
        </div>
      </div>

      {viewing && <AttachmentViewer attachment={viewing} onClose={() => setViewing(null)} />}
    </div>
  );
}
