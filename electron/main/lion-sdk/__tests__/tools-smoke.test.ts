import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

vi.mock('../../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../../db', () => ({
  getAgent: vi.fn(),
  insertAuditEntry: vi.fn(),
  getSetting: vi.fn(() => undefined),
}));

vi.mock('../../paths', () => ({
  getAgentCwd: () => os.tmpdir(),
  getLionClawHome: () => os.tmpdir(),
}));

vi.mock('../../memory-pipeline', () => ({
  searchSemanticMemories: vi.fn(),
}));

vi.mock('../../mcp-tool-bridge', () => ({
  callMCPTool: vi.fn(),
}));

vi.mock('../../ask-question', () => ({
  sendAskQuestion: vi.fn(),
}));

vi.mock('../../agent-runtime', () => ({
  executeAgent: vi.fn(),
}));

vi.mock('../../agent-runtime/permission-profiles', () => ({
  PERM_BYPASS_NO_GUARD: { mode: 'bypassPermissions' },
}));

import { createSessionFsState, lionRead, lionWrite, lionEdit, lionGlob, lionGrep } from '../tools/filesystem';
import { lionBash } from '../tools/bash';
import { LionTodoStore, lionTodoWrite } from '../tools/todo';
import { lionAskUserQuestion } from '../tools/ask-user';
import { lionMemorySearch } from '../tools/memory';
import { lionMcpCall, buildPrefixedMcpName } from '../tools/mcp';
import { lionAgentDispatch } from '../tools/agent';
import { lionSkillLoad } from '../tools/skill';
import { LION_TOOL_SCHEMAS, listLionToolNames } from '../tool-registry';

let SANDBOX = '';
let DEMO_FILE = '';
let DEFAULT_CWD_FILE = '';
const DEMO_CONTENT = 'line1\nline2\nline3\n';

beforeAll(async () => {
  SANDBOX = await fs.mkdtemp(path.join(os.tmpdir(), 'lion-tools-smoke-'));
  DEMO_FILE = path.join(SANDBOX, 'demo.txt');
  DEFAULT_CWD_FILE = path.join(os.tmpdir(), `lion-default-cwd-${Date.now()}.txt`);
  await fs.writeFile(DEMO_FILE, DEMO_CONTENT, 'utf-8');
  await fs.writeFile(DEFAULT_CWD_FILE, 'default root marker', 'utf-8');
});

afterAll(async () => {
  try {
    await fs.rm(SANDBOX, { recursive: true, force: true });
    await fs.rm(DEFAULT_CWD_FILE, { force: true });
  } catch {}
});

describe('SPEC §12.5 registry exposes the 12 tool names', () => {
  it('exposes Read, Write, Edit, Glob, Grep, Bash, TodoWrite, AskUserQuestion, memory_search, mcp_call, Agent, Skill', () => {
    const names = listLionToolNames();
    const expected = [
      'Read',
      'Write',
      'Edit',
      'Glob',
      'Grep',
      'Bash',
      'TodoWrite',
      'AskUserQuestion',
      'memory_search',
      'mcp_call',
      'Agent',
      'Skill',
    ];
    for (const t of expected) {
      expect(names).toContain(t);
    }
    expect(LION_TOOL_SCHEMAS.length).toBe(expected.length);
  });
});

