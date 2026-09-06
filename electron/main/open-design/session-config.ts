import { createLogger } from '../logger';
import { setSetting } from '../db';
import { getOpenDesignConfig, setOpenDesignConfig } from './config';
import type { OpenDesignSessionConfig } from '../../../src/types/open-design';


const logger = createLogger('open-design-session-config');

export const LAST_SESSION_CONFIG_SETTINGS_KEY = 'openDesign.lastSessionConfig';

const FORBIDDEN_KEY_FRAGMENTS = ['token', 'apikey'] as const;
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,199}$/;
const CLAUDE_MODEL_ALIASES = new Set(['opus', 'sonnet', 'haiku']);
const CODEX_MODEL_ALIASES = new Set(['o3', 'o4-mini']);

function violatesSecretPolicy(key: string): boolean {
  const lower = key.toLowerCase();
  for (const fragment of FORBIDDEN_KEY_FRAGMENTS) {
    if (lower.includes(fragment)) return true;
  }
  if (lower.endsWith('key')) return true;
  return false;
}

function assertNoSecretKeys(value: unknown, pathParts: string[] = []): void {
  if (value === null || value === undefined) return;
  if (Array.isArray(value)) {
    value.forEach((item, idx) => {
      assertNoSecretKeys(item, [...pathParts, String(idx)]);
    });
    return;
  }
  if (typeof value !== 'object') return;

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (violatesSecretPolicy(key)) {
      const fullPath = [...pathParts, key].join('.');
      throw new Error(
        `OpenDesignSessionConfig: chave proibida em "${fullPath}". ` +
          `Nomes contendo "token"/"apiKey" ou terminando em "key" sao bloqueados ` +
          `(use o Vault do LionClaw ou .od/media-config.json para credenciais).`,
      );
    }
    assertNoSecretKeys(child, [...pathParts, key]);
  }
}

function assertAgentModelCompatibility(agentIdRaw: string, modelRaw: string): void {
  const agentId = agentIdRaw.trim().toLowerCase();
  const model = modelRaw.trim().toLowerCase();
  if (model === 'default') return;

  if (agentId === 'claude') {
    if (model.startsWith('claude-') || CLAUDE_MODEL_ALIASES.has(model)) return;
    throw new Error(
      `OpenDesignSessionConfig: modelo "${modelRaw}" nao pertence ao agente Claude. ` +
        'Use Opus/Sonnet/Haiku/claude-* ou troque o agente para Codex/Gemini.',
    );
  }

  if (agentId === 'codex') {
    if (model.startsWith('gpt-') || CODEX_MODEL_ALIASES.has(model)) return;
    throw new Error(
      `OpenDesignSessionConfig: modelo "${modelRaw}" nao pertence ao agente Codex. ` +
        'Use modelos GPT/o* ou troque o agente para Claude/Gemini.',
    );
  }

  if (agentId === 'gemini') {
    if (model.startsWith('gemini-')) return;
    throw new Error(
      `OpenDesignSessionConfig: modelo "${modelRaw}" nao pertence ao agente Gemini. ` +
        'Use modelos gemini-* ou troque o agente para Claude/Codex.',
    );
  }
}

export function assertValidSessionConfig(cfg: OpenDesignSessionConfig): void {
  if (!SESSION_ID_RE.test(String(cfg.agentId ?? '').trim())) {
    throw new Error(
      'OpenDesignSessionConfig: agentId invalido. Use o id do agente do LionDesign, ex: claude, codex ou gemini.',
    );
  }

  const model = String(cfg.model ?? '').trim();
  if (!SESSION_ID_RE.test(model)) {
    throw new Error(
      'OpenDesignSessionConfig: modelo invalido. Use o slug exato aceito pelo CLI, sem espacos, ex: claude-sonnet-4-6.',
    );
  }
  assertAgentModelCompatibility(String(cfg.agentId ?? ''), model);

  if (cfg.reasoning !== undefined && !['low', 'medium', 'high'].includes(cfg.reasoning)) {
    throw new Error('OpenDesignSessionConfig: reasoning invalido. Use low, medium ou high.');
  }
}

export function getSessionConfig(projectId: string): OpenDesignSessionConfig | null {
  const cfg = getOpenDesignConfig(projectId);
  if (!cfg) return null;
  return cfg.sessionConfig ?? null;
}

export function setSessionConfig(projectId: string, cfg: OpenDesignSessionConfig): void {
  assertNoSecretKeys(cfg);
  assertValidSessionConfig(cfg);

  setOpenDesignConfig(projectId, {
    sessionConfig: cfg,
    conversationId: undefined,
    initialPromptHash: undefined,
    initialPromptSentAt: undefined,
    sessionConfigHash: undefined,
  });

  logger.info(
    { projectId, agentId: cfg.agentId, model: cfg.model, locale: cfg.locale },
    'session config saved (conversationId + initialPromptHash invalidated)',
  );

  try {
    setSetting(LAST_SESSION_CONFIG_SETTINGS_KEY, JSON.stringify(cfg));
  } catch (err) {
    logger.warn(
      { projectId, error: (err as Error).message },
      'falha ao gravar openDesign.lastSessionConfig (ignorada; sessionConfig salvo)',
    );
  }
}

export function clearSessionConfig(projectId: string): void {
  setOpenDesignConfig(projectId, {
    sessionConfig: undefined,
    conversationId: undefined,
    initialPromptHash: undefined,
    initialPromptSentAt: undefined,
    sessionConfigHash: undefined,
  });
}
