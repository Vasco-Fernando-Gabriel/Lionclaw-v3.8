
import { createLogger } from '../logger';
import type { AgentQueryConfig } from '../agent-config-resolver';
import type { ChatFeatureToggles } from '../../../src/types';
import type { SubagentDispatchContext } from './types';
import { appendRepoGraphSection } from '../prompt-builder-repo-graph';
import {
  buildSubagentTriggerTool,
  buildUserQuestionTool,
  buildCoreMcpCatalogTools,
  buildAllowlistTool,
  KIMI_SUBAGENT_TOOL_NAME,
  KIMI_MCP_INVOKE_TOOL_NAME,
  KIMI_MCP_SCHEMA_TOOL_NAME,
  type KimiExternalTool,
} from './kimi-external-tools';

const logger = createLogger('kimi-session-config');

export type KimiToolProfile = 'chat' | 'pipeline' | 'agent-scoped' | 'one-shot';

export interface BuildKimiSessionToolsArgs {
  profile: KimiToolProfile;
  config: AgentQueryConfig;
  cwd: string;
  abortController: AbortController;
  projectId?: string;
  capabilities?: ChatFeatureToggles;
  lane?: 'desktop' | 'telegram' | 'cron' | 'pipeline' | 'workflow';
  dispatchContext?: SubagentDispatchContext;
}

export interface KimiSessionTools {
  externalTools: KimiExternalTool[];
  systemPrompt: string;
}

const SKILLS_BLOCK_HEADER = '## Skills Disponiveis (via MCP)';

const SKILLS_BLOCK_TOOLS = [
  'mcp__skills__list_skills',
  'mcp__skills__load_skill',
  'mcp__skills__get_skill_metadata',
];

const MCP_TOOL_TOKEN = /mcp__[A-Za-z0-9_-]+__[A-Za-z0-9_-]+/g;

function appendKimiSwarmSteering(prompt: string, hasSubagentTool: boolean): string {
  const parts = [
    'Runtime: a ferramenta nativa de paralelismo do Kimi (AgentSwarm) NAO esta disponivel aqui e sera recusada; nao tente usa-la.',
  ];
  if (hasSubagentTool) {
    parts.push(
      'Para delegar trabalho a sub-agentes, use a ferramenta lion_run_subagent (os sub-agentes do LionClaw).',
    );
  }
  return `${prompt}\n\n${parts.join(' ')}`.trimEnd();
}

