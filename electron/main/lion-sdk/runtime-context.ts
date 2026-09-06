import fs from 'fs';
import os from 'os';
import path from 'path';
import { getAgentCwd, getLionClawHome } from '../paths';

const CONTEXT_FILE_MAX_CHARS = 6000;

function loadBounded(filePath: string): string {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8').trim();
    if (!raw) return '(empty)';
    if (raw.length <= CONTEXT_FILE_MAX_CHARS) return raw;
    return `${raw.slice(0, CONTEXT_FILE_MAX_CHARS)}\n[truncated]`;
  } catch {
    return '(missing)';
  }
}

export function buildLionRuntimeContextPrompt(): string {
  const lionHome = getLionClawHome();
  const defaultCwd = getAgentCwd(false);
  const files = {
    soul: path.join(lionHome, 'SOUL.md'),
    user: path.join(lionHome, 'USER.md'),
    rules: path.join(lionHome, 'RULES.md'),
    memory: path.join(lionHome, 'MEMORY.md'),
  };

  return [
    '## LionClaw Runtime Context',
    '',
    `- LionClaw home: ${lionHome}`,
    `- Default tool cwd: ${defaultCwd}`,
    `- OS home: ${os.homedir()}`,
    `- Process cwd: ${process.cwd()}`,
    '',
    'Critical path rules:',
    `- Global user profile is ONLY: ${files.user}`,
    `- Global long-term working memory is ONLY: ${files.memory}`,
    `- Global personality is ONLY: ${files.soul}`,
    `- Global app rules are ONLY: ${files.rules}`,
    '- Do not hard-code developer-machine paths. Every LionClaw install injects its own LionClaw home above at runtime.',
    '- If you need to rediscover the location, read the LIONCLAW_HOME environment variable from Bash or inspect the default tool cwd, then use absolute paths under that directory.',
    `- If you see a project or repository path like <project>/.lionclaw/MEMORY.md, treat it as project-local data/artifacts, NOT as LionClaw global memory.`,
    `- Never create, edit, or treat <project>/.lionclaw/MEMORY.md as the user's global memory unless the user explicitly gives that exact project path and asks for a project artifact edit.`,
    `- When the user says MEMORY.md, USER.md, SOUL.md, RULES.md, or "memoria do LionClaw" without an explicit project path, use the files under LionClaw home above.`,
    '- Prefer absolute paths. If a search tool gets no path, its default root is the LionClaw home, not the source repository.',
    '',
    `### SOUL.md (${files.soul})`,
    loadBounded(files.soul),
    '',
    `### USER.md (${files.user})`,
    loadBounded(files.user),
    '',
    `### MEMORY.md (${files.memory})`,
    loadBounded(files.memory),
    '',
    `### RULES.md (${files.rules})`,
    loadBounded(files.rules),
  ].join('\n');
}
