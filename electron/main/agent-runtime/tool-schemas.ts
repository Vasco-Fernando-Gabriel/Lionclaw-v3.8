
import type { OllamaToolSchema } from '../ollama-client';

const BUILTIN_SCHEMAS: Record<string, OllamaToolSchema> = {
  Read: {
    type: 'function',
    function: {
      name: 'Read',
      description: 'Read the contents of a file from the filesystem.',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Absolute path to the file.' },
          offset: { type: 'number', description: 'Line offset (0-based).' },
          limit: { type: 'number', description: 'Max lines to read.' },
        },
        required: ['file_path'],
      },
    },
  },
  Write: {
    type: 'function',
    function: {
      name: 'Write',
      description: 'Write content to a file, creating it if necessary.',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Absolute path to the file.' },
          content: { type: 'string', description: 'Content to write.' },
        },
        required: ['file_path', 'content'],
      },
    },
  },
  Edit: {
    type: 'function',
    function: {
      name: 'Edit',
      description: 'Replace a substring in a file with new content.',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Absolute path to the file.' },
          old_string: { type: 'string', description: 'Exact string to replace.' },
          new_string: { type: 'string', description: 'Replacement string.' },
        },
        required: ['file_path', 'old_string', 'new_string'],
      },
    },
  },
  Glob: {
    type: 'function',
    function: {
      name: 'Glob',
      description: 'Find files matching a glob pattern.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Glob pattern to match.' },
          path: { type: 'string', description: 'Base directory path.' },
        },
        required: ['pattern'],
      },
    },
  },
  Grep: {
    type: 'function',
    function: {
      name: 'Grep',
      description: 'Search for a regex pattern in files.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Regex pattern to search.' },
          path: { type: 'string', description: 'Directory or file to search.' },
          glob: { type: 'string', description: 'File glob filter.' },
        },
        required: ['pattern'],
      },
    },
  },
  Bash: {
    type: 'function',
    function: {
      name: 'Bash',
      description: 'Execute a shell command.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command to execute.' },
          timeout: { type: 'number', description: 'Timeout in milliseconds.' },
        },
        required: ['command'],
      },
    },
  },
};

export function builtinToolsToOllamaSchemas(toolNames: string[]): OllamaToolSchema[] {
  return toolNames
    .filter((n) => !n.startsWith('mcp__'))
    .map((n) => BUILTIN_SCHEMAS[n])
    .filter((s): s is OllamaToolSchema => s !== undefined);
}

export function activeToolSchemasJson(toolNames: readonly string[]): string {
  if (!toolNames.length) return '';
  const entries: object[] = toolNames.map(
    (n) => BUILTIN_SCHEMAS[n] ?? { type: 'function', function: { name: n } },
  );
  return JSON.stringify(entries);
}


export interface McpRegistryToolRow {
  mcpId: string;
  toolName: string;
  description: string | null;
  inputSchema: string | null;
}

export const GATEWAY_META_TOOL_SCHEMAS: readonly object[] = [
  {
    type: 'function',
    function: {
      name: 'mcp__gateway__mcp_invoke',
      description:
        'Executa uma tool de um servidor MCP do LionClaw. O catalogo (servidores e tools disponiveis) esta no system prompt; em duvida sobre os args, consulte mcp_schema antes.',
      parameters: {
        type: 'object',
        properties: {
          server: {
            type: 'string',
            description: 'ID do servidor MCP (cabecalho do catalogo no system prompt).',
          },
          tool: {
            type: 'string',
            description: 'Nome exato da tool como listada no catalogo.',
          },
          args: {
            type: 'object',
            description: 'Argumentos da tool (objeto JSON conforme o schema da tool).',
          },
        },
        required: ['server', 'tool'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'mcp__gateway__mcp_schema',
      description:
        'Retorna o contrato completo (input schema) de uma tool do catalogo MCP do system prompt, antes de invoca-la com mcp_invoke.',
      parameters: {
        type: 'object',
        properties: {
          server: {
            type: 'string',
            description: 'ID do servidor MCP (cabecalho do catalogo no system prompt).',
          },
          tool: {
            type: 'string',
            description: 'Nome exato da tool como listada no catalogo.',
          },
        },
        required: ['server', 'tool'],
      },
    },
  },
];

export function serializeMcpSchemasForContext(
  rows: readonly McpRegistryToolRow[],
  opts?: { includeGatewayMeta?: boolean },
): string {
  const entries: object[] = opts?.includeGatewayMeta ? [...GATEWAY_META_TOOL_SCHEMAS] : [];
  for (const row of rows) {
    let parameters: unknown;
    if (row.inputSchema) {
      try {
        parameters = JSON.parse(row.inputSchema);
      } catch {
        parameters = undefined;
      }
    }
    entries.push({
      type: 'function',
      function: {
        name: `mcp__${row.mcpId}__${row.toolName}`,
        ...(row.description ? { description: row.description } : {}),
        ...(parameters !== undefined ? { parameters } : {}),
      },
    });
  }
  return entries.length ? JSON.stringify(entries) : '';
}
