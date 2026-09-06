
import { describe, it, expect } from 'vitest';
import {
  buildHandoffPrompt,
  type GraphHint,
  type PipelineHandoffRequest,
} from '../handoff-to-orchestrator';

const GRAPH: GraphHint = { state: 'ready' };

const DELIVERY_CLAIM = 'Acabei de concluir um pipeline de desenvolvimento neste repositorio';

function bugRequest(over: Partial<PipelineHandoffRequest> = {}): PipelineHandoffRequest {
  return {
    source: 'pipeline',
    pipelineType: 'bug',
    projectId: 'proj_bug_1',
    projectName: 'Crash no login',
    projectPath: '/Users/dev/app',
    specPath: '/Users/dev/app/.lionclaw/pipelines/bug/20260727_101010-a1b2c3/SPEC-20260727_101010-a1b2c3.md',
    ...over,
  };
}

describe('O14 — handoff do Bug Pipe por desfecho', () => {
  it('outcome no-bug: NAO anuncia entrega e aponta o plano de correcao', () => {
    const prompt = buildHandoffPrompt(
      bugRequest({ bugOutcome: 'no-bug', bugRunId: '20260727_101010-a1b2c3' }),
      GRAPH,
    );
    expect(prompt).not.toContain(DELIVERY_CLAIM);
    expect(prompt).not.toContain('a entrega esta pronta');
    expect(prompt).toContain('ENCERRADO SEM CORRECAO');
    expect(prompt).toContain('Nao houve entrega');
    expect(prompt).toContain(
      '/Users/dev/app/.lionclaw/pipelines/bug/20260727_101010-a1b2c3/plano-de-correcao-20260727_101010-a1b2c3.md',
    );
    expect(prompt).toContain('## Desfecho');
  });

  it('outcome no-bug sem runId: usa o placeholder do path, nunca o basename solto', () => {
    const prompt = buildHandoffPrompt(bugRequest({ bugOutcome: 'no-bug' }), GRAPH);
    expect(prompt).toContain('/Users/dev/app/.lionclaw/pipelines/bug/<runId>/plano-de-correcao-<runId>.md');
    expect(prompt).not.toContain(DELIVERY_CLAIM);
  });

  it('outcome fix: pede validacao da correcao e testes de REGRESSAO', () => {
    const prompt = buildHandoffPrompt(
      bugRequest({ bugOutcome: 'fix', bugRunId: '20260727_101010-a1b2c3' }),
      GRAPH,
    );
    expect(prompt).not.toContain(DELIVERY_CLAIM);
    expect(prompt).toContain('CORRECAO aplicada');
    expect(prompt).toContain('REGRESSAO');
    expect(prompt).toContain('SPEC-20260727_101010-a1b2c3.md');
  });

  it('desfecho AUSENTE: nao afirma entrega nem encerramento; manda ler o plano antes', () => {
    const prompt = buildHandoffPrompt(bugRequest(), GRAPH);
    expect(prompt).not.toContain(DELIVERY_CLAIM);
    expect(prompt).toContain('nao tenho aqui o desfecho registrado');
    expect(prompt).toContain('NAO afirme que houve entrega antes de ler o plano');
  });

  it('bug sem projectPath cai no fallback que PEDE a pasta (nao no runProjectPrompt)', () => {
    const prompt = buildHandoffPrompt(
      bugRequest({ projectPath: null, bugOutcome: 'no-bug' }),
      GRAPH,
    );
    expect(prompt).toContain('nao tenho uma pasta de projeto resolvida');
    expect(prompt).not.toContain(DELIVERY_CLAIM);
  });

  it('NAO-REGRESSAO: os 5 tipos existentes mantem os prompts atuais', () => {
    const base = { source: 'pipeline' as const, projectId: 'p', projectName: 'X', projectPath: '/repo' };
    for (const type of ['development', 'feature', 'development-v2'] as const) {
      const prompt = buildHandoffPrompt({ ...base, pipelineType: type }, GRAPH);
      expect(prompt).toContain(DELIVERY_CLAIM);
    }
    expect(buildHandoffPrompt({ ...base, pipelineType: 'security' }, GRAPH)).toContain(
      'relatorio consolidado de seguranca',
    );
    expect(
      buildHandoffPrompt({ ...base, pipelineType: 'architecture-review' }, GRAPH),
    ).not.toContain(DELIVERY_CLAIM);
  });
});