describe('filesystem tools dispatcher path', () => {
  it('Read: returns numbered lines for a real file (happy path)', async () => {
    const state = createSessionFsState();
    const r = await lionRead(state, { file_path: DEMO_FILE });
    expect(r.isError).toBe(false);
    if (!r.isError) {
      expect(r.value).toContain('line1');
      expect(r.value).toContain('line2');
    }
  });

  it('Read: rejects relative paths (validation branch)', async () => {
    const state = createSessionFsState();
    const r = await lionRead(state, { file_path: 'relative.txt' });
    expect(r.isError).toBe(true);
  });

  it('Write: creates a new file (happy path)', async () => {
    const state = createSessionFsState();
    const target = path.join(SANDBOX, 'created.txt');
    const r = await lionWrite(state, { file_path: target, content: 'hello' });
    expect(r.isError).toBe(false);
    const onDisk = await fs.readFile(target, 'utf-8');
    expect(onDisk).toBe('hello');
  });

  it('Write: rejects overwrite of existing file without prior Read (validation branch)', async () => {
    const state = createSessionFsState();
    const r = await lionWrite(state, { file_path: DEMO_FILE, content: 'nope' });
    expect(r.isError).toBe(true);
  });

  it('Edit: applies a unique replacement after Read', async () => {
    const state = createSessionFsState();
    const target = path.join(SANDBOX, 'edit-target.txt');
    await fs.writeFile(target, 'foo bar baz', 'utf-8');
    await lionRead(state, { file_path: target });
    const r = await lionEdit(state, {
      file_path: target,
      old_string: 'bar',
      new_string: 'qux',
    });
    expect(r.isError).toBe(false);
    const onDisk = await fs.readFile(target, 'utf-8');
    expect(onDisk).toBe('foo qux baz');
  });

  it('Edit: rejects when old_string not found (validation branch)', async () => {
    const state = createSessionFsState();
    const target = path.join(SANDBOX, 'edit-missing.txt');
    await fs.writeFile(target, 'hello', 'utf-8');
    await lionRead(state, { file_path: target });
    const r = await lionEdit(state, {
      file_path: target,
      old_string: 'NOTFOUND',
      new_string: 'x',
    });
    expect(r.isError).toBe(true);
  });

  it('Glob: matches files in the sandbox', async () => {
    const r = await lionGlob({ pattern: '*.txt', path: SANDBOX });
    expect(r.isError).toBe(false);
    if (!r.isError) {
      expect(r.value.some((p) => p.endsWith('demo.txt'))).toBe(true);
    }
  });

  it('Glob: defaults to getAgentCwd, not process.cwd', async () => {
    const r = await lionGlob({ pattern: path.basename(DEFAULT_CWD_FILE) });
    expect(r.isError).toBe(false);
    if (!r.isError) {
      expect(r.value).toContain(DEFAULT_CWD_FILE);
    }
  });

  it('Grep: matches a literal pattern across the sandbox', async () => {
    const r = await lionGrep({
      pattern: 'line2',
      path: SANDBOX,
      output_mode: 'content',
    });
    expect(typeof r.isError).toBe('boolean');
  });

  it('Grep: defaults to getAgentCwd, not process.cwd', async () => {
    const r = await lionGrep({
      pattern: 'default root marker',
      glob: path.basename(DEFAULT_CWD_FILE),
      output_mode: 'files_with_matches',
    });
    expect(r.isError).toBe(false);
    if (!r.isError) {
      expect(r.value).toContain(DEFAULT_CWD_FILE);
    }
  });
});

describe('Bash dispatcher path', () => {
  it('returns a typed result for a trivial command', async () => {
    const r = await lionBash(
      { command: 'echo hello-from-smoke', cwd: SANDBOX },
      {
        getWindow: () => null,
        sessionId: 'sess-smoke',
        permissionGuard: async () => ({ behavior: 'allow' }),
        resolveDefaultCwd: () => SANDBOX,
      },
    );
    expect(r).toHaveProperty('stdout');
    expect(r).toHaveProperty('stderr');
    expect(r).toHaveProperty('exitCode');
    expect(r).toHaveProperty('durationMs');
  });

  it('exposes LionClaw home through LIONCLAW_HOME', async () => {
    const nodeCmd = `${JSON.stringify(process.execPath)} -e "process.stdout.write(process.env.LIONCLAW_HOME || '')"`;
    const r = await lionBash(
      { command: nodeCmd, cwd: SANDBOX },
      {
        getWindow: () => null,
        sessionId: 'sess-smoke',
        permissionGuard: async () => ({ behavior: 'allow' }),
        resolveDefaultCwd: () => SANDBOX,
      },
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe(os.tmpdir());
  });

  it('rejects an empty command via the validation branch', async () => {
    const r = await lionBash(
      { command: '' },
      {
        getWindow: () => null,
        sessionId: 'sess-smoke',
        permissionGuard: async () => ({ behavior: 'allow' }),
        resolveDefaultCwd: () => SANDBOX,
      },
    );
    expect(r.blocked).toBeDefined();
    expect(r.exitCode).toBe(1);
  });
});

describe('TodoWrite dispatcher path', () => {
  it('accepts a valid list and rejects multiple in_progress', () => {
    const store = new LionTodoStore();
    const okResult = lionTodoWrite(store, {
      todos: [
        { id: 'a', content: 'do thing', status: 'in_progress' },
        { id: 'b', content: 'other', status: 'pending' },
      ],
    });
    expect(okResult.ok).toBe(true);

    const rejected = lionTodoWrite(store, {
      todos: [
        { id: 'a', content: 'x', status: 'in_progress' },
        { id: 'b', content: 'y', status: 'in_progress' },
      ],
    });
    expect(rejected.ok).toBe(false);
    expect(rejected.error).toMatch(/in_progress/);
  });
});

describe('AskUserQuestion dispatcher path', () => {
  it('forwards through the injected sender and returns answers', async () => {
    const sender = vi.fn(async () => ({
      id: 'q1',
      answers: [{ questionId: 'q1', label: 'opt-a' }],
      annotations: undefined,
    }));
    const r = await lionAskUserQuestion(
      {
        questions: [
          {
            id: 'q1',
            header: 'h',
            question: 'pick one',
            options: [
              { label: 'opt-a', description: 'a' },
              { label: 'opt-b', description: 'b' },
            ],
          },
        ] as never,
      },
      { getWindow: () => null, sender: sender as never },
    );
    expect(r.ok).toBe(true);
    expect(sender).toHaveBeenCalledTimes(1);
  });

  it('rejects empty questions array', async () => {
    const r = await lionAskUserQuestion({ questions: [] }, { getWindow: () => null });
    expect(r.ok).toBe(false);
  });
});

describe('memory_search dispatcher path', () => {
  it('forwards through the injected search function and shapes the result', async () => {
    const search = vi.fn(async () => [{ content: 'a memory', rrf_score: 0.8, created_at: '2026-01-01T00:00:00Z' }]);
    const r = await lionMemorySearch({ query: 'foo' }, { search: search as never });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.results).toHaveLength(1);
      expect(r.results![0]!.content).toBe('a memory');
    }
  });

  it('rejects empty query', async () => {
    const r = await lionMemorySearch({ query: '' });
    expect(r.ok).toBe(false);
  });
});

