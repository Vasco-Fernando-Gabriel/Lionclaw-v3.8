import crypto from 'crypto';
import { createLogger } from '../logger';
import { getHarnessProject } from '../db';
import { getOpenDesignConfig } from './config';
import { getSessionConfig } from './session-config';
import * as manager from './manager';
import { createAdapter } from './adapter-http';

const logger = createLogger('od-design-prompt');

export const DESIGN_SESSION_INACTIVE_ERROR =
  'a sessao de design ainda nao esta ativa; o autostart roda quando a fase do studio abrir';

export interface DesignPromptDelivery {
  delivered: true;
  projectId: string;
  openDesignProjectId: string;
  conversationId: string;
  runId: string;
}

export type DesignPromptResult = DesignPromptDelivery | { error: string };

export async function sendDesignPrompt(projectId: string, message: string): Promise<DesignPromptResult> {
  try {
    if (!projectId || typeof message !== 'string' || !message.trim()) {
      return { error: 'design_prompt: id e message sao obrigatorios' };
    }

    const project = getHarnessProject(projectId);
    if (!project) {
      return { error: `design_prompt: pipeline "${projectId}" nao encontrado` };
    }

    const pipelineType = project.pipelineType ?? 'development';
    if (pipelineType !== 'development-v2') {
      return {
        error:
          `design_prompt: o pipeline "${projectId}" e do tipo "${pipelineType}" - ` +
          'so pipelines development-v2 tem sessao do LionDesign Studio.',
      };
    }

    const sessionConfig = getSessionConfig(projectId);
    const cfg = getOpenDesignConfig(projectId);
    if (!sessionConfig || !cfg?.openDesignProjectId || !cfg?.conversationId) {
      return { error: `design_prompt: ${DESIGN_SESSION_INACTIVE_ERROR}` };
    }
    const live = manager.status(projectId);
    if (!live.running || !live.daemonUrl) {
      return { error: `design_prompt: ${DESIGN_SESSION_INACTIVE_ERROR}` };
    }

    const adapter = createAdapter({ baseUrl: live.daemonUrl });
    const openDesignProjectId = cfg.openDesignProjectId;
    const conversationId = cfg.conversationId;

    const stamp = `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
    const userMessageId = `lionclaw-orch-user-${stamp}`;
    const assistantMessageId = `lionclaw-orch-assistant-${stamp}`;

    await adapter.putMessage(openDesignProjectId, conversationId, userMessageId, {
      id: userMessageId,
      role: 'user',
      content: message,
    });

    await adapter.putMessage(openDesignProjectId, conversationId, assistantMessageId, {
      id: assistantMessageId,
      role: 'assistant',
      content: '',
      runStatus: 'running',
    });

    const run = await adapter.startRun({
      projectId: openDesignProjectId,
      conversationId,
      assistantMessageId,
      clientRequestId: `lionclaw-orch-${stamp}`,
      agentId: sessionConfig.agentId,
      message,
      currentPrompt: message,
      model: sessionConfig.model,
      ...(sessionConfig.reasoning ? { reasoning: sessionConfig.reasoning } : {}),
      designSystemId: sessionConfig.designSystemId ?? null,
    });

    logger.info(
      { projectId, openDesignProjectId, conversationId, runId: run.runId },
      'design_prompt entregue a conversa da sessao OD',
    );

    return {
      delivered: true,
      projectId,
      openDesignProjectId,
      conversationId,
      runId: run.runId,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ projectId, error: msg }, 'design_prompt falhou');
    return { error: `design_prompt: falha ao enviar a instrucao ao LionDesign: ${msg}` };
  }
}
