import { useState } from 'react';
import { ArrowRight, Eye, EyeOff, Loader2, CheckCircle, XCircle } from 'lucide-react';
import { OPENAI_COMPATIBLE_PRESETS } from '@/constants/openai-compatible-presets';
import type { SdkCompleteHandler, OpenAiCompatiblePreset } from '@/types';

interface OpenAiCompatSubPanelProps {
  onComplete: SdkCompleteHandler;
}

type TestStatus = 'idle' | 'testing' | 'ok' | 'fail';

type PresetId = OpenAiCompatiblePreset;

export function OpenAiCompatSubPanel({ onComplete }: OpenAiCompatSubPanelProps) {
  const initialPreset = OPENAI_COMPATIBLE_PRESETS.find((p) => p.id === 'kimi');
  const [presetId, setPresetId] = useState<PresetId>('kimi');
  const [baseUrl, setBaseUrl] = useState<string>(
    initialPreset?.baseUrl ?? '',
  );
  const [apiKey, setApiKey] = useState('');
  const [showApiKey, setShowApiKey] = useState(false);
  const [model, setModel] = useState(initialPreset?.defaultModel ?? '');
  const [testStatus, setTestStatus] = useState<TestStatus>('idle');
  const [testMessage, setTestMessage] = useState('');
  const [localError, setLocalError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const selectedPreset = OPENAI_COMPATIBLE_PRESETS.find((p) => p.id === presetId);
  const modelOptions = selectedPreset?.models ?? [];
  const selectedModel = modelOptions.find((entry) => entry.id === model);
  const isCustomPreset = presetId === 'custom';

  const canContinue =
    apiKey.trim() !== '' && baseUrl.trim() !== '' && model.trim() !== '' && !isSubmitting;

  const handlePresetChange = (id: PresetId) => {
    setPresetId(id);
    const entry = OPENAI_COMPATIBLE_PRESETS.find((p) => p.id === id);
    setBaseUrl(entry?.baseUrl ?? '');
    setModel(entry?.defaultModel ?? '');
    setLocalError('');
    setTestStatus('idle');
    setTestMessage('');
  };

  const handleTestConnection = async () => {
    setTestStatus('testing');
    setTestMessage('');
    try {
      const result = await window.lionclaw.provider.testOpenAiCompatible({
        baseUrl: baseUrl.trim(),
        apiKey: apiKey.trim(),
        preset: presetId,
      });
      if (result && typeof result === 'object' && 'ok' in result && result.ok) {
        setTestStatus('ok');
        setTestMessage('Conexao bem-sucedida.');
      } else {
        setTestStatus('fail');
        const msg =
          result && typeof result === 'object' && 'error' in result
            ? String(result.error)
            : 'Falha ao conectar.';
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
        orchestratorProvider: 'openai-compatible',
        orchestratorModel: model.trim(),
        orchestratorOpenAiCompatPreset: presetId,
      },
      () =>
        window.lionclaw.provider.connect({
          provider: 'openai-compatible',
          apiKey: apiKey.trim(),
          baseUrl: baseUrl.trim(),
          preset: presetId,
        }),
    );
    setIsSubmitting(false);
    if ('error' in result) {
      setLocalError(result.error);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      {/* Preset dropdown */}
      <div>
        <label className="block text-xs text-zinc-500 mb-1.5">Provedor / Preset</label>
        <select
          value={presetId}
          onChange={(e) => handlePresetChange(e.target.value as PresetId)}
          className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2.5 text-sm text-zinc-100 outline-none focus:border-amber-500/50 appearance-none cursor-pointer"
        >
          {OPENAI_COMPATIBLE_PRESETS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.displayName}
            </option>
          ))}
        </select>
      </div>

      {/* Base URL */}
      <div>
        <label className="block text-xs text-zinc-500 mb-1.5">Base URL</label>
        <input
          type="text"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2.5 text-sm text-zinc-100 outline-none focus:border-amber-500/50"
          placeholder={presetId === 'custom' ? 'https://api.exemplo.com' : ''}
          autoComplete="off"
        />
        {!isCustomPreset && (
          <p className="text-xs text-zinc-600 mt-1">Pre-preenchido pelo preset. Editavel.</p>
        )}
      </div>

      {/* API Key */}
      <div>
        <label className="block text-xs text-zinc-500 mb-1.5">
          API Key <span className="text-amber-500">*</span>
        </label>
        <div className="relative">
          <input
            type={showApiKey ? 'text' : 'password'}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 pr-10 py-2.5 text-sm text-zinc-100 outline-none focus:border-amber-500/50"
            placeholder="Sua chave de API"
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
        <p className="text-xs text-zinc-600 mt-1.5">
          Armazenada no keychain do SO, nunca em plaintext.
        </p>
      </div>

      {/* Modelo */}
      <div>
        <label className="block text-xs text-zinc-500 mb-1.5">
          Modelo <span className="text-amber-500">*</span>
        </label>
        {isCustomPreset ? (
          <input
            type="text"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2.5 text-sm text-zinc-100 outline-none focus:border-amber-500/50"
            placeholder="Slug do modelo no provedor customizado"
            autoComplete="off"
          />
        ) : (
          <select
            value={model}
            onChange={(e) => setModel(e.target.value)}
            className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2.5 text-sm text-zinc-100 outline-none focus:border-amber-500/50 appearance-none cursor-pointer"
          >
            {modelOptions.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.displayName} - {entry.id}
              </option>
            ))}
          </select>
        )}
        <p className="text-xs text-zinc-600 mt-1">
          {isCustomPreset
            ? 'Use apenas quando o provedor nao estiver na lista.'
            : `Slug enviado: ${model || 'selecione um modelo'}`}
        </p>
        {selectedModel?.notes && (
          <p className="text-xs text-zinc-500 mt-1 leading-snug">{selectedModel.notes}</p>
        )}
      </div>

      {/* Botao testar */}
      <button
        type="button"
        onClick={handleTestConnection}
        disabled={testStatus === 'testing' || !apiKey.trim() || !baseUrl.trim()}
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
