
import { describe, it, expect, vi, beforeEach } from 'vitest';

interface MockServer {
  id: string;
  name: string;
  description: string;
  isActive: boolean;
  indexMode: 'tools' | 'server';
  visibleTo?: string;
}

interface MockRegistryEntry {
  mcpId: string;
  toolName: string;
  description: string;
  inputSchema: string | null;
  lastDiscoveredAt: string | null;
}

const state = vi.hoisted(() => ({
  servers: [] as MockServer[],
  registry: [] as MockRegistryEntry[],
}));

vi.mock('../mcp-manager', () => ({
  getAllMCPServers: vi.fn(() => state.servers),
  getMcpToolRegistryEntries: vi.fn((mcpId?: string) =>
    mcpId ? state.registry.filter((e) => e.mcpId === mcpId) : state.registry,
  ),
}));

vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { buildMcpToolIndex } from '../mcp-tool-index';


function server(
  id: string,
  description: string,
  indexMode: 'tools' | 'server' = 'tools',
): MockServer {
  return { id, name: id, description, isActive: true, indexMode };
}

function entry(mcpId: string, toolName: string, description: string): MockRegistryEntry {
  return {
    mcpId,
    toolName,
    description,
    inputSchema: '{"type":"object"}',
    lastDiscoveredAt: '2026-07-01T00:00:00.000Z',
  };
}

const SERVERS: MockServer[] = [
  server('google-gmail', 'Le e envia emails da conta Gmail do usuario'),
  server('google-calendar', 'Gerencia eventos e agenda do Google Calendar'),
  server('google-drive', 'Lista, le e gerencia arquivos do Google Drive'),
  server('knowledge-base', 'Busca semantica na base de conhecimento local'),
  server('nano-banana', 'Geracao de imagens com modelos de IA'),
  server('shopify', 'Pedidos, produtos e clientes da loja Shopify'),
  server('higgsfield', 'Geracao de videos com IA (Higgsfield)', 'server'),
  server('memory-search', 'Busca hibrida na memoria de longo prazo do assistente'),
  server('graph-search', 'Knowledge graph de notas do vault com wiki-links'),
];

const REGISTRY: MockRegistryEntry[] = [
  entry('google-gmail', 'send_email', 'Envia um email para destinatarios com assunto e corpo'),
  entry('google-gmail', 'list_emails', 'Lista os emails recentes da caixa de entrada'),
  entry('google-gmail', 'read_email', 'Le o conteudo completo de um email especifico'),
  entry('google-calendar', 'create_event', 'Cria um evento na agenda com data, hora e convidados'),
  entry('google-calendar', 'list_events', 'Lista os eventos da agenda em um intervalo de datas'),
  entry('google-drive', 'list_files', 'Lista arquivos e pastas do Drive do usuario'),
  entry('google-drive', 'delete_file', 'Apaga permanentemente um arquivo do Drive'),
  entry('google-drive', 'upload_file', 'Envia um arquivo local para o Drive'),
  entry('knowledge-base', 'search_knowledge', 'Busca semantica por documentos na base de conhecimento'),
  entry('nano-banana', 'generate_image', 'Gera uma imagem a partir de um prompt de texto'),
  entry('shopify', 'get_orders', 'Lista os pedidos recentes da loja com status e total'),
  entry('shopify', 'create_product', 'Cria um produto novo na loja com preco e estoque'),
  entry('higgsfield', 'generate_video', 'Gera um video a partir de um prompt'),
  entry('higgsfield', 'list_video_jobs', 'Lista jobs de geracao de video'),
  entry('memory-search', 'memory_search', 'Busca hibrida em memorias de conversas passadas do usuario'),
  entry('graph-search', 'graph_search', 'Busca fuzzy em notas do vault (entidades, projetos, decisoes)'),
  entry('graph-search', 'graph_connections', 'Notas conectadas via wiki-links (incoming e outgoing)'),
];

