import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';

const SMOKE_HOME = process.env['LIONCLAW_TEST_HOME'] ?? '';

import { executeAgent } from '../agent-runtime/execute';
import { buildCursorSessionKey, loadCursorSession } from '../agent-runtime/cursor-sidecar/session-registry';
import type { AgentQueryConfig } from '../agent-config-resolver';
import type { AgentExecutionRequest, AgentExecutionResult } from '../agent-runtime/types';

const SMOKE_ENABLED = process.env['LIONCLAW_CURSOR_SMOKE'] === '1';
const SMOKE_TIMEOUT_MS = 300_000;
const MODEL = 'composer-2.5';
const PROOF_CONTENT = 'LION-CURSOR-F1-OK';

const config: AgentQueryConfig = {
  model: MODEL,
  systemPrompt: 'Voce e o coder de teste do LionClaw. Execute exatamente a tarefa pedida, sem passos extras.',
  allowedTools: [],
  mcpServers: [],
  maxTurns: undefined,
  effort: 'medium',
  thinking: 'disabled',
  thinkingBudget: undefined,
  runtime: 'cursor',
};

let repoDir = '';

function makeRequest(overrides: Partial<AgentExecutionRequest>): AgentExecutionRequest {
  return {
    agentId: 'cursor-smoke-coder',
    prompt: '',
    cwd: repoDir,
    abortController: new AbortController(),
    permission: { mode: 'bypassPermissions', dangerouslySkipPermissions: true },
    resolvedConfigOverride: config,
    ...overrides,
  };
}

describe.runIf(SMOKE_ENABLED)('smoke REAL do runtime cursor (LIONCLAW_CURSOR_SMOKE=1)', () => {
  let firstResult: AgentExecutionResult | null = null;

  beforeAll(() => {
    if (SMOKE_HOME.length === 0) {
      throw new Error(
        'LIONCLAW_CURSOR_SMOKE=1 exige LIONCLAW_TEST_HOME apontando para um diretorio ' +
          'temporario vazio (isola sessoes e o espelho do vault do ~/.lionclaw real).',
      );
    }
    repoDir = path.join(SMOKE_HOME, 'repo-descartavel');
    fs.mkdirSync(repoDir, { recursive: true });
    fs.writeFileSync(path.join(repoDir, 'README.md'), '# Repo descartavel do smoke cursor F1\n', 'utf8');
  });

  afterAll(() => {
    try {
      fs.rmSync(SMOKE_HOME, { recursive: true, force: true });
    } catch {}
  });

  it(
    'turno 1 (coder): escreve arquivo real no repo descartavel e reporta custo',
    async () => {
      const result = await executeAgent(
        makeRequest({
          prompt:
            `Crie um arquivo chamado proof.txt na raiz do workspace com o conteudo exato ` +
            `"${PROOF_CONTENT}" (sem aspas, sem newline extra). Depois responda apenas: DONE.`,
        }),
      );
      firstResult = result;

      expect(result.runtime).toBe('cursor');
      expect(result.provider).toBe('cursor');
      expect(result.model).toBe(MODEL);
      expect(result.output.length).toBeGreaterThan(0);

      const proofPath = path.join(repoDir, 'proof.txt');
      expect(fs.existsSync(proofPath)).toBe(true);
      expect(fs.readFileSync(proofPath, 'utf8').trim()).toBe(PROOF_CONTENT);

      expect(result.metrics.tokenStatus).toBe('reported');
      expect(result.metrics.inputTokens).toBeGreaterThan(0);
      expect(result.metrics.outputTokens).toBeGreaterThan(0);
      expect(result.metrics.costUsd).toBeGreaterThan(0);
      expect(['known', 'estimated-partial']).toContain(result.metrics.costStatus);
      expect(result.metadata?.costEstimationKind).toBe('subscription-equivalent-payg');
      expect(result.metadata?.sessionIds?.length).toBe(1);

      const sessionKey = buildCursorSessionKey({ agentId: 'cursor-smoke-coder', cwd: repoDir });
      expect(loadCursorSession(sessionKey)?.cursorAgentId).toBe(result.metadata?.sessionIds?.[0]);
    },
    SMOKE_TIMEOUT_MS,
  );

  it(
    'turno 2 (resume): continueSession retoma o MESMO agent e lembra o contexto',
    async () => {
      expect(firstResult, 'turno 1 precisa ter rodado').not.toBeNull();
      const result = await executeAgent(
        makeRequest({
          continueSession: true,
          prompt:
            'Sem reler nenhum arquivo: qual foi o conteudo exato que voce escreveu em proof.txt ' +
            'no turno anterior? Responda apenas o conteudo.',
        }),
      );

      expect(result.output).toContain(PROOF_CONTENT);
      expect(result.metadata?.sessionIds?.[0]).toBe(firstResult?.metadata?.sessionIds?.[0]);
      expect(result.metrics.tokenStatus).toBe('reported');
      expect(result.metrics.costUsd).toBeGreaterThan(0);
    },
    SMOKE_TIMEOUT_MS,
  );
});

describe.runIf(!SMOKE_ENABLED)('smoke real do cursor (desligado)', () => {
  it.skip('exige LIONCLAW_CURSOR_SMOKE=1 (gasta tokens do plano Cursor)', () => {});
});
