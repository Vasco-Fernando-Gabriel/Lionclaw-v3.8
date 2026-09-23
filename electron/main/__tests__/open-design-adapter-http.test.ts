import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('electron', () => ({
  app: {
    getAppPath: () => '/tmp/lionclaw-test-approot',
    getPath: (_name: string) => '/tmp/lionclaw-test-userdata',
  },
  BrowserWindow: class {
    static getAllWindows() {
      return [];
    }
  },
  ipcMain: { on: vi.fn(), handle: vi.fn() },
}));

import { createAdapter, isForbiddenPath, type Adapter } from '../open-design/adapter-http';
import type { OpenDesignSessionConfig } from '../../../src/types/open-design';

const BASE_URL = 'http://127.0.0.1:4321';

interface MockResponse {
  status: number;
  body: unknown;
  isText?: boolean;
}

let fetchCalls: Array<{ url: string; init: RequestInit | undefined }> = [];
let fetchResponses: MockResponse[] = [];

function makeResponse(mr: MockResponse): Response {
  const body = mr.isText ? String(mr.body) : JSON.stringify(mr.body);
  return new Response(body, {
    status: mr.status,
    statusText: mr.status === 200 ? 'OK' : 'ERR',
    headers: { 'content-type': mr.isText ? 'text/plain' : 'application/json' },
  });
}

