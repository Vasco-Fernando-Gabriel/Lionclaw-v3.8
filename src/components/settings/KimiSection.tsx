import { useState, useEffect } from 'react';
import { CheckCircle, XCircle, Terminal, RefreshCw } from 'lucide-react';
import type { KimiAvailability } from '@/types';

export function KimiSection() {
  const [status, setStatus] = useState<KimiAvailability | null>(null);
  const [loadingStatus, setLoadingStatus] = useState(true);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const [loginUrl, setLoginUrl] = useState<string | null>(null);
  const [customPath, setCustomPath] = useState('');
  const [savingPath, setSavingPath] = useState(false);
  const [pathSaved, setPathSaved] = useState(false);

  const fetchStatus = async () => {
    setLoadingStatus(true);
    try {
      const s = await window.lionclaw.kimi.status();
      setStatus(s);
    } catch {
      setStatus({
        installed: false,
        version: null,
        authenticated: false,
        authMode: 'none',
        managedProviderVerified: false,
        modelAvailable: false,
        availableModels: [],
        usable: false,
        reason: 'Nao foi possivel verificar o runtime Kimi.',
      });
    } finally {
      setLoadingStatus(false);
    }
  };

  useEffect(() => {
    fetchStatus();
  }, []);

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await window.lionclaw.kimi.test();
      setTestResult(result);
      if (result.ok) {
        await fetchStatus();
      }
    } catch {
      setTestResult({ ok: false, message: 'Erro inesperado ao testar conexao' });
    } finally {
      setTesting(false);
    }
  };

  const handleOpenLogin = async () => {
    setLoginUrl(null);
    try {
      const result = await window.lionclaw.kimi.openLogin();
      if (result.url) {
        setLoginUrl(result.url);
      }
    } catch {}
  };

  const handleSavePath = async () => {
    setSavingPath(true);
    try {
      await window.lionclaw.kimi.setBinaryPath(customPath.trim());
      setPathSaved(true);
      setTimeout(() => setPathSaved(false), 2000);
      await fetchStatus();
    } catch {
    } finally {
      setSavingPath(false);
    }
  };

  const statusPill = () => {
    if (loadingStatus) {
      return (
        <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium bg-zinc-800 text-zinc-400">
          <span className="w-2 h-2 rounded-full bg-zinc-600 animate-pulse" />
          Verificando...
        </span>
      );
    }
    if (!status || !status.installed) {
      return (
        <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium bg-red-950 text-red-400 border border-red-800">
          <XCircle size={12} />
          Kimi CLI nao instalado
        </span>
      );
    }
    if (status.authMode === 'none' || !status.authenticated) {
      return (
        <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium bg-yellow-950 text-yellow-400 border border-yellow-800">
          <span className="w-2 h-2 rounded-full bg-yellow-500" />
          Instalado mas nao autenticado
        </span>
      );
    }
    if (!status.managedProviderVerified) {
      return (
        <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium bg-yellow-950 text-yellow-400 border border-yellow-800">
          <XCircle size={12} />
          Sessao oficial nao reconhecida
        </span>
      );
    }
    if (!status.modelAvailable || !status.usable) {
      return (
        <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium bg-yellow-950 text-yellow-400 border border-yellow-800">
          <XCircle size={12} />
          Modelo Kimi nao disponivel
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium bg-green-950 text-green-400 border border-green-800">
        <CheckCircle size={12} />
        Conectado via assinatura Kimi
      </span>
    );
  };

  return (
    <section className="space-y-3">
      <h2 className="text-sm font-medium text-zinc-300 flex items-center gap-2">
        <Terminal size={16} className="text-teal-500" />
        Kimi CLI
      </h2>

      <div className="bg-zinc-900 rounded-lg border border-zinc-800 p-4 space-y-4">
        {/* Tooltip / explicacao */}
        <p className="text-xs text-zinc-500">
          O Kimi nativo roda pela sua assinatura via CLI: o LionClaw usa a sessao do{' '}
          <code className="px-1 py-0.5 bg-zinc-800 rounded text-zinc-300 text-[10px]">/login</code> sem precisar de API
          key separada. Instale o CLI do Kimi e autentique com{' '}
          <code className="px-1 py-0.5 bg-zinc-800 rounded text-zinc-300 text-[10px]">/login</code>. Full assinatura:
          nao usa API key.
        </p>

        {/* Indicador de status */}
        <div className="flex items-center gap-3">
          {statusPill()}
          {status?.version && (
            <span className="text-xs text-zinc-500">
              versao: <span className="text-zinc-400 font-mono">{status.version}</span>
            </span>
          )}
          <button
            onClick={fetchStatus}
            disabled={loadingStatus}
            title="Atualizar status"
            className="ml-auto text-zinc-500 hover:text-zinc-300 transition-colors disabled:opacity-40"
          >
            <RefreshCw size={13} className={loadingStatus ? 'animate-spin' : ''} />
          </button>
        </div>
        {status?.reason && !status.usable && <p className="text-[10px] text-zinc-500">{status.reason}</p>}

        {/* Botoes de acao */}
        <div className="flex flex-wrap items-start gap-3">
          <div className="space-y-1">
            <button
              onClick={handleOpenLogin}
              className="px-3 py-1.5 text-xs rounded-lg bg-teal-600 hover:bg-teal-500 text-white transition-colors"
            >
              Conectar Kimi
            </button>
            <p className="text-[10px] text-zinc-600 max-w-xs">
              Inicia o login por assinatura (device-auth via browser). Depois clique em "Testar conexao".
            </p>
          </div>

          <div className="space-y-1">
            <button
              onClick={handleTest}
              disabled={testing}
              className="px-3 py-1.5 text-xs rounded-lg bg-zinc-700 hover:bg-zinc-600 text-zinc-200 transition-colors disabled:opacity-50"
            >
              {testing ? 'Testando...' : 'Testar conexao'}
            </button>
          </div>
        </div>

        {/* URL de device-auth (quando o SDK a retorna) */}
        {loginUrl && (
          <div className="flex items-start gap-2 text-xs rounded-lg px-3 py-2 bg-teal-950 border border-teal-800 text-teal-200">
            <span className="shrink-0">Abra para autenticar:</span>
            <span className="font-mono break-all">{loginUrl}</span>
          </div>
        )}

        {/* Resultado do teste */}
        {testResult && (
          <div
            className={`flex items-start gap-2 text-xs rounded-lg px-3 py-2 ${
              testResult.ok
                ? 'bg-green-950 border border-green-800 text-green-300'
                : 'bg-red-950 border border-red-800 text-red-300'
            }`}
          >
            {testResult.ok ? (
              <CheckCircle size={13} className="mt-0.5 shrink-0" />
            ) : (
              <XCircle size={13} className="mt-0.5 shrink-0" />
            )}
            <span className="font-mono break-all">{testResult.message}</span>
          </div>
        )}

        {/* Path customizado do binario */}
        <div className="pt-2 border-t border-zinc-800 space-y-2">
          <label className="block text-xs text-zinc-400">Path customizado do binario (opcional)</label>
          <div className="flex gap-2">
            <input
              type="text"
              value={customPath}
              onChange={(e) => setCustomPath(e.target.value)}
              placeholder="/usr/local/bin/kimi"
              className="flex-1 bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 outline-none focus:border-teal-600"
            />
            <button
              onClick={handleSavePath}
              disabled={savingPath || !customPath.trim()}
              className="px-3 py-1.5 text-xs rounded-lg bg-zinc-700 hover:bg-zinc-600 text-zinc-200 transition-colors disabled:opacity-50"
            >
              {pathSaved ? 'Salvo!' : savingPath ? 'Salvando...' : 'Salvar'}
            </button>
          </div>
          <p className="text-[10px] text-zinc-600">Deixe vazio para usar o binario encontrado no PATH do sistema.</p>
        </div>
      </div>
    </section>
  );
}
