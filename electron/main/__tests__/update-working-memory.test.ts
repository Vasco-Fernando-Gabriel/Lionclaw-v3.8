import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';

// eslint-disable-next-line no-var
var TEST_TMP_DIR: string = path.join(os.tmpdir(), `uwm-test-${process.pid}`);

vi.mock('../paths', () => ({
  getLionClawHome: () => TEST_TMP_DIR,
}));

vi.mock('../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: warnSpy,
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// eslint-disable-next-line no-var
var warnSpy: (msg: string, extra?: object) => void = vi.fn();

vi.mock('../db', () => ({
  getDb: vi.fn(),
  getSessionMessages: vi.fn(),
  getSession: vi.fn(),
  getSetting: vi.fn().mockReturnValue(null),
  insertChunkWithEmbedding: vi.fn(),
  insertChunkPlainWithFTS: vi.fn(),
  searchBM25: vi.fn(),
  searchVector: vi.fn(),
}));

vi.mock('../embedding-provider', () => ({
  generateEmbedding: vi.fn(),
}));

vi.mock('../ollama-client', () => ({
  ollamaChat: vi.fn(),
}));

vi.mock('../mgraph-engine', () => ({
  executeVaultOperation: vi.fn(),
  regenerateVaultIndex: vi.fn(),
  updateVaultHot: vi.fn(),
  appendVaultLog: vi.fn(),
  getExistingVaultFilesList: vi.fn(),
}));

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: vi.fn().mockReturnValue([]) },
}));

vi.mock('../lion-sdk/adapters/lmstudio', () => ({
  createLmStudioAdapter: vi.fn(),
}));

vi.mock('../lion-sdk/adapters/ollama', () => ({
  createOllamaAdapter: vi.fn(),
}));

vi.mock('../lion-sdk/adapters/openai-compatible', () => ({
  createOpenAiCompatibleAdapter: vi.fn(),
}));

vi.mock('../lion-sdk/adapters/google-genai', () => ({
  createGoogleGenAiAdapter: vi.fn(),
}));

vi.mock('../dreaming-gate', async (importOriginal) => {
  const original = await importOriginal<typeof import('../dreaming-gate')>();
  return {
    ...original,
    runDreamingGate: vi.fn(),
    saveDreamingReport: vi.fn(),
  };
});

import type { GateOutputApplyItem } from '../dreaming-gate';

type MemorySection = 'decisoes_ativas' | 'workarounds' | 'estado_de_projetos' | 'referencias_externas';

const MEMORY_SKELETON_TEST = [
  '## Decisoes ativas',
  '',
  '## Workarounds e bugs conhecidos',
  '',
  '## Estado de projetos',
  '',
  '## Referencias externas',
].join('\n');

const SECTION_HEADERS_TEST: Record<MemorySection, string> = {
  decisoes_ativas: '## Decisoes ativas',
  workarounds: '## Workarounds e bugs conhecidos',
  estado_de_projetos: '## Estado de projetos',
  referencias_externas: '## Referencias externas',
};

const SECTION_ORDER_TEST: MemorySection[] = [
  'decisoes_ativas',
  'workarounds',
  'estado_de_projetos',
  'referencias_externas',
];

function countNonEmptyLinesTest(content: string): number {
  return content.split('\n').filter((l) => l.trim().length > 0).length;
}

function splitIntoSectionsTest(content: string): Array<{ header: string | null; lines: string[] }> {
  const lines = content.split('\n');
  const blocks: Array<{ header: string | null; lines: string[] }> = [];
  let current: { header: string | null; lines: string[] } = { header: null, lines: [] };
  for (const line of lines) {
    if (line.startsWith('## ')) {
      blocks.push(current);
      current = { header: line, lines: [] };
    } else {
      current.lines.push(line);
    }
  }
  blocks.push(current);
  return blocks;
}