beforeEach(() => {
  fetchCalls = [];
  fetchResponses = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      fetchCalls.push({ url: typeof url === 'string' ? url : url.toString(), init });
      if (fetchResponses.length === 0) {
        throw new Error(`fetch mock: nenhum response na fila (url=${url})`);
      }
      const mr = fetchResponses.shift()!;
      return makeResponse(mr);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function sessionConfig(): OpenDesignSessionConfig {
  return {
    agentId: 'claude',
    model: 'claude-opus-4-7',
    reasoning: 'high',
    designSystemId: 'lc-default',
    memoryEnabled: false,
    mcpServerIds: [],
    locale: 'pt-BR',
    configuredAt: '2026-05-11T00:00:00.000Z',
  };
}

describe('isForbiddenPath (SPEC L811-819)', () => {
  it('bloqueia POST /api/projects/:id/finalize/anthropic', () => {
    expect(isForbiddenPath('/api/projects/foo/finalize/anthropic')).toBe(true);
  });
  it('bloqueia qualquer /finalize/* path', () => {
    expect(isForbiddenPath('/api/projects/x/finalize/cli')).toBe(true);
    expect(isForbiddenPath('/api/foo/finalize/bar')).toBe(true);
  });
  it('bloqueia paths terminando em /DESIGN.md', () => {
    expect(isForbiddenPath('/api/projects/x/files/DESIGN.md')).toBe(true);
  });
  it('permite caminhos do contrato real', () => {
    expect(isForbiddenPath('/api/health')).toBe(false);
    expect(isForbiddenPath('/api/projects')).toBe(false);
    expect(isForbiddenPath('/api/projects/x/conversations')).toBe(false);
    expect(isForbiddenPath('/api/projects/x/files')).toBe(false);
    expect(isForbiddenPath('/api/projects/x/files/foo.html')).toBe(false);
    expect(isForbiddenPath('/api/runs')).toBe(false);
  });
});

describe('adapter callRaw allow-list (SPEC L1092)', () => {
  let adapter: Adapter;
  beforeEach(() => {
    adapter = createAdapter({ baseUrl: BASE_URL });
  });

  it('rejeita POST /api/projects/x/finalize/anthropic com mensagem "endpoint proibido em modo embedded"', async () => {
    await expect(adapter.callRaw('POST', '/api/projects/x/finalize/anthropic')).rejects.toThrow(
      /endpoint proibido em modo embedded/i,
    );
    expect(fetchCalls.length).toBe(0);
  });

  it('rejeita qualquer caminho contendo /finalize/', async () => {
    await expect(adapter.callRaw('POST', '/api/projects/x/finalize/cli')).rejects.toThrow(
      /endpoint proibido em modo embedded/i,
    );
  });

  it('rejeita caminho terminando em DESIGN.md', async () => {
    await expect(adapter.callRaw('GET', '/api/projects/x/files/DESIGN.md')).rejects.toThrow(
      /endpoint proibido em modo embedded/i,
    );
  });
});

describe('adapter.createProject (SPEC L1072)', () => {
  it('envia POST /api/projects com id explicito, fidelity high-fidelity, pendingPrompt:null', async () => {
    fetchResponses.push({
      status: 200,
      body: { project: { id: 'lionclaw-runabc' }, conversationId: 'conv_1' },
    });
    const adapter = createAdapter({ baseUrl: BASE_URL });
    const payload = {
      id: 'lionclaw-runabc',
      name: 'Demo project',
      skillId: null,
      designSystemId: 'lc-default',
      pendingPrompt: null as null,
      metadata: {
        kind: 'prototype' as const,
        fidelity: 'high-fidelity' as const,
        source: 'lionclaw-development-v2' as const,
        lionclawProjectId: 'p_abc',
        lionclawRunId: 'runabc',
        sessionConfigVersion: 1 as const,
      },
    };
    const res = await adapter.createProject(payload);

    expect(fetchCalls.length).toBe(1);
    const call = fetchCalls[0]!;
    expect(call.url).toBe(`${BASE_URL}/api/projects`);
    expect(call.init?.method).toBe('POST');
    const sentBody = JSON.parse(String(call.init?.body));
    expect(sentBody).toMatchObject({
      id: 'lionclaw-runabc',
      pendingPrompt: null,
      metadata: {
        kind: 'prototype',
        fidelity: 'high-fidelity',
        source: 'lionclaw-development-v2',
        sessionConfigVersion: 1,
      },
    });
    expect(res).toEqual({ projectId: 'lionclaw-runabc', conversationId: 'conv_1' });
  });
});

describe('adapter.startInitialRun (SPEC L1073)', () => {
  it('faz PUT user, PUT assistant placeholder, POST /api/runs e reforco pos-run', async () => {
    fetchResponses.push({ status: 200, body: { message: { id: 'u1' } } });
    fetchResponses.push({ status: 200, body: { message: { id: 'a1' } } });
    fetchResponses.push({ status: 200, body: { runId: 'run_xyz' } });
    fetchResponses.push({ status: 200, body: { message: { id: 'u1' } } });
    fetchResponses.push({ status: 200, body: { message: { id: 'a1' } } });

    const adapter = createAdapter({ baseUrl: BASE_URL });
    const res = await adapter.startInitialRun({
      projectId: 'lionclaw-runabc',
      conversationId: 'conv_1',
      prompt: 'Briefing prompt aqui',
      sessionConfig: sessionConfig(),
      userMessageId: 'u1',
      assistantMessageId: 'a1',
      clientRequestId: 'cr_1',
      skillId: null,
    });

    expect(res).toEqual({ runId: 'run_xyz' });
    expect(fetchCalls.length).toBe(5);

    expect(fetchCalls[0]!.init?.method).toBe('PUT');
    expect(fetchCalls[0]!.url).toBe(`${BASE_URL}/api/projects/lionclaw-runabc/conversations/conv_1/messages/u1`);
    const userBody = JSON.parse(String(fetchCalls[0]!.init?.body));
    expect(userBody).toMatchObject({ id: 'u1', role: 'user', content: 'Briefing prompt aqui' });

    expect(fetchCalls[1]!.init?.method).toBe('PUT');
    expect(fetchCalls[1]!.url).toBe(`${BASE_URL}/api/projects/lionclaw-runabc/conversations/conv_1/messages/a1`);
    const assistantBody = JSON.parse(String(fetchCalls[1]!.init?.body));
    expect(assistantBody).toMatchObject({
      id: 'a1',
      role: 'assistant',
      content: '',
      runStatus: 'running',
    });

    expect(fetchCalls[2]!.init?.method).toBe('POST');
    expect(fetchCalls[2]!.url).toBe(`${BASE_URL}/api/runs`);
    const runBody = JSON.parse(String(fetchCalls[2]!.init?.body));
    expect(runBody).toMatchObject({
      projectId: 'lionclaw-runabc',
      conversationId: 'conv_1',
      assistantMessageId: 'a1',
      clientRequestId: 'cr_1',
      agentId: 'claude',
      message: 'Briefing prompt aqui',
      currentPrompt: 'Briefing prompt aqui',
      model: 'claude-opus-4-7',
      reasoning: 'high',
      designSystemId: 'lc-default',
    });

    expect(fetchCalls[3]!.init?.method).toBe('PUT');
    expect(fetchCalls[3]!.url).toBe(`${BASE_URL}/api/projects/lionclaw-runabc/conversations/conv_1/messages/u1`);
    expect(JSON.parse(String(fetchCalls[3]!.init?.body))).toMatchObject({
      id: 'u1',
      role: 'user',
      content: 'Briefing prompt aqui',
    });

    expect(fetchCalls[4]!.init?.method).toBe('PUT');
    expect(fetchCalls[4]!.url).toBe(`${BASE_URL}/api/projects/lionclaw-runabc/conversations/conv_1/messages/a1`);
    expect(JSON.parse(String(fetchCalls[4]!.init?.body))).toMatchObject({
      id: 'a1',
      role: 'assistant',
      content: '',
      runId: 'run_xyz',
      runStatus: 'running',
    });
  });
});

describe('adapter app-config sync', () => {
  it('le e atualiza /api/app-config para alinhar runs internos do OD', async () => {
    fetchResponses.push({
      status: 200,
      body: { config: { agentId: 'claude', agentModels: { claude: { model: 'sonnet' } } } },
    });
    fetchResponses.push({
      status: 200,
      body: {
        config: {
          agentId: 'codex',
          agentModels: {
            claude: { model: 'sonnet' },
            codex: { model: 'default' },
          },
        },
      },
    });

    const adapter = createAdapter({ baseUrl: BASE_URL });
    const current = await adapter.getAppConfig();
    expect(current.config.agentId).toBe('claude');

    await adapter.updateAppConfig({
      agentId: 'codex',
      agentModels: {
        ...(current.config.agentModels ?? {}),
        codex: { model: 'default' },
      },
    });

    expect(fetchCalls[0]!.init?.method).toBe('GET');
    expect(fetchCalls[0]!.url).toBe(`${BASE_URL}/api/app-config`);
    expect(fetchCalls[1]!.init?.method).toBe('PUT');
    expect(fetchCalls[1]!.url).toBe(`${BASE_URL}/api/app-config`);
    expect(JSON.parse(String(fetchCalls[1]!.init?.body))).toEqual({
      agentId: 'codex',
      agentModels: {
        claude: { model: 'sonnet' },
        codex: { model: 'default' },
      },
    });
  });
});

describe('adapter.fetchFinalArtifact (SPEC L1074)', () => {
  it('escolhe HTML com metadata.entryFile=true preferencialmente', async () => {
    fetchResponses.push({
      status: 200,
      body: {
        files: [{ path: 'index.html', metadata: { entryFile: true } }, { path: 'other.html' }],
      },
    });
    fetchResponses.push({ status: 200, body: '<html>some content</html>', isText: true });

    const adapter = createAdapter({ baseUrl: BASE_URL });
    const res = await adapter.fetchFinalArtifact('lionclaw-runabc');
    expect(res.fileName).toBe('index.html');
    expect(res.html).toContain('some content');
    expect(res.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('fallback: HTML mais recente contendo "lionclaw-design-contract"', async () => {
    fetchResponses.push({
      status: 200,
      body: {
        files: [
          { path: 'old.html', updatedAt: '2026-01-01' },
          { path: 'new.html', updatedAt: '2026-05-01' },
        ],
      },
    });
    fetchResponses.push({
      status: 200,
      body: '<html><script id="lionclaw-design-contract">{}</script></html>',
      isText: true,
    });
    const adapter = createAdapter({ baseUrl: BASE_URL });
    const res = await adapter.fetchFinalArtifact('proj');
    expect(res.fileName).toBe('new.html');
    expect(res.html).toContain('lionclaw-design-contract');
  });

  it('lanca erro quando nenhum HTML candidato encontrado', async () => {
    fetchResponses.push({ status: 200, body: { files: [{ path: 'data.json' }] } });
    const adapter = createAdapter({ baseUrl: BASE_URL });
    await expect(adapter.fetchFinalArtifact('proj')).rejects.toThrow(/artifact HTML final/i);
  });
});

describe('adapter retry policy (SPEC L806)', () => {
  it('retry 1x em 5xx (sucesso na segunda tentativa)', async () => {
    fetchResponses.push({ status: 500, body: { error: 'boom' } });
    fetchResponses.push({ status: 200, body: { ok: true } });

    const adapter = createAdapter({ baseUrl: BASE_URL });
    const ok = await adapter.health();
    expect(ok).toBe(true);
    expect(fetchCalls.length).toBe(2);
  });

  it('NAO retenta em 4xx', async () => {
    fetchResponses.push({ status: 404, body: { error: 'not found' } });

    const adapter = createAdapter({ baseUrl: BASE_URL });
    await expect(adapter.createConversation('proj')).rejects.toThrow(/404/);
    expect(fetchCalls.length).toBe(1);
  });
});

describe('adapter timeout (SPEC L806)', () => {
  it('timeout default eh 10s — passa AbortSignal ao fetch', async () => {
    fetchResponses.push({ status: 200, body: { ok: true } });
    const adapter = createAdapter({ baseUrl: BASE_URL });
    await adapter.health();
    expect(fetchCalls[0]!.init?.signal).toBeDefined();
  });

  it('aborta quando excede o timeout configurado', async () => {
    vi.unstubAllGlobals();
    const slowFetch = vi.fn((_url: string | URL, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    });
    vi.stubGlobal('fetch', slowFetch);

    const adapter = createAdapter({ baseUrl: BASE_URL, timeoutMs: 50 });
    await expect(adapter.callRaw('GET', '/api/health')).rejects.toThrow(/timed out/);
  }, 5000);
});
