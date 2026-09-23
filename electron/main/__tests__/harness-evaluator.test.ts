import { describe, it, expect } from 'vitest';
import { parseEvaluationOutput } from '../harness-evaluator';

function makeEvalJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    sprint_id: 'sprint-001',
    verdict: 'pass',
    criteria: [
      {
        id: 'feat-001-c1',
        feature_id: 'feat-001',
        description: 'Component renders',
        result: 'pass',
        justification: 'Rendered correctly',
      },
    ],
    summary: 'All good',
    ...overrides,
  });
}

describe('parseEvaluationOutput: balanced-JSON extraction', () => {
  it('parses a clean JSON response with no prefix', () => {
    const result = parseEvaluationOutput(makeEvalJson(), 1);
    expect(result.sprintId).toBe('sprint-001');
    expect(result.verdict).toBe('pass');
    expect(result.criteria).toHaveLength(1);
  });

  it('parses JSON when preceded by TSX/JSX code snippet with braces', () => {
    const tsxSnippet = `I analyzed the code. Here is a snippet:

function Component({ title }: { title: string }) {
  const [state, setState] = React.useState({ loading: false });
  return <div>{title}</div>;
}

After reviewing all criteria:

`;
    const rawOutput = tsxSnippet + makeEvalJson();
    const result = parseEvaluationOutput(rawOutput, 1);
    expect(result.sprintId).toBe('sprint-001');
    expect(result.verdict).toBe('pass');
  });

  it('picks the last valid candidate when earlier ones lack required fields', () => {
    const codeBlock = '{ "type": "component", "props": {} }';
    const realJson = JSON.stringify({
      sprint_id: 'sprint-002',
      verdict: 'fail',
      criteria: [
        {
          id: 'feat-001-c1',
          feature_id: 'feat-001',
          description: 'Component missing',
          result: 'fail',
          justification: 'Not found in codebase',
        },
      ],
      summary: 'Failed',
    });
    const rawOutput = `Analysis: ${codeBlock} - see above.\n\n${realJson}`;
    const result = parseEvaluationOutput(rawOutput, 2);
    expect(result.verdict).toBe('fail');
    expect(result.sprintId).toBe('sprint-002');
  });

  it('handles markdown code block wrapping', () => {
    const rawOutput = '```json\n' + makeEvalJson() + '\n```';
    const result = parseEvaluationOutput(rawOutput, 1);
    expect(result.sprintId).toBe('sprint-001');
  });

  it('throws a clear error when no JSON object is present at all', () => {
    const rawOutput = "I'll start by reading the files to understand the codebase.";
    expect(() => parseEvaluationOutput(rawOutput, 1)).toThrow(/no JSON object|no valid JSON/i);
  });

  it('throws when JSON exists but missing sprint_id, verdict, and criteria', () => {
    const rawOutput = '{"some_random_key": "value"}';
    expect(() => parseEvaluationOutput(rawOutput, 1)).toThrow(/sprint_id|no valid JSON/i);
  });

  it('throws with first 500 chars of raw output in error message', () => {
    const rawOutput = 'no JSON here at all - just plain text analysis';
    let errorMsg = '';
    try {
      parseEvaluationOutput(rawOutput, 1);
    } catch (e) {
      errorMsg = (e as Error).message;
    }
    expect(errorMsg).toBeTruthy();
    expect(errorMsg.length).toBeGreaterThan(0);
  });

  it('throws on empty input', () => {
    expect(() => parseEvaluationOutput('', 1)).toThrow(/empty output/i);
  });

  it('accepts criterion-level "verdict" field as alias for "result"', () => {
    const jsonWithVerdictAlias = JSON.stringify({
      sprint_id: 'sprint-001',
      verdict: 'fail',
      criteria: [
        {
          id: 'feat-001-c1',
          feature_id: 'feat-001',
          description: 'Does it render',
          verdict: 'fail',
          justification: 'Not rendered',
        },
      ],
      summary: 'Failed',
    });
    const result = parseEvaluationOutput(jsonWithVerdictAlias, 1);
    expect(result.criteria[0].result).toBe('fail');
  });

  it('derives feature_id from criterion id when absent', () => {
    const jsonNoFeatureId = JSON.stringify({
      sprint_id: 'sprint-002',
      verdict: 'pass',
      criteria: [
        {
          id: 'feat-003-c2',
          description: 'Loads data',
          result: 'pass',
          justification: 'Data loaded',
        },
      ],
      summary: 'OK',
    });
    const result = parseEvaluationOutput(jsonNoFeatureId, 1);
    expect(result.criteria[0].featureId).toBe('feat-003');
  });

  it('sets outMeta.repaired when jsonrepair was used', () => {
    const brokenJson = `{
      "sprint_id": "sprint-001",
      "verdict": "pass",
      "criteria": [
        {
          "id": "feat-001-c1",
          "feature_id": "feat-001",
          "description": "test",
          "result": "pass",
          "justification": "ok",
        }
      ],
      "summary": "ok",
    }`;
    const outMeta: { repaired?: boolean } = {};
    const result = parseEvaluationOutput(brokenJson, 1, outMeta);
    expect(result.sprintId).toBe('sprint-001');
    expect(outMeta.repaired).toBe(true);
  });

  it('overrides agent verdict to fail when any criterion fails', () => {
    const jsonWithWrongVerdict = JSON.stringify({
      sprint_id: 'sprint-001',
      verdict: 'pass',
      criteria: [
        {
          id: 'feat-001-c1',
          feature_id: 'feat-001',
          description: 'Test',
          result: 'fail',
          justification: 'Did not work',
        },
      ],
      summary: 'Mixed',
    });
    const result = parseEvaluationOutput(jsonWithWrongVerdict, 1);
    expect(result.verdict).toBe('fail');
  });

  it('handles multiple objects where only the last has valid schema', () => {
    const invalidObj1 = '{"msg": "starting analysis"}';
    const invalidObj2 = '{"intermediate": true}';
    const validFinal = makeEvalJson({ verdict: 'pass' });
    const rawOutput = [invalidObj1, 'some text', invalidObj2, 'more text', validFinal].join('\n');
    const result = parseEvaluationOutput(rawOutput, 3);
    expect(result.sprintId).toBe('sprint-001');
    expect(result.verdict).toBe('pass');
  });
});