function joinSectionsTest(blocks: Array<{ header: string | null; lines: string[] }>): string {
  const parts: string[] = [];
  for (const block of blocks) {
    const bodyLines = [...block.lines];
    while (bodyLines.length > 0 && bodyLines[bodyLines.length - 1].trim() === '') {
      bodyLines.pop();
    }
    if (block.header !== null) {
      parts.push(block.header);
    }
    if (bodyLines.length > 0) {
      parts.push(...bodyLines);
    }
    parts.push('');
  }
  while (parts.length > 0 && parts[parts.length - 1].trim() === '') {
    parts.pop();
  }
  return parts.join('\n') + '\n';
}

async function updateWorkingMemoryTest(
  memoryPath: string,
  input: { add: GateOutputApplyItem[]; remove: string[] },
  warnFn: (msg: string, extra?: object) => void,
): Promise<void> {
  let rawContent: string;
  try {
    rawContent = fs.readFileSync(memoryPath, 'utf-8');
    if (rawContent.trim().length === 0) {
      rawContent = MEMORY_SKELETON_TEST;
    }
  } catch {
    rawContent = MEMORY_SKELETON_TEST;
  }

  if (input.remove.length > 0) {
    const fileLines = rawContent.split('\n');
    const removedSet = new Set(input.remove);
    rawContent = fileLines.filter((line) => !removedSet.has(line)).join('\n');
  }

  let blocks = splitIntoSectionsTest(rawContent);

  const findBlock = (header: string): number => blocks.findIndex((b) => b.header === header);

  for (const section of SECTION_ORDER_TEST) {
    const header = SECTION_HEADERS_TEST[section];
    if (findBlock(header) === -1) {
      blocks.push({ header, lines: [] });
    }
  }

  const grouped = new Map<MemorySection, string[]>();
  for (const item of input.add) {
    const existing = grouped.get(item.section) ?? [];
    existing.push(item.text);
    grouped.set(item.section, existing);
  }

  for (const [section, texts] of grouped) {
    const header = SECTION_HEADERS_TEST[section];
    let idx = findBlock(header);
    if (idx === -1) {
      blocks.push({ header, lines: [] });
      idx = blocks.length - 1;
    }
    const block = blocks[idx];
    while (block.lines.length > 0 && block.lines[block.lines.length - 1].trim() === '') {
      block.lines.pop();
    }
    for (const text of texts) {
      block.lines.push(text);
    }
  }

  const PRUNE_HEADER = SECTION_HEADERS_TEST['estado_de_projetos'];

  let content = joinSectionsTest(blocks);
  let nonEmptyCount = countNonEmptyLinesTest(content);

  if (nonEmptyCount > 50) {
    const pruneIdx = blocks.findIndex((b) => b.header === PRUNE_HEADER);
    if (pruneIdx === -1 || blocks[pruneIdx].lines.filter((l) => l.trim().length > 0).length === 0) {
      warnFn(
        'updateWorkingMemory: MEMORY.md over 50 non-empty lines but "Estado de projetos" is empty — cannot prune other sections',
        { nonEmptyCount, limit: 50 },
      );
    } else {
      const pruneBlock = blocks[pruneIdx];
      while (nonEmptyCount > 50) {
        const firstNonEmpty = pruneBlock.lines.findIndex((l) => l.trim().length > 0);
        if (firstNonEmpty === -1) {
          warnFn(
            'updateWorkingMemory: "Estado de projetos" exhausted but still over 50 non-empty lines — stopping prune',
            { nonEmptyCount, limit: 50 },
          );
          break;
        }
        const removed = pruneBlock.lines.splice(firstNonEmpty, 1)[0];
        warnFn('updateWorkingMemory: pruned oldest entry from "Estado de projetos"', { prunedLine: removed });
        content = joinSectionsTest(blocks);
        nonEmptyCount = countNonEmptyLinesTest(content);
      }
    }
  }

  fs.writeFileSync(memoryPath, content, 'utf-8');
}

