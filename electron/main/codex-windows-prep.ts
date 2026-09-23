import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { createLogger } from './logger';
import {
  CODEX_PREP_VERSION_CURRENT,
  getCodexWindowsPrepConsent,
  markCodexWindowsPrepApplied,
  systemHasActiveCodexAgents,
  upsertCodexWindowsPrepConsent,
  type CodexWindowsPrepConsent,
} from './db';
import { isCodexAvailable } from './codex-runtime/binary';

const logger = createLogger('codex-windows-prep');

export type CodexWindowsIssueType = 'autocrlf-true' | 'no-gitattributes' | 'mixed-line-endings' | 'powershell-5.1';

export interface CodexWindowsIssue {
  type: CodexWindowsIssueType;
  severity: 'low' | 'medium' | 'high';
  message: string;
  hint: string;
}

export interface CheckPrepNeededResult {
  needs: boolean;
  reason:
    | 'not-windows'
    | 'not-git-repo'
    | 'codex-not-authenticated'
    | 'no-codex-agents'
    | 'no-issues'
    | 'consent-current'
    | 'consent-skip-current'
    | 'needs-dialog';
  repoRoot?: string;
  issues?: CodexWindowsIssue[];
  consent?: CodexWindowsPrepConsent | null;
}

export type PrepResult =
  | { applied: true; filesAffected: number }
  | {
      applied: false;
      reason: 'not-windows' | 'no-git-repo' | 'has-submodules' | 'dirty-tree' | 'error';
      message?: string;
    };

const LARGE_RENORMALIZE_THRESHOLD = 5000;
const GIT_ATTRIBUTES_LF_RULE = '* text=auto eol=lf';

function gitExec(repoRoot: string, args: string[], timeoutMs = 30_000): string {
  return execFileSync('git', ['-C', repoRoot, ...args], {
    encoding: 'utf-8',
    timeout: timeoutMs,
    windowsHide: true,
  }).trim();
}

function gitExecSafe(repoRoot: string, args: string[]): string | null {
  try {
    return gitExec(repoRoot, args);
  } catch (err) {
    logger.debug({ args, err: (err as Error).message }, 'git command failed');
    return null;
  }
}

