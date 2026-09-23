import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { createLogger } from './logger.js';

const logger = createLogger('local-agent-tools');

const PRIMITIVE_TOOLS = ['WebSearch', 'WebFetch', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash'] as const;

type PrimitiveTool = (typeof PRIMITIVE_TOOLS)[number];

const BLOCKED_TOOLS = ['Agent', 'Task', 'TeamCreate', 'TodoWrite', 'AskUserQuestion', 'NotebookEdit'];

interface OllamaToolSchema {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, unknown>;
      required?: string[];
    };
  };
}

export function isPrimitiveToolAllowed(toolName: string): boolean {
  return (PRIMITIVE_TOOLS as readonly string[]).includes(toolName);
}

export function isToolBlockedForLocal(toolName: string): boolean {
  return BLOCKED_TOOLS.includes(toolName);
}

export function loadLocalTools(allowedTools: string[]): OllamaToolSchema[] {
  const schemas: OllamaToolSchema[] = [];

  for (const tool of allowedTools) {
    if (!isPrimitiveToolAllowed(tool)) continue;
    const schema = TOOL_SCHEMAS[tool as PrimitiveTool];
    if (schema) schemas.push(schema);
  }

  return schemas;
}

export async function executeLocalTool(toolName: string, args: Record<string, unknown>): Promise<string> {
  if (!isPrimitiveToolAllowed(toolName)) {
    return `Error: Tool "${toolName}" nao esta disponivel para agentes locais.`;
  }

  const impl = TOOL_IMPLEMENTATIONS[toolName as PrimitiveTool];
  if (!impl) return `Error: Tool "${toolName}" nao implementada.`;

  try {
    return await impl(args);
  } catch (err) {
    logger.error({ tool: toolName, err }, 'Local tool execution failed');
    return `Error executando ${toolName}: ${err instanceof Error ? err.message : String(err)}`;
  }
}

const TOOL_SCHEMAS: Record<PrimitiveTool, OllamaToolSchema> = {
  WebSearch: {
    type: 'function',
    function: {
      name: 'WebSearch',
      description: 'Busca na internet e retorna resultados. Use para informacoes atualizadas.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Query de busca' },
        },
        required: ['query'],
      },
    },
  },
  WebFetch: {
    type: 'function',
    function: {
      name: 'WebFetch',
      description: 'Acessa uma URL e retorna o conteudo da pagina.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL para acessar' },
        },
        required: ['url'],
      },
    },
  },
  Read: {
    type: 'function',
    function: {
      name: 'Read',
      description: 'Le o conteudo de um arquivo do filesystem.',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Caminho absoluto do arquivo' },
          offset: { type: 'number', description: 'Linha inicial (opcional)' },
          limit: { type: 'number', description: 'Numero de linhas (opcional)' },
        },
        required: ['file_path'],
      },
    },
  },
  Write: {
    type: 'function',
    function: {
      name: 'Write',
      description: 'Cria ou sobrescreve um arquivo com o conteudo fornecido.',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Caminho absoluto do arquivo' },
          content: { type: 'string', description: 'Conteudo a escrever' },
        },
        required: ['file_path', 'content'],
      },
    },
  },
  Edit: {
    type: 'function',
    function: {
      name: 'Edit',
      description: 'Substitui texto em um arquivo existente.',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Caminho absoluto do arquivo' },
          old_string: { type: 'string', description: 'Texto a ser substituido' },
          new_string: { type: 'string', description: 'Texto substituto' },
        },
        required: ['file_path', 'old_string', 'new_string'],
      },
    },
  },
  Glob: {
    type: 'function',
    function: {
      name: 'Glob',
      description: 'Busca arquivos por pattern (ex: "**/*.ts").',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Glob pattern' },
          path: { type: 'string', description: 'Diretorio base (opcional)' },
        },
        required: ['pattern'],
      },
    },
  },
  Grep: {
    type: 'function',
    function: {
      name: 'Grep',
      description: 'Busca conteudo dentro de arquivos usando regex.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Regex pattern' },
          path: { type: 'string', description: 'Diretorio ou arquivo (opcional)' },
          glob: { type: 'string', description: 'Filtro de arquivos (ex: "*.ts")' },
        },
        required: ['pattern'],
      },
    },
  },
  Bash: {
    type: 'function',
    function: {
      name: 'Bash',
      description: 'Executa um comando no terminal e retorna o output.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Comando a executar' },
          timeout: { type: 'number', description: 'Timeout em ms (default: 30000)' },
        },
        required: ['command'],
      },
    },
  },
};

