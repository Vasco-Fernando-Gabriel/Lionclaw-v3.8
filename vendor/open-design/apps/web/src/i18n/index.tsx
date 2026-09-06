'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { de } from './locales/de';
import { en } from './locales/en';
import { id } from './locales/id';
import { esES } from './locales/es-ES';
import { fa } from './locales/fa';
import { ar } from './locales/ar';
import { ja } from './locales/ja';
import { ko } from './locales/ko';
import { ptBR } from './locales/pt-BR';
import { ru } from './locales/ru';
import { zhCN } from './locales/zh-CN';
import { zhTW } from './locales/zh-TW';
import { pl } from './locales/pl';
import { hu } from './locales/hu';
import { fr } from './locales/fr';
import { uk } from './locales/uk';
import { tr } from './locales/tr';
import { th } from './locales/th';
import { LOCALES, type Dict, type Locale } from './types';

export { LOCALES, LOCALE_LABEL } from './types';
export type { Locale } from './types';

type DictKey = keyof Dict;

const DICTS: Record<Locale, Dict> = {
  'en': en,
  'id': id,
  'de': de,
  'zh-CN': zhCN,
  'zh-TW': zhTW,
  'pt-BR': ptBR,
  'es-ES': esES,
  'ru': ru,
  'fa': fa,
  'ar': ar,
  'ja': ja,
  'ko': ko,
  'pl': pl,
  'hu': hu,
  'fr': fr,
  'uk': uk,
  'tr': tr,
  'th': th,
};

const LS_KEY = 'open-design:locale';

// LionClaw embed-mode patch (SPEC docs/spec-opendesign-vendor.md L632-638,
// secao 5.6 + Findings P1/P2). Regra de prioridade depende do modo:
//
//   Modo embedded (`?host=lionclaw` na URL):
//     1. Query param `?locale=<code>` (escolha do LionClaw — autoridade).
//     2. localStorage[`open-design:locale`].
//     3. Default `en`.
//
//   Modo standalone (sem `?host=lionclaw`):
//     1. localStorage (pick manual previo do usuario — comportamento upstream).
//     2. Query param `?locale=<code>` (defensivo, caso alguem teste manualmente).
//     3. Default `en`.
//
// Razao para inverter a ordem em modo embedded: o LionClaw eh dono da sessao
// (SPEC L591-653). A escolha de idioma vive em `harness_projects.config.openDesign.sessionConfig.locale`
// (PT-BR por padrao). Se um localStorage antigo do OD ja tiver `en` salvo de
// outro contexto, ele NAO pode sobrescrever a eleicao explicita do LionClaw —
// senao o pipeline `development-v2` abriria em ingles mesmo com `pt-BR`
// configurado na fase 4.
//
// Modo standalone preserva o comportamento upstream: a query `?locale=` so
// existe como override defensivo para testes manuais; o pick manual via menu
// (que grava no localStorage) continua sendo a fonte de verdade.
//
// Em ambos os modos, quando a query eh aceita ela tambem persiste no
// localStorage — sobreviver a navegacoes do router upstream que descartam
// query params (`vendor/open-design/apps/web/src/router.ts:46-52`).

function readLocaleFromQuery(): Locale | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = new URLSearchParams(window.location.search).get('locale');
    if (raw && (LOCALES as string[]).includes(raw)) return raw as Locale;
  } catch {
    /* ignore */
  }
  return null;
}

function readLocaleFromStorage(): Locale | null {
  if (typeof window === 'undefined') return null;
  try {
    const stored = window.localStorage.getItem(LS_KEY);
    if (stored && (LOCALES as string[]).includes(stored)) return stored as Locale;
  } catch {
    /* ignore */
  }
  return null;
}

function persistLocale(next: Locale): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(LS_KEY, next);
  } catch {
    /* ignore */
  }
}

function isHostLionClaw(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    if (new URLSearchParams(window.location.search).get('host') === 'lionclaw') return true;
    // sessionStorage cache espelha o que `embed-mode.ts` gravou no primeiro
    // contato — sobrevive ao router upstream que descarta query params.
    return window.sessionStorage?.getItem('lionclaw:embedded') === '1';
  } catch {
    return false;
  }
}

function detectInitialLocale(): Locale {
  if (typeof window === 'undefined') return 'en';

  const embedded = isHostLionClaw();
  const fromQuery = readLocaleFromQuery();
  const fromStorage = readLocaleFromStorage();

  if (embedded) {
    // Query do LionClaw eh autoridade — persiste imediatamente para que a UI
    // continue em PT-BR mesmo apos navegacoes que limpam `?locale=`.
    if (fromQuery) {
      persistLocale(fromQuery);
      return fromQuery;
    }
    if (fromStorage) return fromStorage;
    return 'en';
  }

  // Modo standalone — comportamento upstream com query como override defensivo.
  if (fromStorage) return fromStorage;
  if (fromQuery) {
    persistLocale(fromQuery);
    return fromQuery;
  }
  return 'en';
}

interface I18nContextValue {
  locale: Locale;
  setLocale: (next: Locale) => void;
  t: (key: DictKey, vars?: Record<string, string | number>) => string;
}

const I18nContext = createContext<I18nContextValue | null>(null);

interface ProviderProps {
  initial?: Locale;
  children: ReactNode;
}

const RTL_LOCALES: Locale[] = ['ar', 'fa'];

export function I18nProvider({ initial, children }: ProviderProps) {
  const [locale, setLocaleState] = useState<Locale>(() => initial ?? detectInitialLocale());

  // Keep <html lang="…" dir="…"> in sync so screen readers and CSS hooks
  // pick the right language token and direction without each component
  // having to set it itself.
  useEffect(() => {
    if (typeof document !== 'undefined') {
      const dir = RTL_LOCALES.includes(locale) ? 'rtl' : 'ltr';
      document.documentElement.setAttribute('lang', locale);
      document.documentElement.setAttribute('dir', dir);
    }
  }, [locale]);

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    try {
      window.localStorage.setItem(LS_KEY, next);
    } catch {
      /* ignore */
    }
  }, []);

  const t = useCallback(
    (key: DictKey, vars?: Record<string, string | number>): string => {
      const dict = DICTS[locale] ?? en;
      const raw = dict[key] ?? en[key] ?? key;
      if (!vars) return raw;
      return raw.replace(/\{(\w+)\}/g, (_, name: string) => {
        const v = vars[name];
        return v == null ? `{${name}}` : String(v);
      });
    },
    [locale],
  );

  const value = useMemo<I18nContextValue>(
    () => ({ locale, setLocale, t }),
    [locale, setLocale, t],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) {
    // Fall back to a stand-alone English translator when no provider is
    // mounted (e.g. an isolated test). This keeps the API safe to call
    // without requiring every callsite to wrap in a provider.
    return {
      locale: 'en',
      setLocale: () => { },
      t: (key, vars) => {
        const raw = en[key] ?? key;
        if (!vars) return raw;
        return raw.replace(/\{(\w+)\}/g, (_, n: string) => {
          const v = vars[n];
          return v == null ? `{${n}}` : String(v);
        });
      },
    };
  }
  return ctx;
}

// Convenience for components that only need the translator function.
export function useT(): I18nContextValue['t'] {
  return useI18n().t;
}
