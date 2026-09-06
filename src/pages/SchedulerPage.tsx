import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { ArrowLeft, Bot, User, Trash2, Copy, Check } from 'lucide-react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ScheduledTask, ChatSession, ChatMessage } from '@/types';
import { RejectNoteModal } from '@/components/scheduler/RejectNoteModal';
import { ActivityBoard } from '@/components/scheduler/ActivityBoard';
import { TasksPage } from '@/pages/TasksPage';
import { TaskList } from '@/components/scheduler/TaskList';
import ArtifactRenderer from '@/components/chat/ArtifactRenderer';


function CodeBlock({ className, children }: { className?: string; children: React.ReactNode }) {
  const [copied, setCopied] = useState(false);
  const lang = className?.replace('language-', '') || '';
  const code = String(children).replace(/\n$/, '');

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [code]);

  return (
    <div className="relative group my-3">
      {lang && (
        <div className="flex items-center justify-between px-3 py-1.5 bg-zinc-800/80 border border-zinc-700/50 rounded-t-lg border-b-0">
          <span className="text-[10px] text-zinc-500 font-mono uppercase">{lang}</span>
          <button onClick={handleCopy} className="flex items-center gap-1 text-[10px] text-zinc-500 hover:text-zinc-300 transition-colors">
            {copied ? <Check size={10} /> : <Copy size={10} />}
            {copied ? 'Copiado' : 'Copiar'}
          </button>
        </div>
      )}
      <pre className={`!mt-0 ${lang ? '!rounded-t-none' : ''}`}>
        <code className={className}>{children}</code>
      </pre>
    </div>
  );
}

const markdownComponents: Components = {
  code({ className, children, ...props }) {
    const isInline = !className && typeof children === 'string' && !children.includes('\n');
    if (isInline) {
      return <code className={className} {...props}>{children}</code>;
    }
    return <CodeBlock className={className}>{children}</CodeBlock>;
  },
  pre({ children }) {
    return <>{children}</>;
  },
};