function gitRevParseRoot(p: string): string | null {
  try {
    const out = execFileSync('git', ['-C', p, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf-8',
      timeout: 5_000,
      windowsHide: true,
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

const SKIP_DIR_NAMES = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  '.cache',
  '.idea',
  '.vscode',
  'out',
  'target',
  '__pycache__',
  '.venv',
  'venv',
]);

export function resolveGitRoot(anyPath: string): string | null {
  const direct = gitRevParseRoot(anyPath);
  if (direct) return direct;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(anyPath, { withFileTypes: true });
  } catch {
    return null;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (SKIP_DIR_NAMES.has(entry.name)) continue;
    if (entry.name.startsWith('.')) continue;

    const candidate = path.join(anyPath, entry.name);
    if (!fs.existsSync(path.join(candidate, '.git'))) continue;

    const root = gitRevParseRoot(candidate);
    if (root) {
      logger.info({ projectPath: anyPath, repoRoot: root }, 'resolveGitRoot: matched subdirectory');
      return root;
    }
  }

  return null;
}

function hasSubmodules(repoRoot: string): boolean {
  if (fs.existsSync(path.join(repoRoot, '.gitmodules'))) return true;
  const out = gitExecSafe(repoRoot, ['submodule', 'status']);
  return out !== null && out.length > 0;
}

function gitStatusClean(repoRoot: string): boolean {
  const out = gitExecSafe(repoRoot, ['status', '--porcelain']);
  return out === '';
}

function gitStatusPorcelain(repoRoot: string): string[] {
  const out = gitExecSafe(repoRoot, ['status', '--porcelain']);
  if (out === null || out.length === 0) return [];
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function isOnlyPrepGeneratedGitAttributesDirty(repoRoot: string): boolean {
  const status = gitStatusPorcelain(repoRoot);
  if (status.length !== 1 || !/^(?:\?\?|A)\s+\.gitattributes$/.test(status[0] ?? '')) {
    return false;
  }

  const p = gitAttributesPath(repoRoot);
  if (!fs.existsSync(p)) return false;

  try {
    const content = fs.readFileSync(p, 'utf-8');
    return /(^|\n)\*\s+text=auto\s+eol=lf(\n|$)/i.test(content);
  } catch {
    return false;
  }
}

function readAutoCrlf(repoRoot: string): string | null {
  return gitExecSafe(repoRoot, ['config', '--get', 'core.autocrlf']);
}

function gitAttributesPath(repoRoot: string): string {
  return path.join(repoRoot, '.gitattributes');
}

function gitAttributesHasLfRule(repoRoot: string): boolean {
  const p = gitAttributesPath(repoRoot);
  if (!fs.existsSync(p)) return false;
  const content = fs.readFileSync(p, 'utf-8');
  return /eol\s*=\s*lf/i.test(content);
}

function countMixedLineEndings(repoRoot: string): { count: number; sample: string[] } {
  const mismatched = listLineEndingMismatches(repoRoot);
  return {
    count: mismatched.length,
    sample: mismatched.slice(0, 10),
  };
}

function listLineEndingMismatches(repoRoot: string): string[] {
  const out = gitExecSafe(repoRoot, ['ls-files', '--eol']);
  if (!out) return [];

  const lines = out.split('\n');
  const mismatched: string[] = [];

  for (const line of lines) {
    const tabIndex = line.indexOf('\t');
    const meta = tabIndex >= 0 ? line.slice(0, tabIndex) : line;
    const filename = tabIndex >= 0 ? line.slice(tabIndex + 1) : '';
    if (!filename) continue;

    const m = meta.match(/^i\/(\S+)\s+w\/(\S+)/);
    if (!m) continue;
    const indexEol = m[1];
    const worktreeEol = m[2];

    if (indexEol !== 'none' && (indexEol !== worktreeEol || indexEol === 'mixed' || worktreeEol === 'mixed')) {
      mismatched.push(filename);
    }
  }

  return mismatched;
}

function normalizeBufferLineEndingsToLf(buf: Buffer): Buffer {
  const out: number[] = [];
  for (let i = 0; i < buf.length; i++) {
    const byte = buf[i];
    if (byte === 0x0d) {
      if (buf[i + 1] === 0x0a) {
        out.push(0x0a);
        i++;
      } else {
        out.push(0x0a);
      }
    } else {
      out.push(byte);
    }
  }
  return Buffer.from(out);
}

function rewriteWorkingTreeLineEndingsToLf(repoRoot: string, files: string[]): number {
  let changed = 0;
  const root = path.resolve(repoRoot);

  for (const file of files) {
    const abs = path.resolve(repoRoot, file);
    if (abs !== root && !abs.startsWith(root + path.sep)) continue;
    if (!fs.existsSync(abs)) continue;
    const stat = fs.statSync(abs);
    if (!stat.isFile()) continue;

    const before = fs.readFileSync(abs);
    const after = normalizeBufferLineEndingsToLf(before);
    if (Buffer.compare(before, after) !== 0) {
      fs.writeFileSync(abs, after);
      changed++;
    }
  }

  return changed;
}

export function detectCodexWindowsIssues(repoRoot: string): CodexWindowsIssue[] {
  if (process.platform !== 'win32') return [];

  const issues: CodexWindowsIssue[] = [];

  const autocrlf = readAutoCrlf(repoRoot);
  if (autocrlf === 'true') {
    issues.push({
      type: 'autocrlf-true',
      severity: 'high',
      message: 'core.autocrlf=true detectado (converte LF -> CRLF no checkout)',
      hint: 'Pode causar Codex apply_patch failures em arquivos de codigo.',
    });
  }

  if (!gitAttributesHasLfRule(repoRoot)) {
    issues.push({
      type: 'no-gitattributes',
      severity: 'medium',
      message: '.gitattributes ausente ou sem regra eol=lf',
      hint: 'Recomendado adicionar "* text=auto eol=lf" pra forcar LF cross-platform.',
    });
  }

  const mixed = countMixedLineEndings(repoRoot);
  if (mixed.count > 0) {
    issues.push({
      type: 'mixed-line-endings',
      severity: 'medium',
      message: `${mixed.count} arquivo(s) com line endings mistos/divergentes (index vs working tree)`,
      hint: `Exemplos: ${mixed.sample.slice(0, 3).join(', ')}${mixed.count > 3 ? '...' : ''}`,
    });
  }

  issues.push({
    type: 'powershell-5.1',
    severity: 'low',
    message: 'Codex usa PowerShell 5.1 (encoding default CP-1252)',
    hint: 'Pode corromper UTF-8 sem BOM. Guardrail no system prompt do Codex orienta uso de leitura UTF-8 explicita.',
  });

  return issues;
}

export function isActionableIssue(issue: CodexWindowsIssue): boolean {
  return issue.severity !== 'low';
}

export function countActionableIssues(issues: CodexWindowsIssue[]): number {
  return issues.filter(isActionableIssue).length;
}

export async function checkProjectNeedsPrep(projectPath: string): Promise<CheckPrepNeededResult> {
  if (process.platform !== 'win32') {
    return { needs: false, reason: 'not-windows' };
  }

  const repoRoot = resolveGitRoot(projectPath);
  if (!repoRoot) {
    return { needs: false, reason: 'not-git-repo' };
  }

  const codexStatus = await isCodexAvailable();
  if (!codexStatus.authenticated) {
    return { needs: false, reason: 'codex-not-authenticated', repoRoot };
  }

  if (!systemHasActiveCodexAgents()) {
    return { needs: false, reason: 'no-codex-agents', repoRoot };
  }

  const issues = detectCodexWindowsIssues(repoRoot);
  if (countActionableIssues(issues) === 0) {
    return { needs: false, reason: 'no-issues', repoRoot, issues };
  }

  const consent = getCodexWindowsPrepConsent(repoRoot);
  if (consent && consent.prepVersion >= CODEX_PREP_VERSION_CURRENT && consent.action === 'skip') {
    return {
      needs: false,
      reason: 'consent-skip-current',
      repoRoot,
      issues,
      consent,
    };
  }

  if (
    consent &&
    consent.prepVersion >= CODEX_PREP_VERSION_CURRENT &&
    consent.action === 'prepared' &&
    consent.lastAppliedAt !== null &&
    countActionableIssues(issues) === 0
  ) {
    return {
      needs: false,
      reason: 'consent-current',
      repoRoot,
      issues,
      consent,
    };
  }

  return {
    needs: true,
    reason: 'needs-dialog',
    repoRoot,
    issues,
    consent,
  };
}

export function runPrep(repoRoot: string): PrepResult {
  if (process.platform !== 'win32') {
    return { applied: false, reason: 'not-windows' };
  }

  if (!fs.existsSync(path.join(repoRoot, '.git'))) {
    logger.warn({ repoRoot }, 'runPrep: not a git repo');
    return { applied: false, reason: 'no-git-repo' };
  }

  if (hasSubmodules(repoRoot)) {
    logger.warn({ repoRoot }, 'runPrep: submodules detected, skipping for safety');
    return { applied: false, reason: 'has-submodules' };
  }

  if (!gitStatusClean(repoRoot) && !isOnlyPrepGeneratedGitAttributesDirty(repoRoot)) {
    logger.warn({ repoRoot }, 'runPrep: working tree dirty, skipping');
    return { applied: false, reason: 'dirty-tree' };
  }

  try {
    gitExec(repoRoot, ['config', 'core.autocrlf', 'false']);

    const gaPath = gitAttributesPath(repoRoot);
    if (!fs.existsSync(gaPath)) {
      fs.writeFileSync(gaPath, GIT_ATTRIBUTES_LF_RULE + '\n', 'utf-8');
      logger.info({ repoRoot }, 'runPrep: created .gitattributes');
    } else {
      const content = fs.readFileSync(gaPath, 'utf-8');
      if (!/eol\s*=\s*lf/i.test(content)) {
        fs.appendFileSync(gaPath, (content.endsWith('\n') ? '' : '\n') + GIT_ATTRIBUTES_LF_RULE + '\n', 'utf-8');
        logger.info({ repoRoot }, 'runPrep: appended LF rule to .gitattributes');
      }
    }

    const mixed = countMixedLineEndings(repoRoot);
    logger.info(
      { repoRoot, filesPlanned: mixed.count, sample: mixed.sample },
      mixed.count > LARGE_RENORMALIZE_THRESHOLD ? 'runPrep: large renormalize incoming' : 'runPrep: renormalize plan',
    );

    gitExec(repoRoot, ['add', '.gitattributes']);
    gitExec(repoRoot, ['add', '--renormalize', '.'], 600_000);
    const changedInWorkingTree = rewriteWorkingTreeLineEndingsToLf(repoRoot, listLineEndingMismatches(repoRoot));
    if (changedInWorkingTree > 0) {
      gitExec(repoRoot, ['add', '--renormalize', '.'], 600_000);
    }

    markCodexWindowsPrepApplied(repoRoot);

    return { applied: true, filesAffected: mixed.count };
  } catch (err) {
    const message = (err as Error).message;
    logger.error({ repoRoot, err: message }, 'runPrep failed');
    return { applied: false, reason: 'error', message };
  }
}

export function applyPrepWithConsent(repoRoot: string): PrepResult {
  const result = runPrep(repoRoot);
  if (!result.applied) {
    return result;
  }

  upsertCodexWindowsPrepConsent({
    repoRoot,
    prepVersion: CODEX_PREP_VERSION_CURRENT,
    action: 'prepared',
  });
  markCodexWindowsPrepApplied(repoRoot);

  return result;
}

export function grantSkipConsent(repoRoot: string): void {
  upsertCodexWindowsPrepConsent({
    repoRoot,
    prepVersion: CODEX_PREP_VERSION_CURRENT,
    action: 'skip',
  });
}

export function shouldSilenceWarning(repoRoot: string): boolean {
  const consent = getCodexWindowsPrepConsent(repoRoot);
  if (!consent) return false;
  if (consent.prepVersion < CODEX_PREP_VERSION_CURRENT) return false;
  return consent.action === 'skip';
}
