import type { ComposedToolInput, ToolDecision } from './workflow-agent-adapter';

export type CloserGitClass = 'read' | 'write-local' | 'remote-denied' | 'unknown';

const GIT_READ_SUBCOMMANDS = new Set<string>([
  'status',
  'diff',
  'log',
  'show',
  'blame',
  'branch', // tratado abaixo: `branch` sem args/com -l e leitura; criar/mover e write.
  'rev-parse',
  'rev-list',
  'ls-files',
  'ls-tree',
  'cat-file',
  'describe',
  'shortlog',
  'reflog',
  'whatchanged',
  'grep',
  'config', // `config --get`/`-l` e leitura; set e write (tratado abaixo).
]);

const GIT_WRITE_LOCAL_SUBCOMMANDS = new Set<string>([
  'add',
  'commit',
  'merge',
  'rebase',
  'reset',
  'stash',
  'branch',
  'checkout',
  'switch', // equivalente moderno de checkout de branch.
  'restore', // restore de working tree (escrita local).
  'cherry-pick',
  'revert',
  'tag', // tag local; remoto seria push (ja negado).
  'mv',
  'rm',
  'apply',
  'clean',
]);

const GIT_REMOTE_DENIED_SUBCOMMANDS = new Set<string>([
  'push',
  'fetch',
  'pull',
  'clone',
  'remote',
  'submodule',
  'send-email',
  'request-pull',
  'format-patch', // gera patch para enviar; conservador, fora do escopo local.
]);

export interface TokenizedCommand {
  tokens: string[];
  compound: boolean;
}

const SHELL_OPERATOR = /^(;|&&|\|\||\||&)$/;

export function tokenizeCommand(command: string): TokenizedCommand {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let compound = false;
  let sawAny = false;

  const push = (): void => {
    if (current.length > 0) {
      tokens.push(current);
      current = '';
    }
  };

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      sawAny = true;
      continue;
    }
    if (ch === '\\') {
      if (i + 1 < command.length) {
        current += command[i + 1];
        i++;
      }
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\n') {
      push();
      continue;
    }
    if (ch === ';' || ch === '|' || ch === '&' || ch === '(' || ch === ')' || ch === '`') {
      compound = true;
      push();
      break;
    }
    current += ch;
    sawAny = true;
  }
  push();

  if (tokens.some((t) => SHELL_OPERATOR.test(t))) {
    compound = true;
  }
  void sawAny;
  return { tokens, compound };
}

export function isGitCommand(command: string): boolean {
  const { tokens } = tokenizeCommand(command);
  return tokens.length > 0 && tokens[0] === 'git';
}

export interface GitClassification {
  klass: CloserGitClass;
  subcommand: string | null;
  overridePaths: string[];
  compound: boolean;
}

function classifyGit(command: string): GitClassification {
  const { tokens, compound } = tokenizeCommand(command);
  const overridePaths: string[] = [];
  let idx = 1;
  while (idx < tokens.length) {
    const t = tokens[idx];
    if (t === '-C' && idx + 1 < tokens.length) {
      overridePaths.push(tokens[idx + 1]);
      idx += 2;
      continue;
    }
    if (t === '--git-dir' && idx + 1 < tokens.length) {
      overridePaths.push(tokens[idx + 1]);
      idx += 2;
      continue;
    }
    if (t.startsWith('--git-dir=')) {
      overridePaths.push(t.slice('--git-dir='.length));
      idx += 1;
      continue;
    }
    if (t === '--work-tree' && idx + 1 < tokens.length) {
      overridePaths.push(tokens[idx + 1]);
      idx += 2;
      continue;
    }
    if (t.startsWith('--work-tree=')) {
      overridePaths.push(t.slice('--work-tree='.length));
      idx += 1;
      continue;
    }
    if (t === '-c' && idx + 1 < tokens.length) {
      idx += 2;
      continue;
    }
    if (t.startsWith('-')) {
      idx += 1;
      continue;
    }
    break;
  }

  const subcommand = idx < tokens.length ? tokens[idx] : null;
  const rest = tokens.slice(idx + 1);

  if (!subcommand) {
    return { klass: 'read', subcommand: null, overridePaths, compound };
  }

  if (GIT_REMOTE_DENIED_SUBCOMMANDS.has(subcommand)) {
    return { klass: 'remote-denied', subcommand, overridePaths, compound };
  }

  if (subcommand === 'branch') {
    const writeFlags = new Set(['-d', '-D', '-m', '-M', '-c', '-C', '-f', '--delete', '--move', '--copy', '--force']);
    const hasName = rest.some((a) => !a.startsWith('-'));
    const hasWriteFlag = rest.some((a) => writeFlags.has(a));
    if (!hasName && !hasWriteFlag) {
      return { klass: 'read', subcommand, overridePaths, compound };
    }
    return { klass: 'write-local', subcommand, overridePaths, compound };
  }

  if (subcommand === 'config') {
    const isRead = rest.some(
      (a) => a === '--get' || a === '-l' || a === '--list' || a === '--get-all' || a === '--get-regexp',
    );
    const isWrite =
      rest.some((a) => a === '--unset' || a === '--add' || a === '--replace-all') ||
      rest.filter((a) => !a.startsWith('-')).length >= 2;
    if (isRead && !isWrite) {
      return { klass: 'read', subcommand, overridePaths, compound };
    }
    if (isWrite) {
      return { klass: 'write-local', subcommand, overridePaths, compound };
    }
    return { klass: 'read', subcommand, overridePaths, compound };
  }

  if (subcommand === 'stash') {
    const sub2 = rest.find((a) => !a.startsWith('-'));
    if (sub2 === 'list' || sub2 === 'show') {
      return { klass: 'read', subcommand, overridePaths, compound };
    }
    return { klass: 'write-local', subcommand, overridePaths, compound };
  }

  if (GIT_WRITE_LOCAL_SUBCOMMANDS.has(subcommand)) {
    return { klass: 'write-local', subcommand, overridePaths, compound };
  }

  if (GIT_READ_SUBCOMMANDS.has(subcommand)) {
    return { klass: 'read', subcommand, overridePaths, compound };
  }

  return { klass: 'unknown', subcommand, overridePaths, compound };
}

