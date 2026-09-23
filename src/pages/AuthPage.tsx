import { useState } from 'react';
import { Eye, EyeOff, ArrowRight, Key, AlertTriangle, LogOut } from 'lucide-react';
import { useAuthStore } from '@/stores/auth-store';
import { SdkChoiceStep } from '@/components/auth/SdkChoiceStep';
import { CodexConfigPanel } from '@/components/auth/CodexConfigPanel';
import { ClaudeCompatConfigPanel } from '@/components/auth/ClaudeCompatConfigPanel';
import { LionSdkConfigPanel } from '@/components/auth/LionSdkConfigPanel';
import type { SdkChoice, SdkCompleteHandler, AppSettings } from '@/types';
import { CLAUDE_DEFAULT_MODEL } from '@/constants/claude-models';
import { lionClawLogoUrl } from '@/assets/lionclaw-logo';

interface AuthPageProps {
  mode: 'setup' | 'login' | 'continue-sdk';
}

export function AuthPage({ mode }: AuthPageProps) {
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [step, setStep] = useState<'password' | 'sdk-choice' | 'sdk-config' | 'apikey'>(
    mode === 'continue-sdk' ? 'sdk-choice' : 'password',
  );
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [chosenSdk, setChosenSdk] = useState<SdkChoice | null>('claude-anthropic');

  const { checkAuth } = useAuthStore();

  async function finishSdkSetup(): Promise<void> {
    if (mode === 'setup') {
      await window.lionclaw.auth.login(password);
    }
    await checkAuth();
  }

  const onComplete: SdkCompleteHandler = async (
    patch: Partial<AppSettings>,
    providerConnect?: () => Promise<{ ok: true } | { error: string }>,
  ): Promise<{ ok: true } | { error: string }> => {
    try {
      setIsSubmitting(true);
      setError('');
      if (providerConnect) {
        const result = await providerConnect();
        if ('error' in result) return result;
      }
      const result = await window.lionclaw.settings.update({
        ...patch,
        orchestratorSetupCompleted: true,
      });
      if (result && 'error' in result && result.error) {
        setError(result.error);
        return { error: result.error };
      }
      await finishSdkSetup();
      return { ok: true };
    } catch (e) {
      return { error: (e as Error).message };
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleSetup = async () => {
    if (step === 'password') {
      if (password.length < 6) {
        setError('Senha deve ter pelo menos 6 caracteres');
        return;
      }
      if (password !== confirmPassword) {
        setError('Senhas nao conferem');
        return;
      }
      setError('');
      setIsSubmitting(true);
      try {
        await window.lionclaw.auth.setupPassword(password);
        setStep('sdk-choice');
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setIsSubmitting(false);
      }
      return;
    }

    if (step === 'sdk-choice') {
      if (!chosenSdk) {
        setError('Escolha um SDK para continuar');
        return;
      }
      setError('');
      if (chosenSdk === 'claude-anthropic') {
        setStep('apikey');
      } else {
        setStep('sdk-config');
      }
      return;
    }

    if (step === 'apikey') {
      if (!apiKey.startsWith('sk-')) {
        setError('API key deve comecar com sk-');
        return;
      }
      setError('');
      setIsSubmitting(true);
      try {
        await window.lionclaw.settings.setApiKey(apiKey);
        const result = await window.lionclaw.settings.update({
          orchestratorRuntime: 'claude-sdk',
          orchestratorProvider: 'anthropic',
          orchestratorModel: CLAUDE_DEFAULT_MODEL,
          orchestratorSetupCompleted: true,
        });
        if (result && 'error' in result && result.error) {
          setError(result.error);
          return;
        }
        await finishSdkSetup();
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setIsSubmitting(false);
      }
      return;
    }
  };

  const handleLogin = async () => {
    if (!password) {
      setError('Digite sua senha');
      return;
    }
    setError('');
    setIsSubmitting(true);
    try {
      await window.lionclaw.auth.login(password);
      await checkAuth();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleLogout = async () => {
    try {
      await window.lionclaw.auth.logout();
      await checkAuth();
    } catch {}
  };

  const handleContinueSdkChoice = () => {
    if (!chosenSdk) {
      setError('Escolha um SDK para continuar');
      return;
    }
    setError('');
    if (chosenSdk === 'claude-anthropic') {
      setStep('apikey');
    } else {
      setStep('sdk-config');
    }
  };

  const isSetup = mode === 'setup';

  const subtitle = (() => {
    if (isSetup) {
      if (step === 'password') return 'Criar senha de acesso';
      if (step === 'sdk-choice') return 'Escolher SDK orquestrador';
      if (step === 'sdk-config') return 'Configurar SDK';
      return 'Configurar API Key';
    }
    if (mode === 'continue-sdk') {
      if (step === 'sdk-choice') return 'Escolher SDK orquestrador';
      if (step === 'sdk-config') return 'Configurar SDK';
      if (step === 'apikey') return 'Configurar API Key';
    }
    return 'Acesso protegido';
  })();

  const logo = (
    <div data-testid="auth-brand" className="mb-8 flex flex-col items-center text-center">
      <img
        src={lionClawLogoUrl}
        alt="LionClaw"
        className="w-20 h-20 rounded-2xl mb-3 object-contain"
        onError={(e) => {
          (e.target as HTMLImageElement).style.display = 'none';
        }}
      />
      <div className="flex items-baseline justify-center gap-2">
        <h1 className="text-2xl font-bold text-zinc-100">LionClaw</h1>
        <span data-testid="auth-version" className="text-base font-medium text-zinc-300">
          {/* Mesma regra do formatAppVersionLabel da sidebar: remove so o .0
              final (3.7.0 -> v3.7; 3.7.1 -> v3.7.1). */}
          v{__APP_VERSION__.replace(/\.0$/, '')}
        </span>
      </div>
      <p className="text-sm text-zinc-500 mt-1">{subtitle}</p>
    </div>
  );

  if (step === 'sdk-choice') {
    const handleAction = mode === 'continue-sdk' ? handleContinueSdkChoice : handleSetup;
    return (
      <div className="flex min-h-screen w-full items-center justify-center bg-zinc-950 px-6 py-8">
        <div className="w-full max-w-sm">
          {logo}
          <SdkChoiceStep value={chosenSdk} onChange={setChosenSdk} />
          {error && <p className="text-sm text-red-400 mt-3">{error}</p>}
          <button
            onClick={handleAction}
            disabled={!chosenSdk || isSubmitting}
            className="w-full mt-6 flex items-center justify-center gap-2 bg-amber-600 hover:bg-amber-500 text-white rounded-lg px-4 py-2.5 text-sm font-medium transition-colors disabled:opacity-50"
          >
            {isSubmitting ? (
              <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
            ) : (
              <>
                Continuar
                <ArrowRight size={16} />
              </>
            )}
          </button>
          {mode === 'continue-sdk' && (
            <button
              onClick={handleLogout}
              className="w-full mt-3 flex items-center justify-center gap-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded-lg px-4 py-2.5 text-sm font-medium transition-colors"
            >
              <LogOut size={16} />
              Sair
            </button>
          )}
        </div>
      </div>
    );
  }

  if (step === 'sdk-config') {
    if (chosenSdk === 'codex') {
      return (
        <div className="flex min-h-screen w-full items-center justify-center bg-zinc-950 px-6 py-8">
          <div className="w-full max-w-sm">
            {logo}
            <CodexConfigPanel onComplete={onComplete} />
            <button
              onClick={() => setStep('sdk-choice')}
              className="w-full mt-3 flex items-center justify-center gap-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded-lg px-4 py-2.5 text-sm font-medium transition-colors"
            >
              Voltar
            </button>
          </div>
        </div>
      );
    }

    if (chosenSdk === 'claude-compat') {
      return (
        <div className="flex min-h-screen w-full items-center justify-center bg-zinc-950 px-6 py-8">
          <div className="w-full max-w-sm">
            {logo}
            <ClaudeCompatConfigPanel onComplete={onComplete} />
            <button
              onClick={() => setStep('sdk-choice')}
              className="w-full mt-3 flex items-center justify-center gap-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded-lg px-4 py-2.5 text-sm font-medium transition-colors"
            >
              Voltar
            </button>
          </div>
        </div>
      );
    }

    if (chosenSdk === 'lion-sdk') {
      return (
        <div className="h-screen overflow-y-auto overscroll-contain bg-zinc-950">
          <div className="flex min-h-full items-start justify-center px-6 py-8 pb-12">
            <div className="w-full max-w-sm">
              {logo}
              <LionSdkConfigPanel onComplete={onComplete} />
              <button
                onClick={() => setStep('sdk-choice')}
                className="w-full mt-3 flex items-center justify-center gap-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded-lg px-4 py-2.5 text-sm font-medium transition-colors"
              >
                Voltar
              </button>
            </div>
          </div>
        </div>
      );
    }

    return (
      <div className="flex min-h-screen w-full items-center justify-center bg-zinc-950 px-6 py-8">
        <div className="w-full max-w-sm">
          {logo}
          <div className="flex flex-col items-center gap-4 p-6 bg-zinc-900 border border-zinc-800 rounded-xl">
            <AlertTriangle size={28} className="text-amber-500" />
            <p className="text-sm text-zinc-300 text-center leading-relaxed">SDK nao reconhecido.</p>
          </div>
          <button
            onClick={() => setStep('sdk-choice')}
            className="w-full mt-3 flex items-center justify-center gap-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded-lg px-4 py-2.5 text-sm font-medium transition-colors"
          >
            Voltar
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen w-full items-center justify-center bg-zinc-950 px-6 py-8">
      <div className="w-full max-w-sm">
        {logo}

        {/* Setup: password step */}
        {isSetup && step === 'password' && (
          <div className="space-y-4">
            <div>
              <label className="block text-xs text-zinc-500 mb-1.5">Criar senha</label>
              <div className="relative">
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2.5 text-sm text-zinc-100 outline-none focus:border-amber-500/50"
                  placeholder="Minimo 6 caracteres"
                  autoFocus
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300"
                >
                  {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </div>
            <div>
              <label className="block text-xs text-zinc-500 mb-1.5">Confirmar senha</label>
              <input
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleSetup()}
                className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2.5 text-sm text-zinc-100 outline-none focus:border-amber-500/50"
                placeholder="Repita a senha"
              />
            </div>
          </div>
        )}

        {/* Setup / continue-sdk: apikey step */}
        {(isSetup || mode === 'continue-sdk') && step === 'apikey' && (
          <div className="space-y-4">
            <div>
              <label className="block text-xs text-zinc-500 mb-1.5">Anthropic API Key</label>
              <div className="relative">
                <Key size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" />
                <input
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleSetup()}
                  className="w-full bg-zinc-900 border border-zinc-800 rounded-lg pl-10 pr-3 py-2.5 text-sm text-zinc-100 outline-none focus:border-amber-500/50"
                  placeholder="sk-ant-..."
                  autoFocus
                />
              </div>
              <p className="text-xs text-zinc-600 mt-1.5">Armazenada no keychain do SO, nunca em plaintext</p>
            </div>
          </div>
        )}

        {/* Login flow */}
        {mode === 'login' && (
          <div className="space-y-4">
            <div>
              <label className="block text-xs text-zinc-500 mb-1.5">Senha</label>
              <div className="relative">
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleLogin()}
                  className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2.5 text-sm text-zinc-100 outline-none focus:border-amber-500/50"
                  placeholder="Sua senha"
                  autoFocus
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300"
                >
                  {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Error */}
        {error && <p className="text-sm text-red-400 mt-3">{error}</p>}

        {/* Action button for password / apikey / login steps.
            At this point in the render path, step is always 'password' or 'apikey'
            (sdk-choice and sdk-config branches already returned above). The guard
            is therefore implicit; no conditional needed. */}
        <button
          onClick={isSetup || (mode === 'continue-sdk' && step === 'apikey') ? handleSetup : handleLogin}
          disabled={isSubmitting}
          className="w-full mt-6 flex items-center justify-center gap-2 bg-amber-600 hover:bg-amber-500 text-white rounded-lg px-4 py-2.5 text-sm font-medium transition-colors disabled:opacity-50"
        >
          {isSubmitting ? (
            <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
          ) : (
            <>
              {isSetup && step === 'password'
                ? 'Continuar'
                : isSetup || (mode === 'continue-sdk' && step === 'apikey')
                  ? 'Iniciar LionClaw'
                  : 'Entrar'}
              <ArrowRight size={16} />
            </>
          )}
        </button>

        {/* Back button on apikey step in continue-sdk mode */}
        {mode === 'continue-sdk' && step === 'apikey' && (
          <button
            onClick={() => setStep('sdk-choice')}
            className="w-full mt-3 flex items-center justify-center gap-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded-lg px-4 py-2.5 text-sm font-medium transition-colors"
          >
            Voltar
          </button>
        )}
      </div>
    </div>
  );
}
