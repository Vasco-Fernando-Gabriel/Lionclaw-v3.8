
import { describe, it, expect, vi } from 'vitest';
import type { CanUseTool } from '@anthropic-ai/claude-agent-sdk';

vi.mock('../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { buildClaudeQueryOptions } from '../agent-runtime/cloud-executor';
import {
  PERM_BYPASS_NO_GUARD,
  PERM_DEFAULT_NO_BYPASS,
  PERM_DEFAULT_WITH_GUARD,
} from '../agent-runtime/permission-profiles';
import type {
  AgentExecutionRequest,
  AgentPermissionProfile,
} from '../agent-runtime/types';
import type { AgentQueryConfig } from '../agent-config-resolver';


function makeReq(
  permission: AgentPermissionProfile,
  overrides: Partial<AgentExecutionRequest> = {},
): AgentExecutionRequest {
  return {
    agentId: 'test-cloud-agent',
    prompt: 'Do the thing',
    cwd: '/tmp/project',
    abortController: new AbortController(),
    permission,
    ...overrides,
  };
}

function makeConfig(overrides: Partial<AgentQueryConfig> = {}): AgentQueryConfig {
  return {
    model: 'claude-sonnet-4-5',
    systemPrompt: 'You are a helpful coding agent.',
    allowedTools: ['Read', 'Edit'],
    mcpServers: [],
    maxTurns: undefined,
    effort: undefined,
    thinking: undefined,
    runtime: 'cloud',
    ...overrides,
  } as unknown as AgentQueryConfig;
}


describe('cloud-executor — permission profile wiring (S1.0.2)', () => {
  it('PERM_BYPASS_NO_GUARD → opts honor bypass + skip-perms, NO canUseTool', () => {
    const childAbort = new AbortController();
    const req = makeReq(PERM_BYPASS_NO_GUARD);

    const opts = buildClaudeQueryOptions(
      req,
      makeConfig(),
      '/path/to/cli.js',
      childAbort,
    );

    expect(opts.permissionMode).toBe('bypassPermissions');
    expect(opts.allowDangerouslySkipPermissions).toBe(true);
    expect('canUseTool' in opts).toBe(false);
  });

  it('PERM_DEFAULT_NO_BYPASS → opts use default mode, no skip, NO canUseTool', () => {
    const childAbort = new AbortController();
    const req = makeReq(PERM_DEFAULT_NO_BYPASS);

    const opts = buildClaudeQueryOptions(
      req,
      makeConfig(),
      '/path/to/cli.js',
      childAbort,
    );

    expect(opts.permissionMode).toBe('default');
    expect(opts.allowDangerouslySkipPermissions).toBe(false);
    expect('canUseTool' in opts).toBe(false);
  });

  it('PERM_DEFAULT_WITH_GUARD(mockGuard) → opts include canUseTool with identity reference', () => {
    const childAbort = new AbortController();
    const mockGuard: CanUseTool = vi.fn(async () => ({
      behavior: 'allow' as const,
      updatedInput: {},
    }));
    const profile = PERM_DEFAULT_WITH_GUARD(mockGuard);
    const req = makeReq(profile);

    const opts = buildClaudeQueryOptions(
      req,
      makeConfig(),
      '/path/to/cli.js',
      childAbort,
    );

    expect(opts.permissionMode).toBe('default');
    expect(opts.allowDangerouslySkipPermissions).toBe(false);
    expect(opts.canUseTool).toBe(mockGuard); // identity, not a wrapper
  });

  it('does not hardcode bypassPermissions when permission profile says default', () => {
    const childAbort = new AbortController();
    const req = makeReq(PERM_DEFAULT_NO_BYPASS);

    const opts = buildClaudeQueryOptions(
      req,
      makeConfig(),
      '/path/to/cli.js',
      childAbort,
    );

    expect(opts.permissionMode).not.toBe('bypassPermissions');
    expect(opts.allowDangerouslySkipPermissions).not.toBe(true);
  });

  it('preserves unrelated opts fields (cwd, model, systemPrompt, allowedTools, abortController)', () => {
    const childAbort = new AbortController();
    const req = makeReq(PERM_BYPASS_NO_GUARD, {
      cwd: '/some/repo',
    });
    const config = makeConfig({
      model: 'claude-opus-4-5',
      systemPrompt: 'custom prompt',
      allowedTools: ['Read', 'Glob', 'Grep'],
    });

    const opts = buildClaudeQueryOptions(req, config, '/cli', childAbort);

    expect(opts.cwd).toBe('/some/repo');
    expect(opts.model).toBe('claude-opus-4-5');
    expect(opts.systemPrompt).toBe('custom prompt');
    expect(opts.allowedTools).toEqual(['Read', 'Glob', 'Grep']);
    expect(opts.abortController).toBe(childAbort);
    expect(opts.pathToClaudeCodeExecutable).toBe('/cli');
    expect(opts.includePartialMessages).toBe(true);
  });
});
