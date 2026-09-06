import { useState, useEffect } from 'react';
import { KeyRound, Eye, EyeOff, Check, Trash2, ExternalLink, ShieldCheck, ShieldAlert, Wifi, AlertTriangle } from 'lucide-react';
import { PROVIDER_PRESETS } from '@/lib/provider-presets';
import { getAgentsUsingVaultKey } from '@/lib/credential-usage';

interface VaultEntry {
  key: string;
  label: string;
  description: string;
  service: string;
  required: boolean;
  configured: boolean;
  placeholder?: string;
  docsUrl?: string;
  status?: 'error';
  error?: string;
}

interface VaultHealth {
  keytarDegraded: boolean;
  vaultCorruptBackupPath: string | null;
  unreadableKeys: Array<{ key: string; reason: string }>;
}

const TESTABLE_SERVICES: Record<string, string> = {
  openrouter: 'openrouter',
  'openai-harness': 'openai',
};

const HIGGSFIELD_SESSION_KEY = 'HIGGSFIELD_MCP_SESSION';

type TestState = 'idle' | 'testing' | 'ok' | 'error';

interface DeleteConfirmState {
  key: string;
  agentNames: string[];
}

export default function VaultPage() {
  const [entries, setEntries] = useState<VaultEntry[]>([]);
  const [health, setHealth] = useState<VaultHealth | null>(null);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [inputValue, setInputValue] = useState('');
  const [showValue, setShowValue] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testStates, setTestStates] = useState<Map<string, TestState>>(new Map());
  const [testErrors, setTestErrors] = useState<Map<string, string>>(new Map());
  const [deleteConfirm, setDeleteConfirm] = useState<DeleteConfirmState | null>(null);
  const [higgsfieldBusy, setHiggsfieldBusy] = useState<'connect' | 'disconnect' | null>(null);
  const [higgsfieldError, setHiggsfieldError] = useState<string | null>(null);

  useEffect(() => {
    loadEntries();
  }, []);

  const loadEntries = async () => {
    const list = await window.lionclaw.vault.list();
    setEntries(list);
    try {
      const h = await window.lionclaw.vault.health();
      setHealth(h);
    } catch {
      setHealth(null);
    }
  };

  const handleSave = async (key: string) => {
    if (!inputValue.trim()) return;
    setSaving(true);
    try {
      await window.lionclaw.vault.set(key, inputValue.trim());
      setEditingKey(null);
      setInputValue('');
      setShowValue(false);
      await loadEntries();
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteRequest = async (key: string) => {
    const usage = await getAgentsUsingVaultKey(key);
    if (usage.agentsReferencing.length > 0) {
      setDeleteConfirm({
        key,
        agentNames: usage.agentsReferencing.map((a) => a.name),
      });
    } else {
      await performDelete(key);
    }
  };

  const performDelete = async (key: string) => {
    await window.lionclaw.vault.delete(key);
    setDeleteConfirm(null);
    await loadEntries();
  };

  const startEditing = (key: string) => {
    setEditingKey(key);
    setInputValue('');
    setShowValue(false);
  };

  const isHiggsfieldEntry = (entry: VaultEntry): boolean => entry.key === HIGGSFIELD_SESSION_KEY;

  const handleHiggsfieldConnect = async (force: boolean) => {
    setHiggsfieldBusy('connect');
    setHiggsfieldError(null);
    try {
      const result = await window.lionclaw.higgsfield.connect({ force });
      if (!result.ok) {
        setHiggsfieldError(result.error);
      }
      await loadEntries();
    } catch (error) {
      setHiggsfieldError(error instanceof Error ? error.message : String(error));
    } finally {
      setHiggsfieldBusy(null);
    }
  };

  const handleHiggsfieldDisconnect = async () => {
    setHiggsfieldBusy('disconnect');
    setHiggsfieldError(null);
    try {
      await window.lionclaw.higgsfield.disconnect();
      await loadEntries();
    } catch (error) {
      setHiggsfieldError(error instanceof Error ? error.message : String(error));
    } finally {
      setHiggsfieldBusy(null);
    }
  };

  const handleTestConnection = async (entry: VaultEntry) => {
    const providerName = TESTABLE_SERVICES[entry.service];
    if (!providerName) return;

    const preset = PROVIDER_PRESETS[providerName];
    if (!preset) return;

    setTestStates((prev) => new Map(prev).set(entry.key, 'testing'));
    setTestErrors((prev) => {
      const next = new Map(prev);
      next.delete(entry.key);
      return next;
    });

    const result = await window.lionclaw.provider.testConnection(
      providerName,
      preset.baseUrl ?? '',
      entry.key,
    );

    if (result.ok) {
      setTestStates((prev) => new Map(prev).set(entry.key, 'ok'));
    } else {
      setTestStates((prev) => new Map(prev).set(entry.key, 'error'));
      setTestErrors((prev) => new Map(prev).set(entry.key, result.error));
    }
  };

  return (
    <div className="flex-1 overflow-y-auto p-6">
      {/* Delete confirm dialog */}
      {deleteConfirm !== null && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50">
          <div className="w-full max-w-sm mx-4 rounded-xl border border-zinc-700 bg-zinc-900 p-5 space-y-4">
            <div className="flex items-start gap-3">
              <AlertTriangle size={18} className="text-yellow-400 mt-0.5 shrink-0" />
              <div>
                <h3 className="text-sm font-semibold text-zinc-100 mb-1">Remover credencial?</h3>
                <p className="text-xs text-zinc-400">
                  Os seguintes agentes referenciam esta chave e vao falhar ao executar:
                </p>
                <ul className="mt-2 space-y-1">
                  {deleteConfirm.agentNames.map((n) => (
                    <li key={n} className="text-xs text-amber-300 font-medium">{n}</li>
                  ))}
                </ul>
              </div>
            </div>
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setDeleteConfirm(null)}
                className="px-3 py-1.5 rounded-lg border border-zinc-700 text-zinc-300 hover:bg-zinc-800 text-xs transition-colors"
              >
                Cancelar
              </button>
              <button
                onClick={() => void performDelete(deleteConfirm.key)}
                className="px-3 py-1.5 rounded-lg bg-red-600 hover:bg-red-500 text-white text-xs transition-colors"
              >
                Remover mesmo assim
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="max-w-3xl mx-auto">
        <div className="flex items-center gap-3 mb-6">
          <KeyRound size={24} className="text-amber-500" />
          <h1 className="text-xl font-semibold text-zinc-100">Vault</h1>
        </div>

        <p className="text-sm text-zinc-400 mb-6">
          Gerencie suas credenciais de forma segura. As chaves e sessoes sao armazenadas
          no keychain do sistema operacional com criptografia AES-256-GCM.
        </p>

        {/* SB-9: badges de saude do vault */}
        {health?.keytarDegraded && (
          <div className="flex items-start gap-2 mb-3 px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/30">
            <AlertTriangle size={14} className="text-amber-400 mt-0.5 shrink-0" />
            <p className="text-xs text-amber-300">
              <span className="font-semibold">Keychain indisponivel (KEYTAR-DEGRADED):</span>{' '}
              o keychain do sistema nao respondeu; os segredos estao operando pelo arquivo
              criptografado local. Verifique o keychain do sistema e reinicie o app.
            </p>
          </div>
        )}
        {health?.vaultCorruptBackupPath && (
          <div className="flex items-start gap-2 mb-3 px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/30">
            <AlertTriangle size={14} className="text-red-400 mt-0.5 shrink-0" />
            <p className="text-xs text-red-300">
              <span className="font-semibold">Arquivo de segredos corrompido (VAULT-CORRUPT):</span>{' '}
              um backup foi preservado em{' '}
              <code className="text-red-200">{health.vaultCorruptBackupPath}</code>. Reconfigure as
              credenciais afetadas.
            </p>
          </div>
        )}

        <div className="space-y-3">
          {entries.map((entry) => (
            <div
              key={entry.key}
              className="rounded-lg border border-zinc-700/50 bg-zinc-800/50 p-4"
            >
              <div className="flex items-center justify-between mb-1">
                <div className="flex items-center gap-2">
                  {entry.status === 'error' ? (
                    <ShieldAlert size={16} className="text-red-400" />
                  ) : entry.configured ? (
                    <ShieldCheck size={16} className="text-green-500" />
                  ) : (
                    <ShieldAlert size={16} className={entry.required ? 'text-red-400' : 'text-zinc-500'} />
                  )}
                  <span className="text-sm font-medium text-zinc-200">{entry.label}</span>
                  {entry.required && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-500/20 text-red-400 uppercase tracking-wider">
                      obrigatoria
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-2">
                  {entry.docsUrl && (
                    <a
                      href={entry.docsUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-zinc-500 hover:text-amber-400 flex items-center gap-1 transition-colors"
                    >
                      <ExternalLink size={12} /> {isHiggsfieldEntry(entry) ? 'Docs' : 'Obter chave'}
                    </a>
                  )}
                </div>
              </div>

              <p className="text-xs text-zinc-500 mb-3">{entry.description}</p>

              {/* SB-9 (SECRET-UNREADABLE): segredo existe mas nao decripta — estado
                  de ERRO, distinguivel de "nunca configurado". */}
              {entry.status === 'error' && (
                <p className="text-xs text-red-400 bg-red-500/10 rounded px-2 py-1 mb-3">
                  Segredo ilegivel (SECRET-UNREADABLE): {entry.error ?? 'falha ao descriptografar'}.
                  Reconfigure a credencial.
                </p>
              )}

              {isHiggsfieldEntry(entry) ? (
                <div className="flex flex-col gap-2">
                  <div className="flex items-center gap-2 flex-wrap">
                    <button
                      onClick={() => void handleHiggsfieldConnect(entry.configured)}
                      disabled={higgsfieldBusy !== null}
                      className="text-xs px-3 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-500 text-white transition-colors flex items-center gap-1.5 disabled:opacity-50"
                    >
                      <Wifi size={12} />
                      {higgsfieldBusy === 'connect'
                        ? 'Conectando...'
                        : entry.configured
                          ? 'Reautenticar'
                          : 'Conectar'}
                    </button>
                    {entry.configured && (
                      <button
                        onClick={() => void handleHiggsfieldDisconnect()}
                        disabled={higgsfieldBusy !== null}
                        className="text-xs px-2 py-1.5 rounded-lg text-red-400 hover:bg-red-500/10 transition-colors disabled:opacity-50"
                      >
                        <Trash2 size={12} />
                      </button>
                    )}
                    {entry.configured && (
                      <span className="text-xs text-green-500/70 ml-2 flex items-center gap-1">
                        <Check size={12} /> Conectada
                      </span>
                    )}
                    {!entry.configured && higgsfieldBusy === null && (
                      <span className="text-xs text-zinc-500/90 ml-2">Nao conectada</span>
                    )}
                  </div>
                  {higgsfieldError && (
                    <p className="text-xs text-red-400 bg-red-500/10 rounded px-2 py-1">
                      {higgsfieldError}
                    </p>
                  )}
                </div>
              ) : editingKey === entry.key ? (
                <div className="flex gap-2">
                  <div className="relative flex-1">
                    <input
                      type={showValue ? 'text' : 'password'}
                      value={inputValue}
                      onChange={(e) => setInputValue(e.target.value)}
                      placeholder={entry.placeholder || 'Cole a chave aqui...'}
                      className="w-full bg-zinc-900 border border-zinc-600 rounded-lg px-3 py-2 text-sm text-zinc-200 placeholder-zinc-600 focus:border-amber-500 focus:outline-none pr-9"
                      onKeyDown={(e) => e.key === 'Enter' && handleSave(entry.key)}
                      autoFocus
                    />
                    <button
                      onClick={() => setShowValue(!showValue)}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300"
                    >
                      {showValue ? <EyeOff size={14} /> : <Eye size={14} />}
                    </button>
                  </div>
                  <button
                    onClick={() => handleSave(entry.key)}
                    disabled={saving || !inputValue.trim()}
                    className="px-3 py-2 rounded-lg bg-amber-600 hover:bg-amber-500 text-white text-sm disabled:opacity-50 transition-colors"
                  >
                    {saving ? '...' : 'Salvar'}
                  </button>
                  <button
                    onClick={() => { setEditingKey(null); setInputValue(''); }}
                    className="px-3 py-2 rounded-lg bg-zinc-700 hover:bg-zinc-600 text-zinc-300 text-sm transition-colors"
                  >
                    Cancelar
                  </button>
                </div>
              ) : (
                <div className="flex flex-col gap-2">
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => startEditing(entry.key)}
                      className="text-xs px-3 py-1.5 rounded-lg bg-zinc-700 hover:bg-zinc-600 text-zinc-300 transition-colors"
                    >
                      {entry.configured ? 'Alterar' : 'Configurar'}
                    </button>
                    {entry.configured && !entry.required && (
                      <button
                        onClick={() => void handleDeleteRequest(entry.key)}
                        className="text-xs px-2 py-1.5 rounded-lg text-red-400 hover:bg-red-500/10 transition-colors"
                      >
                        <Trash2 size={12} />
                      </button>
                    )}
                    {entry.configured && TESTABLE_SERVICES[entry.service] && (
                      <button
                        onClick={() => handleTestConnection(entry)}
                        disabled={testStates.get(entry.key) === 'testing'}
                        className="text-xs px-3 py-1.5 rounded-lg bg-zinc-700 hover:bg-zinc-600 text-zinc-300 transition-colors flex items-center gap-1.5 disabled:opacity-50"
                      >
                        <Wifi size={12} />
                        {testStates.get(entry.key) === 'testing' ? 'Testando...' : 'Testar conexao'}
                      </button>
                    )}
                    {entry.configured && (
                      <span className="text-xs text-green-500/70 ml-2 flex items-center gap-1">
                        <Check size={12} /> Configurada
                      </span>
                    )}
                    {testStates.get(entry.key) === 'ok' && (
                      <span className="text-xs text-green-400 flex items-center gap-1">
                        <Check size={12} /> Conexao OK
                      </span>
                    )}
                  </div>
                  {testStates.get(entry.key) === 'error' && (
                    <p className="text-xs text-red-400 bg-red-500/10 rounded px-2 py-1">
                      {testErrors.get(entry.key) ?? 'Erro ao testar conexao'}
                    </p>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
