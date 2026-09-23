import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { SDK_DISALLOWED_TOOLS, TASK_TOOL_NAMES, toSdkToolNames } from '../sdk-tool-names';

const FIXTURES_DIR = path.join(__dirname, '..', '..', '__tests__', 'fixtures');

interface InitToolsFixture {
  engineVersion: string;
  engineSha256: string;
  capturedAt: string;
  options: Record<string, unknown>;
  tools: string[];
}

function readFixture(name: string): InitToolsFixture {
  const raw = fs.readFileSync(path.join(FIXTURES_DIR, name), 'utf8');
  return JSON.parse(raw) as InitToolsFixture;
}

function builtinsOf(fixture: InitToolsFixture): Set<string> {
  return new Set(fixture.tools.filter((t) => !t.startsWith('mcp__')));
}

const EXPECTED_DISALLOWED = [
  'Artifact',
  'ArtifactComments',
  'ArtifactData',
  'DesignSync',
  'ListAgents',
  'ListSkills',
  'Monitor',
  'PowerShell',
  'PushNotification',
  'ReadMcpResourceDirTool',
  'RemoteTrigger',
  'ReportFindings',
  'ScheduleWakeup',
  'SendMessage',
  'SendUserFile',
  'SubscribePR',
  'SuggestSkills',
  'WebBrowser',
  'Workflow',
];

const PISO_ZERO_OCORRENCIAS_2_1_74 = [
  'Workflow',
  'ScheduleWakeup',
  'RemoteTrigger',
  'ListAgents',
  'PushNotification',
  'SuggestSkills',
  'ListSkills',
  'ReportFindings',
  'DesignSync',
  'SendUserFile',
  'SubscribePR',
  'Artifact',
  'WebBrowser',
];

const LIONCLAW_TOOL_CATALOG = [
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
  'Bash',
  'WebSearch',
  'WebFetch',
  'Agent',
  'TodoWrite',
  'NotebookEdit',
  'AskUserQuestion',
];

describe('toSdkToolNames (D8)', () => {
  it('TodoWrite vira as 4 Task tools NO LUGAR, ordem estavel', () => {
    expect(toSdkToolNames(['Read', 'TodoWrite', 'Edit'])).toEqual([
      'Read',
      'TaskCreate',
      'TaskUpdate',
      'TaskGet',
      'TaskList',
      'Edit',
    ]);
  });

  it('TASK_TOOL_NAMES e exatamente TaskCreate/TaskUpdate/TaskGet/TaskList', () => {
    expect([...TASK_TOOL_NAMES]).toEqual(['TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList']);
  });

  it('nao duplica Task tool ja presente (antes ou depois do TodoWrite)', () => {
    expect(toSdkToolNames(['TaskCreate', 'TodoWrite'])).toEqual(['TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList']);
    expect(toSdkToolNames(['TodoWrite', 'TaskGet'])).toEqual(['TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList']);
    expect(toSdkToolNames(['TodoWrite', 'TodoWrite'])).toEqual(['TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList']);
  });

  it('demais nomes passam intactos (mesma ordem, mesmo conteudo, MCP incluso)', () => {
    const input = ['Read', 'Glob', 'Grep', 'mcp__repo-graph__repo_graph_search', 'Bash'];
    expect(toSdkToolNames(input)).toEqual(input);
  });

  it('[] -> []', () => {
    expect(toSdkToolNames([])).toEqual([]);
  });

  it('nao muta a entrada e devolve array novo', () => {
    const input = Object.freeze(['Read', 'TodoWrite']) as readonly string[];
    const out = toSdkToolNames(input);
    expect(out).not.toBe(input);
    expect(input).toEqual(['Read', 'TodoWrite']);
  });
});

