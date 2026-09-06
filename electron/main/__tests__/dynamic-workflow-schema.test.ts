
import { describe, it, expect } from 'vitest';
import {
  resolveStructuredOutput,
  schemaStrategyForRuntime,
  extractFirstJsonObject,
  minimalShapeValidator,
  jsonSchemaToOutputSchema,
  type SchemaAttemptFn,
  type WorkflowOutputSchema,
} from '../dynamic-workflows/workflow-schema';

const SCHEMA: WorkflowOutputSchema = {
  name: 'findings',
  type: 'object',
  required: ['summary', 'items'],
};

describe('workflow-schema: estrategia por runtime (8.7)', () => {
  it('Claude-compatible usa forced-tool; codex/local/external usam parse-repair', () => {
    expect(schemaStrategyForRuntime('cloud')).toBe('forced-tool');
    expect(schemaStrategyForRuntime('zai')).toBe('forced-tool');
    expect(schemaStrategyForRuntime('minimax-tp')).toBe('forced-tool');
    expect(schemaStrategyForRuntime('codex')).toBe('parse-repair');
    expect(schemaStrategyForRuntime('local')).toBe('parse-repair');
    expect(schemaStrategyForRuntime('external')).toBe('parse-repair');
  });
});

describe('workflow-schema: extractFirstJsonObject (parse-repair)', () => {
  it('extrai objeto JSON puro', () => {
    expect(extractFirstJsonObject('{"a":1}')).toEqual({ a: 1 });
  });

  it('extrai objeto cercado de prosa e markdown', () => {
    const text = 'Aqui esta o resultado:\n```json\n{"summary":"ok","items":[]}\n```\nfim.';
    expect(extractFirstJsonObject(text)).toEqual({ summary: 'ok', items: [] });
  });

  it('respeita chaves dentro de strings', () => {
    expect(extractFirstJsonObject('{"k":"a}b"}')).toEqual({ k: 'a}b' });
  });

  it('devolve undefined quando nao ha objeto parseavel', () => {
    expect(extractFirstJsonObject('sem json aqui')).toBeUndefined();
    expect(extractFirstJsonObject('')).toBeUndefined();
  });
});

describe('workflow-schema: minimalShapeValidator', () => {
  it('aprova objeto com todas as chaves required', () => {
    const r = minimalShapeValidator({ summary: 's', items: [] }, SCHEMA);
    expect(r.ok).toBe(true);
  });

  it('reprova chave required ausente', () => {
    const r = minimalShapeValidator({ summary: 's' }, SCHEMA);
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toContain('items');
  });

  it('reprova nao-objeto quando type object', () => {
    expect(minimalShapeValidator([], SCHEMA).ok).toBe(false);
    expect(minimalShapeValidator('x', SCHEMA).ok).toBe(false);
  });
});

describe('workflow-schema: jsonSchemaToOutputSchema (resolveSchemaRef do host)', () => {
  it('converte JSON Schema draft-07 em WorkflowOutputSchema (type+required)', () => {
    const raw = {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      required: ['verdict', 'findings'],
      properties: { verdict: { type: 'string' } },
    };
    expect(jsonSchemaToOutputSchema(raw, 'plan-findings.schema.json')).toEqual({
      name: 'plan-findings.schema.json',
      type: 'object',
      required: ['verdict', 'findings'],
    });
  });

  it('usa title/$id como name quando presentes', () => {
    expect(jsonSchemaToOutputSchema({ title: 'Plano', required: ['x'] })).toEqual({
      name: 'Plano',
      type: 'object',
      required: ['x'],
    });
  });

  it('required ausente vira [] (objeto sem chaves obrigatorias)', () => {
    expect(jsonSchemaToOutputSchema({ type: 'object' }, 'x.json')).toEqual({
      name: 'x.json',
      type: 'object',
      required: [],
    });
  });

  it('input nao-objeto -> null (host trata como sem schema)', () => {
    expect(jsonSchemaToOutputSchema(null)).toBeNull();
    expect(jsonSchemaToOutputSchema('x')).toBeNull();
    expect(jsonSchemaToOutputSchema([1, 2])).toBeNull();
  });

  it('o WorkflowOutputSchema convertido funciona no minimalShapeValidator', () => {
    const schema = jsonSchemaToOutputSchema({ type: 'object', required: ['sprints'] });
    expect(schema).not.toBeNull();
    expect(minimalShapeValidator({ sprints: [] }, schema!).ok).toBe(true);
    expect(minimalShapeValidator({ foo: 1 }, schema!).ok).toBe(false);
  });
});