function memoryPath(tmpDir: string): string {
  return path.join(tmpDir, 'MEMORY.md');
}

function readMemory(tmpDir: string): string {
  return fs.readFileSync(memoryPath(tmpDir), 'utf-8');
}

function writeMemory(tmpDir: string, content: string): void {
  fs.writeFileSync(memoryPath(tmpDir), content, 'utf-8');
}

function makeTmpDir(): string {
  const dir = path.join(os.tmpdir(), `uwm-unit-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

describe('updateWorkingMemory (Sprint 3)', () => {
  let tmpDir: string;
  let warn: Mock<(msg: string, extra?: object) => void>;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    warn = vi.fn();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('1. MEMORY.md vazio + 4 adds em secoes diferentes escreve cada um na secao correta', async () => {
    await updateWorkingMemoryTest(
      memoryPath(tmpDir),
      {
        add: [
          { section: 'decisoes_ativas', text: '- [2026-01-01] Decisao alpha' },
          { section: 'workarounds', text: '- [2026-01-01] Bug beta' },
          { section: 'estado_de_projetos', text: '- [2026-01-01] Projeto gamma' },
          { section: 'referencias_externas', text: '- [2026-01-01] Link delta' },
        ],
        remove: [],
      },
      warn,
    );

    const content = readMemory(tmpDir);

    expect(content).toContain('## Decisoes ativas');
    expect(content).toContain('## Workarounds e bugs conhecidos');
    expect(content).toContain('## Estado de projetos');
    expect(content).toContain('## Referencias externas');

    const lines = content.split('\n');
    const idxDecisoes = lines.findIndex((l) => l === '## Decisoes ativas');
    const idxWorkarounds = lines.findIndex((l) => l === '## Workarounds e bugs conhecidos');
    const idxEstado = lines.findIndex((l) => l === '## Estado de projetos');
    const idxRefs = lines.findIndex((l) => l === '## Referencias externas');
    const idxAlpha = lines.findIndex((l) => l.includes('Decisao alpha'));
    const idxBeta = lines.findIndex((l) => l.includes('Bug beta'));
    const idxGamma = lines.findIndex((l) => l.includes('Projeto gamma'));
    const idxDelta = lines.findIndex((l) => l.includes('Link delta'));

    expect(idxAlpha).toBeGreaterThan(idxDecisoes);
    expect(idxAlpha).toBeLessThan(idxWorkarounds);

    expect(idxBeta).toBeGreaterThan(idxWorkarounds);
    expect(idxBeta).toBeLessThan(idxEstado);

    expect(idxGamma).toBeGreaterThan(idxEstado);
    expect(idxGamma).toBeLessThan(idxRefs);

    expect(idxDelta).toBeGreaterThan(idxRefs);
  });

  it('2. Skeleton existente + add em decisoes_ativas e workarounds cai na secao correta', async () => {
    writeMemory(tmpDir, MEMORY_SKELETON_TEST + '\n');

    await updateWorkingMemoryTest(
      memoryPath(tmpDir),
      {
        add: [
          { section: 'decisoes_ativas', text: '- [2026-02-01] Decisao importante' },
          { section: 'workarounds', text: '- [2026-02-01] Workaround macOS' },
        ],
        remove: [],
      },
      warn,
    );

    const content = readMemory(tmpDir);
    const lines = content.split('\n');

    const idxDecisoes = lines.findIndex((l) => l === '## Decisoes ativas');
    const idxWorkarounds = lines.findIndex((l) => l === '## Workarounds e bugs conhecidos');
    const idxEstado = lines.findIndex((l) => l === '## Estado de projetos');
    const idxDecisaoEntry = lines.findIndex((l) => l.includes('Decisao importante'));
    const idxWorkaroundEntry = lines.findIndex((l) => l.includes('Workaround macOS'));

    expect(idxDecisaoEntry).toBeGreaterThan(idxDecisoes);
    expect(idxDecisaoEntry).toBeLessThan(idxWorkarounds);

    expect(idxWorkaroundEntry).toBeGreaterThan(idxWorkarounds);
    expect(idxWorkaroundEntry).toBeLessThan(idxEstado);
  });

  it('3. Remove linha existente pelo texto exato', async () => {
    writeMemory(
      tmpDir,
      [
        '## Decisoes ativas',
        '- [2026-01-01] Linha A',
        '- [2026-01-02] Linha B',
        '',
        '## Workarounds e bugs conhecidos',
        '',
        '## Estado de projetos',
        '',
        '## Referencias externas',
      ].join('\n') + '\n',
    );

    await updateWorkingMemoryTest(
      memoryPath(tmpDir),
      {
        add: [],
        remove: ['- [2026-01-01] Linha A'],
      },
      warn,
    );

    const content = readMemory(tmpDir);
    expect(content).not.toContain('Linha A');
    expect(content).toContain('Linha B');
  });

  it('4. 55 linhas nao-vazias -> poda do COMECO de "Estado de projetos" ate caber em 50', async () => {
    const decisoesLines = Array.from(
      { length: 10 },
      (_, i) => `- [2026-01-${String(i + 1).padStart(2, '0')}] Decisao ${i + 1}`,
    );
    const workaroundsLines = Array.from(
      { length: 5 },
      (_, i) => `- [2026-01-${String(i + 1).padStart(2, '0')}] Workaround ${i + 1}`,
    );
    const estadoLines = Array.from(
      { length: 35 },
      (_, i) => `- [2026-01-${String(i + 1).padStart(2, '0')}] Projeto ${i + 1}`,
    );
    const refsLines = ['- [2026-01-01] Ref 1'];

    const raw =
      [
        '## Decisoes ativas',
        ...decisoesLines,
        '',
        '## Workarounds e bugs conhecidos',
        ...workaroundsLines,
        '',
        '## Estado de projetos',
        ...estadoLines,
        '',
        '## Referencias externas',
        ...refsLines,
      ].join('\n') + '\n';

    const initialCount = countNonEmptyLinesTest(raw);
    expect(initialCount).toBe(55);

    writeMemory(tmpDir, raw);

    await updateWorkingMemoryTest(memoryPath(tmpDir), { add: [], remove: [] }, warn);

    const finalContent = readMemory(tmpDir);
    const finalCount = countNonEmptyLinesTest(finalContent);
    expect(finalCount).toBeLessThanOrEqual(50);

    expect(warn).toHaveBeenCalled();

    const finalLines = finalContent.split('\n');
    const hasProjetoUm = finalLines.some((l) => /Projeto 1$/.test(l.trim()));
    expect(hasProjetoUm).toBe(false);

    expect(finalContent).toContain('Decisao 1');
    expect(finalContent).toContain('Workaround 1');
    expect(finalContent).toContain('Ref 1');
  });

  it('5. 55 linhas nao-vazias mas "Estado de projetos" VAZIO -> log warning, nao poda, arquivo permanece >50', async () => {
    const decisoesLines2 = Array.from({ length: 50 }, (_, i) => `- Decisao ${i + 1}`);
    const raw =
      [
        '## Decisoes ativas',
        ...decisoesLines2,
        '',
        '## Workarounds e bugs conhecidos',
        '',
        '## Estado de projetos',
        '',
        '## Referencias externas',
        '- [2026-01-01] Ref unica',
      ].join('\n') + '\n';

    const initialCount = countNonEmptyLinesTest(raw);
    expect(initialCount).toBe(55);

    writeMemory(tmpDir, raw);

    await updateWorkingMemoryTest(memoryPath(tmpDir), { add: [], remove: [] }, warn);

    const finalContent = readMemory(tmpDir);
    const finalCount = countNonEmptyLinesTest(finalContent);

    expect(finalCount).toBeGreaterThan(50);

    expect(warn).toHaveBeenCalled();
    const warnCalls = warn.mock.calls.map((call) => call[0] as string);
    expect(warnCalls.some((msg) => msg.includes('empty') || msg.includes('cannot prune'))).toBe(true);

    expect(finalContent).toContain('Decisao 1');
    expect(finalContent).toContain('Ref unica');
  });

  it('6. MEMORY.md com 50 linhas nao-vazias + 10 blanks no meio = nao poda', async () => {
    const entradas = Array.from({ length: 46 }, (_, i) => `- Entrada ${i + 1}`);
    const raw = [
      '## Decisoes ativas',
      '',
      '',
      '',
      ...entradas.slice(0, 10),
      '',
      '',
      '## Workarounds e bugs conhecidos',
      '',
      '',
      ...entradas.slice(10, 20),
      '',
      '',
      '## Estado de projetos',
      '',
      '',
      ...entradas.slice(20, 36),
      '',
      '',
      '## Referencias externas',
      '',
      '',
      ...entradas.slice(36, 46),
      '',
      '',
    ].join('\n');

    const nonEmpty = countNonEmptyLinesTest(raw);
    expect(nonEmpty).toBe(50);

    writeMemory(tmpDir, raw);

    await updateWorkingMemoryTest(memoryPath(tmpDir), { add: [], remove: [] }, warn);

    const finalContent = readMemory(tmpDir);
    const finalCount = countNonEmptyLinesTest(finalContent);

    expect(finalCount).toBeLessThanOrEqual(50);
    const prunedWarns = warn.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].includes('pruned oldest'),
    );
    expect(prunedWarns).toHaveLength(0);

    expect(finalContent).toContain('Entrada 1');
    expect(finalContent).toContain('Entrada 46');
  });

  it('7. Add para secao cujo header nao existe no arquivo -> cria o header', async () => {
    const partial =
      ['## Decisoes ativas', '- Decisao existente', '', '## Estado de projetos', '- Projeto existente'].join('\n') +
      '\n';

    writeMemory(tmpDir, partial);

    await updateWorkingMemoryTest(
      memoryPath(tmpDir),
      {
        add: [
          { section: 'workarounds', text: '- Bug novo' },
          { section: 'referencias_externas', text: '- Link novo' },
        ],
        remove: [],
      },
      warn,
    );

    const content = readMemory(tmpDir);

    expect(content).toContain('## Decisoes ativas');
    expect(content).toContain('## Workarounds e bugs conhecidos');
    expect(content).toContain('## Estado de projetos');
    expect(content).toContain('## Referencias externas');

    expect(content).toContain('Bug novo');
    expect(content).toContain('Link novo');

    expect(content).toContain('Decisao existente');
    expect(content).toContain('Projeto existente');
  });

  it('Extra: 2 adds na mesma secao preservam ordem cronologica (mais novo no fim)', async () => {
    writeMemory(
      tmpDir,
      [
        '## Decisoes ativas',
        '- [2026-01-01] Primeira',
        '',
        '## Workarounds e bugs conhecidos',
        '',
        '## Estado de projetos',
        '',
        '## Referencias externas',
      ].join('\n') + '\n',
    );

    await updateWorkingMemoryTest(
      memoryPath(tmpDir),
      {
        add: [
          { section: 'decisoes_ativas', text: '- [2026-01-02] Segunda' },
          { section: 'decisoes_ativas', text: '- [2026-01-03] Terceira' },
        ],
        remove: [],
      },
      warn,
    );

    const content = readMemory(tmpDir);
    const lines = content.split('\n').filter((l) => l.trim().length > 0);
    const idxPrimeira = lines.findIndex((l) => l.includes('Primeira'));
    const idxSegunda = lines.findIndex((l) => l.includes('Segunda'));
    const idxTerceira = lines.findIndex((l) => l.includes('Terceira'));

    expect(idxPrimeira).toBeLessThan(idxSegunda);
    expect(idxSegunda).toBeLessThan(idxTerceira);
  });
});
