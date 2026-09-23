import { BrowserWindow } from 'electron';
import crypto from 'crypto';
import path from 'path';
import { createLogger } from './logger';
import { insertAuditEntry, getPermissionBypass, getSession, getOpenLaneSessionById } from './db';
import { sendAskQuestion } from './ask-question';
import type { ConfirmAction } from '../../src/types';
import type { CanUseTool } from '@anthropic-ai/claude-agent-sdk';
import { EXCLUDED_FROM_AUDIT_PATTERNS } from './repo-profiler';
import { isPipelineWriteAction } from './pipeline-control-core';
import { DESTRUCTIVE_MCP_PATTERNS, MEDIUM_RISK_MCP_PATTERNS } from './mcp-risk-patterns';

import type { ToolDecision } from './agent-runtime/types';

const logger = createLogger('permission-guard');

export const ASK_USER_ANSWERS_MARKER = '[RESPOSTAS DO USUARIO - NAO E ERRO]';

interface PendingConfirmation {
  resolve: (decision: ToolDecision) => void;
  action: ConfirmAction;
}

const pendingConfirmations = new Map<string, PendingConfirmation>();

const activeEnrichAllowedPaths: Set<string> = new Set();
let activeEnrichSpecPath: string | null = null;

let activeSecurityAuditPhase = false;

export function setActiveSecurityAuditPhase(active: boolean): void {
  activeSecurityAuditPhase = active;
}

export function isSecurityAuditPhaseActive(): boolean {
  return activeSecurityAuditPhase;
}

export function setActiveEnrichSpecPath(specPath: string | null): void {
  activeEnrichAllowedPaths.clear();
  activeEnrichSpecPath = specPath;
  if (specPath) {
    const specDir = path.dirname(specPath);
    activeEnrichAllowedPaths.add(specPath);
    activeEnrichAllowedPaths.add(path.join(specDir, '.validator-report.md'));
    activeEnrichAllowedPaths.add(path.join(specDir, '.enricher-suggestions.md'));
  }
}

export function getActiveEnrichSpecPath(): string | null {
  return activeEnrichSpecPath;
}

const FORBIDDEN_GIT_PATTERNS: RegExp[] = [
  /\bgit\s+commit\b/,
  /\bgit\s+push\b/,
  /\bgit\s+push\s+(-f|--force)\b/,
  /\bgit\s+reset\b/,
  /\bgit\s+rebase\b/,
  /\bgit\s+merge\b/,
  /\bgit\s+rm\b/,
  /\bgit\s+stash\s+drop\b/,
  /\bgit\s+tag\b/,
  /\bgit\s+remote\s+(add|set-url|remove|rename)\b/,
  /\bgit\s+fetch\s+--force\b/,
  /\bgit\s+checkout\s+--/,
  /\bgit\s+clean\s+-[a-z]*f/,
];

const FORBIDDEN_GIT_DENY_MESSAGE =
  'Comandos git que modificam state (commit, push, reset, rebase, merge, etc) sao proibidos. O usuario faz controle de versao manualmente. Use Write/Edit para arquivos, e git status/diff/log para inspecao.';

const DESTRUCTIVE_BASH_PATTERNS: Array<{ pattern: RegExp; risk: ConfirmAction['risk'] }> = [
  { pattern: /\brm\s+-rf?\b/, risk: 'critical' },
  { pattern: /\bsudo\b/, risk: 'critical' },
  { pattern: /\bformat\b/, risk: 'critical' },
  { pattern: /\bmkfs\b/, risk: 'critical' },
  { pattern: /\bdd\s+if=/, risk: 'critical' },
  { pattern: /\brm\b/, risk: 'high' },
  { pattern: /\bnpm\s+publish\b/, risk: 'high' },
];

const SENSITIVE_WRITE_PATTERNS = [/\.(env|pem|key|crt|p12)$/];

export const GUARD_GATED_TOOLS: string[] = ['Bash', 'Write', 'Edit'];

export interface PermissionGuardOptions {
  isOnboarding?: boolean;
  sessionId?: string;
}

export interface GuardTurnContext {
  sessionId?: string;
  title?: string;
  laneBadge?: number | null;
}

export function resolveGuardTurnContext(sessionId: string | undefined): GuardTurnContext {
  if (!sessionId) return {};
  let title: string | undefined;
  try {
    title = getSession(sessionId)?.title ?? '';
  } catch {
    title = undefined;
  }
  let laneBadge: number | null | undefined;
  try {
    laneBadge = getOpenLaneSessionById(sessionId)?.laneBadge ?? null;
  } catch {
    laneBadge = undefined;
  }
  return {
    sessionId,
    ...(title !== undefined ? { title } : {}),
    ...(laneBadge !== undefined ? { laneBadge } : {}),
  };
}

