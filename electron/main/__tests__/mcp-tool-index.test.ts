import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

interface StubServer {
  id: string;
  name: string;
  description?: string;
  isActive: boolean;
  indexMode?: 'tools' | 'server';
}

interface StubEntry {
  mcpId: string;
  toolName: string;
  description: string | null;
  inputSchema: string | null;
  lastDiscoveredAt: string | null;
}

const state = vi.hoisted(() => ({
  servers: [] as unknown[],
  entries: [] as unknown[],
}));

vi.mock('../mcp-manager', () => ({
  getAllMCPServers: () => state.servers,
  getMcpToolRegistryEntries: () => state.entries,
}));

import { buildMcpToolIndex } from '../mcp-tool-index';

function server(partial: Partial<StubServer> & { id: string }): StubServer {
  return { name: partial.id, isActive: true, ...partial };
}

function entry(mcpId: string, toolName: string, description: string | null = null): StubEntry {
  return { mcpId, toolName, description, inputSchema: null, lastDiscoveredAt: '2026-07-02T00:00:00Z' };
}

const OPTS = { invokeToolName: 'mcp_invoke', schemaToolName: 'mcp_schema' };
const MCP_TOKEN_RE = /mcp__\w+__\w+/g;

beforeEach(() => {
  state.servers = [];
  state.entries = [];
});

describe('buildMcpToolIndex: formato por server', () => {
  beforeEach(() => {
    state.servers = [
      server({ id: 'gmail', description: 'Envio e leitura de emails do Gmail' }),
      server({ id: 'google-drive', description: 'Arquivos e pastas do Google Drive' }),
    ];
    state.entries = [
      entry('gmail', 'send_email', 'Envia um email para um ou mais destinatarios'),
      entry('gmail', 'list_messages', 'Lista mensagens da caixa de entrada'),
      entry('google-drive', 'delete_file', 'Deleta um arquivo permanentemente do Drive'),
    ];
  });

  it('cabecalho de 1 linha por server + 1 linha por tool', () => {
    const out = buildMcpToolIndex(OPTS);
    expect(out).toContain('gmail: Envio e leitura de emails do Gmail');
    expect(out).toContain('- send_email: Envia um email para um ou mais destinatarios');
    expect(out).toContain('- list_messages: Lista mensagens da caixa de entrada');
    expect(out).toContain('google-drive: Arquivos e pastas do Google Drive');
    expect(out).toContain('- delete_file: Deleta um arquivo permanentemente do Drive');
  });

  it('instrucao final parametrizada com os nomes reais das meta-tools', () => {
    const out = buildMcpToolIndex(OPTS);
    expect(out).toContain('mcp_invoke(server, tool, args)');
    expect(out).toContain('mcp_schema(server, tool)');

    const outLion = buildMcpToolIndex({ invokeToolName: 'mcp_call', schemaToolName: 'mcp_schema' });
    expect(outLion).toContain('mcp_call(server, tool, args)');
  });

  it('description longa e truncada (~10 palavras/~80 chars) com reticencias', () => {
    state.entries = [
      entry(
        'gmail',
        'send_email',
        'Envia um email extremamente detalhado com anexos multiplos cabecalhos personalizados threads aninhadas rascunhos agendamento e ainda mais opcoes avancadas de entrega',
      ),
    ];
    const out = buildMcpToolIndex(OPTS);
    const line = out.split('\n').find((l) => l.startsWith('- send_email:'));
    expect(line).toBeDefined();
    expect(line as string).toContain('...');
    expect((line as string).length).toBeLessThanOrEqual(100);
  });

  it('tool sem description (transicao pos-V126) lista so o nome', () => {
    state.entries = [entry('gmail', 'send_email', 'Envia um email'), entry('gmail', 'tool_sem_descricao', null)];
    const out = buildMcpToolIndex(OPTS);
    expect(out).toContain('- tool_sem_descricao');
    expect(out).not.toContain('- tool_sem_descricao:');
  });
});

describe('buildMcpToolIndex: dial index_mode', () => {
  it("server com index_mode='server' rebaixa para SO o cabecalho com tools via {schema}", () => {
    state.servers = [
      server({ id: 'higgsfield', description: 'Geracao de video por IA', indexMode: 'server' }),
      server({ id: 'gmail', description: 'Emails', indexMode: 'tools' }),
    ];
    state.entries = [
      entry('higgsfield', 'generate_video', 'Gera um video'),
      entry('higgsfield', 'list_jobs', 'Lista jobs'),
      entry('gmail', 'send_email', 'Envia um email'),
    ];
    const out = buildMcpToolIndex(OPTS);
    expect(out).toContain('higgsfield: Geracao de video por IA (2 tools via mcp_schema)');
    expect(out).not.toContain('generate_video');
    expect(out).not.toContain('list_jobs');
    expect(out).toContain('- send_email: Envia um email');
  });
});

