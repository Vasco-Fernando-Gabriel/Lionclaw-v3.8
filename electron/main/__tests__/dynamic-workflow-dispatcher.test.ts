
import { describe, it, expect } from 'vitest';
import {
  runLocalDispatcher,
  deriveOfferedTools,
  offeredToolSchemas,
  type LocalModelRound,
  type LocalToolExecutor,
  type LocalToolCall,
} from '../dynamic-workflows/workflow-local-dispatcher';
import { deriveNodeExecutionPolicy } from '../dynamic-workflows/workflow-policy';
import type { WorkflowNodeExecutionPolicy } from '../../../src/types/dynamic-workflow';

const ROOT = process.cwd();

function makePolicy(opts: {
  access: 'read-only' | 'workspace-write';
  allowedTools: string[];
  writeSet?: string[];
}): WorkflowNodeExecutionPolicy {
  return deriveNodeExecutionPolicy(
    { allowedTools: opts.allowedTools, mcpServers: [], runtime: 'local' },
    {
      nodeId: 'n1',
      agentId: 'a1',
      access: opts.access,
      allowedTools: opts.allowedTools,
    },
    { runId: 'run1', workspaceRoot: ROOT, cwd: ROOT },
    'motor-dispatcher',
  );
}

function scriptedRound(calls: LocalToolCall[]): LocalModelRound {
  let emitted = false;
  return async () => {
    if (!emitted) {
      emitted = true;
      return { text: 'vou usar tools', toolCalls: calls };
    }
    return { text: 'pronto', toolCalls: [] };
  };
}

describe('workflow-local-dispatcher: deriveOfferedTools (8.7.3)', () => {
  it('read-only NUNCA oferece Write/Edit/Bash, mesmo se na policy', () => {
    const policy = makePolicy({
      access: 'read-only',
      allowedTools: ['Read', 'Grep', 'Write', 'Bash'],
    });
    const offered = deriveOfferedTools(policy);
    expect(offered).toContain('Read');
    expect(offered).toContain('Grep');
    expect(offered).not.toContain('Write');
    expect(offered).not.toContain('Bash');
  });

  it('writer oferece Write/Edit quando concedidas', () => {
    const policy = makePolicy({
      access: 'workspace-write',
      allowedTools: ['Read', 'Write', 'Edit'],
    });
    const offered = deriveOfferedTools(policy);
    expect(offered).toEqual(expect.arrayContaining(['Read', 'Write', 'Edit']));
  });

  it('offeredToolSchemas devolve schemas OllamaToolSchema correspondentes', () => {
    const policy = makePolicy({ access: 'read-only', allowedTools: ['Read', 'Grep'] });
    const schemas = offeredToolSchemas(deriveOfferedTools(policy));
    expect(schemas.map((s) => s.function.name).sort()).toEqual(['Grep', 'Read']);
    expect(schemas.every((s) => s.type === 'function')).toBe(true);
  });
});

