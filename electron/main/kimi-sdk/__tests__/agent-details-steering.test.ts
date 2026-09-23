import { describe, it, expect } from 'vitest';
import { appendAgentDetailsSteering, KIMI_AGENT_DETAILS_TOOL_NAME } from '../agent-details-steering';

describe('AC-62 — steering condicional do agent_details no Kimi', () => {
  const PROMPT = '## Instrucoes\n\nPrompt reconciliado da sessao.';

  it('nome exato pinado com o prefixo MCP', () => {
    expect(KIMI_AGENT_DETAILS_TOOL_NAME).toBe('mcp__lionclaw-agents__agent_details');
  });

  it('anuncia com o nome EXATO quando materializado', () => {
    const out = appendAgentDetailsSteering(
      PROMPT,
      new Set(['mcp__lionclaw-agents__agent_details', 'lion_run_subagent']),
    );
    expect(out).toContain(PROMPT);
    expect(out).toContain('mcp__lionclaw-agents__agent_details');
    expect(out).toContain('{ agent_id }');
  });

  it('prompt INALTERADO quando a tool NAO esta materializada', () => {
    const out = appendAgentDetailsSteering(PROMPT, new Set(['lion_run_subagent']));
    expect(out).toBe(PROMPT);
  });

  it('prompt INALTERADO com set vazio', () => {
    expect(appendAgentDetailsSteering(PROMPT, new Set())).toBe(PROMPT);
  });

  it('nao casa por prefixo parcial (honestidade POR NOME, nao por servidor)', () => {
    const out = appendAgentDetailsSteering(
      PROMPT,
      new Set(['mcp__lionclaw-agents__list_agents', 'mcp__lionclaw-agents__call_agent']),
    );
    expect(out).toBe(PROMPT);
  });
});
