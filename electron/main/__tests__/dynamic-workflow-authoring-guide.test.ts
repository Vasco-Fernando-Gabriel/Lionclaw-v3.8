import { describe, it, expect } from 'vitest';
import vm from 'node:vm';
import {
  AUTHORING_GUIDE_TEXT,
  AUTHORING_GUIDE_EXAMPLE_START,
  AUTHORING_GUIDE_EXAMPLE_END,
  AUTHORING_ALLOWED_AGENT_TYPES,
} from '../../../mcp-servers/_shared/dynamic-workflow-authoring-guide';
import { compileWorkflowJs } from '../dynamic-workflows/workflow-js-compiler';
import { validateAuthoredAgentTypes } from '../dynamic-workflows/authored-agent-validation';
import { DYNAMIC_WORKFLOW_AGENT_DENYLIST } from '../dynamic-workflows/types';

function extractExample(): string {
  const start = AUTHORING_GUIDE_TEXT.indexOf(AUTHORING_GUIDE_EXAMPLE_START);
  const end = AUTHORING_GUIDE_TEXT.indexOf(AUTHORING_GUIDE_EXAMPLE_END);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return AUTHORING_GUIDE_TEXT.slice(start + AUTHORING_GUIDE_EXAMPLE_START.length, end);
}

const MAX_TIMEOUT_MS = 45 * 60_000;
const WRITERS = new Set([
  'dynamic-workflow-coder',
  'dynamic-workflow-coder-codex',
  'dynamic-workflow-coder-glm',
  'dynamic-workflow-fixer',
  'dynamic-workflow-doc-writer',
]);

