import { useCallback, useEffect, useState } from 'react';
import { CheckCircle, Loader2, LogIn, LogOut, RefreshCw, XCircle } from 'lucide-react';
import { GROK_DEFAULT_MODEL, GROK_MODELS } from '@/constants/grok-models';

const GROK_DEFAULT_MODEL_LABEL = GROK_MODELS.find((m) => m.slug === GROK_DEFAULT_MODEL)?.label ?? GROK_DEFAULT_MODEL;

type GrokStatus = Awaited<ReturnType<typeof window.lionclaw.grok.status>>;

export function GrokSection() {
  const [status, setStatus] = useState<GrokStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [binaryPath, setBinaryPath] = useState('');

  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      const next = await window.lionclaw.grok.status();
      setStatus(next);
      setBinaryPath(next.binaryPath);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const test = async () => {
    setBusy(true);
    try {
      const result = await window.lionclaw.grok.test();
      setMessage(result.message);
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const connect = async () => {
    const result = await window.lionclaw.grok.openLogin();
    setMessage(
      result.ok
        ? 'Login por assinatura aberto. Conclua no terminal e recarregue o status.'
        : (result.error ?? 'Nao foi possivel abrir o login.'),
    );
  };

  const logout = async () => {
    setBusy(true);
    try {
      const result = await window.lionclaw.grok.logout();
      setMessage(result.ok ? 'Sessao Grok do LionClaw desconectada.' : (result.error ?? 'Falha ao desconectar.'));
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const saveBinary = async () => {
    await window.lionclaw.grok.setBinaryPath(binaryPath);
    setMessage('Caminho do Grok salvo.');
    await refresh();
  };

  const usable = status?.usable === true;

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-4 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-medium text-zinc-200">Grok Build</h3>
            {usable ? (
              <span className="inline-flex items-center gap-1 text-[10px] text-green-400">
                <CheckCircle size={11} /> conectado e pronto
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 text-[10px] text-zinc-500">
                <XCircle size={11} /> indisponivel
              </span>
            )}
          </div>
          <p className="mt-1 text-xs text-zinc-500">
            CLI oficial da xAI por assinatura. O LionClaw nao usa API key neste runtime.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={busy}
          className="text-zinc-500 hover:text-zinc-300 disabled:opacity-40"
          title="Recarregar"
        >
          <RefreshCw size={14} className={busy ? 'animate-spin' : ''} />
        </button>
      </div>

      <div className="grid grid-cols-2 gap-2 text-[11px]">
        <Status label="CLI" ok={status?.installed === true} value={status?.version ?? 'nao encontrado'} />
        <Status
          label="Assinatura"
          ok={status?.authenticated === true}
          value={status?.authenticated ? 'autenticada' : 'login necessario'}
        />
        <Status
          label="Rota"
          ok={status?.subscriptionRouteVerified === true}
          value={status?.subscriptionRouteVerified ? 'grok.com verificada' : 'nao verificada'}
        />
        <Status
          label="Ambiente"
          ok={status?.isolationVerified === true}
          value={status?.isolationVerified ? 'preparado' : 'nao preparado'}
        />
        <Status
          label="Tools"
          ok={status?.toolPolicyVerified === true}
          value={status?.toolPolicyVerified ? 'allowlist verificada' : 'inconsistente'}
        />
        <Status
          label="Modelo"
          ok={status?.modelAvailable === true}
          value={status?.modelAvailable === true ? GROK_DEFAULT_MODEL_LABEL : 'nao comprovado'}
        />
        <div className="rounded border border-zinc-800 px-2 py-1.5 text-zinc-500">Home dedicado do LionClaw</div>
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => void connect()}
          disabled={busy}
          className="inline-flex items-center gap-1.5 rounded-md bg-amber-600 px-3 py-1.5 text-xs text-white disabled:opacity-50"
        >
          <LogIn size={13} /> Conectar
        </button>
        <button
          type="button"
          onClick={() => void test()}
          disabled={busy}
          className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 disabled:opacity-50"
        >
          {busy ? <Loader2 size={13} className="animate-spin" /> : 'Testar conexao'}
        </button>
        {status?.authenticated && (
          <button
            type="button"
            onClick={() => void logout()}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-400 disabled:opacity-50"
          >
            <LogOut size={13} /> Desconectar
          </button>
        )}
      </div>

      <div className="flex gap-2">
        <input
          value={binaryPath}
          onChange={(event) => setBinaryPath(event.target.value)}
          placeholder="Caminho opcional do executavel grok"
          className="min-w-0 flex-1 rounded-md border border-zinc-700 bg-zinc-950 px-2.5 py-1.5 text-xs text-zinc-200"
        />
        <button
          type="button"
          onClick={() => void saveBinary()}
          className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300"
        >
          Salvar
        </button>
      </div>

      <p className="text-[10px] text-zinc-600">
        Instale com <code>curl -fsSL https://x.ai/cli/install.sh | bash</code> ou{' '}
        <code>npm install -g @xai-official/grok</code>. A cota semanal e compartilhada com os produtos Grok; consulte o
        saldo nas configuracoes do Grok.
      </p>
      <p className="text-[10px] text-zinc-600">
        O teste valida o handshake oficial, a sessao por assinatura e o modelo. O isolamento e a politica de tools sao
        aplicados novamente em cada execucao.
      </p>
      {message && <p className="text-[11px] text-zinc-400">{message}</p>}
    </div>
  );
}

function Status({ label, ok, value }: { label: string; ok: boolean; value: string }) {
  return (
    <div className="rounded border border-zinc-800 px-2 py-1.5">
      <span className="text-zinc-500">{label}: </span>
      <span className={ok ? 'text-green-400' : 'text-zinc-400'}>{value}</span>
    </div>
  );
}
