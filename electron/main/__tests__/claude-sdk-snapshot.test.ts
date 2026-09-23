import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import type {
  executeClaudeSdkQuery as ExecuteClaudeSdkQueryType,
  executeQuery as ExecuteQueryType,
} from '../orchestrator';

const ORCHESTRATOR_SRC = path.join(__dirname, '..', 'orchestrator.ts');

describe('SPEC-001 Sprint 5: Claude SDK verbatim extraction guardrail', () => {
  describe('exports', () => {
    it('exports executeClaudeSdkQuery as a function', async () => {
      const mod = await import('../orchestrator');
      expect(typeof mod.executeClaudeSdkQuery).toBe('function');
    });

    it('exports executeQuery as a function (the router)', async () => {
      const mod = await import('../orchestrator');
      expect(typeof mod.executeQuery).toBe('function');
    });

    it('executeClaudeSdkQuery accepts (message, options, getWindow, lane?)', async () => {
      const mod = await import('../orchestrator');
      expect(mod.executeClaudeSdkQuery.length).toBe(5);
    });

    it('executeQuery accepts (message, options, getWindow, lane?)', async () => {
      const mod = await import('../orchestrator');
      expect(mod.executeQuery.length).toBe(4);
    });

    it('signature return types are Promise-shaped', async () => {
      const mod = await import('../orchestrator');
      expect(mod.executeClaudeSdkQuery.name).toBe('executeClaudeSdkQuery');
      expect(mod.executeQuery.name).toBe('executeQuery');
      const _claudeSig: typeof ExecuteClaudeSdkQueryType = mod.executeClaudeSdkQuery;
      const _routerSig: typeof ExecuteQueryType = mod.executeQuery;
      expect(typeof _claudeSig).toBe('function');
      expect(typeof _routerSig).toBe('function');
    });
  });

  describe('verbatim body sentinels (SPEC §15 orchestrator.ts guardrail)', () => {
    const src = fs.readFileSync(ORCHESTRATOR_SRC, 'utf8');

    it.each([
      ["permissionMode: 'default' as const"],
      ['canUseTool: (tool: string, input: Record<string, unknown>) => permissionGuard(tool, input)'],
      ["await import('@anthropic-ai/claude-agent-sdk')"],
      ["preset: 'claude_code' as const"],
      ["settingSources: ['project', 'user']"],
      ['SubagentStart: [{'],
      ['resetArtifactDetector();'],
      ['calculateCost(model, totalInputTokens'],
      ['lane.sdkActiveSessionId = sdkThreadId'],
      ['_forceNewSession: true'],
      ['allowedTools: toSdkToolNames(getEnabledTools().filter((t) => !GUARD_GATED_TOOLS.includes(t)))'],
      ['disallowedTools: [...SDK_DISALLOWED_TOOLS]'],
      ["import { SDK_DISALLOWED_TOOLS, toSdkToolNames } from './agent-runtime/sdk-tool-names'"],
    ])('contains sentinel %p', (sentinel: string) => {
      expect(src.replace(/\s+/g, '')).toContain(sentinel.replace(/\s+/g, ''));
    });

    it('disallowedTools aparece nos DOIS ramos do query() (onboarding e normal)', () => {
      const matches = src.match(/disallowedTools: \[\.\.\.SDK_DISALLOWED_TOOLS\]/g) ?? [];
      expect(matches.length).toBe(2);
    });

    it('NENHUMA lista positiva `tools:` no orchestrator (D7 Do NOT: tool fora de `tools` desaparece do modelo)', () => {
      expect(src).not.toMatch(/^\s*tools:\s*\[/m);
      expect(src).not.toMatch(/^\s*tools:\s*toSdkToolNames\(/m);
    });

    it('contains exactly one declaration of executeClaudeSdkQuery', () => {
      const matches = src.match(/export async function executeClaudeSdkQuery\s*\(/g) ?? [];
      expect(matches.length).toBe(1);
    });

    it('contains exactly one declaration of executeQuery (the router)', () => {
      const matches = src.match(/export async function executeQuery\s*\(/g) ?? [];
      expect(matches.length).toBe(1);
    });

    it('router body contains the 4-way switch from SPEC §8', () => {
      expect(src).toContain("case 'claude-sdk':");
      expect(src).toContain("case 'claude-compat-sdk':");
      expect(src).toContain("case 'codex-sdk':");
      expect(src).toContain("case 'lion-sdk':");
      expect(src).toContain('resolveOrchestratorSelection({');
      expect(src).toContain("surface: 'main-chat'");
    });

    it('router NO LONGER bypasses non-desktop lanes nor gates non-claude runtimes (SPEC orquestrador-fonte-unica 2.1 + 3)', () => {
      expect(src).not.toContain('return executeClaudeSdkQuery(message, options, getWindow, lane);');
      expect(src).not.toContain("selection.runtime !== 'claude-sdk'");
      expect(src).toContain('executeClaudeCompatSdkQuery(message, options, getWindow, lane, selection)');
      expect(src).toContain('executeCodexSdkQuery(message, options, getWindow, lane, selection)');
      expect(src).toContain('executeKimiSdkQuery(message, options, getWindow, lane, selection)');
      expect(src).toContain('executeLionSdkQuery(message, options, getWindow, lane, selection)');
    });

    it('imports the three runtime entry points the router dispatches to', () => {
      expect(src).toContain("from './orchestrator-selection'");
      expect(src).toContain("from './claude-compat-sdk'");
      expect(src).toContain("from './codex-sdk'");
      expect(src).toContain("from './lion-sdk'");
    });
  });
});
