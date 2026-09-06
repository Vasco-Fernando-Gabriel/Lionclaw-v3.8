
import { describe, it, expect, vi, beforeEach } from 'vitest';


const { mockWarn, mockInfo } = vi.hoisted(() => ({
  mockWarn: vi.fn(),
  mockInfo: vi.fn(),
}));

vi.mock('../logger', () => ({
  createLogger: () => ({
    info: mockInfo,
    warn: mockWarn,
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));


import {
  warnMcpToolsDroppedOnce,
  warnOncePerAgent,
  __resetWarnedAgentsForTests,
} from '../agent-runtime/mcp-warning';


beforeEach(() => {
  __resetWarnedAgentsForTests();
  mockWarn.mockClear();
  mockInfo.mockClear();
});


describe('warnMcpToolsDroppedOnce', () => {
  it('does nothing when allowedTools has no mcp__ tools', () => {
    warnMcpToolsDroppedOnce({
      agentId: 'agent-1',
      runtime: 'external',
      provider: 'kimi',
      allowedTools: ['bash', 'read', 'write', 'edit'],
    });
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it('emits warn on first call when mcp__ tools present', () => {
    warnMcpToolsDroppedOnce({
      agentId: 'agent-1',
      runtime: 'external',
      provider: 'deepseek',
      allowedTools: ['bash', 'mcp__calendar__list', 'mcp__gmail__read'],
    });
    expect(mockWarn).toHaveBeenCalledTimes(1);
    const call = mockWarn.mock.calls[0];
    expect(call[0]).toMatchObject({
      agentId: 'agent-1',
      runtime: 'external',
      provider: 'deepseek',
      droppedTools: ['mcp__calendar__list', 'mcp__gmail__read'],
    });
  });

  it('deduplicates: second call for same (runtime, agentId) does not warn again', () => {
    const args = {
      agentId: 'agent-1',
      runtime: 'external',
      provider: 'kimi',
      allowedTools: ['mcp__calendar__list'],
    };
    warnMcpToolsDroppedOnce(args);
    warnMcpToolsDroppedOnce(args);
    warnMcpToolsDroppedOnce(args);
    expect(mockWarn).toHaveBeenCalledTimes(1);
  });

  it('warns independently for different agentIds', () => {
    const tools = ['mcp__gmail__send'];
    warnMcpToolsDroppedOnce({ agentId: 'agent-A', runtime: 'external', provider: 'qwen', allowedTools: tools });
    warnMcpToolsDroppedOnce({ agentId: 'agent-B', runtime: 'external', provider: 'qwen', allowedTools: tools });
    expect(mockWarn).toHaveBeenCalledTimes(2);
  });

  it('warns independently for different runtimes', () => {
    const tools = ['mcp__drive__list'];
    warnMcpToolsDroppedOnce({ agentId: 'agent-1', runtime: 'external', provider: 'kimi', allowedTools: tools });
    warnMcpToolsDroppedOnce({ agentId: 'agent-1', runtime: 'google-genai', provider: 'gemini', allowedTools: tools });
    expect(mockWarn).toHaveBeenCalledTimes(2);
  });

  it('filters only mcp__ tools in droppedTools, ignores non-mcp tools', () => {
    warnMcpToolsDroppedOnce({
      agentId: 'agent-x',
      runtime: 'external',
      provider: 'deepseek',
      allowedTools: ['bash', 'mcp__slack__post', 'read', 'mcp__gmail__read'],
    });
    const call = mockWarn.mock.calls[0];
    expect(call[0].droppedTools).toEqual(['mcp__slack__post', 'mcp__gmail__read']);
  });
});


describe('warnOncePerAgent', () => {
  it('emits warn on first call', () => {
    warnOncePerAgent('agent-1', 'no-usage-reported', { foo: 'bar' });
    expect(mockWarn).toHaveBeenCalledTimes(1);
    expect(mockWarn.mock.calls[0][0]).toMatchObject({ foo: 'bar' });
    expect(mockWarn.mock.calls[0][1]).toBe('no-usage-reported');
  });

  it('deduplicates: second call for same (reasonKey, agentId) does not warn again', () => {
    warnOncePerAgent('agent-1', 'no-usage-reported', { foo: 'bar' });
    warnOncePerAgent('agent-1', 'no-usage-reported', { foo: 'baz' });
    expect(mockWarn).toHaveBeenCalledTimes(1);
  });

  it('warns independently for different reasonKeys on same agentId', () => {
    warnOncePerAgent('agent-1', 'no-usage-reported', { msg: 'a' });
    warnOncePerAgent('agent-1', 'unknown-pricing', { msg: 'b' });
    expect(mockWarn).toHaveBeenCalledTimes(2);
  });

  it('warns independently for different agentIds on same reasonKey', () => {
    warnOncePerAgent('agent-A', 'no-usage-reported', { msg: 'a' });
    warnOncePerAgent('agent-B', 'no-usage-reported', { msg: 'b' });
    expect(mockWarn).toHaveBeenCalledTimes(2);
  });
});


describe('__resetWarnedAgentsForTests', () => {
  it('clears state so warnings can fire again after reset', () => {
    const args = {
      agentId: 'agent-1',
      runtime: 'external',
      provider: 'kimi',
      allowedTools: ['mcp__calendar__list'],
    };
    warnMcpToolsDroppedOnce(args);
    expect(mockWarn).toHaveBeenCalledTimes(1);

    __resetWarnedAgentsForTests();
    mockWarn.mockClear();
    warnMcpToolsDroppedOnce(args);
    expect(mockWarn).toHaveBeenCalledTimes(1);
  });
});
