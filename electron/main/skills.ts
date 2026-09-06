import fs from 'fs';
import path from 'path';
import { getLionClawHome } from './paths';
import { createLogger } from './logger';

const logger = createLogger('skills');


export interface SkillFrontmatter {
  name?: string;
  description?: string;
  category?: string;
  'allowed-tools'?: string;
  model?: string;
  'disable-model-invocation'?: boolean;
  'user-invocable'?: boolean;
  'argument-hint'?: string;
  context?: 'fork';
  agent?: string;
}

export interface SkillData {
  name: string;
  description: string;
  category?: string;
  allowedTools?: string[];
  model?: string;
  disableModelInvocation: boolean;
  userInvocable: boolean;
  argumentHint?: string;
  context?: 'fork';
  agent?: string;
  content: string;
  rawContent: string;
  path: string;
  hasAuxFiles: boolean;
}

export interface SkillCreateInput {
  name: string;
  description: string;
  category?: string;
  content: string;
  allowedTools?: string[];
  model?: string;
  disableModelInvocation?: boolean;
  userInvocable?: boolean;
  context?: 'fork';
  agent?: string;
}


function getSkillsDir(): string {
  return path.join(getLionClawHome(), 'skills');
}

export function parseSkillFrontmatter(content: string): SkillFrontmatter {
  const normalized = content.replace(/\r\n/g, '\n');
  const match = normalized.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};

  const frontmatter: Record<string, string | boolean> = {};
  const lines = match[1].split('\n');

  for (const line of lines) {
    const colonIndex = line.indexOf(':');
    if (colonIndex === -1) continue;

    const key = line.slice(0, colonIndex).trim();
    const value = line.slice(colonIndex + 1).trim();

    if (value === 'true') frontmatter[key] = true;
    else if (value === 'false') frontmatter[key] = false;
    else frontmatter[key] = value;
  }

  return frontmatter as SkillFrontmatter;
}

function extractBody(rawContent: string): string {
  const normalized = rawContent.replace(/\r\n/g, '\n');
  const bodyMatch = normalized.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
  return bodyMatch ? bodyMatch[1].trim() : rawContent;
}


export function listSkills(): SkillData[] {
  const dir = getSkillsDir();
  if (!fs.existsSync(dir)) return [];

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const skills: SkillData[] = [];
  const claimedBy = new Map<string, string>();

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skill = getSkill(entry.name);
    if (!skill) continue;
    const prevDir = claimedBy.get(skill.name);
    if (prevDir) {
      logger.warn(
        { skillName: skill.name, keptDir: prevDir, ignoredDir: entry.name },
        'Skill com nome duplicado: duas pastas declaram o mesmo `name` no frontmatter. Ignorando a segunda. Renomeie o campo `name` de uma delas para usar ambas.',
      );
      continue;
    }
    claimedBy.set(skill.name, entry.name);
    skills.push(skill);
  }

  return skills;
}

export function getSkill(name: string): SkillData | null {
  const skillDir = path.join(getSkillsDir(), name);
  const skillPath = path.join(skillDir, 'SKILL.md');

  if (!fs.existsSync(skillPath)) return null;

  const rawContent = fs.readFileSync(skillPath, 'utf-8');
  const frontmatter = parseSkillFrontmatter(rawContent);
  const content = extractBody(rawContent);

  const allFiles = fs.readdirSync(skillDir);
  const hasAuxFiles = allFiles.some(f => f !== 'SKILL.md');

  return {
    name: frontmatter.name || name,
    description: frontmatter.description || content.split('\n')[0] || name,
    category: frontmatter.category,
    allowedTools: frontmatter['allowed-tools']?.split(',').map(t => t.trim()),
    model: frontmatter.model,
    disableModelInvocation: frontmatter['disable-model-invocation'] === true,
    userInvocable: frontmatter['user-invocable'] !== false,
    argumentHint: frontmatter['argument-hint'],
    context: frontmatter.context,
    agent: frontmatter.agent,
    content,
    rawContent,
    path: skillDir,
    hasAuxFiles,
  };
}