describe('workflow-schema: resolveStructuredOutput (AC-6)', () => {
  it('forced-tool: usa o structured direto na primeira tentativa', async () => {
    const attempt: SchemaAttemptFn = async () => ({
      text: 'ignorado',
      structured: { summary: 'ok', items: [1, 2] },
    });
    const res = await resolveStructuredOutput({
      runtime: 'cloud',
      schema: SCHEMA,
      attempt,
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value).toEqual({ summary: 'ok', items: [1, 2] });
      expect(res.attempts).toBe(1);
      expect(res.strategy).toBe('forced-tool');
    }
  });

  it('parse-repair: extrai do texto (codex/local)', async () => {
    const attempt: SchemaAttemptFn = async () => ({
      text: 'resposta: {"summary":"done","items":[]}',
    });
    const res = await resolveStructuredOutput({
      runtime: 'codex',
      schema: SCHEMA,
      attempt,
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.strategy).toBe('parse-repair');
  });

  it('retry guiado: 1a tentativa invalida, 2a corrige com feedback', async () => {
    const feedbacks: string[][] = [];
    let call = 0;
    const attempt: SchemaAttemptFn = async ({ feedback }) => {
      feedbacks.push(feedback);
      call++;
      if (call === 1) return { text: '{"summary":"falta items"}' }; // sem items
      return { text: '{"summary":"ok","items":[1]}' };
    };
    const res = await resolveStructuredOutput({
      runtime: 'local',
      schema: SCHEMA,
      attempt,
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.attempts).toBe(2);
    expect(feedbacks[0]).toEqual([]);
    expect(feedbacks[1].join(' ')).toContain('items');
  });

  it('esgota retries -> failure com failureClass schema (AC-6)', async () => {
    const attempt: SchemaAttemptFn = async () => ({ text: '{"summary":"x"}' });
    const res = await resolveStructuredOutput({
      runtime: 'cloud',
      schema: SCHEMA,
      attempt,
      maxAttempts: 2,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.failureClass).toBe('schema');
      expect(res.attempts).toBe(2);
      expect(res.errors.join(' ')).toContain('items');
    }
  });

  it('texto sem JSON algum: erro de schema alimenta o reprompt', async () => {
    const feedbacks: string[][] = [];
    const attempt: SchemaAttemptFn = async ({ feedback }) => {
      feedbacks.push(feedback);
      return { text: 'desculpe, nao consegui' };
    };
    const res = await resolveStructuredOutput({
      runtime: 'external',
      schema: SCHEMA,
      attempt,
      maxAttempts: 2,
    });
    expect(res.ok).toBe(false);
    expect(feedbacks[1][0]).toContain('nenhum objeto JSON');
  });

  it('validador customizado e respeitado', async () => {
    const attempt: SchemaAttemptFn = async () => ({
      structured: { summary: 'ok', items: [], score: 5 },
      text: '',
    });
    const res = await resolveStructuredOutput({
      runtime: 'cloud',
      schema: SCHEMA,
      attempt,
      validator: (value) => {
        const v = value as { score?: number };
        return (v.score ?? 0) >= 10
          ? { ok: true, errors: [] }
          : { ok: false, errors: ['score < 10'] };
      },
      maxAttempts: 1,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors).toEqual(['score < 10']);
  });
});