export async function buildKimiSessionTools(
  args: BuildKimiSessionToolsArgs,
): Promise<KimiSessionTools> {
  const {
    profile,
    config,
    cwd,
    abortController,
    projectId,
    capabilities,
    lane = 'desktop',
    dispatchContext,
  } = args;

  let externalTools: KimiExternalTool[];
  let mcpIndexBlock: string | null = null;

  switch (profile) {
    case 'chat': {
      const { getSetting } = await import('../db');
      const mcpPromptMode: 'index' | 'full' =
        getSetting('mcp_prompt_mode') === 'full' ? 'full' : 'index';
      const [subagent, userQuestion, catalog] = await Promise.all([
        buildSubagentTriggerTool({ cwd, abortController, projectId, dispatchContext }),
        lane === 'desktop' ? buildUserQuestionTool() : Promise.resolve(null),
        buildCoreMcpCatalogTools(config, mcpPromptMode, capabilities),
      ]);
      externalTools = [subagent, ...(userQuestion ? [userQuestion] : []), ...catalog];
      if (mcpPromptMode === 'index') {
        const { buildMcpToolIndex } = await import('../mcp-tool-index');
        mcpIndexBlock = buildMcpToolIndex({
          invokeToolName: KIMI_MCP_INVOKE_TOOL_NAME,
          schemaToolName: KIMI_MCP_SCHEMA_TOOL_NAME,
        });
      }
      break;
    }
    case 'pipeline': {
      const subagent = dispatchContext && config.allowedTools.includes('Agent')
        ? await buildSubagentTriggerTool({ cwd, abortController, projectId, dispatchContext })
        : null;
      externalTools = subagent ? [subagent] : [];
      break;
    }
    case 'one-shot': {
      externalTools = [];
      break;
    }
    case 'agent-scoped': {
      const mcpAllowlist = config.allowedTools.filter((toolName) => toolName.startsWith('mcp__'));
      const allowlistedTools = await Promise.all(
        mcpAllowlist.map((toolName) => buildAllowlistTool(toolName, capabilities)),
      );
      const subagent = dispatchContext && config.allowedTools.includes('Agent')
        ? await buildSubagentTriggerTool({ cwd, abortController, projectId, dispatchContext })
        : null;
      externalTools = [...(subagent ? [subagent] : []), ...allowlistedTools];
      break;
    }
    default: {
      const _exhaustive: never = profile;
      throw new Error(`unhandled KimiToolProfile: ${String(_exhaustive)}`);
    }
  }

  const materializedNames = new Set(externalTools.map((t) => t.name));
  const promptWithMcpIndex = mcpIndexBlock
    ? `${config.systemPrompt}\n\n## Servidores MCP (indice)\n\n${mcpIndexBlock}`
    : config.systemPrompt;
  const strippedPrompt = stripUnmaterializedToolInstructions(promptWithMcpIndex, materializedNames);
  const hasRepoGraphTools = [...materializedNames].some((n) => n.startsWith('mcp__repo-graph__'));
  let steeredPrompt = strippedPrompt;
  if (hasRepoGraphTools) {
    const withRepoGraph = appendRepoGraphSection(strippedPrompt, 'mcp');
    if (withRepoGraph !== strippedPrompt) {
      steeredPrompt = `${withRepoGraph}\n\nNeste runtime as tools do repo-graph aparecem com o prefixo mcp__repo-graph__ (ex: mcp__repo-graph__repo_graph_search, mcp__repo-graph__repo_graph_minimal_context); chame-as por esse nome exato.`;
    }
  }
  const systemPrompt = appendKimiSwarmSteering(steeredPrompt, materializedNames.has(KIMI_SUBAGENT_TOOL_NAME));

  logger.debug(
    { profile, toolCount: externalTools.length, materialized: [...materializedNames] },
    'kimi session tools built',
  );

  return { externalTools, systemPrompt };
}

export function stripUnmaterializedToolInstructions(
  systemPrompt: string,
  materializedNames: Set<string>,
): string {
  if (!systemPrompt || systemPrompt.length === 0) return systemPrompt;

  let result = systemPrompt;

  const headerIdx = result.indexOf(SKILLS_BLOCK_HEADER);
  if (headerIdx !== -1) {
    const allSkillsMaterialized = SKILLS_BLOCK_TOOLS.every((t) => materializedNames.has(t));
    if (!allSkillsMaterialized) {
      result = removeBlockFromHeader(result, SKILLS_BLOCK_HEADER, SKILLS_BLOCK_TOOLS);
    }
  }

  for (;;) {
    const offending = findFirstUnmaterializedToken(result, materializedNames);
    if (offending === null) break;
    result = removeEnclosingBlockOrLine(result, offending.index, offending.token);
  }

  return result;
}

function findFirstUnmaterializedToken(
  text: string,
  materializedNames: Set<string>,
): { index: number; token: string } | null {
  MCP_TOOL_TOKEN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MCP_TOOL_TOKEN.exec(text)) !== null) {
    if (!materializedNames.has(m[0])) return { index: m.index, token: m[0] };
  }
  return null;
}

