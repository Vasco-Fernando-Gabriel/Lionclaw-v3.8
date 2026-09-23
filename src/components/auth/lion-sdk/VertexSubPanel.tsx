import { useState } from 'react';
import { ArrowRight, Eye, EyeOff, Loader2, CheckCircle, XCircle } from 'lucide-react';
import { VERTEX_MODEL_CATALOG, VERTEX_DEFAULT_MODEL } from '@/constants/vertex-gemini-models';
import type { SdkCompleteHandler } from '@/types';

interface VertexSubPanelProps {
  onComplete: SdkCompleteHandler;
}

type TestStatus = 'idle' | 'testing' | 'ok' | 'fail';

export function VertexSubPanel({ onComplete }: VertexSubPanelProps) {
  const [apiKey, setApiKey] = useState('');
  const [showApiKey, setShowApiKey] = useState(false);
  const [model, setModel] = useState(VERTEX_DEFAULT_MODEL);
  const [testStatus, setTestStatus] = useState<TestStatus>('idle');
  const [testMessage, setTestMessage] = useState('');
  const [localError, setLocalError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const canContinue = apiKey.trim() !== '' && model.trim() !== '' && !isSubmitting;

  const handleTestConnection = async () => {
    setTestStatus('testing');
    setTestMessage('');
    try {
      const result = await window.lionclaw.provider.testVertexAi({
        apiKey: apiKey.trim(),
        model: model.trim(),
      });
      if (result && typeof result === 'object' && 'ok' in result && result.ok) {
        setTestStatus('ok');
        setTestMessage('Conexao bem-sucedida.');
      } else {
        setTestStatus('fail');
        const msg =
          result && typeof result === 'object' && 'error' in result ? String(result.error) : 'Falha ao conectar.';
        setTestMessage(msg);
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
        orchestratorProvider: 'vertex-ai',
        orchestratorModel: model.trim(),
      },
      () =>
        window.lionclaw.provider.connect({
          provider: 'vertex-ai',
          apiKey: apiKey.trim(),
        }),
    );
    setIsSubmitting(false);
    if ('error' in result) {
      setLocalError(result.error);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      {/* API Key */}
      <div>
        <label className="block text-xs text-zinc-500 mb-1.5">
          Vertex AI API Key <span className="text-amber-500">*</span>
        </label>
        <div className="relative">
          <input
            type={showApiKey ? 'text' : 'password'}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 pr-10 py-2.5 text-sm text-zinc-100 outline-none focus:border-amber-500/50"
            placeholder="Sua chave da API Vertex AI"
            autoComplete="off"
          />
          <button
            type="button"
            onClick={() => setShowApiKey(!showApiKey)}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300 transition-colors"
          >
            {showApiKey ? <EyeOff size={16} /> : <Eye size={16} />}
          </button>
        </div>
        <p className="text-xs text-zinc-600 mt-1.5">Armazenada no keychain do SO, nunca em plaintext.</p>
      </div>

      {/* Modelo */}
      <div>
        <label className="block text-xs text-zinc-500 mb-1.5">
          Modelo <span className="text-amber-500">*</span>
        </label>
        <select
          value={model}
          onChange={(e) => setModel(e.target.value)}
          className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2.5 text-sm text-zinc-100 outline-none focus:border-amber-500/50 appearance-none cursor-pointer"
        >
          {VERTEX_MODEL_CATALOG.map((m) => (
            <option key={m.id} value={m.id}>
              {m.displayName} ({m.stage})
            </option>
          ))}
        </select>
        <p className="text-xs text-zinc-600 mt-1">Catalogo Vertex Gemini. Padrao: {VERTEX_DEFAULT_MODEL}.</p>
      </div>

      {/* Botao testar */}
      <button
        type="button"
        onClick={handleTestConnection}
        disabled={testStatus === 'testing' || !apiKey.trim()}
        className="flex items-center gap-1.5 self-start rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-xs text-zinc-300 hover:bg-zinc-800 transition-colors disabled:opacity-50"
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

      {/* Feedback de teste */}
      {testMessage && (
        <p
          className={`text-xs ${testStatus === 'ok' ? 'text-green-400' : testStatus === 'fail' ? 'text-red-400' : 'text-zinc-400'}`}
        >
          {testMessage}
        </p>
      )}

      {/* Erro do onComplete */}
      {localError && <p className="text-sm text-red-400">{localError}</p>}

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
