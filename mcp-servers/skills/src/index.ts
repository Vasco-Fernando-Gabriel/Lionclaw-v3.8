import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ---- Configuração de diretório ----

const LIONCLAW_HOME = process.env.LIONCLAW_HOME ?? path.join(os.homedir(), '.lionclaw');
const SKILLS_DIR = path.join(LIONCLAW_HOME, 'skills');

// ---- Tipos ----

interface SkillFrontmatter {
  name: string;
  description: string;
  category: string;
  allowedTools: string[];
  model: string;
  disableModelInvocation: boolean;
  userInvocable: boolean;
  context: string;
  agent: string;
}

interface SkillData extends SkillFrontmatter {
  content: string;
  rawContent: string;
  hasAuxFiles: boolean;
}

// ---- Parser de frontmatter ----

function parseFrontmatter(raw: string): { frontmatter: SkillFrontmatter; content: string } {
  const lines = raw.replace(/\r\n/g, '\n').split('\n');

  // Verifica se começa com ---
  if (lines[0].trim() !== '---') {
    return {
      frontmatter: {
        name: '',
        description: '',
        category: '',
        allowedTools: [],
        model: '',
        disableModelInvocation: false,
        userInvocable: false,
        context: '',
        agent: '',
      },
      content: raw,
    };
  }

  // Encontra o segundo ---
  let endIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      endIdx = i;
      break;
    }
  }

  if (endIdx === -1) {
    return {
      frontmatter: {
        name: '',
        description: '',
        category: '',
        allowedTools: [],
        model: '',
        disableModelInvocation: false,
        userInvocable: false,
        context: '',
        agent: '',
      },
      content: raw,
    };
  }

  const frontmatterLines = lines.slice(1, endIdx);
  const content = lines.slice(endIdx + 1).join('\n').trim();

  const fm: Record<string, string> = {};
  for (const line of frontmatterLines) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    fm[key] = value;
  }

  // Parse allowed-tools: pode ser formato inline [Bash, Read, Write] ou string simples
  let allowedTools: string[] = [];
  if (fm['allowed-tools']) {
    const raw = fm['allowed-tools'].trim();
    if (raw.startsWith('[') && raw.endsWith(']')) {
      // Formato inline YAML: [Bash, Read, Write]
      const inner = raw.slice(1, -1);
      allowedTools = inner.split(',').map((s) => s.trim()).filter(Boolean);
    } else if (raw) {
      allowedTools = raw.split(',').map((s) => s.trim()).filter(Boolean);
    }
  }

  // Parse booleanos
  const parseBoolean = (val: string | undefined): boolean => {
    if (!val) return false;
    return val.trim().toLowerCase() === 'true';
  };

  return {
    frontmatter: {
      name: fm['name'] ?? '',
      description: fm['description'] ?? '',
      category: fm['category'] ?? '',
      allowedTools,
      model: fm['model'] ?? '',
      disableModelInvocation: parseBoolean(fm['disable-model-invocation']),
      userInvocable: parseBoolean(fm['user-invocable']),
      context: fm['context'] ?? '',
      agent: fm['agent'] ?? '',
    },
    content,
  };
}

// ---- Carregamento de skills ----

function loadSkill(name: string): SkillData | null {
  const skillDir = path.join(SKILLS_DIR, name);
  const skillFile = path.join(skillDir, 'SKILL.md');

  if (!fs.existsSync(skillFile)) {
    return null;
  }

  try {
    const rawContent = fs.readFileSync(skillFile, 'utf-8');
    const { frontmatter, content } = parseFrontmatter(rawContent);

    // Detecta arquivos auxiliares (além de SKILL.md)
    let hasAuxFiles = false;
    try {
      const entries = fs.readdirSync(skillDir);
      hasAuxFiles = entries.some((e) => e !== 'SKILL.md');
    } catch {
      hasAuxFiles = false;
    }

    return {
      ...frontmatter,
      // Usa o nome da pasta se frontmatter não tiver nome
      name: frontmatter.name || name,
      content,
      rawContent,
      hasAuxFiles,
    };
  } catch {
    return null;
  }
}

function loadAllSkills(): SkillData[] {
  if (!fs.existsSync(SKILLS_DIR)) {
    return [];
  }

  let entries: string[];
  try {
    entries = fs.readdirSync(SKILLS_DIR);
  } catch {
    return [];
  }

  const skills: SkillData[] = [];
  for (const entry of entries) {
    const skillDir = path.join(SKILLS_DIR, entry);
    try {
      const stat = fs.statSync(skillDir);
      if (!stat.isDirectory()) continue;
    } catch {
      continue;
    }

    const skill = loadSkill(entry);
    if (skill) {
      skills.push(skill);
    }
  }

  return skills;
}

// ---- MCP Server ----

const server = new McpServer({
  name: 'skills',
  version: '1.0.0',
});

server.tool(
  'list_skills',
  'Lista o catálogo de skills disponíveis com metadados leves. Suporta filtro opcional por categoria.',
  {
    category: z.string().optional().describe('Filtrar por categoria (opcional)'),
  },
  async ({ category }) => {
    try {
      const allSkills = loadAllSkills();

      // Filtra skills com disableModelInvocation: true
      let filtered = allSkills.filter((s) => !s.disableModelInvocation);

      // Aplica filtro por categoria se fornecido
      if (category) {
        filtered = filtered.filter((s) => s.category === category);
      }

      const skills = filtered.map((s) => ({
        name: s.name,
        description: s.description,
        category: s.category,
        tools: s.allowedTools,
      }));

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ skills, total: skills.length }),
          },
        ],
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`[skills] list_skills error: ${msg}`);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: msg }) }],
        isError: true,
      };
    }
  },
);

server.tool(
  'load_skill',
  'Carrega o conteúdo completo de uma skill pelo nome, incluindo corpo do SKILL.md.',
  {
    name: z.string().describe('Nome da skill a carregar'),
  },
  async ({ name }) => {
    try {
      const skill = loadSkill(name);

      if (!skill) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ isError: true, error: `Skill ${name} nao encontrada` }),
            },
          ],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              name: skill.name,
              description: skill.description,
              allowedTools: skill.allowedTools,
              context: skill.context,
              agent: skill.agent,
              content: skill.content,
            }),
          },
        ],
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`[skills] load_skill error: ${msg}`);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: msg }) }],
        isError: true,
      };
    }
  },
);

server.tool(
  'get_skill_metadata',
  'Retorna metadados de uma skill sem o conteúdo completo. Inclui contentSize para decisão rápida.',
  {
    name: z.string().describe('Nome da skill'),
  },
  async ({ name }) => {
    try {
      const skill = loadSkill(name);

      if (!skill) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ isError: true, error: `Skill ${name} nao encontrada` }),
            },
          ],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              name: skill.name,
              description: skill.description,
              category: skill.category,
              allowedTools: skill.allowedTools,
              model: skill.model,
              userInvocable: skill.userInvocable,
              context: skill.context,
              agent: skill.agent,
              contentSize: Buffer.byteLength(skill.rawContent, 'utf-8'),
              hasAuxFiles: skill.hasAuxFiles,
            }),
          },
        ],
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`[skills] get_skill_metadata error: ${msg}`);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: msg }) }],
        isError: true,
      };
    }
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[skills] MCP server running on stdio');
}

main().catch((error) => {
  console.error('[skills] Fatal error:', error);
  process.exit(1);
});