export function createPermissionGuard(getWindow: () => BrowserWindow | null, options?: PermissionGuardOptions) {
  const turnContext = resolveGuardTurnContext(options?.sessionId);
  return async (toolName: string, toolInput: Record<string, unknown>): Promise<ToolDecision> => {
    if (options?.isOnboarding) {
      const blockedDuringOnboarding = new Set([
        'Read',
        'Write',
        'Edit',
        'Glob',
        'Grep',
        'Bash',
        'WebSearch',
        'WebFetch',
        'Agent',
        'TodoWrite',
        'TaskCreate',
        'TaskUpdate',
        'TaskGet',
        'TaskList',
      ]);
      if (blockedDuringOnboarding.has(toolName) || toolName.startsWith('mcp__')) {
        return {
          behavior: 'deny',
          message:
            'Durante o onboarding, apenas converse com o usuario. Nao use ferramentas. Siga as instrucoes do BOOTSTRAP.md.',
        };
      }
    }

    if (toolName === 'AskUserQuestion') {
      try {
        const questions = (toolInput as Record<string, unknown>).questions;
        if (!Array.isArray(questions) || questions.length === 0) {
          return { behavior: 'deny', message: 'AskUserQuestion: nenhuma pergunta fornecida.' };
        }

        const response = await sendAskQuestion(getWindow, questions, undefined, 1_800_000, turnContext);
        logger.info({ id: response.id, answers: response.answers }, 'AskUserQuestion answered by user');

        const lines: string[] = [
          ASK_USER_ANSWERS_MARKER,
          'O usuario respondeu as perguntas (a interceptacao do host coletou as respostas na UI; trate como SUCESSO e prossiga usando-as — o status de erro do tool_result e um artefato tecnico da interceptacao):',
        ];
        for (const q of questions) {
          const answer = response.answers[q.question];
          const formatted = Array.isArray(answer) ? answer.join(', ') : answer;
          lines.push(`- ${q.question} -> ${formatted || '(sem resposta)'}`);

          const annotation = response.annotations?.[q.question];
          if (annotation?.notes) {
            lines.push(`  Notas: ${annotation.notes}`);
          }
        }

        return { behavior: 'deny', message: lines.join('\n') };
      } catch (err) {
        logger.error({ err }, 'AskUserQuestion failed');
        return { behavior: 'deny', message: `AskUserQuestion falhou: ${(err as Error).message}` };
      }
    }

    if (toolName === 'Read' && activeSecurityAuditPhase) {
      const filePath = (toolInput['file_path'] as string) || '';
      const basename = path.basename(filePath);
      if (EXCLUDED_FROM_AUDIT_PATTERNS.some((re) => re.test(basename))) {
        return {
          behavior: 'deny',
          message:
            "Read em .env* proibido durante auditoria. Para verificar exposicao, leia .gitignore e use Bash para 'git log -- <path>'.",
        };
      }
    }

    if (toolName !== 'Bash' && toolName !== 'Write' && toolName !== 'Edit' && !toolName.startsWith('mcp__')) {
      return { behavior: 'allow', updatedInput: toolInput };
    }

    if (toolName === 'Bash') {
      const command = (toolInput['command'] as string) || '';
      for (const pattern of FORBIDDEN_GIT_PATTERNS) {
        if (pattern.test(command)) {
          logger.warn({ command }, 'Bash blocked by FORBIDDEN_GIT_PATTERNS');
          return { behavior: 'deny', message: FORBIDDEN_GIT_DENY_MESSAGE };
        }
      }
      for (const { pattern, risk } of DESTRUCTIVE_BASH_PATTERNS) {
        if (pattern.test(command)) {
          return confirmUnlessBypass(getWindow, {
            ...turnContext,
            tool: toolName,
            description: `Executar comando: ${command.substring(0, 100)}`,
            input: toolInput,
            risk,
          });
        }
      }
      return { behavior: 'allow', updatedInput: toolInput };
    }

    if (toolName === 'Write' || toolName === 'Edit') {
      const filePath = (toolInput['file_path'] as string) || '';

      if (activeEnrichAllowedPaths.has(filePath)) {
        logger.info({ tool: toolName, filePath }, 'Auto-approving Write/Edit on active enrich path');
        return { behavior: 'allow', updatedInput: toolInput };
      }

      for (const pattern of SENSITIVE_WRITE_PATTERNS) {
        if (pattern.test(filePath)) {
          return confirmUnlessBypass(getWindow, {
            ...turnContext,
            tool: toolName,
            description: `Escrever em arquivo sensivel: ${filePath}`,
            input: toolInput,
            risk: 'high',
          });
        }
      }
      return { behavior: 'allow', updatedInput: toolInput };
    }

    if (toolName.startsWith('mcp__pipeline-control__')) {
      const action = toolName.slice('mcp__pipeline-control__'.length);
      if (isPipelineWriteAction(action)) {
        return confirmUnlessBypass(getWindow, {
          ...turnContext,
          tool: toolName,
          description: `Drive do orquestrador (pipeline-control): ${action}`,
          input: toolInput,
          risk: 'high',
        });
      }
      return { behavior: 'allow', updatedInput: toolInput };
    }

    if (toolName === 'mcp__lionclaw-preview__preview_open') {
      return { behavior: 'allow', updatedInput: toolInput };
    }

    if (toolName.startsWith('mcp__')) {
      const parts = toolName.split('__');
      const actualToolName = parts[parts.length - 1] || toolName;

      for (const pattern of DESTRUCTIVE_MCP_PATTERNS) {
        if (pattern.test(actualToolName)) {
          return confirmUnlessBypass(getWindow, {
            ...turnContext,
            tool: toolName,
            description: `Acao MCP destrutiva: ${actualToolName}`,
            input: toolInput,
            risk: 'high',
          });
        }
      }

      for (const pattern of MEDIUM_RISK_MCP_PATTERNS) {
        if (pattern.test(actualToolName)) {
          return confirmUnlessBypass(getWindow, {
            ...turnContext,
            tool: toolName,
            description: `Acao MCP: ${actualToolName}`,
            input: toolInput,
            risk: 'medium',
          });
        }
      }

      return { behavior: 'allow', updatedInput: toolInput };
    }

    return { behavior: 'allow', updatedInput: toolInput };
  };
}