const GOLDEN_SET: Array<{
  prompt: string;
  expectedServer: string;
  expectedTool: string;
  triggers: string[];
}> = [
  {
    prompt: 'mande um email para o Joao avisando do atraso',
    expectedServer: 'google-gmail',
    expectedTool: 'send_email',
    triggers: ['envia', 'email'],
  },
  {
    prompt: 'leia o ultimo email que chegou',
    expectedServer: 'google-gmail',
    expectedTool: 'read_email',
    triggers: ['le', 'email'],
  },
  {
    prompt: 'crie um evento amanha as 15h com a equipe',
    expectedServer: 'google-calendar',
    expectedTool: 'create_event',
    triggers: ['cria', 'evento'],
  },
  {
    prompt: 'quais compromissos tenho essa semana na agenda',
    expectedServer: 'google-calendar',
    expectedTool: 'list_events',
    triggers: ['eventos', 'agenda'],
  },
  {
    prompt: 'liste meus arquivos no drive',
    expectedServer: 'google-drive',
    expectedTool: 'list_files',
    triggers: ['lista', 'arquivos'],
  },
  {
    prompt: 'apague o relatorio antigo do drive',
    expectedServer: 'google-drive',
    expectedTool: 'delete_file',
    triggers: ['apaga', 'arquivo'],
  },
  {
    prompt: 'busque na base de conhecimento o contrato da ACME',
    expectedServer: 'knowledge-base',
    expectedTool: 'search_knowledge',
    triggers: ['busca', 'conhecimento'],
  },
  {
    prompt: 'gere uma imagem de um leao coroado',
    expectedServer: 'nano-banana',
    expectedTool: 'generate_image',
    triggers: ['gera', 'imagem'],
  },
  {
    prompt: 'quantos pedidos a loja teve hoje',
    expectedServer: 'shopify',
    expectedTool: 'get_orders',
    triggers: ['pedidos', 'loja'],
  },
  {
    prompt: 'adicione um produto novo na loja',
    expectedServer: 'shopify',
    expectedTool: 'create_product',
    triggers: ['produto', 'loja'],
  },
  {
    prompt: 'lembra o que a gente conversou sobre o contrato da ACME?',
    expectedServer: 'memory-search',
    expectedTool: 'memory_search',
    triggers: ['memorias', 'conversas'],
  },
  {
    prompt: 'quais notas do vault se conectam a nota do projeto X',
    expectedServer: 'graph-search',
    expectedTool: 'graph_connections',
    triggers: ['notas', 'wiki-links'],
  },
];

const INDEX_OPTS = { invokeToolName: 'mcp_invoke', schemaToolName: 'mcp_schema' };

function serverSection(index: string, serverId: string): string {
  const lines = index.split('\n');
  const start = lines.findIndex((l) => l.startsWith(`${serverId}: `));
  if (start === -1) return '';
  let end = start + 1;
  while (end < lines.length && lines[end].trim() !== '') end += 1;
  return lines.slice(start, end).join('\n');
}

function allToolLines(index: string): string[] {
  return index.split('\n').filter((l) => l.startsWith('- ') && l.includes(': '));
}

beforeEach(() => {
  vi.clearAllMocks();
  state.servers = SERVERS;
  state.registry = REGISTRY;
});