export function createSkill(input: SkillCreateInput): SkillData {
  const safeName = input.name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 64);

  if (!safeName) {
    throw new Error('Nome da skill invalido');
  }

  const skillDir = path.join(getSkillsDir(), safeName);
  fs.mkdirSync(skillDir, { recursive: true });

  const rawContent = buildSkillContent(safeName, input);
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), rawContent, 'utf-8');

  logger.info({ name: safeName }, 'Skill created');
  return getSkill(safeName)!;
}

export function updateSkill(name: string, input: SkillCreateInput): SkillData {
  const skillDir = path.join(getSkillsDir(), name);
  const skillPath = path.join(skillDir, 'SKILL.md');

  if (!fs.existsSync(skillPath)) {
    throw new Error(`Skill '${name}' nao encontrada`);
  }

  const rawContent = buildSkillContent(name, input);
  fs.writeFileSync(skillPath, rawContent, 'utf-8');

  logger.info({ name }, 'Skill updated');
  return getSkill(name)!;
}

export function updateSkillRaw(name: string, rawContent: string): SkillData {
  const skillDir = path.join(getSkillsDir(), name);
  const skillPath = path.join(skillDir, 'SKILL.md');

  if (!fs.existsSync(skillPath)) {
    throw new Error(`Skill '${name}' nao encontrada`);
  }

  fs.writeFileSync(skillPath, rawContent, 'utf-8');

  logger.info({ name }, 'Skill raw content updated');
  return getSkill(name)!;
}

export function deleteSkill(name: string): void {
  const dir = path.join(getSkillsDir(), name);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true });
    logger.info({ name }, 'Skill deleted');
  }
}


function buildSkillContent(name: string, input: SkillCreateInput): string {
  const lines = ['---'];
  lines.push(`name: ${name}`);
  lines.push(`description: ${input.description}`);

  if (input.category) {
    lines.push(`category: ${input.category}`);
  }

  if (input.allowedTools?.length) {
    lines.push(`allowed-tools: ${input.allowedTools.join(', ')}`);
  }
  if (input.model) {
    lines.push(`model: ${input.model}`);
  }
  if (input.disableModelInvocation) {
    lines.push('disable-model-invocation: true');
  }
  if (input.userInvocable === false) {
    lines.push('user-invocable: false');
  }
  if (input.context) {
    lines.push(`context: ${input.context}`);
  }
  if (input.agent) {
    lines.push(`agent: ${input.agent}`);
  }

  lines.push('---');
  lines.push('');

  return lines.join('\n') + input.content;
}


export function buildSkillsPromptSection(): string {
  const skills = listSkills();
  if (skills.length === 0) return '';

  const parts = ['## Skills Disponiveis'];
  parts.push('Skills sao especialidades sob demanda. Quando a tarefa se encaixar, busque e use a tool `load_skill` do helper `lionclaw-skills` antes de agir.');
  parts.push('Nao use a tool nativa `Skill` do Claude Code para estas skills e nao leia o SKILL.md via Bash/Read como primeira opcao.');
  parts.push('Voce pode criar novas skills usando Write em .lionclaw/skills/{nome}/SKILL.md');
  parts.push('');

  for (const skill of skills) {
    if (skill.disableModelInvocation) continue;

    let line = `- **${skill.name}**: ${skill.description}`;
    if (skill.context === 'fork') {
      line += ` (executa em subagent: ${skill.agent || 'padrao'})`;
    }
    if (skill.allowedTools?.length) {
      line += ` [tools: ${skill.allowedTools.join(', ')}]`;
    }
    parts.push(line);
  }

  return parts.join('\n');
}

export function buildAgentSkillsPromptSection(skillNames: string[]): string {
  if (skillNames.length === 0) return '';

  const parts = ['## Skills Disponiveis'];
  parts.push('Quando a tarefa se encaixar com uma skill, use `lionclaw-skills.load_skill` para carregar o conteudo completo.');
  parts.push('Nao tente executar a skill sem carregar primeiro.');

  for (const name of skillNames) {
    const skill = getSkill(name);
    if (skill) {
      let line = `- **${skill.name}**: ${skill.description}`;
      if (skill.allowedTools?.length) {
        line += ` [tools: ${skill.allowedTools.join(', ')}]`;
      }
      parts.push(line);
    }
  }

  return parts.join('\n');
}