describe('buildMcpToolIndex: exclusoes (P4 + P5 + inativos)', () => {
  it('DIRECT_MCP_HELPERS nunca aparecem, mesmo ativos e com tools no registry', () => {
    state.servers = [
      server({ id: 'lionclaw-pipeline-control', description: 'Drive de pipelines' }),
      server({ id: 'repo-graph', description: 'Grafo do repo' }),
      server({ id: 'lionclaw-agents', description: 'Agentes' }),
      server({ id: 'gmail', description: 'Emails' }),
    ];
    state.entries = [
      entry('lionclaw-pipeline-control', 'pipeline_drive', 'Dirige pipelines'),
      entry('repo-graph', 'repo_graph_query', 'Consulta o grafo'),
      entry('gmail', 'send_email', 'Envia um email'),
    ];
    const out = buildMcpToolIndex(OPTS);
    expect(out).not.toContain('lionclaw-pipeline-control');
    expect(out).not.toContain('pipeline_drive');
    expect(out).not.toContain('repo-graph');
    expect(out).not.toContain('lionclaw-agents');
    expect(out).toContain('gmail: Emails');
  });

  it('excludeServerIds (P5) e servers inativos ficam fora', () => {
    state.servers = [
      server({ id: 'gmail', description: 'Emails' }),
      server({ id: 'shopify', description: 'Loja' }),
      server({ id: 'youtube', description: 'Videos', isActive: false }),
    ];
    state.entries = [
      entry('gmail', 'send_email', 'Envia um email'),
      entry('shopify', 'create_product', 'Cria um produto'),
      entry('youtube', 'search_videos', 'Busca videos'),
    ];
    const out = buildMcpToolIndex({ ...OPTS, excludeServerIds: ['shopify'] });
    expect(out).toContain('gmail');
    expect(out).not.toContain('shopify');
    expect(out).not.toContain('create_product');
    expect(out).not.toContain('youtube');
    expect(out).not.toContain('search_videos');
  });
});

describe('buildMcpToolIndex: REGRA DURA (sem tokens mcp__server__tool)', () => {
  beforeEach(() => {
    state.servers = [server({ id: 'gmail', description: 'Emails' })];
    state.entries = [
      entry('gmail', 'send_email', 'Envia um email'),
      entry('gmail', 'forward', 'Encaminha como mcp__google-drive__share_file faria no Drive'),
    ];
  });

  it('com invoke flat: saida sem NENHUM token mcp__', () => {
    const out = buildMcpToolIndex(OPTS);
    expect(out.match(MCP_TOKEN_RE)).toBeNull();
  });

  it('com invoke mcp__gateway__mcp_invoke: todo token da saida esta na whitelist', () => {
    const out = buildMcpToolIndex({
      invokeToolName: 'mcp__gateway__mcp_invoke',
      schemaToolName: 'mcp__gateway__mcp_schema',
    });
    const tokens = out.match(MCP_TOKEN_RE) ?? [];
    expect(tokens.length).toBeGreaterThan(0);
    const whitelist = new Set(['mcp__gateway__mcp_invoke', 'mcp__gateway__mcp_schema']);
    for (const token of tokens) {
      expect(whitelist.has(token)).toBe(true);
    }
  });

  it('description contaminada e sanitizada para "server: tool"', () => {
    const out = buildMcpToolIndex(OPTS);
    expect(out).toContain('google-drive: share_file');
    expect(out).not.toContain('mcp__google-drive__share_file');
  });
});

describe('buildMcpToolIndex: registry vazio / em transicao', () => {
  it('registry vazio -> bloco "catalogo em descoberta", nunca string vazia', () => {
    state.servers = [server({ id: 'gmail', description: 'Emails' })];
    state.entries = [];
    const out = buildMcpToolIndex(OPTS);
    expect(out.length).toBeGreaterThan(0);
    expect(out).toContain('Catalogo MCP em descoberta');
    expect(out).toContain('mcp_schema');
  });

  it('entradas sem NENHUMA description (pos-V126, pre re-discovery) -> mesmo bloco', () => {
    state.servers = [server({ id: 'gmail', description: 'Emails' })];
    state.entries = [entry('gmail', 'send_email', null), entry('gmail', 'forward', null)];
    const out = buildMcpToolIndex(OPTS);
    expect(out).toContain('Catalogo MCP em descoberta');
  });

  it('nenhum server ativo elegivel -> mesmo bloco (nunca silencio)', () => {
    state.servers = [server({ id: 'lionclaw-pipeline-control', description: 'Drive' })];
    state.entries = [entry('lionclaw-pipeline-control', 'pipeline_drive', 'Dirige')];
    const out = buildMcpToolIndex(OPTS);
    expect(out).toContain('Catalogo MCP em descoberta');
  });
});
