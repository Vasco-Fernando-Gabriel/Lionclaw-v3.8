import { describe, it, expect } from 'vitest';
import { parsePlannerOutput } from '../harness-planner';
import type { SprintsJson } from '../harness-planner';

function makeValidSprintsJson(overrides: Partial<SprintsJson> = {}): SprintsJson {
  return {
    project: {
      id: 'proj-001',
      name: 'Test Project',
      description: 'A test',
      path: '/tmp/test',
      stack: ['typescript'],
      config: {
        max_rounds_per_sprint: 3,
        use_playwright: false,
        evaluator_agent_id: 'harness-evaluator',
        planner_agent_id: 'harness-planner',
      },
    },
    sprints: [
      {
        id: 'sprint-001',
        index: 0,
        name: 'First Sprint',
        description: 'Implement core',
        coder_agent_id: 'backend-developer',
        stack: ['typescript'],
        features: [
          {
            id: 'feat-001',
            name: 'API endpoint',
            description: 'Create endpoint',
            acceptance_criteria: ['Returns 200 OK'],
          },
        ],
        hints: { existing_files: [], key_interfaces: [], architecture_notes: '' },
        dependencies: [],
        complexity: 'low',
        estimated_rounds: 1,
      },
    ],
    metadata: {
      version: 1,
      created_at: new Date().toISOString(),
      total_sprints: 1,
      total_features: 1,
    },
    ...overrides,
  };
}

const VALID_CODER_IDS = new Set(['backend-developer', 'frontend-developer', 'electron-pro']);
const VALID_EVALUATOR_IDS = new Set(['harness-evaluator']);

describe('parsePlannerOutput: wrapper unwrapping', () => {
  it('parses direct valid JSON without wrapper', () => {
    const raw = JSON.stringify(makeValidSprintsJson());
    const result = parsePlannerOutput(raw);
    expect(result.project.id).toBe('proj-001');
    expect(result.sprints).toHaveLength(1);
  });

  it('unwraps { "plan": { ... } } wrapper', () => {
    const inner = makeValidSprintsJson();
    const wrapped = JSON.stringify({ plan: inner });
    const result = parsePlannerOutput(wrapped);
    expect(result.project.id).toBe('proj-001');
    expect(result.sprints).toHaveLength(1);
  });

  it('unwraps { "data": { ... } } wrapper', () => {
    const inner = makeValidSprintsJson();
    const wrapped = JSON.stringify({ data: inner });
    const result = parsePlannerOutput(wrapped);
    expect(result.project.id).toBe('proj-001');
  });

  it('unwraps { "result": { ... } } wrapper', () => {
    const inner = makeValidSprintsJson();
    const wrapped = JSON.stringify({ result: inner });
    const result = parsePlannerOutput(wrapped);
    expect(result.project.id).toBe('proj-001');
  });

  it('unwraps { "output": { ... } } wrapper', () => {
    const inner = makeValidSprintsJson();
    const wrapped = JSON.stringify({ output: inner });
    const result = parsePlannerOutput(wrapped);
    expect(result.project.id).toBe('proj-001');
  });

  it('unwraps double-wrapped { "plan": { "data": { ... } } }', () => {
    const inner = makeValidSprintsJson();
    const wrapped = JSON.stringify({ plan: { data: inner } });
    const result = parsePlannerOutput(wrapped);
    expect(result.project.id).toBe('proj-001');
  });

  it('throws when wrapped value is missing "project" after unwrapping', () => {
    const inner = { sprints: [], metadata: {} };
    const wrapped = JSON.stringify({ plan: inner });
    expect(() => parsePlannerOutput(wrapped)).toThrow(/Missing "project"/);
  });
});

