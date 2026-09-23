import { useState, useEffect, useCallback } from 'react';
import { MessageCircle, Loader2, CheckCircle2, XCircle, Settings2, Zap } from 'lucide-react';
import { TelegramSetup } from '@/components/channels/TelegramSetup';
import type { Channel } from '@/types';

interface ChannelCardProps {
  name: string;
  icon: React.ReactNode;
  channel?: Channel;
  onConfigure?: () => void;
  onToggle?: (active: boolean) => void;
  onTest?: () => void;
  testing?: boolean;
  testResult?: { success: boolean; botUsername?: string; error?: string } | null;
}

function ChannelCard({ name, icon, channel, onConfigure, onToggle, onTest, testing, testResult }: ChannelCardProps) {
  const isActive = channel?.isActive ?? false;
  const status = channel?.status ?? 'disconnected';
  const isConfigured = !!channel;

  return (
    <div className="rounded-lg border border-zinc-700/50 bg-zinc-800/50 p-5">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-3">
          <div
            className={`p-2 rounded-lg ${isActive && status === 'connected' ? 'bg-amber-500/10 text-amber-500' : 'bg-zinc-700/50 text-zinc-400'}`}
          >
            {icon}
          </div>
          <h3 className="text-sm font-medium text-zinc-200">{name}</h3>
        </div>

        {isConfigured && (
          <button
            onClick={() => onToggle?.(!isActive)}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
              isActive ? 'bg-amber-500' : 'bg-zinc-600'
            }`}
          >
            <span
              className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                isActive ? 'translate-x-6' : 'translate-x-1'
              }`}
            />
          </button>
        )}
      </div>

      {isConfigured && (
        <div className="space-y-2 mb-3">
          <div className="flex items-center gap-2 text-xs">
            {status === 'connected' ? (
              <>
                <CheckCircle2 size={12} className="text-green-500" />
                <span className="text-green-400">Conectado</span>
              </>
            ) : status === 'error' ? (
              <>
                <XCircle size={12} className="text-red-400" />
                <span className="text-red-400">Erro</span>
              </>
            ) : (
              <>
                <XCircle size={12} className="text-zinc-500" />
                <span className="text-zinc-500">Desconectado</span>
              </>
            )}
          </div>
          {channel?.errorMessage && <p className="text-[10px] text-red-400/80 truncate">{channel.errorMessage}</p>}
          {channel?.config &&
            (() => {
              const cfg = channel.config as Record<string, unknown>;
              const userName = cfg.allowedUserName as string | undefined;
              const userId = cfg.allowedUserId as number | undefined;

              return userName || userId ? (
                <p className="text-[10px] text-zinc-500">{`Usuario: ${userName || userId}`}</p>
              ) : null;
            })()}
          {testResult && (
            <div
              className={`text-[10px] px-2 py-1 rounded ${testResult.success ? 'bg-green-500/10 text-green-400' : 'bg-red-500/10 text-red-400'}`}
            >
              {testResult.success ? `Bot: @${testResult.botUsername}` : `Falha: ${testResult.error}`}
            </div>
          )}
        </div>
      )}

      <div className="flex items-center gap-2">
        <button
          onClick={onConfigure}
          className="px-3 py-1.5 rounded-lg text-xs font-medium bg-zinc-700 hover:bg-zinc-600 text-zinc-300 hover:text-zinc-100 transition-colors flex items-center gap-1.5"
        >
          <Settings2 size={12} />
          Configurar
        </button>
        {isConfigured && (
          <button
            onClick={onTest}
            disabled={testing}
            className="px-3 py-1.5 rounded-lg text-xs font-medium bg-zinc-700 hover:bg-zinc-600 text-zinc-300 hover:text-zinc-100 transition-colors disabled:opacity-50 flex items-center gap-1.5"
          >
            {testing ? <Loader2 size={12} className="animate-spin" /> : <Zap size={12} />}
            Testar Conexao
          </button>
        )}
      </div>
    </div>
  );
}

export function ChannelsSettings() {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [showTelegramSetup, setShowTelegramSetup] = useState(false);
  const [testingTelegram, setTestingTelegram] = useState(false);
  const [telegramTestResult, setTelegramTestResult] = useState<{
    success: boolean;
    botUsername?: string;
    error?: string;
  } | null>(null);

  const loadChannels = useCallback(async () => {
    const list = await window.lionclaw.channels.list();
    setChannels(list);
  }, []);

  useEffect(() => {
    loadChannels();
  }, [loadChannels]);

  const telegramChannel = channels.find((c) => c.type === 'telegram');

  const handleToggle = async (type: string, active: boolean) => {
    await window.lionclaw.channels.toggle(type, active);
    await loadChannels();
  };

  const handleTestTelegram = async () => {
    setTestingTelegram(true);
    setTelegramTestResult(null);
    try {
      const result = await window.lionclaw.channels.testTelegram();
      setTelegramTestResult(result);
    } catch (err) {
      setTelegramTestResult({ success: false, error: String(err) });
    } finally {
      setTestingTelegram(false);
    }
  };

  return (
    <div className="space-y-3">
      <p className="text-sm text-zinc-400">
        Integracoes com plataformas de mensagem. Converse com o assistente de qualquer lugar.
      </p>

      <ChannelCard
        name="Telegram"
        icon={<MessageCircle size={20} />}
        channel={telegramChannel}
        onConfigure={() => setShowTelegramSetup(true)}
        onToggle={(active) => handleToggle('telegram', active)}
        onTest={handleTestTelegram}
        testing={testingTelegram}
        testResult={telegramTestResult}
      />

      {showTelegramSetup && (
        <TelegramSetup
          onClose={() => setShowTelegramSetup(false)}
          onSaved={() => {
            setShowTelegramSetup(false);
            loadChannels();
            setTelegramTestResult(null);
          }}
          existingConfig={
            telegramChannel?.config as
              | {
                  allowedUserId?: number;
                  allowedUserName?: string;
                  allowedUsers?: Array<{ userId: number; name: string }>;
                  allowedUserIds?: number[];
                  notifyOnSchedulerTasks?: boolean;
                  notifyOnDriveHandoff?: boolean;
                }
              | undefined
          }
        />
      )}
    </div>
  );
}
