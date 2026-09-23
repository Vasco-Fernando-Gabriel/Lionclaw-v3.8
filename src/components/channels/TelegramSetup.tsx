import { useState } from 'react';
import { X, ExternalLink, Loader2 } from 'lucide-react';

interface TelegramSetupProps {
  onClose: () => void;
  onSaved: () => void;
  existingConfig?: {
    allowedUserId?: number;
    allowedUserName?: string;
    allowedUsers?: Array<{ userId: number; name: string }>;
    allowedUserIds?: number[];
    notifyOnSchedulerTasks?: boolean;
    notifyOnDriveHandoff?: boolean;
  };
}

function resolveExistingUser(config: TelegramSetupProps['existingConfig']): { userId: string; name: string } {
  if (!config) return { userId: '', name: '' };

  if (config.allowedUserId) {
    return { userId: config.allowedUserId.toString(), name: config.allowedUserName || 'Usuario' };
  }
  if (config.allowedUsers?.length) {
    return { userId: config.allowedUsers[0].userId.toString(), name: config.allowedUsers[0].name || 'Usuario' };
  }
  if (config.allowedUserIds?.length) {
    return { userId: config.allowedUserIds[0].toString(), name: 'Usuario' };
  }
  return { userId: '', name: '' };
}

export function TelegramSetup({ onClose, onSaved, existingConfig }: TelegramSetupProps) {
  const [botToken, setBotToken] = useState('');
  const existing = resolveExistingUser(existingConfig);
  const [userName, setUserName] = useState(existing.name);
  const [userId, setUserId] = useState(existing.userId);
  const [notifyTasks, setNotifyTasks] = useState(existingConfig?.notifyOnSchedulerTasks ?? true);
  const [notifyDriveHandoff, setNotifyDriveHandoff] = useState(existingConfig?.notifyOnDriveHandoff ?? false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const handleSave = async () => {
    if (!botToken.trim() && !existingConfig) {
      setError('Bot token e obrigatorio');
      return;
    }

    if (!userName.trim()) {
      setError('Nome do usuario e obrigatorio');
      return;
    }

    if (!userId.trim() || isNaN(Number(userId))) {
      setError('User ID invalido');
      return;
    }

    setSaving(true);
    setError('');

    try {
      const tokenToSave = botToken.trim() || '__keep__';

      if (tokenToSave === '__keep__' && !existingConfig) {
        setError('Bot token e obrigatorio para primeira configuracao');
        setSaving(false);
        return;
      }

      await window.lionclaw.channels.saveTelegram({
        botToken: tokenToSave,
        allowedUserId: parseInt(userId, 10),
        allowedUserName: userName.trim(),
        notifyOnSchedulerTasks: notifyTasks,
        notifyOnDriveHandoff: notifyDriveHandoff,
      });

      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao salvar');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="bg-zinc-900 border border-zinc-700 rounded-xl w-full max-w-md mx-4 shadow-2xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-800">
          <h2 className="text-base font-semibold text-zinc-100">Configurar Telegram</h2>
          <button onClick={onClose} className="p-1 rounded hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200">
            <X size={18} />
          </button>
        </div>

        <div className="px-5 py-4 space-y-4">
          <div className="text-sm text-zinc-400 space-y-1">
            <p>
              1. Crie um bot no{' '}
              <a
                href="https://t.me/BotFather"
                target="_blank"
                rel="noreferrer"
                className="text-amber-500 hover:underline inline-flex items-center gap-1"
              >
                @BotFather <ExternalLink size={12} />
              </a>
            </p>
            <p>2. Copie o token gerado</p>
            <p>
              3. Obtenha seu User ID via{' '}
              <a
                href="https://t.me/userinfobot"
                target="_blank"
                rel="noreferrer"
                className="text-amber-500 hover:underline inline-flex items-center gap-1"
              >
                @userinfobot <ExternalLink size={12} />
              </a>
            </p>
          </div>

          <div>
            <label className="block text-xs font-medium text-zinc-300 mb-1.5">Bot Token</label>
            <input
              type="password"
              value={botToken}
              onChange={(e) => setBotToken(e.target.value)}
              placeholder={existingConfig ? '(manter atual)' : '123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11'}
              className="w-full px-3 py-2 rounded-lg bg-zinc-800 border border-zinc-700 text-sm text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-amber-500/50"
            />
            <p className="text-[10px] text-zinc-500 mt-1">Salvo no Vault (keychain do OS)</p>
          </div>

          <div>
            <label className="block text-xs font-medium text-zinc-300 mb-2">Usuario Autorizado</label>
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={userName}
                onChange={(e) => setUserName(e.target.value)}
                placeholder="Seu nome"
                className="flex-1 px-3 py-2 rounded-lg bg-zinc-800 border border-zinc-700 text-sm text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-amber-500/50"
              />
              <input
                type="text"
                value={userId}
                onChange={(e) => setUserId(e.target.value)}
                placeholder="User ID"
                className="w-32 px-3 py-2 rounded-lg bg-zinc-800 border border-zinc-700 text-sm text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-amber-500/50"
              />
            </div>
            <p className="text-[10px] text-zinc-500 mt-1">Apenas um usuario autorizado por bot</p>
          </div>

          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={notifyTasks}
              onChange={(e) => setNotifyTasks(e.target.checked)}
              className="rounded border-zinc-600 bg-zinc-800 text-amber-500 focus:ring-amber-500/50"
            />
            <span className="text-sm text-zinc-300">Notificar tasks agendadas via Telegram</span>
          </label>

          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={notifyDriveHandoff}
              onChange={(e) => setNotifyDriveHandoff(e.target.checked)}
              className="rounded border-zinc-600 bg-zinc-800 text-amber-500 focus:ring-amber-500/50"
            />
            <span className="text-sm text-zinc-300">
              Avisar no Telegram quando o drive ceder a voce (aguardando humano)
            </span>
          </label>

          {error && <p className="text-sm text-red-400">{error}</p>}
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-zinc-800">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg text-sm text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors"
          >
            Cancelar
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-4 py-2 rounded-lg text-sm font-medium bg-amber-600 hover:bg-amber-500 text-white transition-colors disabled:opacity-50 flex items-center gap-2"
          >
            {saving && <Loader2 size={14} className="animate-spin" />}
            {existingConfig ? 'Salvar' : 'Salvar e Ativar'}
          </button>
        </div>
      </div>
    </div>
  );
}
