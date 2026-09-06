
import {
  resolveGitRoot,
  detectCodexWindowsIssues,
  countActionableIssues,
  runPrep,
  shouldSilenceWarning,
} from '../codex-windows-prep';
import { getCodexWindowsPrepConsent, CODEX_PREP_VERSION_CURRENT } from '../db';
import { emitIPC } from '../pipeline-shared/ipc-emitter';
import { createLogger } from '../logger';

const logger = createLogger('codex-runtime:windows-preflight');

const officialPreparedRepos = new Set<string>();

export interface OfficialPreFlightResult {
  status: 'not-windows' | 'not-git-repo' | 'silenced' | 'clean' | 'warned';
  repoRoot?: string;
  actionableCount?: number;
}

export function runOfficialPreFlight(
  cwd: string,
  projectId?: string,
  agentId?: string,
): OfficialPreFlightResult {
  if (process.platform !== 'win32') {
    return { status: 'not-windows' };
  }

  const repoRoot = resolveGitRoot(cwd);
  if (!repoRoot) {
    return { status: 'not-git-repo' };
  }

  let issues = detectCodexWindowsIssues(repoRoot);
  let actionableCount = countActionableIssues(issues);

  const consent = getCodexWindowsPrepConsent(repoRoot);
  let prepSucceededThisRun = false;
  if (
    consent &&
    consent.prepVersion >= CODEX_PREP_VERSION_CURRENT &&
    consent.action === 'prepared' &&
    !officialPreparedRepos.has(repoRoot)
  ) {
    if (actionableCount === 0) {
      officialPreparedRepos.add(repoRoot);
      logger.info(
        { projectId, repoRoot },
        'official codex auto-prep skipped: no actionable issues remain',
      );
    } else {
      const result = runPrep(repoRoot);
      if (result.applied) {
        officialPreparedRepos.add(repoRoot);
        prepSucceededThisRun = true;
        logger.info(
          { projectId, repoRoot, filesAffected: result.filesAffected },
          'official codex auto-prep applied silently',
        );
      } else {
        logger.warn(
          { projectId, repoRoot, reason: result.reason },
          'official codex auto-prep skipped',
        );
      }
    }
  }

  if (shouldSilenceWarning(repoRoot)) {
    return { status: 'silenced', repoRoot };
  }

  if (prepSucceededThisRun) {
    issues = detectCodexWindowsIssues(repoRoot);
    actionableCount = countActionableIssues(issues);
  }

  if (actionableCount === 0) {
    return { status: 'clean', repoRoot, actionableCount: 0 };
  }

  emitIPC('codex:windows-health-warning', {
    projectId,
    agentId,
    cwd,
    repoRoot,
    timestamp: Date.now(),
    issues,
  });
  logger.warn(
    { projectId, repoRoot, actionableCount, totalIssues: issues.length },
    'official codex windows pre-flight warning',
  );
  return { status: 'warned', repoRoot, actionableCount };
}

export function resetOfficialPreparedRepos(): void {
  officialPreparedRepos.clear();
}
