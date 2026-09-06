
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  saveNodeCheckpoint,
  readNodeCheckpoint,
  readNodeCheckpointSummary,
  parseRunCheckpointIndex,
  type WorkflowCheckpointsDeps,
} from '../dynamic-workflows/workflow-checkpoints';

let base: string;
let runDir: string;

function makeDeps(initial = '{}'): {
  deps: WorkflowCheckpointsDeps;
  current: () => string;
} {
  let store = initial;
  const deps: WorkflowCheckpointsDeps = {
    getRunCheckpoint: () => store,
    persistRunCheckpoint: (_runId, json) => {
      store = json;
    },
    now: () => new Date('2026-01-02T03:04:05.000Z'),
  };
  return { deps, current: () => store };
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'dwf-ckpt-')));
  runDir = join(base, '.lionclaw', 'workflows', 'run-9');
  mkdirSync(runDir, { recursive: true });
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('workflow-checkpoints: saveNodeCheckpoint', () => {
  it('grava checkpoints/<nodeId>.json com hashes e worktreeCommitSha (8.6.1)', () => {
    const { deps } = makeDeps();
    const result = saveNodeCheckpoint(deps, {
      runId: 'run-9',
      runDir,
      nodeId: 'coder',
      attempt: 1,
      state: { wrote: ['a.ts'] },
      inputHash: 'in-abc',
      worktreeCommitSha: 'sha-deadbeef',
      schemaRef: 'impl.schema.json',
      agentId: 'dynamic-workflow-coder',
    });

    expect(existsSync(result.absolutePath)).toBe(true);
    expect(result.absolutePath.startsWith(runDir)).toBe(true);

    const onDisk = JSON.parse(readFileSync(result.absolutePath, 'utf8'));
    expect(onDisk.nodeId).toBe('coder');
    expect(onDisk.inputHash).toBe('in-abc');
    expect(onDisk.worktreeCommitSha).toBe('sha-deadbeef');
    expect(onDisk.schemaRef).toBe('impl.schema.json');
    expect(onDisk.agentId).toBe('dynamic-workflow-coder');
    expect(typeof onDisk.outputHash).toBe('string');
    expect(onDisk.outputHash).toHaveLength(64);
    expect(onDisk.savedAt).toBe('2026-01-02T03:04:05.000Z');
  });

  it('funde o resumo no indice checkpoint_json do run', () => {
    const { deps, current } = makeDeps();
    saveNodeCheckpoint(deps, {
      runId: 'run-9',
      runDir,
      nodeId: 'scout',
      attempt: 1,
      state: { files: [] },
      inputHash: 'h1',
    });
    const index = JSON.parse(current());
    expect(index.nodes.scout).toBeDefined();
    expect(index.nodes.scout.inputHash).toBe('h1');
    expect(index.nodes.scout.attempt).toBe(1);
  });

  it('read-merge-write PRESERVA chaves extras do checkpoint_json (S17 scheduledResumeAt)', () => {
    const { deps, current } = makeDeps(
      JSON.stringify({ scheduledResumeAt: '2026-02-01T00:00:00.000Z', nodes: {} }),
    );
    saveNodeCheckpoint(deps, {
      runId: 'run-9',
      runDir,
      nodeId: 'coder',
      attempt: 2,
      state: {},
    });
    const index = JSON.parse(current());
    expect(index.scheduledResumeAt).toBe('2026-02-01T00:00:00.000Z');
    expect(index.nodes.coder.attempt).toBe(2);
  });

  it('respeita outputHash explicito quando fornecido', () => {
    const { deps } = makeDeps();
    const result = saveNodeCheckpoint(deps, {
      runId: 'run-9',
      runDir,
      nodeId: 'gate',
      attempt: 1,
      state: { ok: true },
      outputHash: 'forced-hash',
    });
    expect(result.file.outputHash).toBe('forced-hash');
  });

  it('sanitiza nodeId perigoso sem escapar o run dir', () => {
    const { deps } = makeDeps();
    const result = saveNodeCheckpoint(deps, {
      runId: 'run-9',
      runDir,
      nodeId: 'weird/../id',
      attempt: 1,
      state: {},
    });
    expect(result.absolutePath.startsWith(join(runDir, 'checkpoints'))).toBe(true);
    expect(existsSync(result.absolutePath)).toBe(true);
  });
});

describe('workflow-checkpoints: leitura para resume (10.1)', () => {
  it('readNodeCheckpoint le o arquivo gravado', () => {
    const { deps } = makeDeps();
    saveNodeCheckpoint(deps, {
      runId: 'run-9',
      runDir,
      nodeId: 'coder',
      attempt: 3,
      state: { x: 1 },
      inputHash: 'h',
    });
    const read = readNodeCheckpoint(runDir, 'coder');
    expect(read).not.toBeNull();
    expect(read!.attempt).toBe(3);
    expect(read!.state).toEqual({ x: 1 });
  });

  it('readNodeCheckpoint retorna null quando nao existe', () => {
    expect(readNodeCheckpoint(runDir, 'inexistente')).toBeNull();
  });

  it('readNodeCheckpointSummary le o resumo do indice', () => {
    const { deps } = makeDeps();
    saveNodeCheckpoint(deps, {
      runId: 'run-9',
      runDir,
      nodeId: 'scout',
      attempt: 1,
      state: {},
      schemaRef: 'scout.schema.json',
      agentId: 'dynamic-workflow-scout',
    });
    const summary = readNodeCheckpointSummary(deps, 'run-9', 'scout');
    expect(summary).not.toBeNull();
    expect(summary!.schemaRef).toBe('scout.schema.json');
    expect(summary!.agentId).toBe('dynamic-workflow-scout');
  });
});

describe('workflow-checkpoints: parseRunCheckpointIndex (tolerancia)', () => {
  it('JSON ausente/invalido vira indice vazio', () => {
    expect(parseRunCheckpointIndex(null).nodes).toEqual({});
    expect(parseRunCheckpointIndex('').nodes).toEqual({});
    expect(parseRunCheckpointIndex('nao-json').nodes).toEqual({});
    expect(parseRunCheckpointIndex('123').nodes).toEqual({});
  });

  it('preserva chaves extras e normaliza nodes ausente', () => {
    const idx = parseRunCheckpointIndex(JSON.stringify({ scheduledResumeAt: 'x' }));
    expect(idx.nodes).toEqual({});
    expect(idx['scheduledResumeAt']).toBe('x');
  });
});
