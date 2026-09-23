import { useEffect, useState, useCallback } from 'react';
import type { CodexChatReasoningEffort } from '@/types';
import { CODEX_CHAT_EFFORT_BY_MODEL } from '@/constants/codex-models';

export interface DiscoveredCodexModel {
  id: string;
  displayName: string;
  description: string;
  supportedEfforts: readonly CodexChatReasoningEffort[];
  defaultEffort: CodexChatReasoningEffort;
  hidden: boolean;
}

export function useCodexModelCapabilities(): {
  capabilities: DiscoveredCodexModel[] | null;
  visibleModels: DiscoveredCodexModel[] | null;
  effortsFor: (model: string) => readonly CodexChatReasoningEffort[];
} {
  const [capabilities, setCapabilities] = useState<DiscoveredCodexModel[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    void window.lionclaw.codex
      .listModelCapabilities()
      .then((res) => {
        if (!cancelled && res.state === 'ready' && res.capabilities) {
          setCapabilities(res.capabilities as DiscoveredCodexModel[]);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const effortsFor = useCallback(
    (model: string): readonly CodexChatReasoningEffort[] => {
      const slug = (model || '').trim().toLowerCase();
      const found = capabilities?.find((c) => c.id.toLowerCase() === slug);
      return found?.supportedEfforts ?? CODEX_CHAT_EFFORT_BY_MODEL(model);
    },
    [capabilities],
  );

  const visibleModels = capabilities ? capabilities.filter((c) => !c.hidden) : null;

  return { capabilities, visibleModels, effortsFor };
}