function MessageBubble({ role, content, subagent }: { role: string; content: string; subagent?: string }) {
  const isUser = role === 'user';
  const rendered = useMemo(() => {
    if (isUser) return null;
    return <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>{content}</ReactMarkdown>;
  }, [content, isUser]);

  return (
    <div className={`flex gap-3 items-start ${isUser ? 'flex-row-reverse' : ''}`}>
      <div className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 mt-0.5 ${isUser ? 'bg-zinc-700' : 'bg-amber-500/10'}`}>
        {isUser ? <User size={14} className="text-zinc-300" /> : <Bot size={14} className="text-amber-500" />}
      </div>
      <div className={`rounded-xl px-4 py-3 text-sm max-w-[85%] ${isUser ? 'bg-amber-600 text-white' : 'bg-zinc-900 text-zinc-300 border border-zinc-800'}`}>
        {subagent && !isUser && (
          <span className="text-[10px] text-amber-500/70 font-medium uppercase block mb-1.5">{subagent}</span>
        )}
        {isUser ? (
          <p className="whitespace-pre-wrap selectable">{content}</p>
        ) : (
          <div className="chat-markdown">{rendered}</div>
        )}
      </div>
    </div>
  );
}


export function SchedulerPage() {
  const [activeTab, setActiveTab] = useState<'agenda' | 'tasks' | 'personal'>('agenda');

  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [pendingCount, setPendingCount] = useState(0);
  const [rejectingRunId, setRejectingRunId] = useState<number | null>(null);

  const [schedulerSessions, setSchedulerSessions] = useState<ChatSession[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [sessionMessages, setSessionMessages] = useState<ChatMessage[]>([]);
  const [sessionRunId, setSessionRunId] = useState<number | null>(null);
  const [sessionReviewStatus, setSessionReviewStatus] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const loadTasks = async () => {
    setIsLoading(true);
    const [result, count] = await Promise.all([
      window.lionclaw.scheduler.list(),
      window.lionclaw.scheduler.getPendingReviewCount(),
    ]);
    setTasks(result);
    setPendingCount(count);
    setIsLoading(false);
  };

  const loadSessions = async () => {
    const sessions = await window.lionclaw.scheduler.getSessions();
    setSchedulerSessions(sessions);
  };

  useEffect(() => {
    loadTasks();
    loadSessions();
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [sessionMessages]);

  const handleReviewRun = async (runId: number, status: 'validated' | 'rejected', note?: string) => {
    await window.lionclaw.scheduler.reviewRun(runId, status, note);
    const count = await window.lionclaw.scheduler.getPendingReviewCount();
    setPendingCount(count);
    if (runId === sessionRunId) {
      setSessionReviewStatus(status);
    }
    loadSessions();
    loadTasks();
  };

  const handleViewSession = async (sessionId: string, runId: number, reviewStatus?: string | null) => {
    setSelectedSessionId(sessionId);
    setSessionRunId(runId);
    setSessionReviewStatus(reviewStatus || null);
    const messages = await window.lionclaw.chat.getMessages(sessionId);
    setSessionMessages(messages);
  };

  const handleCloseSession = () => {
    setSelectedSessionId(null);
    setSessionMessages([]);
    setSessionRunId(null);
    setSessionReviewStatus(null);
  };

  const handleDeleteSession = async (sessionId: string) => {
    await window.lionclaw.scheduler.deleteSession(sessionId);
    if (selectedSessionId === sessionId) {
      handleCloseSession();
    }
    loadSessions();
  };

  const formatDateShort = (d: string) => {
    return new Date(d).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  };

  const getSessionLabel = (session: ChatSession) => {
    const title = session.title || 'Sessao';
    return title.replace(/^\[Scheduler\]\s*/, '');
  };

  return (
    <div className="flex h-full">
      {/* Left: Session sidebar */}
      <div className="w-56 border-r border-zinc-800 flex flex-col bg-zinc-900/50 shrink-0">
        <div className="px-3 py-3 border-b border-zinc-800">
          <p className="text-[10px] uppercase text-zinc-500 font-medium tracking-wider">Sessoes do Scheduler</p>
        </div>
        <div className="flex-1 overflow-y-auto px-2 py-1">
          {schedulerSessions.length === 0 ? (
            <p className="text-[11px] text-zinc-600 px-2 py-4 text-center">Nenhuma sessao</p>
          ) : (
            <div className="space-y-0.5">
              {schedulerSessions.map((session) => {
                const isSelected = selectedSessionId === session.id;
                const totalTokens = (session.inputTokens || 0) + (session.outputTokens || 0);
                return (
                  <div
                    key={session.id}
                    className={`group flex items-center rounded-lg transition-colors ${
                      isSelected ? 'bg-zinc-800 border border-amber-500/30' : 'hover:bg-zinc-800/50'
                    }`}
                  >
                    <button
                      onClick={() => handleViewSession(session.id, 0, undefined)}
                      className="flex-1 min-w-0 px-2.5 py-1.5 text-left"
                    >
                      <span className={`text-xs truncate block ${isSelected ? 'text-zinc-200' : 'text-zinc-400'}`}>
                        {getSessionLabel(session)}
                      </span>
                      <span className="text-[9px] text-zinc-600 font-mono">
                        {formatDateShort(session.createdAt)}
                        {session.tokenStatus === 'not_reported'
                          ? ' - tokens nao reportados'
                          : totalTokens > 0
                            ? ` - ${totalTokens >= 1000 ? `${(totalTokens / 1000).toFixed(1)}K` : totalTokens} tok`
                            : ''}
                        {session.costStatus === 'unknown' ? ' - custo nao estimado' : ''}
                      </span>
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDeleteSession(session.id);
                      }}
                      className="p-1 rounded opacity-0 group-hover:opacity-100 text-zinc-600 hover:text-red-400 transition-all mr-1"
                      title="Apagar sessao"
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Right: Content area */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {selectedSessionId ? (
          <>
            <div className="bg-zinc-800/50 border-b border-zinc-700 px-4 py-3 flex items-center justify-between shrink-0">
              <div className="flex items-center gap-3">
                <button
                  onClick={handleCloseSession}
                  className="p-1.5 rounded-lg hover:bg-zinc-700 text-zinc-400 hover:text-zinc-200 transition-colors"
                  title="Voltar"
                >
                  <ArrowLeft size={16} />
                </button>
                <div>
                  <span className="text-sm text-zinc-200">Sessao de tarefa</span>
                  <span className="text-[11px] text-zinc-500 ml-2">
                    {sessionMessages.length} mensagens
                  </span>
                </div>
              </div>
              <div className="flex items-center gap-2">
                {sessionReviewStatus === 'pending_review' && sessionRunId && sessionRunId > 0 && (
                  <>
                    <button
                      onClick={() => handleReviewRun(sessionRunId, 'validated')}
                      className="px-3 py-1.5 text-xs bg-green-600 hover:bg-green-500 text-white rounded-lg font-medium transition-colors"
                    >
                      Validar
                    </button>
                    <button
                      onClick={() => setRejectingRunId(sessionRunId)}
                      className="px-3 py-1.5 text-xs bg-red-600 hover:bg-red-500 text-white rounded-lg font-medium transition-colors"
                    >
                      Rejeitar
                    </button>
                  </>
                )}
                {sessionReviewStatus === 'validated' && (
                  <span className="px-2.5 py-1 text-[11px] font-medium text-green-400 bg-green-500/10 border border-green-500/20 rounded-lg">
                    Validado
                  </span>
                )}
                {sessionReviewStatus === 'rejected' && (
                  <span className="px-2.5 py-1 text-[11px] font-medium text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg">
                    Rejeitado
                  </span>
                )}
              </div>
            </div>

            <div className="flex-1 overflow-y-auto px-4 py-6">
              {sessionMessages.length === 0 ? (
                <div className="text-center py-12 text-zinc-600">
                  <Bot size={32} className="mx-auto mb-3 opacity-50" />
                  <p className="text-sm">Sessao sem mensagens</p>
                </div>
              ) : (
                <div className="max-w-3xl mx-auto space-y-5">
                  {sessionMessages.map((msg) => {
                    const hasArtifacts = msg.metadata?.artifacts && msg.metadata.artifacts.length > 0;
                    return (
                      <div key={msg.id}>
                        <MessageBubble role={msg.role} content={msg.content} subagent={msg.subagent} />
                        {hasArtifacts && msg.metadata!.artifacts!.map((artifact) => (
                          <div key={artifact.id} className="mt-3">
                            <ArtifactRenderer artifact={artifact} />
                          </div>
                        ))}
                      </div>
                    );
                  })}
                  <div ref={messagesEndRef} />
                </div>
              )}
            </div>
          </>
        ) : (
          <>
            {/* Tab bar */}
            <div className="flex items-center gap-1 px-6 pt-4 pb-2 border-b border-zinc-800 shrink-0">
              <button
                onClick={() => setActiveTab('agenda')}
                className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                  activeTab === 'agenda'
                    ? 'bg-amber-600 text-white'
                    : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800'
                }`}
              >
                Agenda
              </button>
              <button
                onClick={() => setActiveTab('tasks')}
                className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                  activeTab === 'tasks'
                    ? 'bg-amber-600 text-white'
                    : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800'
                }`}
              >
                Tarefas
                {pendingCount > 0 && (
                  <span className="ml-1.5 px-1.5 py-0.5 text-[10px] font-semibold bg-amber-500/20 text-amber-400 rounded-full">
                    {pendingCount}
                  </span>
                )}
              </button>
              <button
                onClick={() => setActiveTab('personal')}
                className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                  activeTab === 'personal'
                    ? 'bg-amber-600 text-white'
                    : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800'
                }`}
              >
                Minhas Tasks
              </button>
            </div>

            {/* Content */}
            {activeTab === 'agenda' ? (
              <ActivityBoard onViewSession={handleViewSession} />
            ) : activeTab === 'tasks' ? (
              <TaskList
                tasks={tasks}
                isLoading={isLoading}
                pendingCount={pendingCount}
                onReload={loadTasks}
                onViewSession={handleViewSession}
              />
            ) : (
              <TasksPage />
            )}
          </>
        )}
      </div>

      {rejectingRunId !== null && (
        <RejectNoteModal
          onConfirm={(note) => {
            handleReviewRun(rejectingRunId, 'rejected', note);
            setRejectingRunId(null);
          }}
          onCancel={() => setRejectingRunId(null)}
        />
      )}
    </div>
  );
}