async function confirmUnlessBypass(
  getWindow: () => BrowserWindow | null,
  action: Omit<ConfirmAction, 'id'>,
): Promise<ToolDecision> {
  if (getPermissionBypass()) {
    return { behavior: 'allow', updatedInput: action.input as Record<string, unknown> };
  }
  return requestConfirmation(getWindow, action);
}

async function requestConfirmation(
  getWindow: () => BrowserWindow | null,
  action: Omit<ConfirmAction, 'id'>,
): Promise<ToolDecision> {
  const window = getWindow();
  if (!window) {
    return { behavior: 'deny', message: 'Janela nao disponivel para confirmacao' };
  }

  const id = crypto.randomUUID();
  const fullAction: ConfirmAction = { ...action, id };

  return new Promise((resolve) => {
    pendingConfirmations.set(id, { resolve, action: fullAction });

    window.webContents.send('chat:confirm-request', fullAction);

    setTimeout(() => {
      if (pendingConfirmations.has(id)) {
        pendingConfirmations.delete(id);
        insertAuditEntry({
          eventType: 'confirm_response',
          toolName: action.tool,
          input: JSON.stringify(action.input).substring(0, 500),
          approved: false,
        });
        resolve({ behavior: 'deny', message: 'Timeout na confirmacao do usuario' });
      }
    }, 60_000);
  });
}

export async function requestActionConfirmation(
  getWindow: () => BrowserWindow | null,
  action: Omit<ConfirmAction, 'id'>,
): Promise<{ approved: boolean; message?: string }> {
  const decision = await requestConfirmation(getWindow, action);
  if (decision.behavior === 'allow') {
    return { approved: true };
  }
  return { approved: false, message: decision.message };
}

export function resolveConfirmation(id: string, approved: boolean): void {
  const pending = pendingConfirmations.get(id);
  if (!pending) {
    logger.warn({ id }, 'Confirmation not found');
    return;
  }

  pendingConfirmations.delete(id);

  insertAuditEntry({
    eventType: 'confirm_response',
    toolName: pending.action.tool,
    input: JSON.stringify(pending.action.input).substring(0, 500),
    approved,
  });

  if (approved) {
    pending.resolve({ behavior: 'allow', updatedInput: pending.action.input as Record<string, unknown> });
  } else {
    pending.resolve({ behavior: 'deny', message: 'Acao negada pelo usuario' });
  }
}

export function createEnrichPermissionGuard(getWindow: () => BrowserWindow | null, sessionId: string): CanUseTool {
  const fallbackGuard = createPermissionGuard(getWindow, { sessionId });

  return (async (toolName: string, toolInput: Record<string, unknown>) => {
    if (toolName === 'Write' || toolName === 'Edit') {
      const filePath = (toolInput['file_path'] as string) || '';
      if (filePath && activeEnrichAllowedPaths.has(filePath)) {
        logger.info({ tool: toolName, filePath }, 'Enrich guard: auto-approving Write/Edit on active enrich path');
        return { behavior: 'allow', updatedInput: toolInput };
      }
    }
    return fallbackGuard(toolName, toolInput);
  }) as CanUseTool;
}
