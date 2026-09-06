import { useState, useEffect } from 'react';
import { CheckCircle, XCircle, Terminal, RefreshCw } from 'lucide-react';

interface CodexStatus {
  installed: boolean;
  version: string | null;
  authenticated: boolean;
  appServerSupported: boolean;
  error?: string;
}

export function CodexSection() {
  const [status, setStatus] = useState<CodexStatus | null>(null);
  const [loadingStatus, setLoadingStatus] = useState(true);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const [customPath, setCustomPath] = useState('');
  const [savingPath, setSavingPath] = useState(false);
  const [pathSaved, setPathSaved] = useState(false);

  const fetchStatus = async () => {
    setLoadingStatus(true);
    try {
      const s = await window.lionclaw.codex.status();
      setStatus(s);
    } catch {
      setStatus({
        installed: false,
        version: null,
        authenticated: false,
        appServerSupported: false,
      });
    } finally {
      setLoadingStatus(false);
    }
  };

  useEffect(() => {
    void fetchStatus();
  }, []);

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await window.lionclaw.codex.test();
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
    try {
      await window.lionclaw.codex.openLogin();
    } catch {
    }
  };

  const handleSavePath = async () => {
    setSavingPath(true);
    try {
      await window.lionclaw.codex.setBinaryPath(customPath.trim());
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
          Codex CLI nao instalado
        </span>
      );
    }
    if (!status.authenticated) {
      return (
        <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium bg-yellow-950 text-yellow-400 border border-yellow-800">
          <span className="w-2 h-2 rounded-full bg-yellow-500" />
          Instalado mas nao autenticado
        </span>
      );
    }
    if (!status.appServerSupported) {
      return (
        <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium bg-red-950 text-red-400 border border-red-800">
          <XCircle size={12} />
          App Server indisponivel
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium bg-green-950 text-green-400 border border-green-800">
        <CheckCircle size={12} />
        Conectado
      </span>
    );
  };

  return (
    <section className="space-y-3">
      <h2 className="text-sm font-medium text-zinc-300 flex items-center gap-2">
        <Terminal size={16} className="text-amber-500" />
        Codex CLI
      </h2>

      <div className="bg-zinc-900 rounded-lg border border-zinc-800 p-4 space-y-4">

        {/* Tooltip / explanation */}
        <p className="text-xs text-zinc-500">
          O Codex e coberto pela sua assinatura ChatGPT. O LionClaw usa o token OAuth do CLI sem precisar de API key separada. Instale o CLI via{' '}
          <code className="px-1 py-0.5 bg-zinc-800 rounded text-zinc-300 text-[10px]">npm install -g @openai/codex</code>{' '}
          e autentique com <code className="px-1 py-0.5 bg-zinc-800 rounded text-zinc-300 text-[10px]">codex login</code>.
        </p>

        {/* Status indicator */}
        <div className="flex items-center gap-3">
          {statusPill()}
          {status?.version && (
            <span className="text-xs text-zinc-500">
              versao: <span className="text-zinc-400 font-mono">{status.version}</span>
            </span>
          )}
          <button
            onClick={() => {
              void fetchStatus();
            }}
            disabled={loadingStatus}
            title="Atualizar status"
            className="ml-auto text-zinc-500 hover:text-zinc-300 transition-colors disabled:opacity-40"
          >
            <RefreshCw size={13} className={loadingStatus ? 'animate-spin' : ''} />
          </button>
        </div>

        {/* Action buttons */}
        <div className="flex flex-wrap items-start gap-3">
          <div className="space-y-1">
            <button
              onClick={handleOpenLogin}
              className="px-3 py-1.5 text-xs rounded-lg bg-amber-600 hover:bg-amber-500 text-white transition-colors"
            >
              Conectar Codex
            </button>
            <p className="text-[10px] text-zinc-600 max-w-xs">
              Abre um terminal externo com{' '}
              <code className="text-zinc-500">codex login</code>{' '}
              para autenticacao OAuth via browser. Depois clique em "Testar conexao".
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

        {/* Test result */}
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

        {/* Custom binary path */}
        <div className="pt-2 border-t border-zinc-800 space-y-2">
          <label className="block text-xs text-zinc-400">
            Path customizado do binario (opcional)
          </label>
          <div className="flex gap-2">
            <input
              type="text"
              value={customPath}
              onChange={(e) => setCustomPath(e.target.value)}
              placeholder="/usr/local/bin/codex"
              className="flex-1 bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 outline-none focus:border-amber-600"
            />
            <button
              onClick={handleSavePath}
              disabled={savingPath || !customPath.trim()}
              className="px-3 py-1.5 text-xs rounded-lg bg-zinc-700 hover:bg-zinc-600 text-zinc-200 transition-colors disabled:opacity-50"
            >
              {pathSaved ? 'Salvo!' : savingPath ? 'Salvando...' : 'Salvar'}
            </button>
          </div>
          <p className="text-[10px] text-zinc-600">
            Deixe vazio para usar o binario encontrado no PATH do sistema.
          </p>
        </div>

        {/* Driver unico e saude do App Server */}
        <div className="pt-2 border-t border-zinc-800 space-y-1.5">
          <p className="text-xs text-zinc-400 font-medium">Driver Codex</p>
          <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11px]">
            <span className="text-zinc-600">Driver ativo</span>
            <span className="text-zinc-300 font-mono">official-app-server</span>
            <span className="text-zinc-600">App Server</span>
            <span
              className={`font-mono ${
                status?.appServerSupported
                  ? 'text-green-400'
                  : 'text-yellow-400'
              }`}
              title={status?.error}
            >
              {loadingStatus
                ? '...'
                : status?.appServerSupported
                  ? 'OK'
                  : (status?.error ?? 'indisponivel')}
            </span>
          </div>
        </div>
      </div>
    </section>
  );
}
