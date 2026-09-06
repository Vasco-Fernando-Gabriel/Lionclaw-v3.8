import { useState } from 'react';
import { MessageCircleQuestion, Send } from 'lucide-react';
import type { AskQuestionRequest, AskQuestionResponse, AskQuestion } from '@/types';

interface AskQuestionDialogProps {
  request: AskQuestionRequest;
  onSubmit: (response: AskQuestionResponse) => void;
}

export function AskQuestionDialog({ request, onSubmit }: AskQuestionDialogProps) {
  const [answers, setAnswers] = useState<Record<string, string | string[]>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});

  const allAnswered = request.questions.every((q) => {
    const answer = answers[q.question];
    if (q.multiSelect) {
      return Array.isArray(answer) && answer.length > 0;
    }
    return typeof answer === 'string' && answer.length > 0;
  });

  const handleSelect = (question: AskQuestion, label: string) => {
    if (question.multiSelect) {
      const current = (answers[question.question] as string[]) || [];
      const next = current.includes(label)
        ? current.filter((l) => l !== label)
        : [...current, label];
      setAnswers({ ...answers, [question.question]: next });
    } else {
      setAnswers({ ...answers, [question.question]: label });
    }
  };

  const isSelected = (question: AskQuestion, label: string): boolean => {
    const answer = answers[question.question];
    if (question.multiSelect) {
      return Array.isArray(answer) && answer.includes(label);
    }
    return answer === label;
  };

  const handleSubmit = () => {
    if (!allAnswered) return;

    const annotations: AskQuestionResponse['annotations'] = {};
    for (const q of request.questions) {
      const note = notes[q.question];
      if (note) {
        annotations[q.question] = { notes: note };
      }
    }

    onSubmit({
      id: request.id,
      answers,
      ...(Object.keys(annotations).length > 0 ? { annotations } : {}),
    });
  };

  return (
    <div className="mx-auto max-w-3xl mb-3">
      <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4 max-h-[60vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center gap-2 mb-4">
          <div className="w-8 h-8 rounded-lg bg-amber-500/10 flex items-center justify-center">
            <MessageCircleQuestion size={16} className="text-amber-400" />
          </div>
          <span className="text-sm font-medium text-zinc-200">O agente precisa da sua resposta</span>
        </div>

        {/* Questions */}
        <div className="space-y-5">
          {request.questions.map((q, qi) => (
            <div key={qi}>
              {/* Question header + text */}
              <div className="flex items-center gap-2 mb-2">
                <span className="text-[10px] font-semibold uppercase text-amber-400 bg-amber-500/10 px-2 py-0.5 rounded">
                  {q.header}
                </span>
                {q.multiSelect && (
                  <span className="text-[10px] text-zinc-500">(multipla escolha)</span>
                )}
              </div>
              <p className="text-sm text-zinc-300 mb-3">{q.question}</p>

              {/* Options */}
              <div className="space-y-2">
                {q.options.map((opt) => {
                  const selected = isSelected(q, opt.label);
                  return (
                    <button
                      key={opt.label}
                      onClick={() => handleSelect(q, opt.label)}
                      className={`w-full text-left rounded-lg border px-3 py-2.5 transition-colors ${
                        selected
                          ? 'border-amber-500/50 bg-amber-500/10'
                          : 'border-zinc-700/50 bg-zinc-900/50 hover:border-zinc-600'
                      }`}
                    >
                      <div className="flex items-start gap-2.5">
                        {/* Radio/Checkbox indicator */}
                        <div className={`mt-0.5 w-4 h-4 rounded-${q.multiSelect ? 'sm' : 'full'} border flex items-center justify-center shrink-0 ${
                          selected
                            ? 'border-amber-500 bg-amber-500'
                            : 'border-zinc-600'
                        }`}>
                          {selected && (
                            <svg width="10" height="10" viewBox="0 0 10 10" className="text-white">
                              <path d="M2 5l2 2 4-4" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
                            </svg>
                          )}
                        </div>
                        <div className="flex-1 min-w-0">
                          <span className="text-sm font-medium text-zinc-200">{opt.label}</span>
                          <p className="text-xs text-zinc-500 mt-0.5">{opt.description}</p>
                        </div>
                      </div>
                      {/* Preview */}
                      {selected && opt.preview && (
                        <div className="mt-2 ml-6.5 p-2 bg-zinc-800/50 rounded text-xs text-zinc-400 font-mono whitespace-pre-wrap">
                          {opt.preview}
                        </div>
                      )}
                    </button>
                  );
                })}
              </div>

              {/* Optional notes */}
              <div className="mt-3">
                <textarea
                  value={notes[q.question] || ''}
                  onChange={(e) => setNotes({ ...notes, [q.question]: e.target.value })}
                  placeholder="Notas adicionais (opcional)"
                  rows={1}
                  className="w-full bg-zinc-900/50 border border-zinc-700/50 rounded-lg px-3 py-2 text-xs text-zinc-300 placeholder-zinc-600 resize-none outline-none focus:border-amber-500/30 transition-colors"
                />
              </div>
            </div>
          ))}
        </div>

        {/* Submit */}
        <div className="flex justify-end mt-4">
          <button
            onClick={handleSubmit}
            disabled={!allAnswered}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-amber-600 hover:bg-amber-500 text-white text-sm font-medium transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
          >
            <Send size={14} />
            Responder
          </button>
        </div>
      </div>
    </div>
  );
}
