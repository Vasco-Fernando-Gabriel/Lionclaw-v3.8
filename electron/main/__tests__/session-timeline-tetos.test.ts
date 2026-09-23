import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
vi.mock('../swarm/aggregation-policy', () => ({}));
vi.mock('../swarm/chat-persistence', () => ({}));
vi.mock('../smoke-audit', () => ({}));
vi.mock('../user-attachments-meta', () => ({}));
vi.mock('../pricing', () => ({}));
vi.mock('../agent-runtime/context-measure', () => ({}));
vi.mock('../title-generator', () => ({}));
vi.mock('../skills', () => ({}));
vi.mock('../mcp-manager', () => ({}));
vi.mock('../mcp-tool-bridge', () => ({}));
vi.mock('../desktop-lanes', () => ({}));
vi.mock('../lanes', () => ({}));
vi.mock('../chat-context-usage', () => ({}));
vi.mock('../lion-sdk/prompt', () => ({}));
vi.mock('../lion-sdk/runtime-context', () => ({}));
vi.mock('../mcp-tool-index', () => ({}));
vi.mock('../lion-sdk/stream-translator', () => ({}));
vi.mock('../lion-sdk/adapters/ollama', () => ({}));
vi.mock('../lion-sdk/adapters/lmstudio', () => ({}));
vi.mock('../lion-sdk/adapters/openai-compatible', () => ({}));
vi.mock('../lion-sdk/compaction', () => ({}));
vi.mock('../chat-compaction-trigger', () => ({}));
vi.mock('../prompt-builder', () => ({}));
vi.mock('../chat-capability-context', () => ({}));
vi.mock('../prompt-builder-repo-graph', () => ({}));
vi.mock('../onboarding', () => ({}));
vi.mock('../lion-sdk/tools/skill', () => ({}));
vi.mock('../lion-sdk/tools/agent', () => ({}));
vi.mock('../lion-sdk/tools/mcp', () => ({}));
vi.mock('../lion-sdk/tools/ask-user', () => ({}));
vi.mock('../lion-sdk/tools/memory', () => ({}));
vi.mock('../lion-sdk/tools/todo', () => ({}));
vi.mock('../lion-sdk/title', () => ({}));
vi.mock('../dreaming-turn-engine', () => ({}));
vi.mock('../repo-graph/turn-context', () => ({}));
vi.mock('../agent-runtime/subagent-dispatch', () => ({}));
vi.mock('../agent-runtime/permission-profiles', () => ({}));
vi.mock('../agent-runtime/chat-effort-inheritance', () => ({}));

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import type { GenerateContentParameters } from '@google/genai';

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), warn: vi.fn(), generate: vi.fn() }));
vi.mock('child_process', () => ({ spawn: mocks.spawn }));
vi.mock('../logger', () => ({
  createLogger: () => ({ warn: mocks.warn, info: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));
vi.mock('../db', () => ({ insertAuditEntry: vi.fn() }));
vi.mock('../permission-guard', () => ({ createPermissionGuard: vi.fn() }));
vi.mock('@google/genai', async (importOriginal) => {
  const real = await importOriginal<typeof import('@google/genai')>();
  return {
    ...real,
    GoogleGenAI: class {
      models = { generateContentStream: mocks.generate };
    },
  };
});

import { spillIfNeeded } from '../lion-sdk';
import { buildPersistedOutputBlock, SPILL_PREVIEW_BYTES } from '../session-timeline';
import {
  createSessionFsState,
  lionRead,
  lionGrep,
  normalizeHeadLimit,
  READ_MAX_INTEGRAL_BYTES,
  READ_TOKEN_CAP,
  type FsToolResult,
} from '../lion-sdk/tools/filesystem';
import { lionBash } from '../lion-sdk/tools/bash';
import { createGoogleGenAiAdapter } from '../lion-sdk/adapters/google-genai';
import { LION_TOOL_SCHEMAS } from '../lion-sdk/tool-registry';

let home: string;
let fixture: string;
let files: string[];
beforeAll(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'lion-tetos-'));
  vi.stubEnv('LIONCLAW_TEST_HOME', home);
  fixture = path.join(home, 'grep');
  await fs.mkdir(fixture);
  files = await Promise.all(
    Array.from({ length: 300 }, async (_, i) => {
      const file = path.join(fixture, `${String(i).padStart(3, '0')}.txt`);
      await fs.writeFile(file, i < 100 ? 'x\nx' : 'x');
      return file;
    }),
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  mocks.spawn.mockReset();
  mocks.warn.mockClear();
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await fs.rm(home, { recursive: true, force: true });
});

function value(result: FsToolResult<string>): string {
  if (result.isError) throw new Error(result.message);
  return result.value;
}
function bashText(bytes: number): string {
  const prefix = 'exit=1 duration=2ms\n';
  return prefix + 'x'.repeat(bytes - prefix.length);
}
async function saved(content: string, tool = 'Bash') {
  const result = await spillIfNeeded('tetos', tool, { content, isError: tool === 'Bash' });
  expect(result.meta).toEqual({ originalBytes: Buffer.byteLength(content), spillPath: expect.any(String) });
  expect(await fs.readFile(result.meta!.spillPath!, 'utf8')).toBe(content);
  expect(result.meta!.spillPath).toMatch(/[0-9a-f-]{36}\.txt$/);
  return result;
}
function processOutput(stdout: string, stderr = '', missing = false): void {
  mocks.spawn.mockImplementation(() => {
    const proc = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: vi.fn(),
    });
    queueMicrotask(() => {
      if (missing) {
        proc.emit('error', new Error('ENOENT'));
        return;
      }
      proc.stdout.emit('data', Buffer.from(stdout));
      proc.stderr.emit('data', Buffer.from(stderr));
      proc.emit('exit', 0);
    });
    return proc;
  });
}