describe('parsePlannerOutput: agent ID validation', () => {
  it('passes when coder_agent_id is valid', () => {
    const raw = JSON.stringify(makeValidSprintsJson());
    const result = parsePlannerOutput(raw, undefined, {
      coderIds: VALID_CODER_IDS,
      evaluatorIds: VALID_EVALUATOR_IDS,
    });
    expect(result.sprints[0].coder_agent_id).toBe('backend-developer');
  });

  it('throws when coder_agent_id is invalid and validAgentIds provided', () => {
    const json = makeValidSprintsJson();
    json.sprints[0].coder_agent_id = 'invented-agent';
    const raw = JSON.stringify(json);
    expect(() =>
      parsePlannerOutput(raw, undefined, {
        coderIds: VALID_CODER_IDS,
        evaluatorIds: VALID_EVALUATOR_IDS,
      }),
    ).toThrow(/invalid coder_agent_id "invented-agent"/);
  });

  it('error message for invalid coder_agent_id lists valid IDs', () => {
    const json = makeValidSprintsJson();
    json.sprints[0].coder_agent_id = 'node-developer';
    const raw = JSON.stringify(json);
    let errorMsg = '';
    try {
      parsePlannerOutput(raw, undefined, {
        coderIds: VALID_CODER_IDS,
        evaluatorIds: VALID_EVALUATOR_IDS,
      });
    } catch (e) {
      errorMsg = (e as Error).message;
    }
    expect(errorMsg).toContain('backend-developer');
    expect(errorMsg).toContain('frontend-developer');
  });

  it('throws when sprint evaluator_agent_id is invalid', () => {
    const json = makeValidSprintsJson();
    (json.sprints[0] as unknown as Record<string, unknown>)['evaluator_agent_id'] = 'wrong-evaluator';
    const raw = JSON.stringify(json);
    expect(() =>
      parsePlannerOutput(raw, undefined, {
        coderIds: VALID_CODER_IDS,
        evaluatorIds: VALID_EVALUATOR_IDS,
      }),
    ).toThrow(/invalid evaluator_agent_id "wrong-evaluator"/);
  });

  it('throws when project.config.evaluator_agent_id is invalid', () => {
    const json = makeValidSprintsJson();
    json.project.config.evaluator_agent_id = 'bad-evaluator';
    const raw = JSON.stringify(json);
    expect(() =>
      parsePlannerOutput(raw, undefined, {
        coderIds: VALID_CODER_IDS,
        evaluatorIds: VALID_EVALUATOR_IDS,
      }),
    ).toThrow(/evaluator_agent_id "bad-evaluator"/);
  });

  it('does not throw when coder_agent_id is absent (not required)', () => {
    const json = makeValidSprintsJson();
    delete (json.sprints[0] as unknown as Record<string, unknown>)['coder_agent_id'];
    const raw = JSON.stringify(json);
    expect(() =>
      parsePlannerOutput(raw, undefined, {
        coderIds: VALID_CODER_IDS,
        evaluatorIds: VALID_EVALUATOR_IDS,
      }),
    ).not.toThrow();
  });

  it('does not validate when validAgentIds is not passed', () => {
    const json = makeValidSprintsJson();
    json.sprints[0].coder_agent_id = 'completely-made-up-agent';
    const raw = JSON.stringify(json);
    const result = parsePlannerOutput(raw);
    expect(result.sprints[0].coder_agent_id).toBe('completely-made-up-agent');
  });

  it('parses with valid IDs and fixes metadata counts', () => {
    const json = makeValidSprintsJson();
    json.metadata.total_sprints = 99;
    const raw = JSON.stringify(json);
    const result = parsePlannerOutput(raw, undefined, {
      coderIds: VALID_CODER_IDS,
      evaluatorIds: VALID_EVALUATOR_IDS,
    });
    expect(result.metadata.total_sprints).toBe(1);
    expect(result.metadata.total_features).toBe(1);
  });
});

describe('parsePlannerOutput: schema validation', () => {
  it('throws when "project" is missing', () => {
    const json = makeValidSprintsJson();
    const obj = json as unknown as Record<string, unknown>;
    delete obj['project'];
    expect(() => parsePlannerOutput(JSON.stringify(obj))).toThrow(/Missing "project"/);
  });

  it('throws when "sprints" is missing', () => {
    const json = makeValidSprintsJson();
    const obj = json as unknown as Record<string, unknown>;
    delete obj['sprints'];
    expect(() => parsePlannerOutput(JSON.stringify(obj))).toThrow(/Missing "sprints"/);
  });

  it('throws when sprints array is empty', () => {
    const json = makeValidSprintsJson({ sprints: [] });
    expect(() => parsePlannerOutput(JSON.stringify(json))).toThrow(/0 sprints/);
  });

  it('throws when no JSON is found in output', () => {
    expect(() => parsePlannerOutput('just plain text')).toThrow();
  });

  it('sets outMeta.repaired when jsonrepair was needed', () => {
    const broken = `{
      "project": {
        "id": "proj-001",
        "name": "Test",
        "description": "",
        "path": "/tmp",
        "stack": ["ts"],
        "config": {
          "max_rounds_per_sprint": 1,
          "use_playwright": false,
          "evaluator_agent_id": "harness-evaluator",
          "planner_agent_id": "harness-planner",
        }
      },
      "sprints": [
        {
          "id": "sprint-001",
          "index": 0,
          "name": "S1",
          "description": "d",
          "coder_agent_id": "backend-developer",
          "stack": [],
          "features": [
            {"id": "feat-001", "name": "F", "description": "d", "acceptance_criteria": ["ac1"]}
          ],
          "hints": {"existing_files": [], "key_interfaces": [], "architecture_notes": ""},
          "dependencies": [],
          "complexity": "low",
          "estimated_rounds": 1,
        }
      ],
      "metadata": {"version": 1, "created_at": "2026-01-01T00:00:00Z", "total_sprints": 1, "total_features": 1,}
    }`;
    const outMeta: { repaired?: boolean } = {};
    const result = parsePlannerOutput(broken, outMeta);
    expect(result.project.id).toBe('proj-001');
    expect(outMeta.repaired).toBe(true);
  });
});
