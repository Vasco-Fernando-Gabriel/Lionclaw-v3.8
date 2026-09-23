import { createLogger } from '../logger';
import { getHarnessProject } from '../db';
import { getSessionConfig, setSessionConfig } from './session-config';
import { resolveAutostartBaseSessionConfig } from './drive-autostart';
import type { OpenDesignSessionConfig } from '../../../src/types/open-design';

const logger = createLogger('od-session-config-tool');

export interface DesignSessionConfigPatch {
  agentId?: string;
  model?: string;
  reasoning?: 'low' | 'medium' | 'high';
  designSystemId?: string;
}

export interface DesignSessionConfigApplied {
  applied: true;
  projectId: string;
  agentId: string;
  model: string;
  reasoning?: 'low' | 'medium' | 'high';
  designSystemId?: string;
  sessionEnsured: boolean;
  conversationId?: string;
  ensureError?: string;
}

export type DesignSessionConfigResult = DesignSessionConfigApplied | { error: string };

async function ensureSessionStartOnly(
  projectId: string,
  current: OpenDesignSessionConfig,
): Promise<DesignSessionConfigResult> {
  let sessionEnsured = false;
  let conversationId: string | undefined;
  let ensureError: string | undefined;
  try {
    const { ensureSession } = await import('./bootstrap');
    const result = await ensureSession(projectId);
    if ('error' in result) {
      ensureError = result.error;
      logger.warn(
        { projectId, error: result.error },
        'design_session_config (GO start-only): ensureSession falhou (config vigente preservado)',
      );
    } else {
      sessionEnsured = true;
      conversationId = result.conversationId;
    }
  } catch (err) {
    ensureError = err instanceof Error ? err.message : String(err);
    logger.error(
      { projectId, error: ensureError },
      'design_session_config (GO start-only): ensureSession lancou (config vigente preservado)',
    );
  }

  logger.info(
    { projectId, agentId: current.agentId, model: current.model, sessionEnsured },
    'design_session_config GO start-only (patch vazio sobre config vigente)',
  );

  return {
    applied: true,
    projectId,
    agentId: current.agentId,
    model: current.model,
    ...(current.reasoning ? { reasoning: current.reasoning } : {}),
    ...(current.designSystemId ? { designSystemId: current.designSystemId } : {}),
    sessionEnsured,
    ...(conversationId ? { conversationId } : {}),
    ...(ensureError ? { ensureError } : {}),
  };
}

export async function applyDesignSessionConfig(
  projectId: string,
  patch: DesignSessionConfigPatch,
): Promise<DesignSessionConfigResult> {
  try {
    if (!projectId) {
      return { error: 'design_session_config: id e obrigatorio' };
    }
    const hasField =
      patch.agentId !== undefined ||
      patch.model !== undefined ||
      patch.reasoning !== undefined ||
      patch.designSystemId !== undefined;

    const project = getHarnessProject(projectId);
    if (!project) {
      return { error: `design_session_config: pipeline "${projectId}" nao encontrado` };
    }
    const pipelineType = project.pipelineType ?? 'development';
    if (pipelineType !== 'development-v2') {
      return {
        error:
          `design_session_config: o pipeline "${projectId}" e do tipo "${pipelineType}" - ` +
          'so pipelines development-v2 tem sessao do LionDesign Studio.',
      };
    }

    const current = getSessionConfig(projectId);

    if (!hasField) {
      if (!current) {
        return {
          error:
            'design_session_config: informe ao menos um campo (agentId, model, reasoning, designSystemId) ' +
            'ou de o GO quando ja houver uma sessao configurada. ' +
            'Ex: { agentId: "claude", model: "opus" }.',
        };
      }
      return ensureSessionStartOnly(projectId, current);
    }

    const { hasActiveDesignRun } = await import('./bootstrap');
    if (await hasActiveDesignRun(projectId)) {
      return {
        error:
          'design_session_config: a sessao do LionDesign tem uma geracao em curso. ' +
          'Espere a geracao concluir (o dono valida e trava o Design Lock na UI) antes de trocar ' +
          'agente/modelo - troca por cima de geracao viva destroi o layout.',
      };
    }

    const base = current ?? resolveAutostartBaseSessionConfig();

    const merged: OpenDesignSessionConfig = {
      agentId: base?.agentId ?? '',
      model: base?.model ?? '',
      memoryEnabled: base?.memoryEnabled ?? false,
      mcpServerIds: base?.mcpServerIds ?? [],
      locale: base?.locale ?? 'pt-BR',
      ...(base?.reasoning !== undefined ? { reasoning: base.reasoning } : {}),
      ...(base?.designSystemId !== undefined ? { designSystemId: base.designSystemId } : {}),
      ...(patch.agentId !== undefined ? { agentId: patch.agentId } : {}),
      ...(patch.model !== undefined ? { model: patch.model } : {}),
      ...(patch.reasoning !== undefined ? { reasoning: patch.reasoning } : {}),
      ...(patch.designSystemId !== undefined ? { designSystemId: patch.designSystemId } : {}),
      configuredAt: new Date().toISOString(),
    };

    try {
      setSessionConfig(projectId, merged);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { error: `design_session_config: ${msg}` };
    }

    let sessionEnsured = false;
    let conversationId: string | undefined;
    let ensureError: string | undefined;
    try {
      const { ensureSession } = await import('./bootstrap');
      const result = await ensureSession(projectId);
      if ('error' in result) {
        ensureError = result.error;
        logger.warn(
          { projectId, error: result.error },
          'design_session_config: config salvo, mas ensureSession falhou (sessao fica para o autostart/fase)',
        );
      } else {
        sessionEnsured = true;
        conversationId = result.conversationId;
      }
    } catch (err) {
      ensureError = err instanceof Error ? err.message : String(err);
      logger.error(
        { projectId, error: ensureError },
        'design_session_config: ensureSession lancou (config salvo mesmo assim)',
      );
    }

    logger.info(
      { projectId, agentId: merged.agentId, model: merged.model, sessionEnsured },
      'design_session_config aplicado',
    );

    return {
      applied: true,
      projectId,
      agentId: merged.agentId,
      model: merged.model,
      ...(merged.reasoning ? { reasoning: merged.reasoning } : {}),
      ...(merged.designSystemId ? { designSystemId: merged.designSystemId } : {}),
      sessionEnsured,
      ...(conversationId ? { conversationId } : {}),
      ...(ensureError ? { ensureError } : {}),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ projectId, error: msg }, 'design_session_config falhou');
    return { error: `design_session_config: falha ao configurar a sessao do LionDesign: ${msg}` };
  }
}
