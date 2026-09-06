import crypto from 'crypto';
import { createLogger } from '../logger';
import { getOpenDesignConfig } from './config';
import { getSessionConfig } from './session-config';
import { status as managerStatus } from './manager';
import { createAdapter } from './adapter-http';
import type { LockValidationResult } from './validator';

const logger = createLogger('open-design-auto-correct');

export async function requestAgentCorrection(
  projectId: string,
  validation: LockValidationResult,
  attempt: number,
): Promise<{ runId: string }> {
  const cfg = getOpenDesignConfig(projectId);
  if (!cfg?.openDesignProjectId || !cfg?.conversationId) {
    throw new Error(
      'auto-correct: cfg.openDesignProjectId ou conversationId ausente (bootstrap nao concluido)',
    );
  }

  const sessionConfig = getSessionConfig(projectId);
  if (!sessionConfig) {
    throw new Error('auto-correct: sessionConfig ausente — preencha em fase 5 antes de travar');
  }

  const stat = managerStatus(projectId);
  if (!stat.running || !stat.daemonUrl) {
    throw new Error('auto-correct: sidecar OD nao esta rodando — manager.start eh pre-requisito');
  }

  const adapter = createAdapter({ baseUrl: stat.daemonUrl });

  const problemsList = validation.problems
    .map((p, i) => `${i + 1}. ${p.hint}`)
    .join('\n');

  const prompt = [
    `[LionClaw — auto-correcao do Design Lock, tentativa ${attempt}]`,
    '',
    `O Design Lock recusou o HTML atual. Lista EXATA do que precisa ser ajustado no JSON dentro do \`<script type="application/json" id="lionclaw-design-contract">\` (${validation.problems.length} item${validation.problems.length === 1 ? '' : 'ns'}):`,
    '',
    problemsList,
    '',
    '## Acao obrigatoria',
    '',
    'Atualize APENAS o `<script type="application/json" id="lionclaw-design-contract">` no HTML do projeto. Para os itens acima, adicione/corrija o campo no JSON existente — nao precisa reescrever o HTML inteiro.',
    '',
    'Lembretes que costumam evitar regredir:',
    '- Mantenha o JSON valido (parseavel por JSON.parse).',
    '- Voce pode ter campos EXTRAS (project, kind, fidelity, design_system, etc) — eles sao tolerados. Mas os obrigatorios da lista acima precisam estar TODOS presentes simultaneamente.',
    '- `version` deve ser literalmente `"1.0"` (string, com aspas).',
    '- `screens[]`, `navigation.primary[]`: use `userStoryIds: ["US-01", ...]` (NAO use `covers`, NAO use `acceptance_criteria_visualized` como substituto).',
    '- `apiExpectations[]` precisa ter `operation`, `screenIds: string[]`, `actionIds: string[]` e `userStoryIds: string[]`. Use `[]` quando nao houver vinculo real.',
    '- `dataRequirements[]` precisa ter `fields[]`, `sourceScreenIds: string[]` e `userStoryIds: string[]`.',
    '- `deltas[]` precisa ter `type`, `description`, `impact`, `relatedUserStoryIds` e `requiresRequirementsChange`.',
    '- Arrays vazios `[]` sao validos para `components`, `dataRequirements`, `apiExpectations`, `deltas` quando nao houver conteudo real.',
    '- Objects pequenos sao validos para `visual.tokens.typography`, `spacing`, `radii` quando nao houver tokens reais (ex: `{"base": "..."}`).',
    '',
    'Apos atualizar, salve/re-exporte o HTML para que ele fique disponivel via `GET /api/projects/:id/files`. O LionClaw vai tentar travar novamente sozinho — voce NAO precisa me avisar quando terminar.',
  ].join('\n');

  const promptStamp = crypto
    .createHash('sha256')
    .update(`${attempt}-${prompt}`)
    .digest('hex')
    .slice(0, 16);

  const { runId } = await adapter.startInitialRun({
    projectId: cfg.openDesignProjectId,
    conversationId: cfg.conversationId,
    prompt,
    sessionConfig,
    userMessageId: `lionclaw-correct-user-${promptStamp}`,
    assistantMessageId: `lionclaw-correct-asst-${promptStamp}`,
    clientRequestId: `lionclaw-correct-${promptStamp}`,
  });

  logger.info(
    { projectId, runId, attempt, problemCount: validation.problems.length },
    'auto-correct: correction message dispatched to OD agent',
  );

  return { runId };
}

export async function waitForAgentCorrection(
  projectId: string,
  runId: string,
  opts?: { timeoutMs?: number },
): Promise<boolean> {
  const stat = managerStatus(projectId);
  if (!stat.running || !stat.daemonUrl) {
    logger.warn({ projectId }, 'waitForAgentCorrection: sidecar nao esta rodando');
    return false;
  }
  const adapter = createAdapter({ baseUrl: stat.daemonUrl });
  const result = await adapter.waitForRunComplete(runId, {
    timeoutMs: opts?.timeoutMs ?? 180_000,
  });
  logger.info({ projectId, runId, status: result.status }, 'auto-correct: agent run finished');
  return result.status === 'completed';
}