describe('AC-10 (estatico) — indice compacto carrega sinal de selecao por caso', () => {
  it('cada caso: a tool esperada tem linha propria na secao do server esperado, com os termos-chave', () => {
    const index = buildMcpToolIndex(INDEX_OPTS);
    for (const c of GOLDEN_SET) {
      const section = serverSection(index, c.expectedServer);
      expect(section, `secao do server ${c.expectedServer} (caso: "${c.prompt}")`).not.toBe('');
      const line = section
        .split('\n')
        .find((l) => l.startsWith(`- ${c.expectedTool}: `));
      expect(line, `linha da tool ${c.expectedTool} (caso: "${c.prompt}")`).toBeDefined();
      const haystack = line!.toLowerCase();
      for (const trigger of c.triggers) {
        expect(
          haystack,
          `termo-chave "${trigger}" na linha de ${c.expectedTool} (caso: "${c.prompt}")`,
        ).toContain(trigger.toLowerCase());
      }
    }
  });

  it('discriminacao: nenhuma OUTRA linha de tool carrega TODOS os termos-chave de um caso', () => {
    const index = buildMcpToolIndex(INDEX_OPTS);
    const toolLines = allToolLines(index);
    for (const c of GOLDEN_SET) {
      const matches = toolLines.filter((l) => {
        const hay = l.toLowerCase();
        return c.triggers.every((t) => hay.includes(t.toLowerCase()));
      });
      expect(
        matches,
        `caso "${c.prompt}": termos ${JSON.stringify(c.triggers)} devem apontar para 1 tool`,
      ).toHaveLength(1);
      expect(matches[0]).toContain(`- ${c.expectedTool}: `);
    }
  });

  it('baseline preservado: os termos-chave vem da MESMA description que o modo full carrega', () => {
    for (const c of GOLDEN_SET) {
      const source = REGISTRY.find(
        (e) => e.mcpId === c.expectedServer && e.toolName === c.expectedTool,
      );
      expect(source, `registro de ${c.expectedServer}/${c.expectedTool}`).toBeDefined();
      const full = `${source!.toolName}: ${source!.description}`.toLowerCase();
      for (const trigger of c.triggers) {
        expect(full).toContain(trigger.toLowerCase());
      }
    }
  });

  it("dial index_mode='server' (higgsfield): 1 linha discriminante + rota mcp_schema, sem linhas de tool", () => {
    const index = buildMcpToolIndex(INDEX_OPTS);
    const line = index
      .split('\n')
      .find((l) => l.startsWith('higgsfield: '));
    expect(line, 'linha unica do higgsfield').toBeDefined();
    expect(line!.toLowerCase()).toContain('video');
    expect(line!).toContain('2 tools via mcp_schema');
    expect(index).not.toContain('- generate_video');
    expect(index).not.toContain('- list_video_jobs');
  });

  it('sanidade do formato: instrucao de invocacao parametrizada presente (rota de execucao do caso)', () => {
    const index = buildMcpToolIndex(INDEX_OPTS);
    expect(index).toContain('Para executar uma tool: mcp_invoke(server, tool, args).');
    expect(index).toContain('mcp_schema(server, tool)');
  });
});


describe('AC-C10 — golden-set na superficie codex (chatSurface codex-sdk)', () => {
  it('indice codex carrega o MESMO sinal por caso (parity com o indice claude do set)', () => {
    const claudeIndex = buildMcpToolIndex(INDEX_OPTS);
    const codexIndex = buildMcpToolIndex({ ...INDEX_OPTS, chatSurface: 'codex-sdk' });
    expect(codexIndex).toBe(claudeIndex);
  });

  it('server invisivel ao codex sai do indice codex e permanece no claude (AC-C6)', () => {
    state.servers = [
      ...SERVERS,
      {
        id: 'claude-secret',
        name: 'claude-secret',
        description: 'Server invisivel ao codex',
        isActive: true,
        indexMode: 'tools',
        visibleTo: 'claude-only',
      },
    ];
    state.registry = [
      ...REGISTRY,
      entry('claude-secret', 'secret_tool', 'Tool que o codex nao pode ver'),
    ];
    const codexIndex = buildMcpToolIndex({ ...INDEX_OPTS, chatSurface: 'codex-sdk' });
    expect(codexIndex).not.toContain('claude-secret');
    expect(codexIndex).not.toContain('secret_tool');
    const claudeIndex = buildMcpToolIndex(INDEX_OPTS);
    expect(claudeIndex).toContain('claude-secret');
    expect(claudeIndex).toContain('- secret_tool');
  });
});
