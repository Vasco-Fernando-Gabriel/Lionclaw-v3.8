import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const bypassState = { value: true };
vi.mock('../db', () => ({
  insertAuditEntry: vi.fn(),
  getPermissionBypass: vi.fn(() => bypassState.value),
}));

vi.mock('../ask-question', () => ({ sendAskQuestion: vi.fn() }));

vi.mock('../repo-profiler', () => ({ EXCLUDED_FROM_AUDIT_PATTERNS: [] }));

vi.mock('electron', () => ({
  BrowserWindow: class {},
  ipcMain: { on: vi.fn(), handle: vi.fn() },
}));

import {
  DESTRUCTIVE_MCP_PATTERNS,
  MEDIUM_RISK_MCP_PATTERNS,
  DIRECT_MCP_HELPERS,
  assessMcpToolRisk,
  isDirectMcpHelper,
  TOOL_SCRIPT_HELPER_ID,
  isChatTurnScopedMcpHelper,
  CHAT_TURN_SCOPED_MCP_HELPERS,
  PROMPT_CATALOG_MCP_HELPERS,
} from '../mcp-risk-patterns';
import { createPermissionGuard } from '../permission-guard';

const WINDOW_UNAVAILABLE = 'Janela nao disponivel para confirmacao';

const LEGACY_DESTRUCTIVE = [
  /^.*-delete$/i,
  /^.*-trash$/i,
  /^.*-send-email$/i,
  /^.*-send-message$/i,
  /^.*-publish$/i,
  /^send_email$/i,
  /^reply_to$/i,
  /^forward$/i,
  /^delete_event$/i,
  /^delete_file$/i,
  /^trash_message$/i,
  /^share_file$/i,
];

const LEGACY_MEDIUM = [/^.*-move$/i, /^.*-archive$/i];

function legacyVerdict(name: string): 'destructive' | 'medium' | 'safe' {
  if (LEGACY_DESTRUCTIVE.some((p) => p.test(name))) return 'destructive';
  if (LEGACY_MEDIUM.some((p) => p.test(name))) return 'medium';
  return 'safe';
}

const PARITY_NAMES = [
  'delete_file',
  'send_email',
  'reply_to',
  'forward',
  'trash_message',
  'share_file',
  'delete_event',
  'notion-delete',
  'x-trash',
  'y-send-message',
  'z-publish',
  'a-move',
  'b-archive',
  'tool_inocua',
  'get_events',
] as const;

describe('mcp-risk-patterns: paridade com os regex antigos do guard', () => {
  for (const name of PARITY_NAMES) {
    it(`"${name}" -> ${legacyVerdict(name)}`, () => {
      expect(assessMcpToolRisk(name)).toBe(legacyVerdict(name));
    });
  }

  it('vereditos explicitos da lista (sanidade alem do oraculo)', () => {
    const destructive = PARITY_NAMES.filter((n) => assessMcpToolRisk(n) === 'destructive');
    const medium = PARITY_NAMES.filter((n) => assessMcpToolRisk(n) === 'medium');
    const safe = PARITY_NAMES.filter((n) => assessMcpToolRisk(n) === 'safe');
    expect(destructive).toEqual([
      'delete_file',
      'send_email',
      'reply_to',
      'forward',
      'trash_message',
      'share_file',
      'delete_event',
      'notion-delete',
      'x-trash',
      'y-send-message',
      'z-publish',
    ]);
    expect(medium).toEqual(['a-move', 'b-archive']);
    expect(safe).toEqual(['tool_inocua', 'get_events']);
  });

  it('arrays exportados batem 1:1 com o oraculo (fonte unica sem drift)', () => {
    expect(DESTRUCTIVE_MCP_PATTERNS.map(String)).toEqual(LEGACY_DESTRUCTIVE.map(String));
    expect(MEDIUM_RISK_MCP_PATTERNS.map(String)).toEqual(LEGACY_MEDIUM.map(String));
  });
});