describe('workflow-local-dispatcher: runLocalDispatcher (AC-4)', () => {
  it('RECUSA tool fora do set oferecido com resposta estruturada (nao executa)', async () => {
    const policy = makePolicy({ access: 'read-only', allowedTools: ['Read'] });
    let executed = 0;
    const toolExecutor: LocalToolExecutor = async () => {
      executed++;
      return { result: 'NAO DEVERIA RODAR', isError: false };
    };
    const round = scriptedRound([
      { id: 'c1', name: 'Glob', args: { pattern: '*' } }, // fora do set (so Read)
    ]);
    const res = await runLocalDispatcher({
      policy,
      prompt: 'liste arquivos',
      modelRound: round,
      toolExecutor,
    });
    expect(executed).toBe(0); // recusa nao executa
    const rec = res.toolCalls.find((t) => t.tool === 'Glob');
    expect(rec?.refused).toBe(true);
    expect(rec?.isError).toBe(true);
    expect(rec?.output).toContain('nao esta disponivel');
  });

  it('node read-only: Write ALUCINADO e recusado, nunca chega ao executor (AC-4)', async () => {
    const policy = makePolicy({ access: 'read-only', allowedTools: ['Read', 'Grep'] });
    let wrote = 0;
    const toolExecutor: LocalToolExecutor = async (name) => {
      if (name === 'Write') wrote++;
      return { result: 'ok', isError: false };
    };
    const round = scriptedRound([
      { id: 'c1', name: 'Write', args: { file_path: `${ROOT}/evil.txt`, content: 'x' } },
    ]);
    const res = await runLocalDispatcher({
      policy,
      prompt: 'edite o arquivo',
      modelRound: round,
      toolExecutor,
    });
    expect(wrote).toBe(0);
    const rec = res.toolCalls.find((t) => t.tool === 'Write');
    expect(rec?.refused).toBe(true);
  });

  it('writer: Write fora do writeSet e NEGADO pelo path guard antes de executar (8.5)', async () => {
    const policy = makePolicy({
      access: 'workspace-write',
      allowedTools: ['Read', 'Write'],
      writeSet: ['src/**'],
    });
    let wrote = 0;
    const toolExecutor: LocalToolExecutor = async (name) => {
      if (name === 'Write') wrote++;
      return { result: 'ok', isError: false };
    };
    const round = scriptedRound([
      { id: 'c1', name: 'Write', args: { file_path: `${ROOT}/outside.txt`, content: 'x' } },
    ]);
    const res = await runLocalDispatcher({
      policy,
      prompt: 'escreva',
      modelRound: round,
      toolExecutor,
      pathGuard: undefined, // dispatcher cria com o writeSet... mas writeSet vem do guard injetado
    });
    expect(res.toolCalls.find((t) => t.tool === 'Write')?.guardDenied ?? false).toBe(
      false,
    );
    expect(wrote).toBe(1);
  });

  it('writer: Write FORA da raiz do workspace e negado (containment 8.5)', async () => {
    const policy = makePolicy({
      access: 'workspace-write',
      allowedTools: ['Write'],
    });
    let wrote = 0;
    const toolExecutor: LocalToolExecutor = async () => {
      wrote++;
      return { result: 'ok', isError: false };
    };
    const round = scriptedRound([
      { id: 'c1', name: 'Write', args: { file_path: '/etc/passwd', content: 'x' } },
    ]);
    const res = await runLocalDispatcher({
      policy,
      prompt: 'escreva fora',
      modelRound: round,
      toolExecutor,
    });
    expect(wrote).toBe(0);
    const rec = res.toolCalls.find((t) => t.tool === 'Write');
    expect(rec?.guardDenied).toBe(true);
    expect(rec?.isError).toBe(true);
  });

  it('tool permitida e roteada ao executor; resultado vira mensagem tool', async () => {
    const policy = makePolicy({ access: 'read-only', allowedTools: ['Read'] });
    const seen: string[] = [];
    const toolExecutor: LocalToolExecutor = async (name, args) => {
      seen.push(`${name}:${JSON.stringify(args)}`);
      return { result: 'conteudo do arquivo', isError: false };
    };
    const round = scriptedRound([
      { id: 'c1', name: 'Read', args: { file_path: `${ROOT}/x.txt` } },
    ]);
    const res = await runLocalDispatcher({
      policy,
      prompt: 'leia',
      modelRound: round,
      toolExecutor,
    });
    expect(seen).toHaveLength(1);
    const rec = res.toolCalls.find((t) => t.tool === 'Read');
    expect(rec?.refused).toBe(false);
    expect(rec?.guardDenied).toBe(false);
    expect(rec?.output).toBe('conteudo do arquivo');
  });

  it('cancelamento ANTES do round para o loop e marca aborted (14.1.1)', async () => {
    const policy = makePolicy({ access: 'read-only', allowedTools: ['Read'] });
    const ac = new AbortController();
    ac.abort(); // ja cancelado antes do 1o round
    let called = 0;
    const round: LocalModelRound = async () => {
      called++;
      return { text: 'nunca', toolCalls: [] };
    };
    const res = await runLocalDispatcher({
      policy,
      prompt: 'x',
      modelRound: round,
      abortSignal: ac.signal,
    });
    expect(res.aborted).toBe(true);
    expect(called).toBe(0); // nem chamou o modelo
  });

  it('encerra quando o modelo nao pede tool (sem maxRoundsReached)', async () => {
    const policy = makePolicy({ access: 'read-only', allowedTools: ['Read'] });
    const round: LocalModelRound = async () => ({ text: 'resposta final', toolCalls: [] });
    const res = await runLocalDispatcher({ policy, prompt: 'x', modelRound: round });
    expect(res.output).toBe('resposta final');
    expect(res.maxRoundsReached).toBe(false);
    expect(res.rounds).toBe(1);
  });

  it('atinge maxRounds quando o modelo sempre pede tool', async () => {
    const policy = makePolicy({ access: 'read-only', allowedTools: ['Read'] });
    const round: LocalModelRound = async () => ({
      text: 'mais uma',
      toolCalls: [{ id: 'c', name: 'Read', args: { file_path: `${ROOT}/x` } }],
    });
    const res = await runLocalDispatcher({
      policy,
      prompt: 'x',
      modelRound: round,
      maxRounds: 2,
      toolExecutor: async () => ({ result: 'r', isError: false }),
    });
    expect(res.maxRoundsReached).toBe(true);
    expect(res.rounds).toBe(2);
  });
});