export type PathContainmentCheck = (workspaceRoot: string, candidate: string) => boolean;

export const defaultPathContainment: PathContainmentCheck = (workspaceRoot, candidate) => {
  const root = normalizeAbs(workspaceRoot);
  const target = candidate.startsWith('/')
    ? normalizeAbs(candidate)
    : normalizeAbs(joinPosix(workspaceRoot, candidate));
  return target === root || target.startsWith(root + '/');
};

function joinPosix(a: string, b: string): string {
  return `${a.replace(/\/+$/, '')}/${b.replace(/^\/+/, '')}`;
}

function normalizeAbs(p: string): string {
  const isAbs = p.startsWith('/');
  const parts = p.split('/');
  const out: string[] = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (out.length > 0) out.pop();
      continue;
    }
    out.push(part);
  }
  return (isAbs ? '/' : '') + out.join('/');
}

export interface CloserGitConfirmRequest {
  runId: string;
  command: string;
  subcommand: string;
  cwd: string;
}

export interface CloserGitAuditEvent {
  runId: string;
  command: string;
  subcommand: string;
  decision: 'approved' | 'denied';
  reason: string;
}

export interface CloserPermissionGuardOptions {
  runId: string;
  workspaceCwd: string;
  confirmGitWrite?: (req: CloserGitConfirmRequest) => Promise<boolean> | boolean;
  auditGit?: (event: CloserGitAuditEvent) => void;
  delegate?: (input: ComposedToolInput) => ToolDecision | Promise<ToolDecision>;
  pathContainment?: PathContainmentCheck;
}

export function createCloserPermissionGuard(
  options: CloserPermissionGuardOptions,
): (input: ComposedToolInput) => Promise<ToolDecision> {
  const containment = options.pathContainment ?? defaultPathContainment;

  return async ({ toolName, input }): Promise<ToolDecision> => {
    if (toolName === 'Bash') {
      const command = typeof input.command === 'string' ? input.command : '';
      if (isGitCommand(command)) {
        return decideGit(command, options, containment);
      }
      return runDelegate(options, { toolName, input });
    }

    return runDelegate(options, { toolName, input });
  };
}

async function runDelegate(options: CloserPermissionGuardOptions, input: ComposedToolInput): Promise<ToolDecision> {
  if (!options.delegate) {
    return {
      behavior: 'deny',
      message: `tool ${input.toolName} sem delegate configurado no guard do closer (fail-closed)`,
    };
  }
  return options.delegate(input);
}

async function decideGit(
  command: string,
  options: CloserPermissionGuardOptions,
  containment: PathContainmentCheck,
): Promise<ToolDecision> {
  const cls = classifyGit(command);

  if (cls.compound) {
    return {
      behavior: 'deny',
      message: 'comando git encadeado (;, &&, |, subshell) nao e permitido ao closer: rode um comando git por vez',
    };
  }

  const escaping = cls.overridePaths.filter((p) => !containment(options.workspaceCwd, p));
  if (escaping.length > 0) {
    return {
      behavior: 'deny',
      message: `git aponta para fora do workspace do run (${escaping.join(', ')}); o closer so opera dentro do repo alvo`,
    };
  }

  switch (cls.klass) {
    case 'read':
      return { behavior: 'allow' };

    case 'remote-denied':
      options.auditGit?.({
        runId: options.runId,
        command,
        subcommand: cls.subcommand ?? '?',
        decision: 'denied',
        reason: 'push/remoto sempre negado (8.8)',
      });
      return {
        behavior: 'deny',
        message: `git ${cls.subcommand}: push e operacoes de remoto sao SEMPRE negados ao closer; o usuario faz push manualmente`,
      };

    case 'unknown':
      return {
        behavior: 'deny',
        message: `git ${cls.subcommand}: subcomando fora da allowlist do closer (negado por seguranca)`,
      };

    case 'write-local': {
      const confirmed = options.confirmGitWrite
        ? await options.confirmGitWrite({
            runId: options.runId,
            command,
            subcommand: cls.subcommand ?? '?',
            cwd: options.workspaceCwd,
          })
        : false;

      options.auditGit?.({
        runId: options.runId,
        command,
        subcommand: cls.subcommand ?? '?',
        decision: confirmed ? 'approved' : 'denied',
        reason: confirmed
          ? 'git de escrita local aprovado por confirmacao inline (8.8)'
          : 'git de escrita local negado (sem confirmacao)',
      });

      if (!confirmed) {
        return {
          behavior: 'deny',
          message: `git ${cls.subcommand}: escrita local exige confirmacao inline (nao confirmada)`,
        };
      }
      return { behavior: 'allow' };
    }
  }
}
