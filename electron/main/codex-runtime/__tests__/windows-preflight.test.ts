import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const prep = vi.hoisted(() => ({
  resolveGitRoot: vi.fn(),
  detectCodexWindowsIssues: vi.fn(),
  countActionableIssues: vi.fn(),
  runPrep: vi.fn(),
  shouldSilenceWarning: vi.fn(),
}));
const dbm = vi.hoisted(() => ({
  getCodexWindowsPrepConsent: vi.fn(),
  CODEX_PREP_VERSION_CURRENT: 3,
}));
const ipc = vi.hoisted(() => ({ emitIPC: vi.fn() }));

vi.mock('../../codex-windows-prep', () => prep);
vi.mock('../../db', () => dbm);
vi.mock('../../pipeline-shared/ipc-emitter', () => ipc);

import { runOfficialPreFlight, resetOfficialPreparedRepos } from '../windows-preflight';

const realPlatform = process.platform;

function setPlatform(p: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: p, configurable: true });
}

describe('runOfficialPreFlight', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetOfficialPreparedRepos();
  });
  afterEach(() => {
    setPlatform(realPlatform);
  });

  it('mac/Linux: strict no-op (no prep block runs, no IPC, status not-windows)', () => {
    setPlatform('darwin');
    const res = runOfficialPreFlight('/Users/me/proj', 'p1', 'coder');
    expect(res.status).toBe('not-windows');
    expect(prep.resolveGitRoot).not.toHaveBeenCalled();
    expect(prep.detectCodexWindowsIssues).not.toHaveBeenCalled();
    expect(ipc.emitIPC).not.toHaveBeenCalled();
  });

  it('Windows + not a git repo: returns not-git-repo, no warning', () => {
    setPlatform('win32');
    prep.resolveGitRoot.mockReturnValue(null);
    const res = runOfficialPreFlight('C:/tmp/proj');
    expect(res.status).toBe('not-git-repo');
    expect(ipc.emitIPC).not.toHaveBeenCalled();
  });

  it('Windows + actionable issues + no silence: emits codex:windows-health-warning', () => {
    setPlatform('win32');
    prep.resolveGitRoot.mockReturnValue('C:/repo');
    const issues = [{ type: 'autocrlf-true', severity: 'high', message: 'm', hint: 'h' }];
    prep.detectCodexWindowsIssues.mockReturnValue(issues);
    prep.countActionableIssues.mockReturnValue(1);
    dbm.getCodexWindowsPrepConsent.mockReturnValue(undefined);
    prep.shouldSilenceWarning.mockReturnValue(false);

    const res = runOfficialPreFlight('C:/repo project with space', 'p1', 'coder');

    expect(prep.detectCodexWindowsIssues).toHaveBeenCalledWith('C:/repo');
    expect(res.status).toBe('warned');
    expect(ipc.emitIPC).toHaveBeenCalledWith(
      'codex:windows-health-warning',
      expect.objectContaining({ repoRoot: 'C:/repo', issues, projectId: 'p1', agentId: 'coder' }),
    );
  });

  it('Windows + explicit skip consent: silenced, no warning', () => {
    setPlatform('win32');
    prep.resolveGitRoot.mockReturnValue('C:/repo');
    prep.detectCodexWindowsIssues.mockReturnValue([{ severity: 'high' }]);
    prep.countActionableIssues.mockReturnValue(1);
    dbm.getCodexWindowsPrepConsent.mockReturnValue(undefined);
    prep.shouldSilenceWarning.mockReturnValue(true);

    const res = runOfficialPreFlight('C:/repo');
    expect(res.status).toBe('silenced');
    expect(ipc.emitIPC).not.toHaveBeenCalled();
  });

  it('Windows + current prepared consent + actionable issues: runs prep, then re-detects', () => {
    setPlatform('win32');
    prep.resolveGitRoot.mockReturnValue('C:/repo');
    prep.detectCodexWindowsIssues.mockReturnValueOnce([{ severity: 'high' }]).mockReturnValueOnce([]);
    prep.countActionableIssues.mockReturnValueOnce(1).mockReturnValueOnce(0);
    dbm.getCodexWindowsPrepConsent.mockReturnValue({ prepVersion: 3, action: 'prepared' });
    prep.runPrep.mockReturnValue({ applied: true, filesAffected: 4 });
    prep.shouldSilenceWarning.mockReturnValue(false);

    const res = runOfficialPreFlight('C:/repo', 'p1');
    expect(prep.runPrep).toHaveBeenCalledWith('C:/repo');
    expect(res.status).toBe('clean');
    expect(ipc.emitIPC).not.toHaveBeenCalled();
  });

  it('Windows + clean repo (no actionable issues): status clean, no warning', () => {
    setPlatform('win32');
    prep.resolveGitRoot.mockReturnValue('C:/repo');
    prep.detectCodexWindowsIssues.mockReturnValue([{ severity: 'low' }]);
    prep.countActionableIssues.mockReturnValue(0);
    dbm.getCodexWindowsPrepConsent.mockReturnValue(undefined);
    prep.shouldSilenceWarning.mockReturnValue(false);

    const res = runOfficialPreFlight('C:/repo');
    expect(res.status).toBe('clean');
    expect(ipc.emitIPC).not.toHaveBeenCalled();
  });
});
