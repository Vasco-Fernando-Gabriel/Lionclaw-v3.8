import { create } from 'zustand';
import {
  translateLlmError,
  type TranslateLlmErrorInput,
  type TranslatedLlmError,
} from '@/utils/translate-llm-error';

export const ERROR_TOAST_AUTO_DISMISS_MS = 8000;
const MAX_TOASTS = 5;

export interface ErrorToast extends TranslatedLlmError {
  id: string;
  source?: string;
  createdAt: number;
}

export interface PushErrorOptions {
  title?: string;
  source?: string;
}

interface ErrorToastState {
  toasts: ErrorToast[];
  pushError: (
    input: TranslateLlmErrorInput | string | Error | null | undefined,
    opts?: PushErrorOptions,
  ) => string;
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
