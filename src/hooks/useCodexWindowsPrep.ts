
import { useCallback, useRef, useState } from 'react';
import type { CodexPrepCheckResult, CodexPrepApplyResult, CodexWindowsIssue } from '@/types';

export interface UseCodexWindowsPrepReturn {
  checkResult: CodexPrepCheckResult | null;
  busy: boolean;
  checkProject: (projectPath: string) => Promise<CodexPrepCheckResult>;
  openFromWarning: (repoRoot: string, issues: CodexWindowsIssue[]) => void;
  ensureCheckedThen: (projectPath: string, pendingAction: () => void | Promise<void>) => Promise<void>;
  dismiss: () => void;
  handleDialogDone: (result: CodexPrepApplyResult | null) => void;
}

export function useCodexWindowsPrep(): UseCodexWindowsPrepReturn {
  const [checkResult, setCheckResult] = useState<CodexPrepCheckResult | null>(null);
  const [busy, setBusy] = useState(false);
  const pendingActionRef = useRef<(() => void | Promise<void>) | null>(null);

  const flushPending = useCallback((): void => {
    const action = pendingActionRef.current;
    pendingActionRef.current = null;
    if (action) {
      void Promise.resolve(action()).catch((err) => {
        // eslint-disable-next-line no-console
        console.error('useCodexWindowsPrep: pending action threw', err);
      });
    }
  }, []);

  const checkProject = useCallback(
    async (projectPath: string): Promise<CodexPrepCheckResult> => {
      setBusy(true);
      try {
        const result = (await window.lionclaw.codex.checkPrepNeeded(projectPath)) as CodexPrepCheckResult;
        if (result.needs) {
          setCheckResult(result);
        }
        return result;
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const openFromWarning = useCallback((repoRoot: string, issues: CodexWindowsIssue[]): void => {
    setCheckResult({
      needs: true,
      reason: 'needs-dialog',
      repoRoot,
      issues,
    });
  }, []);

  const ensureCheckedThen = useCallback(
    async (projectPath: string, pendingAction: () => void | Promise<void>): Promise<void> => {
      pendingActionRef.current = pendingAction;
      try {
        const result = await checkProject(projectPath);
        if (!result.needs) {
          flushPending();
          return;
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('useCodexWindowsPrep: checkProject falhou, executando pendingAction sem prep', err);
        flushPending();
      }
    },
    [checkProject, flushPending],
  );

  const dismiss = useCallback(() => {
    setCheckResult(null);
    flushPending();
  }, [flushPending]);

  const handleDialogDone = useCallback(
    (_result: CodexPrepApplyResult | null) => {
      setCheckResult(null);
      flushPending();
    },
    [flushPending],
  );

  return { checkResult, busy, checkProject, openFromWarning, ensureCheckedThen, dismiss, handleDialogDone };
}
