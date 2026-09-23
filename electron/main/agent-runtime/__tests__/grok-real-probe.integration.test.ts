import { describe, expect, it } from 'vitest';
import type { AgentQueryConfig } from '../../agent-config-resolver';
import { grokExecutor } from '../grok-executor';

const config: AgentQueryConfig = {
  model: 'grok-4.5',
  systemPrompt: 'Voce e um probe de integracao do LionClaw. Siga literalmente o pedido.',
  allowedTools: [],
  mcpServers: [],
  maxTurns: 1,
  effort: 'low',
  thinking: 'disabled',
  thinkingBudget: undefined,
  runtime: 'grok',
};

describe.skipIf(process.env['LIONCLAW_REAL_GROK_PROBE'] !== '1')('Grok real dev probe', () => {
  it('executa o caminho real do executor/ACP no home isolado', async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 90_000);
    try {
      const result = await grokExecutor.run(
        {
          agentId: 'grok-real-dev-probe',
          prompt: 'Responda exatamente: LIONCLAW_GROK_EXECUTOR_OK',
          cwd: process.cwd(),
          abortController: controller,
          permission: { mode: 'default', dangerouslySkipPermissions: false },
        },
        config,
      );
      expect(result.runtime).toBe('grok');
      expect(result.output.trim()).toBe('LIONCLAW_GROK_EXECUTOR_OK');
    } finally {
      clearTimeout(timer);
    }
  }, 100_000);
});