describe('tetos medidos', () => {
  it('T-03: Bash persiste o result inteiro e mantem exit fora do bloco literal', async () => {
    const text = bashText(40_000);
    const result = await saved(text);
    expect(result.isError).toBe(true);
    expect(result.content).toBe(
      'exit=1 duration=2ms\n' +
        `<persisted-output>\nOutput too large (39.1KB). Full output saved to: ${result.meta!.spillPath}\n\nPreview (first 2KB):\n${'x'.repeat(2048)}\n...\n</persisted-output>`,
    );
    expect(buildPersistedOutputBlock(30_010, 'p', 'a')).toContain('(29.3KB)');
    expect(SPILL_PREVIEW_BYTES).toBe(2048);
  });
  it('T-03b: limiares exclusivos ASCII e UTF-8, preview sem caractere quebrado', async () => {
    for (const text of [bashText(30_000), 'exit=0 duration=1ms\n' + 'é'.repeat(14_000)]) {
      expect(await spillIfNeeded('tetos', 'Bash', { content: text })).toEqual({ content: text });
    }
    await saved(bashText(30_001));
    const result = await saved('exit=1 duration=1ms\nx' + 'é'.repeat(20_000));
    expect(result.content).not.toContain('\uFFFD');
    expect(result.content).toContain('x' + 'é'.repeat(1023) + '\n...');
    for (const char of ['é', '€', '😀']) {
      const preview = buildPersistedOutputBlock(40_000, 'p', 'x'.repeat(2047) + char);
      expect(preview).not.toContain('\uFFFD');
      expect(preview).toContain('x'.repeat(2047) + '\n...');
    }
  });
  it('T-03c: EACCES entrega content inteiro, meta nula e warn', async () => {
    vi.spyOn(fs, 'writeFile').mockRejectedValue(Object.assign(new Error('EACCES'), { code: 'EACCES' }));
    const content = bashText(40_000);
    for (const tool of ['Bash', 'Grep']) {
      expect(await spillIfNeeded('tetos', tool, { content, isError: true })).toEqual({
        content,
        isError: true,
        meta: { originalBytes: 40_000, spillPath: null },
      });
    }
    expect(mocks.warn).toHaveBeenCalled();
  });
  it('T-03d: literal persisted-output abaixo do limiar passa verbatim', async () => {
    for (const tool of ['Bash', 'Grep', 'Read']) {
      const result = { content: 'exit=0\n<persisted-output>literal</persisted-output>' };
      expect(await spillIfNeeded('tetos', tool, result)).toBe(result);
    }
    const result = { content: 'x'.repeat(40_000) };
    expect(await spillIfNeeded('tetos', 'Read', result)).toBe(result);
  });
  it('T-03e: Grep conta rodape nos 19.990/20.010 bytes e 20.000 fica inline', async () => {
    const footer = '\n[Showing results with pagination = limit: 250]';
    for (const bytes of [19_990, 20_000, 20_010]) {
      const content = 'x'.repeat(bytes - footer.length) + footer;
      if (bytes <= 20_000) expect(await spillIfNeeded('tetos', 'Grep', { content })).toEqual({ content });
      else expect((await saved(content, 'Grep')).content.startsWith('<persisted-output>')).toBe(true);
    }
  });
  it('T-03f: originalBytes e arquivo refletem o buffer real do Bash, inclusive multibyte', async () => {
    processOutput('é'.repeat(210_000), 'z'.repeat(210_000));
    const r = await lionBash(
      { command: 'mock', cwd: home },
      { sessionId: 'tetos', getWindow: () => null, permissionGuard: async () => ({ behavior: 'allow' }) },
    );
    expect(r.stdout).toBe('é'.repeat(200_000));
    expect(r.stderr).toBe('z'.repeat(200_000));
    const text = `exit=${r.exitCode} duration=${r.durationMs}ms\n--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}`;
    const result = await saved(text);
    expect(result.meta!.originalBytes).toBe(Buffer.byteLength(text));
    expect(result.content).not.toContain('\uFFFD');
  });

  it('T-04: Read integral, paginado, vazio, alem do fim, 256KB e linha gigante', async () => {
    expect(READ_MAX_INTEGRAL_BYTES).toBe(262_144);
    expect(READ_TOKEN_CAP).toBe(25_000);
    const file = path.join(home, 'read.txt');
    const state = createSessionFsState();
    const lines = Array.from({ length: 3001 }, (_, i) => `line-${i}`);
    await fs.writeFile(file, lines.join('\n'));
    expect(value(await lionRead(state, { file_path: file }))).toBe(
      lines.map((line, i) => `${String(i + 1).padStart(6, ' ')}\t${line}`).join('\n'),
    );
    expect(value(await lionRead(state, { file_path: file, limit: 50 })).split('\n')).toHaveLength(50);
    await fs.writeFile(file, 'x\n'.repeat(500_673));
    state.readFiles.clear();
    const readSpy = vi.spyOn(fs, 'readFile');
    expect(await lionRead(state, { file_path: file })).toEqual({
      isError: true,
      message:
        'File content (977.9KB) exceeds maximum allowed size (256KB). Use offset and limit parameters to read specific portions of the file',
    });
    expect(readSpy).not.toHaveBeenCalled();
    expect(state.readFiles.size).toBe(0);
    expect(value(await lionRead(state, { file_path: file, offset: 0, limit: 50 })).split('\n')).toHaveLength(50);
    expect(state.readFiles.has(file)).toBe(true);
    expect(value(await lionRead(state, { file_path: file, limit: 1 }))).toBe('     1\tx');
    expect(value(await lionRead(state, { file_path: file, offset: 0 }))).toContain('PARTIAL view');
    await fs.writeFile(file, '');
    expect(value(await lionRead(state, { file_path: file }))).toBe('');
    await fs.writeFile(file, 'a\nb');
    expect(value(await lionRead(state, { file_path: file, offset: 2 }))).toBe(
      '[offset 2 alem do fim: arquivo tem 2 linhas]',
    );
    await fs.writeFile(file, 'x'.repeat(200_000));
    const giant = value(await lionRead(state, { file_path: file }));
    expect(giant).toContain('[... linha cortada; 100007 chars restantes ...]');
    expect(giant.indexOf('[...')).toBe(100_000);
    expect(giant).toContain('offset=1 limit=1');
    await fs.writeFile(file, 'x'.repeat(262_144));
    expect((await lionRead(state, { file_path: file })).isError).toBe(false);
    await fs.appendFile(file, 'x');
    expect((await lionRead(state, { file_path: file, limit: 0 })).isError).toBe(true);
  });
  it('T-04a: PARTIAL devolve maior prefixo e proxima pagina sem perder/repetir linhas', async () => {
    const file = path.join(home, 'partial.txt');
    const lines = Array.from({ length: 156 }, (_, i) => `${i}:` + 'x'.repeat(997));
    await fs.writeFile(file, lines.join('\n'));
    const state = createSessionFsState();
    const output = value(await lionRead(state, { file_path: file }));
    const note =
      /showing lines 1-(\d+) of 156 total \((\d+) tokens, cap 25000\). Call Read with offset=(\d+) limit=(\d+)/.exec(
        output,
      )!;
    expect(note).not.toBeNull();
    const end = Number(note[1]);
    expect(Number(note[3])).toBe(end);
    expect(Number(note[4])).toBe(end);
    const prefix = output.slice(0, output.indexOf('\n[Truncated:'));
    expect(Math.ceil(prefix.length / 4)).toBe(Number(note[2]));
    expect(prefix.length).toBeLessThanOrEqual(100_000);
    expect(prefix.length + 1 + 7 + lines[end].length).toBeGreaterThan(100_000);
    const next = value(await lionRead(state, { file_path: file, offset: Number(note[3]), limit: Number(note[4]) }));
    expect(next.split('\n')[0]).toBe(`${String(end + 1).padStart(6, ' ')}\t${lines[end]}`);
  });

  for (const executor of ['ripgrep', 'fallback'] as const) {
    it(`T-04b: ${executor}, 300 arquivos/400 matches, todos os head_limit e modos`, async () => {
      expect(LION_TOOL_SCHEMAS.find((tool) => tool.name === 'Grep')!.input_schema.properties.head_limit).toEqual({
        type: 'number',
      });
      for (const invalid of [undefined, null, NaN, 2.5, 0, -1]) expect(normalizeHeadLimit(invalid)).toBe(250);
      for (const mode of ['content', 'files_with_matches', 'count'] as const) {
        const available = mode === 'content' ? 400 : 300;
        const entries =
          mode === 'content'
            ? files.flatMap((file, i) => (i < 100 ? [`${file}:1:x`, `${file}:2:x`] : [`${file}:1:x`]))
            : mode === 'count'
              ? files.map((file, i) => `${file}:${i < 100 ? 2 : 1}`)
              : files;
        processOutput(entries.join('\n') + '\n', '', executor === 'fallback');
        for (const head_limit of [undefined, 0, -1, 2.5, 10, 250, 251, 1000]) {
          const result = value(await lionGrep({ pattern: 'x', path: fixture, output_mode: mode, head_limit }));
          const expected = Math.min(available, normalizeHeadLimit(head_limit));
          const lines = result.split('\n').filter(Boolean);
          const footer = `[Showing results with pagination = limit: ${normalizeHeadLimit(head_limit)}]`;
          expect(lines.includes(footer)).toBe(expected < available);
          const actual = lines.filter((line) => line !== footer);
          expect(actual).toHaveLength(expected);
          expect(actual.every((entry) => entries.includes(entry))).toBe(true);
          if (mode === 'count') expect(actual.every((line) => /:[12]$/.test(line))).toBe(true);
        }
      }
      const exact = path.join(home, `exact-${executor}`);
      await fs.mkdir(exact);
      const exactFiles = await Promise.all(
        Array.from({ length: 250 }, async (_, i) => {
          const file = path.join(exact, `${i}.txt`);
          await fs.writeFile(file, 'x');
          return file;
        }),
      );
      for (const mode of ['content', 'files_with_matches', 'count'] as const) {
        const entries = exactFiles.map((file) =>
          mode === 'content' ? `${file}:1:x` : mode === 'count' ? `${file}:1` : file,
        );
        processOutput(entries.join('\n'), '', executor === 'fallback');
        const output = value(await lionGrep({ pattern: 'x', path: exact, output_mode: mode, head_limit: 250 }));
        expect(output.split('\n')).toHaveLength(250);
        expect(output).not.toContain('[Showing');
      }
    });
  }
  it('T-04c: fallback reseta lastIndex e multiline conta matches', async () => {
    const dir = path.join(home, 'regex');
    await fs.mkdir(dir);
    const file = path.join(dir, 'x.txt');
    await fs.writeFile(file, 'x\nx\nx\nx');
    processOutput('', '', true);
    expect(value(await lionGrep({ pattern: 'x', path: dir, output_mode: 'content' })).split('\n')).toHaveLength(4);
    expect(value(await lionGrep({ pattern: 'x', path: dir, output_mode: 'count' }))).toBe(`${file}:4`);
    await fs.writeFile(file, 'xx');
    expect(value(await lionGrep({ pattern: 'x', path: dir, output_mode: 'count', multiline: true }))).toBe(`${file}:2`);
  });
  it('T-37: API publica Gemini preserva error e content antes/depois do spill', async () => {
    mocks.generate.mockImplementation(async () =>
      (async function* () {
        yield { text: 'ok' };
      })(),
    );
    const original = bashText(40_000);
    const spilled = await saved(original);
    const adapter = createGoogleGenAiAdapter({ apiKey: 'mock' });
    for (const content of [original, spilled.content]) {
      for await (const event of adapter.streamCompletion({
        model: 'gemini-test',
        messages: [{ role: 'tool', tool_call_id: 'bash', name: 'Bash', content }],
      })) {
        expect(event.type).not.toBe('error');
      }
      const request = mocks.generate.mock.lastCall![0] as GenerateContentParameters;
      const contents = request.contents as import('@google/genai').Content[];
      expect(contents[0].parts![0].functionResponse!.response).toEqual({ error: content });
    }
  });
});
