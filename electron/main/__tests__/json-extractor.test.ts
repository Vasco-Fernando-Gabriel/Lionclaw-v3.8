import { describe, it, expect } from 'vitest';
import { extractJSON, extractBalancedJsonObjectCandidates, unwrapKnownJsonWrappers } from '../json-extractor';
import type { StreamProcessorResult } from '../stream-processor';

function mockResult(output: string, accumulatedText: string, textBlocks: string[]): StreamProcessorResult {
  return {
    output,
    accumulatedText,
    textBlocks,
    metrics: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      toolUses: 0,
      apiRequests: 0,
    },
  };
}

interface Payload {
  x: number;
}

function parser(text: string): Payload {
  const obj = JSON.parse(text) as unknown;
  if (typeof (obj as Record<string, unknown>).x !== 'number') {
    throw new Error('invalid: missing numeric x');
  }
  return obj as Payload;
}

const OPTS = { parser, contextLabel: 'test-context' };

describe('extractJSON: tier selection and fallback logic', () => {
  it('returns tier "result" when output contains valid JSON', () => {
    const result = mockResult('{"x":42}', '', []);
    const { value, tier } = extractJSON<Payload>(result, OPTS);

    expect(tier).toBe('result');
    expect(value.x).toBe(42);
  });

  it('falls back to tier "accumulated" when output is empty', () => {
    const result = mockResult('', '{"x":7}', []);
    const { value, tier } = extractJSON<Payload>(result, OPTS);

    expect(tier).toBe('accumulated');
    expect(value.x).toBe(7);
  });

  it('falls back to last textBlock when output and accumulated are invalid', () => {
    const result = mockResult('not-json', 'also-not-json', ['{"x":99}']);
    const { value, tier } = extractJSON<Payload>(result, OPTS);

    expect(tier).toBe('block[0]');
    expect(value.x).toBe(99);
  });

  it('iterates textBlocks in reverse and returns first valid block', () => {
    const result = mockResult('', '', ['{invalid}', '{"x":1}']);
    const { value, tier } = extractJSON<Payload>(result, OPTS);

    expect(tier).toBe('block[1]');
    expect(value.x).toBe(1);
  });

  it('throws when no source contains valid JSON', () => {
    const result = mockResult('bad', 'also bad', ['still bad', 'worse']);
    expect(() => extractJSON<Payload>(result, OPTS)).toThrow();
  });

  it('throws with an error when all sources have malformed JSON', () => {
    const result = mockResult('{x:1}', '{y:2}', ['{z:3}']);
    expect(() => extractJSON<Payload>(result, OPTS)).toThrow();
  });

  it('uses accumulated when output JSON fails parser validation', () => {
    const result = mockResult('{"y":100}', '{"x":55}', []);
    const { value, tier } = extractJSON<Payload>(result, OPTS);

    expect(tier).toBe('accumulated');
    expect(value.x).toBe(55);
  });

  it('finds valid block among multiple textBlocks iterating in reverse', () => {
    const result = mockResult('', '', [
      '{"x":10}', // block[0] - valid but tried last in reverse
      '{bad}', // block[1] - invalid, tried first in reverse
    ]);

    const { value, tier } = extractJSON<Payload>(result, OPTS);

    expect(tier).toBe('block[0]');
    expect(value.x).toBe(10);
  });

  it('skips sources that are empty or whitespace-only', () => {
    const result = mockResult('   ', '\n\t', ['{"x":3}']);
    const { value, tier } = extractJSON<Payload>(result, OPTS);

    expect(tier).toBe('block[0]');
    expect(value.x).toBe(3);
  });

  it('accepts optional round and sprintId without affecting extraction', () => {
    const result = mockResult('{"x":0}', '', []);
    const opts = { ...OPTS, round: 3, sprintId: 'sprint-abc' };
    const { value, tier } = extractJSON<Payload>(result, opts);

    expect(tier).toBe('result');
    expect(value.x).toBe(0);
  });

  it('returns tier "jsonrepair" when parser sets meta.repaired = true', () => {
    const result = mockResult('{"x":1}', '', []);
    const repairedParser = (text: string, outMeta?: { repaired?: boolean }): Payload => {
      const obj = JSON.parse(text) as unknown;
      if (outMeta) outMeta.repaired = true;
      return obj as Payload;
    };
    const { value, tier } = extractJSON<Payload>(result, {
      parser: repairedParser,
      contextLabel: 'Test',
    });
    expect(value.x).toBe(1);
    expect(tier).toBe('jsonrepair');
  });
});

