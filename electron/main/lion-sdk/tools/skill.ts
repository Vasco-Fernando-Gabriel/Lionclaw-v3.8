
import fs from 'fs/promises';
import path from 'path';
import { getLionClawHome } from '../../paths';

export interface SkillInput {
  skill_name: string;
}

export interface SkillFrontmatter {
  name?: string;
  description?: string;
  category?: string;
  [key: string]: string | boolean | undefined;
}

export interface SkillToolResult {
  ok: boolean;
  body?: string;
  frontmatter?: SkillFrontmatter;
  attemptedPath?: string;
  error?: string;
}

const SKILL_NAME_SAFE = /^[A-Za-z0-9_-]+$/;

export function resolveSkillPath(skillName: string): string {
  return path.join(getLionClawHome(), 'skills', skillName, 'SKILL.md');
}

export function parseFrontmatter(raw: string): { frontmatter: SkillFrontmatter; body: string } {
  const normalized = raw.replace(/\r\n/g, '\n');
  const m = normalized.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { frontmatter: {}, body: normalized.trim() };

  const fm: SkillFrontmatter = {};
  const lines = m[1].split('\n');
  for (const line of lines) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (value === 'true') fm[key] = true;
    else if (value === 'false') fm[key] = false;
    else fm[key] = value;
  }
  return { frontmatter: fm, body: (m[2] ?? '').trim() };
}

export async function lionSkillLoad(input: SkillInput): Promise<SkillToolResult> {
  if (!input || typeof input.skill_name !== 'string' || input.skill_name.length === 0) {
    return { ok: false, error: 'Skill: skill_name obrigatorio.' };
  }
  if (!SKILL_NAME_SAFE.test(input.skill_name)) {
    return {
      ok: false,
      error: `Skill: skill_name invalido (use [A-Za-z0-9_-]): ${input.skill_name}`,
    };
  }

  const attemptedPath = resolveSkillPath(input.skill_name);
  let raw: string;
  try {
    raw = await fs.readFile(attemptedPath, 'utf-8');
  } catch (e) {
    return {
      ok: false,
      attemptedPath,
      error: `Skill nao encontrada em ${attemptedPath}: ${(e as Error).message}`,
    };
  }

  const { frontmatter, body } = parseFrontmatter(raw);
  return {
    ok: true,
    attemptedPath,
    frontmatter,
    body,
  };
}
