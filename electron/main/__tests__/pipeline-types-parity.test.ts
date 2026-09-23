import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const CORE_FILE = path.join(REPO_ROOT, 'electron/main/pipeline-control-core.ts');
const MCP_FILE = path.join(REPO_ROOT, 'mcp-servers/lionclaw-pipeline-control/src/index.ts');

function readPipelineTypes(file: string): string[] {
  const source = fs.readFileSync(file, 'utf-8');
  const match = source.match(/PIPELINE_TYPES\s*=\s*\[([\s\S]*?)\]\s*as const;/);
  if (!match) throw new Error(`PIPELINE_TYPES nao encontrado em ${file}`);
  const body = match[1]
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
  const literals = body.match(/'([^']+)'/g);
  if (!literals) throw new Error(`Nenhum literal em PIPELINE_TYPES de ${file}`);
  return literals.map((l) => l.slice(1, -1));
}

describe('TB-35 — paridade de PIPELINE_TYPES entre o core e o subprocesso MCP', () => {
  it('os dois fontes declaram o MESMO conjunto', () => {
    const core = readPipelineTypes(CORE_FILE);
    const mcp = readPipelineTypes(MCP_FILE);
    expect([...mcp].sort()).toEqual([...core].sort());
  });

  it("'bug' esta nos DOIS (seams O1 e O2)", () => {
    expect(readPipelineTypes(CORE_FILE)).toContain('bug');
    expect(readPipelineTypes(MCP_FILE)).toContain('bug');
  });

  it('nenhum dos dois perdeu um tipo existente', () => {
    const expected = ['development', 'development-v2', 'security', 'feature', 'architecture-review', 'bug'].sort();
    expect(readPipelineTypes(CORE_FILE).sort()).toEqual(expected);
    expect(readPipelineTypes(MCP_FILE).sort()).toEqual(expected);
  });

  it('a descricao de pipeline_create anuncia o tipo bug (seam O3)', () => {
    const source = fs.readFileSync(MCP_FILE, 'utf-8');
    expect(source).toContain('architecture-review | bug');
  });

  it('a descricao de pipeline_approve anuncia a metadata da fase 3 do bug (seam O3b)', () => {
    const source = fs.readFileSync(MCP_FILE, 'utf-8');
    expect(source).toContain('bug phase3 { action:"approve-plan" | "close-pipeline" }');
  });
});