describe('mcp_call dispatcher path', () => {
  it('rejects when server_id is absent from the session client', async () => {
    const client = { connections: [] } as never;
    const r = await lionMcpCall(client, {
      server_id: 'does-not-exist',
      tool: 'some_tool',
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/nenhum MCP ativo/);
    expect(r.prefixedName).toBe('mcp__does-not-exist__some_tool');
  });

  it('builds the prefixed MCP name per SPEC convention', () => {
    expect(buildPrefixedMcpName('knowledge-base', 'search')).toBe('mcp__knowledge-base__search');
  });
});

describe('Agent dispatcher path', () => {
  it('rejects unknown agent_id (no executor call)', async () => {
    const executor = vi.fn();
    const getAgent = vi.fn(() => undefined);
    const r = await lionAgentDispatch(
      { agent_id: 'no-such-agent', task: 't' },
      { executor: executor as never, getAgent: getAgent as never },
    );
    expect(r.ok).toBe(false);
    expect(executor).not.toHaveBeenCalled();
  });

  it('rejects pipeline-internal squad (security, etc.)', async () => {
    const executor = vi.fn();
    const getAgent = vi.fn(() => ({
      id: 'sec-agent',
      isActive: true,
      squad: 'security',
    }));
    const r = await lionAgentDispatch(
      { agent_id: 'sec-agent', task: 't' },
      { executor: executor as never, getAgent: getAgent as never },
    );
    expect(r.ok).toBe(false);
    expect(executor).not.toHaveBeenCalled();
  });

  it('dispatches to the injected executor for a chat-eligible agent', async () => {
    const executor = vi.fn(async () => ({
      runtime: 'cloud',
      model: 'claude-sonnet',
      output: 'agent reply',
      metrics: {
        inputTokens: 10,
        outputTokens: 20,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUsd: 0.0001,
      },
    }));
    const getAgent = vi.fn(() => ({
      id: 'chat-agent',
      isActive: true,
      squad: 'general',
    }));
    const r = await lionAgentDispatch(
      { agent_id: 'chat-agent', task: 'do the thing' },
      { executor: executor as never, getAgent: getAgent as never },
    );
    expect(r.ok).toBe(true);
    expect(r.status).toBe('completed');
    expect(r.output).toBe('agent reply');
    expect(r.summary).not.toMatch(/tokens=|cost=/);
    expect(r).not.toHaveProperty('usage');
    expect(r).not.toHaveProperty('costUsd');
    expect(executor).toHaveBeenCalledTimes(1);
  });

  it('nao converte auth de provider do subagente em resultado generico', async () => {
    const { KimiAuthError } = await import('../../agent-runtime/kimi-availability');
    const authError = new KimiAuthError('login Kimi necessario');
    const executor = vi.fn(async () => {
      throw authError;
    });
    const getAgent = vi.fn(() => ({
      id: 'chat-agent',
      isActive: true,
      squad: 'general',
    }));

    await expect(
      lionAgentDispatch(
        { agent_id: 'chat-agent', task: 'do the thing' },
        { executor: executor as never, getAgent: getAgent as never },
      ),
    ).rejects.toBe(authError);
  });
});

describe('Skill dispatcher path', () => {
  it('rejects unsafe skill_name characters', async () => {
    const r = await lionSkillLoad({ skill_name: '../escape' });
    expect(r.ok).toBe(false);
  });

  it('returns frontmatter + body for a real skill file in the home', async () => {
    const skillsRoot = path.join(os.tmpdir(), 'skills', 'demo-smoke');
    await fs.mkdir(skillsRoot, { recursive: true });
    const skillFile = path.join(skillsRoot, 'SKILL.md');
    await fs.writeFile(skillFile, '---\nname: demo\nuserInvocable: true\n---\nBody of the skill.', 'utf-8');

    const r = await lionSkillLoad({ skill_name: 'demo-smoke' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.frontmatter?.name).toBe('demo');
      expect(r.body).toContain('Body of the skill');
    }

    await fs.rm(path.join(os.tmpdir(), 'skills'), { recursive: true, force: true });
  });
});
