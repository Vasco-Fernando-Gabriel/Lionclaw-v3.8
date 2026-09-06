import { useState, useEffect } from 'react';

const THINKING_PHRASES = [
  'Processando contexto...',
  'Analisando os dados...',
  'Rugindo para os bugs...',
  'Cacando a solucao...',
  'Afiando as garras...',
  'Farejando o codigo...',
];

export function AgentThinking({ elapsed }: { elapsed?: string }) {
  const neonOrange = '#FF7A00';
  const [phraseIndex, setPhraseIndex] = useState(() => Math.floor(Math.random() * THINKING_PHRASES.length));

  useEffect(() => {
    const interval = setInterval(() => {
      setPhraseIndex(prev => {
        let next: number;
        do { next = Math.floor(Math.random() * THINKING_PHRASES.length); } while (next === prev);
        return next;
      });
    }, 3000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div
      className="flex items-center gap-2.5 py-1"
      style={{ '--agent-neon': neonOrange } as React.CSSProperties}
    >
      <style>{`
        .paw-pad-sm {
          background-color: var(--agent-neon);
          position: absolute;
        }
        .main-pad-sm {
          width: 20px;
          height: 14px;
          bottom: 1px;
          left: 8px;
          border-radius: 40% 40% 50% 50%;
          animation: paw-pulse-sm 1.5s infinite;
        }
        .toe-ct { position: absolute; width: 7px; height: 10px; }
        .toe-s1 { top: 9px; left: 0px; rotate: -35deg; }
        .toe-s2 { top: 2px; left: 9px; rotate: -10deg; }
        .toe-s3 { top: 2px; right: 9px; rotate: 10deg; }
        .toe-s4 { top: 9px; right: 0px; rotate: 35deg; }
        .toe-dot {
          width: 100%; height: 100%;
          background-color: var(--agent-neon);
          border-radius: 50%;
          opacity: 0.3;
          animation: toe-hit 1.5s infinite;
        }
        .td1 { animation-delay: 0s; }
        .td2 { animation-delay: 0.15s; }
        .td3 { animation-delay: 0.3s; }
        .td4 { animation-delay: 0.45s; }
        @keyframes toe-hit {
          0%, 100% { opacity: 0.3; transform: scale(1); }
          50% { opacity: 1; transform: scale(1.15); box-shadow: 0 0 12px var(--agent-neon); }
        }
        @keyframes paw-pulse-sm {
          0%, 100% { transform: scale(0.9); opacity: 0.7; box-shadow: 0 0 6px var(--agent-neon); }
          50% { transform: scale(1.1); opacity: 1; box-shadow: 0 0 14px var(--agent-neon), 0 0 24px var(--agent-neon); }
        }
      `}</style>

      <div className="relative w-[36px] h-[36px]">
        <div className="toe-ct toe-s1"><div className="toe-dot td1" /></div>
        <div className="toe-ct toe-s2"><div className="toe-dot td2" /></div>
        <div className="toe-ct toe-s3"><div className="toe-dot td3" /></div>
        <div className="toe-ct toe-s4"><div className="toe-dot td4" /></div>
        <div className="paw-pad-sm main-pad-sm" />
      </div>

      <span className="text-[10px] font-mono tracking-widest text-zinc-500 uppercase animate-pulse">
        {THINKING_PHRASES[phraseIndex]}
      </span>
      {elapsed && (
        <span className="text-[10px] font-mono tabular-nums text-amber-400/70">{elapsed}</span>
      )}
    </div>
  );
}
