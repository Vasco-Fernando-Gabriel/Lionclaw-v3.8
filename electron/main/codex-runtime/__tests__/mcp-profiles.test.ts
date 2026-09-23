import { describe, it, expect, vi } from 'vitest';

vi.mock('../../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { resolveMcpProfile, CHAT_LION_HELPERS } from '../mcp-profiles';

describe('resolveMcpProfile', () => {
  it('chat includes catalog + Lion helpers + codex-lion-only MCPs, user config, workspace sandbox', () => {
    const r = resolveMcpProfile({
      profile: 'chat',
      surface: 'chat',
      chatActiveMcpServerIds: ['knowledge-base', 'google-calendar'],
      codexLionOnlyServerIds: ['lion-only-x'],
    });
    expect(r.useUserCodexConfig).toBe(true);
    expect(r.dedicatedProfile).toBeUndefined();
    expect(r.includeLionHelpers).toBe(true);
    expect(r.includeCodexLionOnly).toBe(true);
    expect(r.mcpServerIds).toContain('knowledge-base');
    expect(r.mcpServerIds).toContain('lion-only-x');
    expect(r.sandbox).toBe('workspace-write');
    expect(r.warnings).toEqual([]);
    expect([...CHAT_LION_HELPERS]).toContain('pipeline-control');
  });

  it('pipeline resolves ZERO global MCP, dedicated profile, no lion helpers', () => {
    const r = resolveMcpProfile({ profile: 'pipeline', surface: 'pipeline', projectId: 'p1' });
    expect(r.mcpServerIds).toEqual([]);
    expect(r.mcpToolNames).toEqual([]);
    expect(r.includeLionHelpers).toBe(false);
    expect(r.includeCodexLionOnly).toBe(false);
    expect(r.useUserCodexConfig).toBe(false);
    expect(r.dedicatedProfile).toContain('pipeline');
    expect(r.dedicatedProfile).toContain('p1');
    expect(r.sandbox).toBe('workspace-write');
  });

  it('pipeline ignores any chat catalog inputs (structural gate: chat MCP cannot leak)', () => {
    const r = resolveMcpProfile({
      profile: 'pipeline',
      surface: 'pipeline',
      chatActiveMcpServerIds: ['knowledge-base'],
      codexLionOnlyServerIds: ['lion-only-x'],
    });
    expect(r.mcpServerIds).toEqual([]);
    expect(r.includeCodexLionOnly).toBe(false);
  });

  it('agent-scoped includes ONLY the allowlist', () => {
    const r = resolveMcpProfile({
      profile: 'agent-scoped',
      surface: 'pipeline',
      projectId: 'p2',
      allowedMcpServerIds: ['memory-search'],
      allowedMcpToolNames: ['mcp__memory-search__query'],
      chatActiveMcpServerIds: ['knowledge-base'],
      codexLionOnlyServerIds: ['lion-only-x'],
    });
    expect(r.mcpServerIds).toEqual(['memory-search']);
    expect(r.mcpToolNames).toEqual(['mcp__memory-search__query']);
    expect(r.includeLionHelpers).toBe(false);
    expect(r.includeCodexLionOnly).toBe(false);
    expect(r.warnings).toEqual([]);
  });

  it('agent-scoped with an empty allowlist => no MCP + structured warning', () => {
    const r = resolveMcpProfile({
      profile: 'agent-scoped',
      surface: 'pipeline',
      allowedMcpServerIds: [],
      allowedMcpToolNames: [],
    });
    expect(r.mcpServerIds).toEqual([]);
    expect(r.warnings.length).toBe(1);
    expect(r.warnings[0]).toMatch(/empty allowlist/);
  });

  it('one-shot resolves ZERO MCP + read-only', () => {
    const r = resolveMcpProfile({ profile: 'one-shot', surface: 'one-shot' });
    expect(r.mcpServerIds).toEqual([]);
    expect(r.includeLionHelpers).toBe(false);
    expect(r.sandbox).toBe('read-only');
  });

  it('codex-lion-only resolves in chat but NOT in a non-chat profile', () => {
    const chat = resolveMcpProfile({
      profile: 'chat',
      surface: 'chat',
      codexLionOnlyServerIds: ['lion-only-x'],
    });
    expect(chat.mcpServerIds).toContain('lion-only-x');
    expect(chat.includeCodexLionOnly).toBe(true);

    for (const profile of ['pipeline', 'agent-scoped', 'one-shot'] as const) {
      const r = resolveMcpProfile({
        profile,
        surface: 'pipeline',
        codexLionOnlyServerIds: ['lion-only-x'],
        allowedMcpServerIds: profile === 'agent-scoped' ? ['memory-search'] : undefined,
      });
      expect(r.includeCodexLionOnly).toBe(false);
      expect(r.mcpServerIds).not.toContain('lion-only-x');
    }
  });
});