describe('permission-guard: comportamento identico apos a extracao', () => {
  beforeEach(() => {
    bypassState.value = false;
  });

  const guard = () => createPermissionGuard(() => null);

  for (const name of PARITY_NAMES) {
    const verdict = legacyVerdict(name);
    if (verdict === 'safe') {
      it(`inocua "${name}" auto-aprova mesmo com bypass OFF`, async () => {
        const result = await guard()(`mcp__someserver__${name}`, {});
        expect(result.behavior).toBe('allow');
      });
    } else {
      it(`"${name}" (${verdict}) roteia para confirmacao com bypass OFF`, async () => {
        const result = await guard()(`mcp__someserver__${name}`, {});
        expect(result.behavior).toBe('deny');
        expect((result as { behavior: 'deny'; message: string }).message).toBe(WINDOW_UNAVAILABLE);
      });
    }
  }

  it('bypass ON auto-aprova ate o destrutivo (mesmo contrato de antes)', async () => {
    bypassState.value = true;
    const result = await guard()('mcp__gmail__send_email', {});
    expect(result.behavior).toBe('allow');
  });
});

describe('DIRECT_MCP_HELPERS: fonte unica dos helpers diretos (P4)', () => {
  it('contem os 12 IDs REAIS de registro', () => {
    expect([...DIRECT_MCP_HELPERS].sort()).toEqual(
      [
        'lionclaw-user-question',
        'local-agents',
        'codex-agents', // ID real do server in-process (codex-agents-mcp.ts registra como 'codex-agents')
        'lionclaw-pipeline-control',
        'lionclaw-preview',
        'lionclaw-dynamic-workflows',
        'lionclaw-swarm',
        'repo-graph',
        'lionclaw-agents',
        'lionclaw-skills',
        'lionclaw-telegram',
        'lionclaw-toolscript',
      ].sort(),
    );
  });

  it('isDirectMcpHelper: true para helper (case-insensitive), false para server de negocio', () => {
    expect(isDirectMcpHelper('lionclaw-pipeline-control')).toBe(true);
    expect(isDirectMcpHelper('Repo-Graph')).toBe(true);
    expect(isDirectMcpHelper('codex-agents')).toBe(true);
    expect(isDirectMcpHelper('google-drive')).toBe(false);
    expect(isDirectMcpHelper('shopify')).toBe(false);
    expect(isDirectMcpHelper('')).toBe(false);
  });
});

describe('Tool Script (Fase B): identidade e turn-scope do helper always-on', () => {
  it('TOOL_SCRIPT_HELPER_ID e o id canonico e e um DIRECT helper', () => {
    expect(TOOL_SCRIPT_HELPER_ID).toBe('lionclaw-toolscript');
    expect(isDirectMcpHelper(TOOL_SCRIPT_HELPER_ID)).toBe(true);
  });

  it('isChatTurnScopedMcpHelper: SO o toolscript e turn-scoped (predicado do S3c em mcp-manager e session.ts)', () => {
    expect(isChatTurnScopedMcpHelper(TOOL_SCRIPT_HELPER_ID)).toBe(true);
    expect(isChatTurnScopedMcpHelper('LionClaw-ToolScript')).toBe(true);
    expect(isChatTurnScopedMcpHelper('lionclaw-pipeline-control')).toBe(false);
    expect(isChatTurnScopedMcpHelper('repo-graph')).toBe(false);
    expect(isChatTurnScopedMcpHelper('google-gmail')).toBe(false);
  });

  it('os sets contem exatamente o toolscript (fonte unica dos anuncios/scopes)', () => {
    expect([...CHAT_TURN_SCOPED_MCP_HELPERS]).toEqual([TOOL_SCRIPT_HELPER_ID]);
    expect([...PROMPT_CATALOG_MCP_HELPERS]).toEqual([TOOL_SCRIPT_HELPER_ID]);
  });
});
