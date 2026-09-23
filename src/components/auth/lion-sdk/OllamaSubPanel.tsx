import { useState } from 'react';
import { ArrowRight, Loader2, CheckCircle, XCircle } from 'lucide-react';
import type { SdkCompleteHandler } from '@/types';

interface OllamaSubPanelProps {
  onComplete: SdkCompleteHandler;
}

type TestStatus = 'idle' | 'testing' | 'ok' | 'fail';

export function OllamaSubPanel({ onComplete }: OllamaSubPanelProps) {
  const [baseUrl, setBaseUrl] = useState('http://localhost:11434');
  const [orchestratorModel, setOrchestratorModel] = useState('');
  const [modelSuggestions, setModelSuggestions] = useState<string[]>([]);
  const [testStatus, setTestStatus] = useState<TestStatus>('idle');
  const [testMessage, setTestMessage] = useState('');
  const [localError, setLocalError] = useState('');
  const [isListing, setIsListing] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const canContinue = orchestratorModel.trim() !== '' && !isSubmitting;

  const handleListModels = async () => {
    setIsListing(true);
    setTestStatus('idle');
    setTestMessage('');
    try {
      const result = await window.lionclaw.ollama.listModels('ollama', baseUrl.trim());
      if (result?.models && Array.isArray(result.models) && result.models.length > 0) {
        setModelSuggestions(result.models);
      } else {
        setModelSuggestions([]);
        if (result?.error) {
          setTestMessage('Nao foi possivel listar: ' + result.error);
        } else {
          setTestMessage('Nenhum modelo encontrado. Digite o nome manualmente.');
        }
      }
    } catch {
      setModelSuggestions([]);
      setTestMessage('Nao foi possivel listar modelos. Digite o nome manualmente.');
    } finally {
      setIsListing(false);
    }
  };

  const handleTestConnection = async () => {
    setTestStatus('testing');
    setTestMessage('');
    try {
      const result = await window.lionclaw.ollama.listModels('ollama', baseUrl.trim());
      if (result?.models && Array.isArray(result.models)) {
        setTestStatus('ok');
        const n = result.models.length;
        setTestMessage(
          n > 0
            ? `Servidor acessivel. ${n} modelo${n === 1 ? '' : 's'} disponivel${n === 1 ? '' : 'is'}.`
            : 'Servidor acessivel, mas nenhum modelo instalado ainda.',
        );
      } else {
        setTestStatus('fail');
        setTestMessage(result?.error ?? 'Servidor nao acessivel.');
      }
    } catch (e) {
      setTestStatus('fail');
      setTestMessage((e as Error).message ?? 'Erro ao testar conexao.');
    }
  };

  const handleContinue = async () => {
    if (!canContinue) return;
    setLocalError('');
    setIsSubmitting(true);
    const result = await onComplete(
      {
        orchestratorRuntime: 'lion-sdk',
        orchestratorProvider: 'ollama',
        orchestratorModel: orchestratorModel.trim(),
      },
      () =>
        window.lionclaw.provider.connect({
          provider: 'ollama',
          baseUrl: baseUrl.trim(),
        }),
    );
    setIsSubmitting(false);
    if ('error' in result) {
      setLocalError(result.error);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      {/* Base URL */}
      <div>
        <label className="block text-xs text-zinc-500 mb-1.5">URL do servidor Ollama</label>
        <input
          type="text"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2.5 text-sm text-zinc-100 outline-none focus:border-amber-500/50"
          placeholder="http://localhost:11434"
          autoComplete="off"
        />
      </div>

      {/* Modelo */}
      <div>
        <label className="block text-xs text-zinc-500 mb-1.5">
          Modelo <span className="text-amber-500">*</span>
        </label>
        {modelSuggestions.length > 0 ? (
          <select
            value={orchestratorModel}
            onChange={(e) => setOrchestratorModel(e.target.value)}
            className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2.5 text-sm text-zinc-100 outline-none focus:border-amber-500/50 appearance-none cursor-pointer"
          >
            <option value="">Selecione um modelo...</option>
            {modelSuggestions.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        ) : (
          <input
            type="text"
            value={orchestratorModel}
            onChange={(e) => setOrchestratorModel(e.target.value)}
            className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2.5 text-sm text-zinc-100 outline-none focus:border-amber-500/50"
            placeholder="Ex: llama3.2, mistral, gemma3..."
            autoComplete="off"
          />
        )}
        <p className="text-xs text-zinc-600 mt-1">Nome exato do modelo instalado no Ollama.</p>
      </div>

      {/* Acoes secundarias */}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={handleListModels}
          disabled={isListing}
          className="flex items-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-xs text-zinc-300 hover:bg-zinc-800 transition-colors disabled:opacity-50"
        >
          {isListing ? <Loader2 size={12} className="animate-spin" /> : null}
          Listar modelos
        </button>
        <button
          type="button"
          onClick={handleTestConnection}
          disabled={testStatus === 'testing'}
          className="flex items-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-xs text-zinc-300 hover:bg-zinc-800 transition-colors disabled:opacity-50"
        >
          {testStatus === 'testing' ? (
            <Loader2 size={12} className="animate-spin" />
          ) : testStatus === 'ok' ? (
            <CheckCircle size={12} className="text-green-400" />
          ) : testStatus === 'fail' ? (
            <XCircle size={12} className="text-red-400" />
          ) : null}
          Testar conexao
        </button>
      </div>

      {/* Feedback de teste/lista */}
      {testMessage && (
        <p
          className={`text-xs ${testStatus === 'ok' ? 'text-green-400' : testStatus === 'fail' ? 'text-red-400' : 'text-zinc-400'}`}
        >
          {testMessage}
        </p>
      )}

      {/* Erro do onComplete */}
      {localError && <p className="text-sm text-red-400">{localError}</p>}

      {/* Nota offline */}
      <p className="text-xs text-zinc-600 leading-snug">
        Servidor offline nao impede avanco. "Testar conexao" apenas verifica disponibilidade.
      </p>

      {/* Continuar */}
      <button
        type="button"
        onClick={handleContinue}
        disabled={!canContinue}
        className="w-full flex items-center justify-center gap-2 bg-amber-600 hover:bg-amber-500 text-white rounded-lg px-4 py-2.5 text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {isSubmitting ? (
          <Loader2 size={16} className="animate-spin" />
        ) : (
          <>
            Continuar
            <ArrowRight size={16} />
          </>
        )}
      </button>
    </div>
  );
}
