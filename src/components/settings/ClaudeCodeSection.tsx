
import { useState, useEffect } from 'react';
import { CheckCircle, XCircle, Terminal, RefreshCw } from 'lucide-react';

interface ClaudeCliStatus {
  installed: boolean;
  version: string | null;
  authenticated: boolean;
  authMode: 'oauth' | 'api-key' | 'none';
  resolvedPath: string;
}

function authModeLabel(mode: ClaudeCliStatus['authMode']): string {
  if (mode === 'oauth') return 'OAuth (assinatura Claude)';
  if (mode === 'api-key') return 'ANTHROPIC_API_KEY';
  return 'sem auth';
}

export function ClaudeCodeSection() {
  const [status, setStatus] = useState<ClaudeCliStatus | null>(null);
  const [loadingStatus, setLoadingStatus] = useState(true);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const [customPath, setCustomPath] = useState('');
  const [savingPath, setSavingPath] = useState(false);
  const [pathSaved, setPathSaved] = useState(false);

  const fetchStatus = async () => {
    setLoadingStatus(true);
    try {
      const s = await window.lionclaw.claudeCli.status();
      setStatus(s);
    } catch {
      setStatus({
        installed: false,
        version: null,
        authenticated: false,
        authMode: 'none',
        resolvedPath: '',
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
      const result = await window.lionclaw.claudeCli.test();
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
      await window.lionclaw.claudeCli.openLogin();
    } catch {
    }
  };

  const handleSavePath = async () => {
    setSavingPath(true);
    try {
      await window.lionclaw.claudeCli.setBinaryPath(customPath.trim());
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
          Claude Code CLI nao resolvido
        </span>
      );
    }
    if (status.authMode === 'none') {
      return (
        <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium bg-yellow-950 text-yellow-400 border border-yellow-800">
          <span className="w-2 h-2 rounded-full bg-yellow-500" />
          Resolvido mas sem auth
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
        <Terminal size={16} className="text-orange-500" />
        Claude Code CLI
      </h2>

      <div className="bg-zinc-900 rounded-lg border border-zinc-800 p-4 space-y-4">

        {/* Tooltip / explicacao */}
        <p className="text-xs text-zinc-500">
          O Claude e o runtime nativo do LionClaw: o SDK usa o engine{' '}
          <code className="px-1 py-0.5 bg-zinc-800 rounded text-zinc-300 text-[10px]">claude</code>{' '}
          embutido do Claude Code (binario nativo) e autentica pela sua assinatura via{' '}
          <code className="px-1 py-0.5 bg-zinc-800 rounded text-zinc-300 text-[10px]">claude login</code>{' '}
          (OAuth em ~/.claude) ou por{' '}
          <code className="px-1 py-0.5 bg-zinc-800 rounded text-zinc-300 text-[10px]">ANTHROPIC_API_KEY</code>{' '}
          no Vault. Use o path customizado abaixo so se o binario nao resolver sozinho
          (ex: node_modules em outro HD/SSD).
        </p>

        {/* Indicador de status */}
        <div className="flex items-center gap-3">
          {statusPill()}
          {status?.version && (
            <span className="text-xs text-zinc-500">
              Claude Code: <span className="text-zinc-400 font-mono">{status.version}</span>
            </span>
          )}
          {status && status.installed && (
            <span className="text-xs text-zinc-500">
              auth: <span className="text-zinc-400 font-mono">{authModeLabel(status.authMode)}</span>
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

        {/* Path resolvido (ajuda a debugar o caso do binario em outro HD) */}
        {status?.resolvedPath && (
          <p className="text-[10px] text-zinc-600 font-mono break-all">
            binario: {status.resolvedPath}
          </p>
        )}

        {/* Botoes de acao */}
        <div className="flex flex-wrap items-start gap-3">
          <div className="space-y-1">
            <button
              onClick={handleOpenLogin}
              className="px-3 py-1.5 text-xs rounded-lg bg-orange-600 hover:bg-orange-500 text-white transition-colors"
            >
              Conectar Claude
            </button>
            <p className="text-[10px] text-zinc-600 max-w-xs">
              Abre um terminal externo com{' '}
              <code className="text-zinc-500">claude login</code>{' '}
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
          <label className="block text-xs text-zinc-400">
            Path customizado do binario (opcional)
          </label>
          <div className="flex gap-2">
            <input
              type="text"
              value={customPath}
              onChange={(e) => setCustomPath(e.target.value)}
              placeholder="C:\\...\\node_modules\\@anthropic-ai\\claude-agent-sdk-win32-x64\\claude.exe"
              className="flex-1 bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 outline-none focus:border-orange-600"
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
            Deixe vazio para usar o engine embutido do SDK. Aceita o caminho de um
            executavel claude/claude.exe (Claude Code 2.1.251 ou superior). Um cli.js
            legado ainda roda via node, mas e a versao antiga e nao serve o Fable 5.1.
          </p>
        </div>
      </div>
    </section>
  );
}