describe('guia de autoria: sentinelas (D17 + L2)', () => {
  it('tem tamanho de guia (fora do system prompt), nao de regra', () => {
    expect(AUTHORING_GUIDE_TEXT.length).toBeGreaterThan(6000);
    expect(AUTHORING_GUIDE_TEXT.length).toBeLessThan(28000);
  });

  it('contem as sentinelas do modelo canonico', () => {
    for (const s of [
      'greenCheck({ final: false })',
      'greenCheck({ final: true })',
      'ARQUIVOS TOCADOS',
      'RESUMO:',
      'refute-',
      'recheck-',
      'P1',
      'dynamic-workflow-scout',
      'PROIBIDO',
      'gate()',
      'export const meta',
      'SPRINT-VERDICT: RED',
      'digest-',
      'cc-delivery',
      'workflow-templates',
      'sprintIndex',
      'materializeSprintPlan',
    ]) {
      expect(AUTHORING_GUIDE_TEXT).toContain(s);
    }
  });

  it('L2: contrato de retorno (string/objeto), textOf, maxTurns, build, gate failure:, skip, refuter P1-only', () => {
    for (const s of ['textOf', 'string', 'maxTurns', 'npm run build', 'failure:', 'skip', 'P1', '[object Object]']) {
      expect(AUTHORING_GUIDE_TEXT).toContain(s);
    }
    expect(AUTHORING_GUIDE_TEXT).toContain('## Contrato de retorno de agent()');
    expect(AUTHORING_GUIDE_TEXT).toMatch(/Node SEM schema \(todo writer[^\n]*devolve STRING/);
    expect(AUTHORING_GUIDE_TEXT).toMatch(/Node COM schema[^\n]*devolve OBJETO/);
    expect(AUTHORING_GUIDE_TEXT).toMatch(/NUNCA String\(obj\)/);
    expect(AUTHORING_GUIDE_TEXT).toMatch(/null = decisao "skip" do orquestrador/);
    expect(AUTHORING_GUIDE_TEXT).toMatch(/gate failure:<nodeId>/);
    expect(AUTHORING_GUIDE_TEXT).toMatch(/retry[^\n]*switch-agent[^\n]*skip[^\n]*abort/);
    expect(AUTHORING_GUIDE_TEXT).toMatch(/maxTurns por agent\(\) \(1\.\.400\)/);
    expect(AUTHORING_GUIDE_TEXT).toMatch(/maxTurns: 150/);
    expect(AUTHORING_GUIDE_TEXT).toMatch(/~20 min ou ~100 turnos[^\n]*quebre em 2 ACs/);
    expect(AUTHORING_GUIDE_TEXT).toMatch(/A ULTIMA unidade de cada sprint roda npm run build/);
    expect(AUTHORING_GUIDE_TEXT).toMatch(/greenCheck\(\{ final: true \}\) tambem roda build quando o package\.json/);
    expect(AUTHORING_GUIDE_TEXT).toMatch(/Refuter SO para P1: findings\.filter\(f => f\.severity === "P1"\)/);
    expect(AUTHORING_GUIDE_TEXT).toMatch(/adjust-next-node[^\n]*QUALQUER node futuro por id/);
  });

  it('L2.1(c): documenta o shape do plano do sprint-planner como o host normaliza', () => {
    expect(AUTHORING_GUIDE_TEXT).toContain('## Plano do sprint-planner');
    expect(AUTHORING_GUIDE_TEXT).toMatch(/devolve \{ sprints: \[\.\.\.\] \} CRU/);
    for (const s of [
      'id ("s0","s1"...; ausente => "s" + indice)',
      'features: [...]',
      'writeSetHint: string[] (default [])',
      'dependencies: string[] (default [])',
      'feature: { id (ausente => sprintId + "-f" + indice), name, acceptanceCriteria: string[] NAO-VAZIO }',
      'A UNIDADE de trabalho e UM item de features[].acceptanceCriteria',
    ]) {
      expect(AUTHORING_GUIDE_TEXT).toContain(s);
    }
  });

  it('lista fechada de agentType casa com a denylist D18 (nenhum denylisted permitido)', () => {
    for (const denied of DYNAMIC_WORKFLOW_AGENT_DENYLIST) {
      expect(AUTHORING_ALLOWED_AGENT_TYPES).not.toContain(denied);
    }
    expect(AUTHORING_GUIDE_TEXT).toMatch(/dynamic-workflow-closer, -narrator, -maestro, -builder/);
  });

  it('carrega a matriz model/effort que saiu do system prompt', () => {
    expect(AUTHORING_GUIDE_TEXT).toContain('"low" | "medium" | "high" | "xhigh" | "max" | "ultra"');
    expect(AUTHORING_GUIDE_TEXT).toContain('Na familia Claude, "xhigh"/"max"/"ultra" viram "max"');
    expect(AUTHORING_GUIDE_TEXT).toContain('cloud/zai/minimax-tp/codex');
    expect(AUTHORING_GUIDE_TEXT).toContain('Kimi aceita apenas effort por node');
    expect(AUTHORING_GUIDE_TEXT).toContain('Grok suporta model/effort');
    expect(AUTHORING_GUIDE_TEXT).toMatch(/Em local\/external, model\/effort por node e erro fatal/);
    expect(AUTHORING_GUIDE_TEXT).toContain('NUNCA escolha "ultra" por conta propria');
    expect(AUTHORING_GUIDE_TEXT).toContain('model-cross-family');
  });

  it('sem em-dash e sem acentos', () => {
    expect(AUTHORING_GUIDE_TEXT).not.toMatch(/[–—]/);
    expect(AUTHORING_GUIDE_TEXT).not.toMatch(/[À-ÿ]/);
  });
});

describe('guia de autoria: o .js de referencia e compilavel e valido', () => {
  const example = extractExample();

  it('compila na gramatica claude-code atual (meta.description obrigatoria, corpo top-level)', () => {
    const r = compileWorkflowJs(example);
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    expect(r.meta.name).toBe('feature-curta');
    expect(r.meta.phases).toEqual(['Documentos', 'Sprint', 'Auditoria']);
  });

  it('todo agentType e literal, da lista permitida, e passa em validateAuthoredAgentTypes', () => {
    const allowed = new Set<string>(AUTHORING_ALLOWED_AGENT_TYPES);
    const r = validateAuthoredAgentTypes(example, {
      getAgent: (id) =>
        allowed.has(id)
          ? { access: WRITERS.has(id) ? 'workspace-write' : 'read-only', squad: 'dynamic-workflow' }
          : undefined,
    });
    if (!r.ok) throw new Error(r.error);
    expect(r.agentTypes.length).toBeGreaterThan(0);
    for (const t of r.agentTypes) expect(allowed.has(t)).toBe(true);
    expect(r.agentTypes).toContain('dynamic-workflow-sprint-planner');
  });

  it('nao usa primitivas proibidas nem String(obj) em retorno de agent()', () => {
    expect(example).not.toMatch(/\bgate\s*\(/);
    expect(example).not.toMatch(/materializeSprintPlan|validateSprintPlan/);
    expect(example).not.toMatch(/sprintIndex/);
    expect(example).toMatch(/const textOf = \(r\) => \(typeof r === "string" \? r : \(r && typeof r\.output === "string" \? r\.output : JSON\.stringify\(r\)\)\)/);
    expect(example).toMatch(/const t = textOf\(r\);/);
    expect(example).not.toMatch(/String\(texto\)|String\(saida\)|String\(fix\)/);
  });

  it('TODA chamada de phase() e awaited e o guia separa FATAL no host de doutrina', () => {
    const phaseCalls = example.match(/[^\w.]phase\s*\(/g) ?? [];
    expect(phaseCalls.length).toBeGreaterThanOrEqual(3);
    const awaited = example.match(/await phase\s*\(/g) ?? [];
    expect(awaited.length).toBe(phaseCalls.length);
    expect(AUTHORING_GUIDE_TEXT).toContain('## FATAL no host');
    expect(AUTHORING_GUIDE_TEXT).toContain('## Doutrina (o host NAO aplica');
    expect(AUTHORING_GUIDE_TEXT).toMatch(/Sempre "await phase\(nome\)"/);
    expect(AUTHORING_GUIDE_TEXT).toMatch(/confirme o projectPath/);
    expect(AUTHORING_GUIDE_TEXT).toMatch(/edit_coordinator exige o run quiescente/);
  });
});

describe('guia de autoria: o .js de referencia executa a doutrina (vm com stubs no contrato da rodada 2)', () => {
  type AgentCall = { prompt: string; opts: Record<string, unknown> };

  const TOUCHED = 'feito\nARQUIVOS TOCADOS:\n- src/a.ts\n- src/a.test.ts\nRESUMO:\nok\nok';

  const PLAN_RAW = {
    sprints: [
      {
        id: 's0',
        name: 'Base',
        description: 'entrega X',
        stack: ['ts'],
        writeSetHint: ['src/a.ts'],
        features: [{ id: 'F1', name: 'feature X', acceptanceCriteria: ['faz X', 'faz Y'] }],
      },
    ],
  };

  async function runExample(over?: {
    recheck?: Record<string, unknown> | null;
    refuteSeverity?: string;
    dod?: Record<string, unknown> | null;
    plan?: unknown;
    skipWriters?: string[];
    legacyWriterEnvelope?: boolean;
    reporterNull?: boolean;
  }) {
    const example = extractExample();
    const compiled = compileWorkflowJs(example);
    if (!compiled.ok) throw new Error(JSON.stringify(compiled.errors));

    const calls: AgentCall[] = [];
    const phases: string[] = [];
    const logs: string[] = [];
    const artifacts: Array<{ path: string; data: unknown }> = [];
    const order: string[] = [];
    let greenChecks = 0;
    const skip = new Set(over?.skipWriters ?? []);

    const sandbox: Record<string, unknown> = {
      args: { objetivo: 'feature X', specPath: 'docs/SPEC.md', planoPath: 'docs/plano.md' },
      phase: (name: string) => {
        phases.push(name);
        order.push(`phase:call:${name}`);
        return new Promise<void>((resolve) =>
          setTimeout(() => {
            order.push(`phase:resolve:${name}`);
            resolve();
          }, 0),
        );
      },
      log: async (m: string) => {
        logs.push(m);
      },
      artifact: async (arg: { path: string; data: unknown }) => {
        artifacts.push(arg);
      },
      gate: () => {
        throw new Error('gate() e proibido em .js autorado');
      },
      greenCheck: async () => {
        greenChecks += 1;
        return greenChecks === 1
          ? {
              ok: false,
              inconclusive: false,
              findings: [{ severity: 'P1', where: 'typecheck', problem: 'TS2322', fix: '' }],
              checks: [],
            }
          : { ok: true, inconclusive: false, findings: [], checks: [] };
      },
      parallel: async (thunks: Array<() => Promise<unknown>>) => {
        const out: unknown[] = [];
        for (const t of thunks) out.push(await t());
        return out;
      },
      agent: async (prompt: string, opts: Record<string, unknown>) => {
        calls.push({ prompt, opts });
        const type = String(opts.agentType);
        const label = String(opts.label);
        order.push(`agent:${label}`);
        if (WRITERS.has(type)) {
          if (skip.has(label)) return null;
          return over?.legacyWriterEnvelope ? { output: TOUCHED } : TOUCHED;
        }
        if (type === 'dynamic-workflow-sprint-planner') return over && 'plan' in over ? over.plan : PLAN_RAW;
        if (type === 'dynamic-workflow-validator-spec') {
          return {
            verdict: 'fail',
            findings: [
              { severity: 'P1', where: 'src/b.ts', problem: 'zz quebrado' },
              { severity: 'P2', where: 'src/a.ts', problem: 'aa fraco' },
            ],
          };
        }
        if (type.startsWith('dynamic-workflow-validator-')) return { verdict: 'pass', findings: [] };
        if (type === 'dynamic-workflow-refuter') {
          if (label.startsWith('recheck-')) {
            if (over && 'recheck' in over) return over.recheck;
            return { where: 'src/b.ts', problem: 'zz quebrado', verdict: 'fixed', evidencia: 'ok' };
          }
          return {
            where: 'src/b.ts',
            problem: 'zz quebrado',
            verdict: 'real',
            severityConfirmada: over?.refuteSeverity ?? 'P1',
            evidencia: 'trecho',
          };
        }
        if (label === 'mapa') return { arquivos: ['src/a.ts'], riscos: [] };
        if (label.startsWith('reporter-')) {
          if (over?.reporterNull) return null;
          return { unidades: ['u'], gates: ['g'], p1Restantes: [], advisories: [], notas: 'n' };
        }
        if (label === 'dod') {
          if (over && 'dod' in over) return over.dod;
          return { ok: true, pendencias: [] };
        }
        throw new Error('agent stub sem resposta para ' + type + '/' + label);
      },
    };
    const ctx = vm.createContext(sandbox);
    new vm.Script(compiled.transformedSource).runInContext(ctx);
    const run = sandbox.__run as (c: unknown) => Promise<unknown>;
    const result = await run(ctx);
    return { calls, phases, logs, artifacts, greenChecks, result, order };
  }

  function labelsOf(calls: AgentCall[]): string[] {
    return calls.map((c) => String(c.opts.label));
  }

  it('await phase: NENHUM agent() roda antes do phase() resolver (o host pode pausar ali no gate boundary)', async () => {
    const { order, phases } = await runExample();
    expect(phases).toEqual(['Documentos', 'Sprint s0', 'Auditoria']);
    for (const name of phases) {
      const call = order.indexOf(`phase:call:${name}`);
      const resolve = order.indexOf(`phase:resolve:${name}`);
      expect(call).toBeGreaterThan(-1);
      expect(resolve).toBeGreaterThan(call);
      expect(order.slice(call + 1, resolve).filter((o) => o.startsWith('agent:'))).toEqual([]);
    }
    expect(order[order.indexOf('phase:resolve:Documentos') + 1]).toBe('agent:mapa');
    expect(order[order.indexOf('phase:resolve:Sprint s0') + 1]).toBe('agent:u-s0-F1-a0');
    expect(order[order.indexOf('phase:resolve:Auditoria') + 1]).toBe('agent:dod');
  });

  it('L2.1(c): le o plano do sprint-planner no shape normalizado (features[].acceptanceCriteria => 1 unidade por AC; writeSetHint => arquivo-alvo)', async () => {
    const { calls } = await runExample();
    const labels = labelsOf(calls);
    expect(labels.slice(0, 3)).toEqual(['mapa', 'plano', 'planner']);
    const planner = calls[2]!;
    expect(planner.opts.agentType).toBe('dynamic-workflow-sprint-planner');
    expect(planner.opts.schema).toBeDefined();
    expect(planner.prompt).toContain('docs/SPEC.md');
    expect(labels.filter((l) => l.startsWith('u-'))).toEqual(['u-s0-F1-a0', 'u-s0-F1-a1']);
    const u0 = calls.find((c) => c.opts.label === 'u-s0-F1-a0')!;
    expect(u0.prompt).toContain('faz X');
    expect(u0.prompt).toContain('writeSetHint');
    expect(u0.prompt).toContain('src/a.ts');
  });

  it('L2.1(c): defaults do host aplicados no .js (id => s<i>, feature.id => <sid>-f<j>) e plano invalido encerra sem writer', async () => {
    const semIds = await runExample({
      plan: { sprints: [{ features: [{ acceptanceCriteria: ['faz Z'] }] }] },
    });
    expect(semIds.phases).toContain('Sprint s0');
    expect(labelsOf(semIds.calls)).toContain('u-s0-s0-f0-a0');

    const invalido = await runExample({ plan: { sprints: [{ id: 's0', features: [{ id: 'F1', acceptanceCriteria: [] }] }] } });
    expect(invalido.result).toMatchObject({ ok: false, motivo: 'plano-invalido' });
    expect(labelsOf(invalido.calls).some((l) => l.startsWith('u-'))).toBe(false);
    expect(invalido.logs.some((l) => l.startsWith('PLANO INVALIDO'))).toBe(true);

    const vazio = await runExample({ plan: null });
    expect(vazio.result).toMatchObject({ ok: false, motivo: 'plano-invalido' });
  });

  it('L2.1(b): writer devolve STRING e o escopo dos validadores contem os caminhos dos ARQUIVOS TOCADOS (via textOf)', async () => {
    const { calls } = await runExample();
    const val = calls.filter((c) => String(c.opts.label).startsWith('val-'));
    expect(val).toHaveLength(3);
    for (const v of val) {
      expect(v.prompt).toContain('ARQUIVOS TOCADOS:\n- src/a.ts\n- src/a.test.ts');
      expect(v.prompt).not.toContain('[object Object]');
    }
    expect(val[0]!.prompt).not.toMatch(/\nfeito\n/);
  });

  it('L2.1(b): textOf cobre por 1 versao o envelope legado { output } do host anterior', async () => {
    const { calls, logs, artifacts } = await runExample({ legacyWriterEnvelope: true });
    const val = calls.filter((c) => String(c.opts.label).startsWith('val-'));
    for (const v of val) expect(v.prompt).toContain('ARQUIVOS TOCADOS:\n- src/a.ts');
    const tudo = [...calls.map((c) => c.prompt), ...logs, JSON.stringify(artifacts)].join('\n');
    expect(tudo).not.toContain('[object Object]');
  });

  it('[object Object]: nenhum prompt, log ou artifact carrega concatenacao de objeto; digest e JSON.stringify', async () => {
    const { calls, logs, artifacts } = await runExample();
    const tudo = [...calls.map((c) => c.prompt), ...logs, JSON.stringify(artifacts)].join('\n');
    expect(tudo).not.toContain('[object Object]');
    const reporter = calls.find((c) => c.opts.label === 'reporter-s0')!;
    expect(reporter.prompt).toContain('"unidades"');
    expect(reporter.prompt).toContain('"tocados"');
    expect(reporter.prompt).toContain('src/a.ts');
    expect(logs.some((l) => l.startsWith('{') && l.includes('"unidades"'))).toBe(true);
    expect(artifacts.map((a) => a.path)).toEqual(['artifacts/digest-s0.json']);
  });

  it('L2.3: todo writer leva maxTurns (1..400); a ULTIMA unidade da sprint roda npm run build, as outras nao', async () => {
    const { calls } = await runExample();
    for (const c of calls) {
      const type = String(c.opts.agentType);
      if (WRITERS.has(type)) {
        expect(typeof c.opts.maxTurns).toBe('number');
        expect(c.opts.maxTurns as number).toBeGreaterThanOrEqual(1);
        expect(c.opts.maxTurns as number).toBeLessThanOrEqual(400);
      }
    }
    const coder = calls.find((c) => c.opts.label === 'u-s0-F1-a0')!;
    expect(coder.opts.maxTurns).toBe(150);
    const units = calls.filter((c) => String(c.opts.label).startsWith('u-'));
    expect(units).toHaveLength(2);
    expect(units[0]!.prompt).not.toContain('npm run build');
    expect(units[1]!.prompt).toContain('npm run build');
    expect(units[1]!.prompt).toContain('npm run typecheck');
  });

  it('L2.2: refuter SO para P1 (P2 vai direto para advisory) mantendo ids canonicos; recheck SO para P1 real', async () => {
    const { calls } = await runExample();
    const labels = labelsOf(calls);
    expect(labels.filter((l) => l.startsWith('refute-'))).toEqual(['refute-f1']);
    const refute = calls.find((c) => c.opts.label === 'refute-f1')!;
    expect(refute.prompt).toContain('src/b.ts');
    expect(refute.prompt).not.toContain('aa fraco');
    expect(labels.filter((l) => l.startsWith('recheck-'))).toEqual(['recheck-f1']);
    const reporter = calls.find((c) => c.opts.label === 'reporter-s0')!;
    expect(reporter.prompt).toContain('src/a.ts: aa fraco');
  });

  it('L2.2: P1 rebaixado pelo refuter (severityConfirmada P2) vira advisory: sem fixer de sprint, sem recheck', async () => {
    const { calls, logs, result } = await runExample({ refuteSeverity: 'P2' });
    const labels = labelsOf(calls);
    expect(labels).toEqual(expect.arrayContaining(['refute-f1']));
    expect(labels.filter((l) => l.startsWith('recheck-'))).toEqual([]);
    expect(labels.filter((l) => l === 'fix-s0')).toEqual([]);
    const reporter = calls.find((c) => c.opts.label === 'reporter-s0')!;
    expect(reporter.prompt).toContain('src/b.ts: zz quebrado');
    expect(logs.some((l) => l.startsWith('SPRINT-VERDICT: RED'))).toBe(false);
    expect(result).toEqual({ ok: true, pendencias: [] });
  });

  it('prompts do refuter e do recheck dizem o enum do verdict EXPLICITAMENTE (o host ignora enum de schema inline)', async () => {
    const { calls } = await runExample();
    const refute = calls.find((c) => String(c.opts.label).startsWith('refute-'))!;
    expect(refute.prompt).toContain("verdict: 'real' ou 'false'");
    const recheck = calls.find((c) => String(c.opts.label).startsWith('recheck-'))!;
    expect(recheck.prompt).toContain("verdict: 'fixed' ou 'still-real'");
    expect(AUTHORING_GUIDE_TEXT).toMatch(/enum\/properties sao IGNORADOS/);
  });

  it('fail-closed: recheck null (skip) ou verdict fora do enum NAO fecha o P1 => SPRINT-VERDICT: RED e o run encerra', async () => {
    const nulo = await runExample({ recheck: null });
    expect(nulo.logs.some((l) => l.startsWith('SPRINT-VERDICT: RED'))).toBe(true);
    expect(nulo.result).toMatchObject({ ok: false, sprint: 's0' });
    expect(nulo.calls.some((c) => c.opts.label === 'dod')).toBe(false);

    const foraDoEnum = await runExample({ recheck: { where: 'src/b.ts', problem: 'zz quebrado', verdict: 'resolvido', evidencia: 'x' } });
    expect(foraDoEnum.logs.some((l) => l.startsWith('SPRINT-VERDICT: RED'))).toBe(true);
  });

  it('null de um writer (skip do orquestrador) NAO derruba o coordenador: registra SKIPPED e segue', async () => {
    const { calls, logs, result, greenChecks } = await runExample({ skipWriters: ['u-s0-F1-a0'] });
    const labels = labelsOf(calls);
    expect(labels).toContain('u-s0-F1-a1');
    expect(labels).not.toContain('fix-u-s0-F1-a0');
    expect(logs.some((l) => l.startsWith('SKIP F1-a0'))).toBe(true);
    const val = calls.find((c) => c.opts.label === 'val-spec-s0')!;
    expect(val.prompt).toContain('F1-a0: SKIPPED');
    const reporter = calls.find((c) => c.opts.label === 'reporter-s0')!;
    expect(reporter.prompt).toContain('F1-a0: SKIPPED');
    expect(greenChecks).toBe(3);
    expect(result).toEqual({ ok: true, pendencias: [] });
  });

  it('null do fixer de sprint (skip) mantem o P1 aberto (sem recheck) => RED; null do doc-writer so loga', async () => {
    const fixSkip = await runExample({ skipWriters: ['fix-s0'] });
    expect(labelsOf(fixSkip.calls).filter((l) => l.startsWith('recheck-'))).toEqual([]);
    expect(fixSkip.logs.some((l) => l.startsWith('SPRINT-VERDICT: RED'))).toBe(true);

    const planoSkip = await runExample({ skipWriters: ['plano'] });
    expect(planoSkip.logs.some((l) => l.startsWith('SKIP plano'))).toBe(true);
    expect(labelsOf(planoSkip.calls)).toContain('planner');
    expect(planoSkip.result).toEqual({ ok: true, pendencias: [] });
  });

  it('reporter null (skip) => digest mecanico com os mesmos dados; artifact e log continuam', async () => {
    const { artifacts, logs } = await runExample({ reporterNull: true });
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]!.data).toMatchObject({ notas: expect.stringContaining('SKIPPED') });
    expect(logs.some((l) => l.startsWith('{') && l.includes('"unidades"'))).toBe(true);
  });

  it('dod null (skip do scout) nao lanca: ok=false com pendencia default', async () => {
    const { result } = await runExample({ dod: null });
    expect(result).toEqual({ ok: false, pendencias: ['auditoria DoD nao concluida'] });
  });

  it('produz a topologia da doutrina sem violar as regras do host', async () => {
    const { calls, phases, logs, artifacts, greenChecks, result } = await runExample();
    const labels = labelsOf(calls);

    expect(phases).toEqual(['Documentos', 'Sprint s0', 'Auditoria']);
    expect(labels.slice(0, 3)).toEqual(['mapa', 'plano', 'planner']);

    expect(labels).toContain('u-s0-F1-a0');
    expect(labels).toContain('fix-u-s0-F1-a0');
    expect(labels).toContain('u-s0-F1-a1');

    expect(labels.filter((l) => l.startsWith('val-')).sort()).toEqual(['val-reg-s0', 'val-spec-s0', 'val-tests-s0']);

    expect(labels.filter((l) => l === 'fix-s0')).toHaveLength(1);
    expect(labels.filter((l) => l.startsWith('recheck-'))).toEqual(['recheck-f1']);

    expect(labels).toContain('reporter-s0');
    expect(artifacts.map((a) => a.path)).toEqual(['artifacts/digest-s0.json']);
    expect(logs.some((l) => l.startsWith('{') && l.includes('"unidades"'))).toBe(true);
    expect(labels[labels.length - 1]).toBe('dod');

    expect(greenChecks).toBe(4);

    for (const c of calls) {
      const type = String(c.opts.agentType);
      expect((AUTHORING_ALLOWED_AGENT_TYPES as readonly string[]).includes(type)).toBe(true);
      expect(typeof c.opts.timeoutMs).toBe('number');
      expect(c.opts.timeoutMs as number).toBeLessThanOrEqual(MAX_TIMEOUT_MS);
      if (WRITERS.has(type)) expect(c.opts.schema).toBeUndefined();
      else expect(c.opts.schema).toBeDefined();
    }

    expect(logs.some((l) => l.startsWith('SPRINT-VERDICT: RED'))).toBe(false);
    expect(result).toEqual({ ok: true, pendencias: [] });
  });
});