describe('SDK_DISALLOWED_TOOLS (D7): lista congelada', () => {
  it('e exatamente a lista fixada em D7, em ordem', () => {
    expect([...SDK_DISALLOWED_TOOLS]).toEqual(EXPECTED_DISALLOWED);
  });

  it('esta ordenada e sem duplicatas', () => {
    const sorted = [...SDK_DISALLOWED_TOOLS].sort((a, b) => a.localeCompare(b, 'en'));
    expect([...SDK_DISALLOWED_TOOLS]).toEqual(sorted);
    expect(new Set(SDK_DISALLOWED_TOOLS).size).toBe(SDK_DISALLOWED_TOOLS.length);
  });

  it('esta congelada (Object.freeze)', () => {
    expect(Object.isFrozen(SDK_DISALLOWED_TOOLS)).toBe(true);
  });

  it('NAO contem nenhuma Task tool (Do NOT: sao o TodoWrite do engine novo)', () => {
    for (const taskTool of TASK_TOOL_NAMES) {
      expect(SDK_DISALLOWED_TOOLS).not.toContain(taskTool);
    }
  });

  it('NAO contem TodoWrite nem nenhum nome do catalogo de tools do LionClaw (db.ts ALL_TOOLS)', () => {
    for (const tool of LIONCLAW_TOOL_CATALOG) {
      expect(SDK_DISALLOWED_TOOLS).not.toContain(tool);
    }
  });

  it('⊇ piso (13 nomes com zero ocorrencias no cli.js 2.1.74)', () => {
    expect(PISO_ZERO_OCORRENCIAS_2_1_74.length).toBe(13);
    for (const name of PISO_ZERO_OCORRENCIAS_2_1_74) {
      expect(SDK_DISALLOWED_TOOLS).toContain(name);
    }
  });
});

describe('SDK_DISALLOWED_TOOLS (D7): reconferida contra as fixtures do engine real', () => {
  const init74 = readFixture('sdk-init-tools-2.1.74.json');
  const init280 = readFixture('sdk-init-tools-2.1.280.json');

  it('fixtures sao das versoes esperadas e capturadas com as MESMAS opcoes', () => {
    expect(init74.engineVersion).toContain('2.1.74');
    expect(init280.engineVersion).toContain('2.1.280');
    expect(init74.engineSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(init280.engineSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(init280.options).toMatchObject(init74.options);
    expect(init74.options).toMatchObject({ allowedTools: [], settingSources: [], mcpServers: {}, maxTurns: 1 });
  });

  it('⊇ init(2.1.280) − init(2.1.74) − Task*', () => {
    const builtins74 = builtinsOf(init74);
    const builtins280 = builtinsOf(init280);
    const taskTools = new Set<string>(TASK_TOOL_NAMES);
    const novas = [...builtins280].filter((t) => !builtins74.has(t) && !taskTools.has(t));
    expect(novas.length).toBeGreaterThan(0);
    for (const name of novas) {
      expect(SDK_DISALLOWED_TOOLS).toContain(name);
    }
  });

  it('∩ init(2.1.74) = ∅ (nenhum nome que o modelo ve hoje entra na lista)', () => {
    const builtins74 = builtinsOf(init74);
    for (const name of SDK_DISALLOWED_TOOLS) {
      expect(builtins74.has(name)).toBe(false);
    }
  });

  it('nao afeta MCP: nenhum nome da lista tem prefixo mcp__', () => {
    for (const name of SDK_DISALLOWED_TOOLS) {
      expect(name.startsWith('mcp__')).toBe(false);
    }
  });

  it('equivalencia por conjunto (VA-4): init(2.1.280) − lista == init(2.1.74) − TodoWrite + Task* − {sumidas por opcoes da captura} − {removidas pelo engine}', () => {
    const sumidasNaCaptura = new Set(['AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode', 'TodoWrite']);
    const removidasPeloEngine = new Set(['ListMcpResourcesTool', 'ReadMcpResourceTool', 'TaskOutput']);
    const disallowed = new Set(SDK_DISALLOWED_TOOLS);
    const visiveis280 = [...builtinsOf(init280)].filter((t) => !disallowed.has(t)).sort();
    const esperado = [
      ...[...builtinsOf(init74)].filter((t) => !sumidasNaCaptura.has(t) && !removidasPeloEngine.has(t)),
      ...TASK_TOOL_NAMES.filter((t) => builtinsOf(init280).has(t)),
    ].sort();
    expect(visiveis280).toEqual(esperado);
  });
});
