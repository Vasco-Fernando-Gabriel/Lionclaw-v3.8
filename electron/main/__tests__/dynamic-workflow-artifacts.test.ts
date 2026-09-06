
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  mkdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  writeArtifact,
  resolveArtifactPath,
  sha256Hex,
  runLogPath,
  WorkflowArtifactPathError,
  type WorkflowArtifactsDeps,
} from '../dynamic-workflows/workflow-artifacts';
import type {
  DynamicWorkflowArtifact,
  DynamicWorkflowArtifactInsertInput,
} from '../dynamic-workflows/types';

let base: string;
let runDir: string;

function makeDeps(): {
  deps: WorkflowArtifactsDeps;
  registered: DynamicWorkflowArtifactInsertInput[];
} {
  const registered: DynamicWorkflowArtifactInsertInput[] = [];
  let counter = 0;
  const deps: WorkflowArtifactsDeps = {
    registerArtifact: (input): DynamicWorkflowArtifact => {
      registered.push(input);
      return {
        id: input.id,
        runId: input.runId,
        nodeId: input.nodeId ?? null,
        kind: input.kind,
        path: input.path,
        sha256: input.sha256,
        metadataJson: input.metadataJson ?? '{}',
        createdAt: '2026-01-01T00:00:00.000Z',
      };
    },
    generateId: () => `art-${++counter}`,
  };
  return { deps, registered };
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'dwf-artifacts-')));
  runDir = join(base, 'project', '.lionclaw', 'workflows', 'run-123');
  mkdirSync(runDir, { recursive: true });
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('workflow-artifacts: writeArtifact (caminho feliz)', () => {
  it('grava no run dir, calcula sha256 e registra (AC-11)', () => {
    const { deps, registered } = makeDeps();
    const content = '# Plano\n\nfazer X';
    const result = writeArtifact(deps, {
      runId: 'run-123',
      runDir,
      relativePath: 'artifacts/plan.md',
      content,
      kind: 'plan',
      nodeId: 'scout',
      metadata: { round: 0 },
    });

    expect(existsSync(result.absolutePath)).toBe(true);
    expect(result.absolutePath.startsWith(runDir)).toBe(true);
    expect(readFileSync(result.absolutePath, 'utf8')).toBe(content);

    const expectedHash = createHash('sha256').update(content, 'utf8').digest('hex');
    expect(result.sha256).toBe(expectedHash);

    expect(registered).toHaveLength(1);
    expect(registered[0]!.kind).toBe('plan');
    expect(registered[0]!.nodeId).toBe('scout');
    expect(registered[0]!.sha256).toBe(expectedHash);
    expect(registered[0]!.path).toBe(result.absolutePath);
    expect(JSON.parse(registered[0]!.metadataJson!)).toEqual({ round: 0 });
  });

  it('cria subdiretorios intermediarios dentro do run dir', () => {
    const { deps } = makeDeps();
    const result = writeArtifact(deps, {
      runId: 'run-123',
      runDir,
      relativePath: 'artifacts/nested/deep/anchors.json',
      content: '{}',
      kind: 'anchors',
    });
    expect(existsSync(result.absolutePath)).toBe(true);
  });

  it('aceita path absoluto DENTRO do run dir', () => {
    const { deps } = makeDeps();
    const abs = join(runDir, 'artifacts', 'delivery.md');
    const result = writeArtifact(deps, {
      runId: 'run-123',
      runDir,
      relativePath: abs,
      content: 'entregue',
      kind: 'delivery',
    });
    expect(result.absolutePath).toBe(abs);
    expect(existsSync(abs)).toBe(true);
  });
});

describe('workflow-artifacts: guard de path (artifact fora do run dir falha tipado)', () => {
  it('rejeita traversal com .. (erro tipado, sem escrever)', () => {
    const { deps, registered } = makeDeps();
    expect(() =>
      writeArtifact(deps, {
        runId: 'run-123',
        runDir,
        relativePath: '../../escapou.md',
        content: 'nope',
        kind: 'x',
      }),
    ).toThrow(WorkflowArtifactPathError);
    expect(registered).toHaveLength(0);
  });

  it('rejeita path absoluto FORA do run dir', () => {
    const { deps } = makeDeps();
    const outside = join(base, 'fora.md');
    expect(() =>
      writeArtifact(deps, {
        runId: 'run-123',
        runDir,
        relativePath: outside,
        content: 'nope',
        kind: 'x',
      }),
    ).toThrow(WorkflowArtifactPathError);
    expect(existsSync(outside)).toBe(false);
  });

  it('rejeita symlink que escapa a raiz (symlink escape)', () => {
    const outsideDir = join(base, 'outside-target');
    mkdirSync(outsideDir, { recursive: true });
    const linkPath = join(runDir, 'leak');
    symlinkSync(outsideDir, linkPath, 'dir');

    const { deps } = makeDeps();
    expect(() => resolveArtifactPath(runDir, 'leak/secret.md')).toThrow(
      WorkflowArtifactPathError,
    );
    expect(() =>
      writeArtifact(deps, {
        runId: 'run-123',
        runDir,
        relativePath: 'leak/secret.md',
        content: 'x',
        kind: 'x',
      }),
    ).toThrow(WorkflowArtifactPathError);
  });

  it('o erro tipado carrega runDir e attemptedPath', () => {
    try {
      resolveArtifactPath(runDir, '../escape.md');
      throw new Error('deveria ter jogado');
    } catch (err) {
      expect(err).toBeInstanceOf(WorkflowArtifactPathError);
      const typed = err as WorkflowArtifactPathError;
      expect(typed.code).toBe('artifact-path-escape');
      expect(typed.attemptedPath).toBe('../escape.md');
    }
  });
});

describe('workflow-artifacts: helpers', () => {
  it('sha256Hex bate o hash de referencia', () => {
    expect(sha256Hex('abc')).toBe(
      createHash('sha256').update('abc', 'utf8').digest('hex'),
    );
  });

  it('runLogPath resolve logs/<file> dentro do run dir', () => {
    const p = runLogPath(runDir, 'events.jsonl');
    expect(p).toBe(join(runDir, 'logs', 'events.jsonl'));
  });
});
