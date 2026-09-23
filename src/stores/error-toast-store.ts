import { create } from 'zustand';
import { translateLlmError, type TranslateLlmErrorInput, type TranslatedLlmError } from '@/utils/translate-llm-error';

export const ERROR_TOAST_AUTO_DISMISS_MS = 8000;
const MAX_TOASTS = 5;

export type ToastTone = 'error' | 'success' | 'warning' | 'info';

export interface ErrorToast extends TranslatedLlmError {
  id: string;
  source?: string;
  createdAt: number;
  tone: ToastTone;
}

export interface PushErrorOptions {
  title?: string;
  source?: string;
}

export interface PushNoticeOptions {
  tone: Exclude<ToastTone, 'error'>;
  body: string;
  detail?: string;
  source?: string;
  persist?: boolean;
}

interface ErrorToastState {
  toasts: ErrorToast[];
  pushError: (input: TranslateLlmErrorInput | string | Error | null | undefined, opts?: PushErrorOptions) => string;
  pushNotice: (title: string, opts: PushNoticeOptions) => string;
  dismissToast: (id: string) => void;
  clearToasts: () => void;
}

let nextToastId = 0;

export const useErrorToastStore = create<ErrorToastState>((set, get) => ({
  toasts: [],

  pushError: (input, opts) => {
    const translated = translateLlmError(input);
    nextToastId += 1;
    const id = `toast-${nextToastId}`;
    const toast: ErrorToast = {
      ...translated,
      ...(opts?.title ? { title: opts.title } : {}),
      id,
      ...(opts?.source ? { source: opts.source } : {}),
      createdAt: Date.now(),
      tone: 'error',
    };

    set((state) => ({ toasts: [...state.toasts, toast].slice(-MAX_TOASTS) }));

    if (!toast.persist) {
      setTimeout(() => {
        get().dismissToast(id);
      }, ERROR_TOAST_AUTO_DISMISS_MS);
    }

    return id;
  },

  pushNotice: (title, opts) => {
    nextToastId += 1;
    const id = `toast-${nextToastId}`;
    const toast: ErrorToast = {
      code: opts.tone === 'success' ? 'NOTICE-OK' : opts.tone === 'info' ? 'NOTICE-INFO' : 'NOTICE-WARN',
      title,
      body: opts.body,
      persist: opts.persist ?? false,
      ...(opts.detail ? { detail: opts.detail } : {}),
      ...(opts.source ? { source: opts.source } : {}),
      id,
      createdAt: Date.now(),
      tone: opts.tone,
    };

    set((state) => ({ toasts: [...state.toasts, toast].slice(-MAX_TOASTS) }));

    if (!toast.persist) {
      setTimeout(() => {
        get().dismissToast(id);
      }, ERROR_TOAST_AUTO_DISMISS_MS);
    }

    return id;
  },

  dismissToast: (id) => {
    set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) }));
  },

  clearToasts: () => set({ toasts: [] }),
}));
