
export interface LionToolSchema {
  name: string;
  aliases?: string[];
  description?: string;
  input_schema: {
    type: 'object';
    required?: string[];
    properties: Record<string, unknown>;
  };
}

export const LION_TOOL_SCHEMAS: LionToolSchema[] = [
  {
    name: 'Read',
    description: 'Read a file from disk with optional offset/limit windowing. Returns numbered UTF-8 lines.',
    input_schema: {
      type: 'object',
      required: ['file_path'],
      properties: {
        file_path: { type: 'string' },
        offset: { type: 'number' },
        limit: { type: 'number' },
      },
    },
  },
  {
    name: 'Write',
    description: 'Write UTF-8 content to a file. For existing files, the file must have been Read in this session.',
    input_schema: {
      type: 'object',
      required: ['file_path', 'content'],
      properties: {
        file_path: { type: 'string' },
        content: { type: 'string' },
      },
    },
  },
  {
    name: 'Edit',
    description: 'Apply a unique string replacement to a file. The file must have been Read in this session.',
    input_schema: {
      type: 'object',
      required: ['file_path', 'old_string', 'new_string'],
      properties: {
        file_path: { type: 'string' },
        old_string: { type: 'string' },
        new_string: { type: 'string' },
        replace_all: { type: 'boolean' },
      },
    },
  },
  {
    name: 'Glob',
    description: 'Find files matching a glob pattern, sorted by mtime desc.',
    input_schema: {
      type: 'object',
      required: ['pattern'],
      properties: {
        pattern: { type: 'string' },
        path: { type: 'string' },
      },
    },
  },
  {
    name: 'Grep',
    description: 'Search file contents with ripgrep. Bounded output.',
    input_schema: {
      type: 'object',
      required: ['pattern'],
      properties: {
        pattern: { type: 'string' },
        path: { type: 'string' },
        glob: { type: 'string' },
        output_mode: { type: 'string', enum: ['content', 'files_with_matches', 'count'] },
        multiline: { type: 'boolean' },
      },
    },
  },
  {
    name: 'Bash',
    description: 'Run a shell command. Default cwd from getAgentCwd, default 120s timeout, permission-guarded.',
    input_schema: {
      type: 'object',
      required: ['command'],
      properties: {
        command: { type: 'string' },
        cwd: { type: 'string' },
        timeout_ms: { type: 'number' },
      },
    },
  },
  {
    name: 'TodoWrite',
    description: 'Record an ordered list of todos for the current turn.',
    input_schema: {
      type: 'object',
      required: ['todos'],
      properties: {
        todos: {
          type: 'array',
          items: {
            type: 'object',
            required: ['id', 'content', 'status'],
            properties: {
              id: { type: 'string' },
              content: { type: 'string' },
              status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
            },
          },
        },
      },
    },
  },
  {
    name: 'AskUserQuestion',
    description: 'Ask the user a structured question. Bridges to chat:ask-question IPC.',
    input_schema: {
      type: 'object',
      required: ['questions'],
      properties: {
        questions: {
          type: 'array',
          items: {
            type: 'object',
            required: ['id', 'header', 'question', 'options'],
            properties: {
              id: { type: 'string' },
              header: { type: 'string' },
              question: { type: 'string' },
              multiSelect: { type: 'boolean' },
              options: {
                type: 'array',
                items: {
                  type: 'object',
                  required: ['label', 'description'],
                  properties: {
                    label: { type: 'string' },
                    description: { type: 'string' },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
  {
    name: 'memory_search',
    description: 'Semantic + keyword search across prior LionClaw memories.',
    input_schema: {
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string' },
        limit: { type: 'number' },
      },
    },
  },
  {
    name: 'mcp_call',
    description: 'Invoke a LionClaw MCP tool. Requires server_id + tool + args.',
    input_schema: {
      type: 'object',
      required: ['server_id', 'tool', 'args'],
      properties: {
        server_id: { type: 'string' },
        tool: { type: 'string' },
        args: { type: 'object' },
      },
    },
  },
  {
    name: 'Agent',
    aliases: ['Task'],
    description: 'Dispatch a chat-eligible subagent for specialist or parallel work.',
    input_schema: {
      type: 'object',
      required: ['agent_id', 'task'],
      properties: {
        agent_id: { type: 'string' },
        task: { type: 'string' },
        context: { type: 'object' },
        expected_output: { type: 'string' },
        repoRoot: { type: 'string' },
        sessionId: { type: 'string' },
      },
    },
  },
  {
    name: 'Skill',
    description: 'Load a LionClaw skill (markdown body of .lionclaw/skills/{name}/SKILL.md).',
    input_schema: {
      type: 'object',
      required: ['skill_name'],
      properties: {
        skill_name: { type: 'string' },
      },
    },
  },
];


export const MCP_SCHEMA_TOOL_SCHEMA: LionToolSchema = {
  name: 'mcp_schema',
  description: 'Return the full input schema of one LionClaw MCP tool from the registry.',
  input_schema: {
    type: 'object',
    required: ['server', 'tool'],
    properties: {
      server: { type: 'string' },
      tool: { type: 'string' },
    },
  },
};

const TOOL_INDEX = new Map<string, LionToolSchema>();
for (const t of LION_TOOL_SCHEMAS) {
  TOOL_INDEX.set(t.name, t);
  for (const alias of t.aliases ?? []) {
    TOOL_INDEX.set(alias, t);
  }
}
TOOL_INDEX.set(MCP_SCHEMA_TOOL_SCHEMA.name, MCP_SCHEMA_TOOL_SCHEMA);

export function findLionToolSchema(name: string): LionToolSchema | undefined {
  return TOOL_INDEX.get(name);
}

export function listLionToolNames(): string[] {
  return LION_TOOL_SCHEMAS.map((t) => t.name);
}