function removeEnclosingBlockOrLine(text: string, tokenIndex: number, offendingToken: string): string {
  const lineStart = text.lastIndexOf('\n', tokenIndex) + 1; // 0 if not found
  const lineEol = text.indexOf('\n', tokenIndex);
  const ownLine = lineEol === -1 ? text.slice(lineStart) : text.slice(lineStart, lineEol);
  if (ownLine.startsWith('## ')) {
    return removeBlockFromHeader(text, ownLine, [offendingToken]);
  }
  const precedingHeaderStart = findGoverningHeaderStart(text, lineStart);
  if (precedingHeaderStart !== -1) {
    const headerEol = text.indexOf('\n', precedingHeaderStart);
    const headerText =
      headerEol === -1 ? text.slice(precedingHeaderStart) : text.slice(precedingHeaderStart, headerEol);
    return removeBlockFromHeader(text, headerText, [offendingToken]);
  }
  const before = text.slice(0, lineStart);
  const after = lineEol === -1 ? '' : text.slice(lineEol + 1);
  const trimmedBefore = before.replace(/\s+$/, '');
  const trimmedAfter = after.replace(/^\s+/, '');
  if (trimmedBefore.length === 0) return trimmedAfter;
  if (trimmedAfter.length === 0) return trimmedBefore;
  return `${trimmedBefore}\n\n${trimmedAfter}`;
}

function findGoverningHeaderStart(text: string, lineStart: number): number {
  let pos = lineStart;
  while (pos > 0) {
    const prevLineEnd = pos - 1; // the '\n' before this line
    const prevLineStart = text.lastIndexOf('\n', prevLineEnd - 1) + 1;
    const prevLine = text.slice(prevLineStart, prevLineEnd);
    if (prevLine.startsWith('## ')) return prevLineStart;
    if (prevLine.trim().length === 0) return -1; // blank line breaks the block
    pos = prevLineStart;
  }
  const firstLineEnd = text.indexOf('\n', lineStart);
  const firstLine = firstLineEnd === -1 ? text.slice(lineStart) : text.slice(lineStart, firstLineEnd);
  return firstLine.startsWith('## ') ? lineStart : -1;
}

function removeBlockFromHeader(text: string, header: string, blockTokens?: readonly string[]): string {
  const start = text.indexOf(header);
  if (start === -1) return text;

  const afterHeader = start + header.length;
  const nextHeaderRel = text.slice(afterHeader).search(/\n## /);
  const hardEnd = nextHeaderRel === -1 ? text.length : afterHeader + nextHeaderRel + 1; // +1 keeps the leading \n with the next block

  let end = hardEnd;
  if (blockTokens && blockTokens.length > 0) {
    const boundedEnd = boundRemovalToAnnouncingBlock(text, start, hardEnd, blockTokens);
    if (boundedEnd !== -1) end = boundedEnd;
  }

  const before = text.slice(0, start);
  const after = text.slice(end);
  const trimmedBefore = before.replace(/\s+$/, '');
  const trimmedAfter = after.replace(/^\s+/, '');
  if (trimmedBefore.length === 0) return trimmedAfter;
  if (trimmedAfter.length === 0) return trimmedBefore;
  return `${trimmedBefore}\n\n${trimmedAfter}`;
}

function boundRemovalToAnnouncingBlock(
  text: string,
  start: number,
  hardEnd: number,
  blockTokens: readonly string[],
): number {
  const paras = paragraphRanges(text, start, hardEnd);
  const hasToken = (s: number, e: number): boolean => {
    const slice = text.slice(s, e);
    return blockTokens.some((tok) => slice.includes(tok));
  };
  let lastEnd = -1;
  let prevHadToken = false;
  for (const [s, e] of paras) {
    const tok = hasToken(s, e);
    if (tok || prevHadToken) {
      lastEnd = e;
      prevHadToken = tok;
    } else {
      break;
    }
  }
  return lastEnd;
}

function paragraphRanges(text: string, from: number, hardEnd: number): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let i = from;
  while (i < hardEnd) {
    while (i < hardEnd && text[i] === '\n') i++;
    if (i >= hardEnd) break;
    const startP = i;
    const gap = text.indexOf('\n\n', i);
    if (gap === -1 || gap >= hardEnd) {
      ranges.push([startP, hardEnd]);
      break;
    }
    ranges.push([startP, gap]);
    i = gap + 2;
  }
  return ranges;
}