const TOOL_IMPLEMENTATIONS: Record<PrimitiveTool, (args: Record<string, unknown>) => Promise<string>> = {
  async Read(args) {
    const filePath = args.file_path as string;
    if (!filePath) return 'Error: file_path obrigatorio';
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');
    const offset = (args.offset as number) || 0;
    const limit = (args.limit as number) || lines.length;
    return lines.slice(offset, offset + limit).join('\n');
  },

  async Write(args) {
    const filePath = args.file_path as string;
    const content = args.content as string;
    if (!filePath || content === undefined) return 'Error: file_path e content obrigatorios';
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf-8');
    return `Arquivo escrito: ${filePath}`;
  },

  async Edit(args) {
    const filePath = args.file_path as string;
    const oldStr = args.old_string as string;
    const newStr = args.new_string as string;
    if (!filePath || !oldStr) return 'Error: file_path e old_string obrigatorios';
    let content = fs.readFileSync(filePath, 'utf-8');
    if (!content.includes(oldStr)) return 'Error: old_string nao encontrado no arquivo';
    content = content.replace(oldStr, newStr);
    fs.writeFileSync(filePath, content, 'utf-8');
    return `Arquivo editado: ${filePath}`;
  },

  async Glob(args) {
    const pattern = args.pattern as string;
    const basePath = (args.path as string) || process.cwd();
    try {
      const result = execSync(
        `find "${basePath}" -name "${pattern.replace(/\*\*/g, '*')}" -type f 2>/dev/null | head -50`,
        { encoding: 'utf-8', timeout: 10000 },
      );
      return result || 'Nenhum arquivo encontrado.';
    } catch {
      return 'Erro ao buscar arquivos.';
    }
  },

  async Grep(args) {
    const pattern = args.pattern as string;
    const searchPath = (args.path as string) || process.cwd();
    const glob = args.glob as string | undefined;
    try {
      let cmd = `grep -rn "${pattern}" "${searchPath}"`;
      if (glob) cmd += ` --include="${glob}"`;
      cmd += ' 2>/dev/null | head -30';
      const result = execSync(cmd, { encoding: 'utf-8', timeout: 10000 });
      return result || 'Nenhum resultado encontrado.';
    } catch {
      return 'Nenhum resultado encontrado.';
    }
  },

  async Bash(args) {
    const command = args.command as string;
    if (!command) return 'Error: command obrigatorio';
    const timeout = (args.timeout as number) || 30000;

    const BLOCKED_TERMS = ['rm -rf', 'rm -r', 'sudo', 'mkfs', 'dd if=', ':(){', 'chmod -R 777', '> /dev/sd'];
    const blockedTerm = BLOCKED_TERMS.find((term) => command.includes(term));
    if (blockedTerm) {
      logger.warn({ command, blockedTerm }, 'Bash command blocked');
      return `BLOCKED: comando contem termo proibido '${blockedTerm}'. Este comando foi bloqueado por seguranca. Use alternativas seguras (ex: mover para lixeira em vez de rm, evite sudo).`;
    }

    try {
      return execSync(command, { encoding: 'utf-8', timeout, maxBuffer: 1024 * 1024 });
    } catch (err) {
      const error = err as { stderr?: string; message?: string };
      return `Error: ${error.stderr || error.message || 'comando falhou'}`;
    }
  },

  async WebSearch(args) {
    const query = args.query as string;
    if (!query) return 'Error: query obrigatorio';

    const braveApiKey = process.env.BRAVE_SEARCH_API_KEY;

    if (braveApiKey) {
      try {
        const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=5`;
        const res = await fetch(url, {
          headers: {
            'Accept': 'application/json',
            'Accept-Encoding': 'gzip',
            'X-Subscription-Token': braveApiKey,
          },
          signal: AbortSignal.timeout(10000),
        });
        if (res.ok) {
          const data = (await res.json()) as {
            web?: { results?: Array<{ title: string; url: string; description: string }> };
          };
          const results = data.web?.results;
          if (results && results.length > 0) {
            return results.map((r) => `${r.title}\n${r.url}\n${r.description}`).join('\n\n');
          }
          return 'Nenhum resultado encontrado.';
        }
        logger.warn({ status: res.status }, 'Brave Search API falhou, tentando DDG fallback');
      } catch (err) {
        logger.warn({ err }, 'Brave Search API erro, tentando DDG fallback');
      }
    }

    try {
      const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
      const res = await fetch(url, {
        headers: { 'User-Agent': 'LionClaw/1.0' },
        signal: AbortSignal.timeout(15000),
      });
      const html = await res.text();
      const results = html.match(/<a rel="nofollow" class="result__a" href="[^"]*">[^<]*/g);
      if (!results) return 'Nenhum resultado encontrado.';
      return results
        .slice(0, 5)
        .map((r) => {
          const hrefMatch = r.match(/href="([^"]*)"/);
          const textMatch = r.match(/>([^<]*)/);
          return `${textMatch?.[1] || ''}\n${hrefMatch?.[1] || ''}`;
        })
        .join('\n\n');
    } catch (err) {
      return `Error: WebSearch falhou - ${err instanceof Error ? err.message : String(err)}`;
    }
  },

  async WebFetch(args) {
    const url = args.url as string;
    if (!url) return 'Error: url obrigatorio';
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'LionClaw/1.0' },
        signal: AbortSignal.timeout(15000),
      });
      const text = await res.text();
      return text.substring(0, 8000);
    } catch (err) {
      return `Error: WebFetch falhou - ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};
