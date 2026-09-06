import { MessageCircleQuestion, CheckCircle2 } from 'lucide-react';
import type { AskQuestion } from '@/types';

interface AskQuestionInlineProps {
  questions: AskQuestion[];
  answers?: Record<string, string | string[]>;
}

export function AskQuestionInline({ questions, answers }: AskQuestionInlineProps) {
  return (
    <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 px-4 py-3">
      <div className="flex items-center gap-2 mb-3">
        <MessageCircleQuestion size={14} className="text-amber-400" />
        <span className="text-xs font-medium text-amber-400">Pergunta do agente</span>
        {answers && (
          <span className="flex items-center gap-1 text-[10px] text-green-400">
            <CheckCircle2 size={10} />
            Respondida
          </span>
        )}
      </div>

      {questions.map((q, i) => (
        <div key={i} className={i > 0 ? 'mt-3 pt-3 border-t border-zinc-800' : ''}>
          <span className="text-[10px] font-semibold uppercase text-amber-400/70 mr-2">{q.header}</span>
          <p className="text-sm text-zinc-300 mb-2">{q.question}</p>

          <div className="flex flex-wrap gap-1.5">
            {q.options.map((opt) => {
              const answer = answers?.[q.question];
              const isChosen = answer
                ? (Array.isArray(answer) ? answer.includes(opt.label) : answer === opt.label)
                : false;

              return (
                <span
                  key={opt.label}
                  className={`inline-flex items-center gap-1 px-2 py-1 rounded text-xs ${
                    isChosen
                      ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
                      : 'bg-zinc-800/50 text-zinc-500 border border-zinc-700/30'
                  }`}
                >
                  {isChosen && <CheckCircle2 size={10} />}
                  {opt.label}
                </span>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