describe('extractBalancedJsonObjectCandidates', () => {
  it('returns empty array when no { is present', () => {
    expect(extractBalancedJsonObjectCandidates('no braces here at all')).toEqual([]);
  });

  it('extracts a single simple object', () => {
    const result = extractBalancedJsonObjectCandidates('prefix {"a":1} suffix');
    expect(result).toHaveLength(1);
    expect(result[0]).toBe('{"a":1}');
  });

  it('extracts two separate top-level objects in order', () => {
    const text = 'start {"a":1} middle {"b":2} end';
    const result = extractBalancedJsonObjectCandidates(text);
    expect(result).toHaveLength(2);
    expect(result[0]).toBe('{"a":1}');
    expect(result[1]).toBe('{"b":2}');
  });

  it('handles nested objects as a single top-level candidate', () => {
    const text = '{"outer":{"inner":42}}';
    const result = extractBalancedJsonObjectCandidates(text);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe('{"outer":{"inner":42}}');
  });

  it('does not count braces inside string literals', () => {
    const text = '{"key":"value with { brace } inside"}';
    const result = extractBalancedJsonObjectCandidates(text);
    expect(result).toHaveLength(1);
    const parsed = JSON.parse(result[0]) as Record<string, unknown>;
    expect(parsed.key).toBe('value with { brace } inside');
  });

  it('handles escape sequences in strings correctly', () => {
    const text = '{"path":"C:\\\\Users\\\\foo","val":1}';
    const result = extractBalancedJsonObjectCandidates(text);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(text);
  });

  it('extracts TSX snippet before real JSON - both returned', () => {
    const text = `function Foo() {
  return <div />;
}
{"sprint_id":"s1","verdict":"pass","criteria":[]}`;
    const results = extractBalancedJsonObjectCandidates(text);
    expect(results.length).toBeGreaterThanOrEqual(1);
    const last = results[results.length - 1];
    const parsed = JSON.parse(last) as Record<string, unknown>;
    expect(parsed.sprint_id).toBe('s1');
  });

  it('ignores unbalanced opening brace at end of input', () => {
    const text = '{"a":1} dangling {';
    const result = extractBalancedJsonObjectCandidates(text);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe('{"a":1}');
  });
});

describe('unwrapKnownJsonWrappers', () => {
  it('unwraps { "plan": {...} }', () => {
    const inner = { project: { id: 'p1' }, sprints: [] };
    const result = unwrapKnownJsonWrappers({ plan: inner });
    expect(result).toBe(inner);
  });

  it('unwraps { "data": {...} }', () => {
    const inner = { foo: 'bar' };
    const result = unwrapKnownJsonWrappers({ data: inner });
    expect(result).toEqual(inner);
  });

  it('unwraps { "result": {...} }', () => {
    const inner = { value: 42 };
    expect(unwrapKnownJsonWrappers({ result: inner })).toEqual(inner);
  });

  it('unwraps { "output": {...} }', () => {
    const inner = { value: 99 };
    expect(unwrapKnownJsonWrappers({ output: inner })).toEqual(inner);
  });

  it('does not unwrap when more than one key is present', () => {
    const obj = { plan: { x: 1 }, other: { y: 2 } };
    expect(unwrapKnownJsonWrappers(obj)).toBe(obj);
  });

  it('does not unwrap when key is not in known list', () => {
    const obj = { unknown: { x: 1 } };
    expect(unwrapKnownJsonWrappers(obj)).toBe(obj);
  });

  it('does not unwrap when inner value is an array', () => {
    const obj = { plan: [1, 2, 3] };
    expect(unwrapKnownJsonWrappers(obj)).toBe(obj);
  });

  it('does not unwrap when inner value is null', () => {
    const obj = { plan: null };
    expect(unwrapKnownJsonWrappers(obj)).toBe(obj);
  });

  it('is idempotent: applies up to 5 times and then stops', () => {
    const actual = { actual: true };
    const double = { plan: { data: actual } };
    const result = unwrapKnownJsonWrappers(double);
    expect(result).toBe(actual);
  });

  it('returns non-object values unchanged', () => {
    expect(unwrapKnownJsonWrappers('hello')).toBe('hello');
    expect(unwrapKnownJsonWrappers(42)).toBe(42);
    expect(unwrapKnownJsonWrappers(null)).toBeNull();
    expect(unwrapKnownJsonWrappers([1, 2])).toEqual([1, 2]);
  });
});
