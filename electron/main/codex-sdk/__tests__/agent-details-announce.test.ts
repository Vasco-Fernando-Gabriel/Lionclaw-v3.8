import { describe, it, expect } from 'vitest';
import { CODEX_SDK_SYSTEM_PROMPT_V1, CODEX_SDK_SYSTEM_PROMPT_V2, CODEX_SDK_SYSTEM_PROMPT_V3 } from '../prompt';

describe('AC-61 — anuncio de agent_details no CODEX_SDK_SYSTEM_PROMPT_V2', () => {
  it('bloco Capabilities (lionclaw-agents MCP) anuncia a tool com assinatura', () => {
    const capabilities = CODEX_SDK_SYSTEM_PROMPT_V2.split('## Working Style')[0]!;
    expect(capabilities).toContain('`agent_details({ agent_id })`');
    expect(capabilities).toContain('full profile of one subagent');
  });

  it('bloco ## Subagents orienta a consultar a ficha antes de despachar', () => {
    const subagentsBlock = CODEX_SDK_SYSTEM_PROMPT_V2.split('## Subagents')[1]!.split('## Skills')[0]!;
    expect(subagentsBlock).toContain('agent_details({ agent_id })');
    expect(subagentsBlock).toContain('compact index');
  });

  it('anuncio presente nos DOIS blocos (2 ocorrencias no minimo)', () => {
    const occurrences = CODEX_SDK_SYSTEM_PROMPT_V2.split('agent_details').length - 1;
    expect(occurrences).toBeGreaterThanOrEqual(2);
  });

  it('V1 permanece CONGELADA (sem agent_details)', () => {
    expect(CODEX_SDK_SYSTEM_PROMPT_V1).not.toContain('agent_details');
  });

  it('guardrail: nenhum em-dash na V2', () => {
    expect(CODEX_SDK_SYSTEM_PROMPT_V2.includes('—')).toBe(false);
  });
});

describe('CODEX_SDK_SYSTEM_PROMPT_V3 (fix drive FULL / stand-down)', () => {
  it('V3 preserva os anuncios de agent_details da V2 (AC-61)', () => {
    const occurrences = CODEX_SDK_SYSTEM_PROMPT_V3.split('agent_details').length - 1;
    expect(occurrences).toBeGreaterThanOrEqual(2);
  });

  it('V3 remove a politica global antiga de high-risk e traz a C-02 por modo', () => {
    expect(CODEX_SDK_SYSTEM_PROMPT_V3).not.toContain('always go to the user');
    expect(CODEX_SDK_SYSTEM_PROMPT_V3).toContain('Gate policy by mode');
    expect(CODEX_SDK_SYSTEM_PROMPT_V3).toContain('decide control gates yourself');
    expect(CODEX_SDK_SYSTEM_PROMPT_V2).toContain('always go to the user');
  });

  it('V3 traz o stand-down explicito (drive reativo, fase auto encerra o turno)', () => {
    expect(CODEX_SDK_SYSTEM_PROMPT_V3).toContain('REACTIVE DRIVING');
    expect(CODEX_SDK_SYSTEM_PROMPT_V3).toContain('END YOUR TURN');
    expect(CODEX_SDK_SYSTEM_PROMPT_V3).toContain('NEVER wait, sleep, poll');
  });

  it('V3 mantem os headers do splice condicional (S5c) e nao duplica o anuncio antigo', () => {
    expect(CODEX_SDK_SYSTEM_PROMPT_V3).toContain('## Driving Pipelines');
    expect(CODEX_SDK_SYSTEM_PROMPT_V3).toContain('## Asking the User');
    expect(CODEX_SDK_SYSTEM_PROMPT_V3).not.toContain('Driving LionClaw pipelines via the');
    expect(CODEX_SDK_SYSTEM_PROMPT_V3).not.toContain('pipeline_list()');
  });

  it('guardrail: nenhum em-dash na V3', () => {
    expect(CODEX_SDK_SYSTEM_PROMPT_V3.includes('—')).toBe(false);
  });
});
