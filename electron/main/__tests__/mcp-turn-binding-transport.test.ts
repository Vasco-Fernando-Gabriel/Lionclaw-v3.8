import { describe, it, expect, afterEach } from 'vitest';
import {
  buildMcpTurnBindingEnv,
  LIONCLAW_MCP_LANE_ENV,
  LIONCLAW_MCP_SESSION_ID_ENV,
  LIONCLAW_MCP_TURN_ID_ENV,
} from '../mcp-manager';
import { chatInvocationContext, turnBindingFromContext } from '../mcp-invocation-context';
import {
  readEnvTurnBinding,
  turnBindingFromMeta,
  withTurnBinding,
} from '../../../mcp-servers/_shared/local-ipc-client';

const ENV_KEYS = [LIONCLAW_MCP_SESSION_ID_ENV, LIONCLAW_MCP_TURN_ID_ENV, LIONCLAW_MCP_LANE_ENV];
const saved = new Map<string, string | undefined>();

afterEach(() => {
  for (const key of ENV_KEYS) {
    const prev = saved.get(key);
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  }
  saved.clear();
});

function setEnv(values: Record<string, string | undefined>): void {
  for (const key of ENV_KEYS) {
    if (!saved.has(key)) saved.set(key, process.env[key]);
    const v = values[key];
    if (v === undefined) delete process.env[key];
    else process.env[key] = v;
  }
}

describe('9.2 (claude-sdk / claude-compat): env por query montado em getMCPConfigForAgent', () => {
  it('lane + turno viram LIONCLAW_MCP_LANE / LIONCLAW_MCP_SESSION_ID / LIONCLAW_MCP_TURN_ID', () => {
    expect(buildMcpTurnBindingEnv('desktop', { sessionId: 'sess-1', turnId: 'turn-1' })).toEqual({
      LIONCLAW_MCP_LANE: 'desktop',
      LIONCLAW_MCP_SESSION_ID: 'sess-1',
      LIONCLAW_MCP_TURN_ID: 'turn-1',
    });
    expect(buildMcpTurnBindingEnv('telegram', undefined)).toEqual({ LIONCLAW_MCP_LANE: 'telegram' });
    expect(buildMcpTurnBindingEnv(undefined, undefined)).toEqual({});
  });
});

describe('9.2 (gateway e helpers): o processo MCP le o binding real do env, com fallback quando ausente', () => {
  it('env presente => binding real', () => {
    setEnv({
      LIONCLAW_MCP_SESSION_ID: 'sess-9',
      LIONCLAW_MCP_TURN_ID: 'turn-9',
      LIONCLAW_MCP_LANE: 'desktop',
    });
    expect(readEnvTurnBinding()).toEqual({ sessionId: 'sess-9', turnId: 'turn-9', lane: 'desktop' });
    expect(withTurnBinding({ code: 'x' })).toEqual({
      sessionId: 'sess-9',
      turnId: 'turn-9',
      lane: 'desktop',
      code: 'x',
    });
  });

  it('env ausente (Codex e outros) => nada e inventado; parametros explicitos vencem o env', () => {
    setEnv({ LIONCLAW_MCP_SESSION_ID: undefined, LIONCLAW_MCP_TURN_ID: undefined, LIONCLAW_MCP_LANE: undefined });
    expect(readEnvTurnBinding()).toEqual({});
    expect(withTurnBinding({ code: 'x' })).toEqual({ code: 'x' });
    setEnv({ LIONCLAW_MCP_SESSION_ID: 'sess-env', LIONCLAW_MCP_TURN_ID: undefined, LIONCLAW_MCP_LANE: undefined });
    expect(withTurnBinding({ sessionId: 'sess-explicita' })).toEqual({ sessionId: 'sess-explicita' });
  });

  it('pool compartilhado: o binding chega por _meta.lionclaw do tools/call e vence o env do processo', () => {
    setEnv({ LIONCLAW_MCP_SESSION_ID: 'sess-env', LIONCLAW_MCP_TURN_ID: 'turn-env', LIONCLAW_MCP_LANE: undefined });
    const extra = { _meta: { lionclaw: { sessionId: 'sess-meta', turnId: 'turn-meta', lane: 'desktop' } } };
    expect(turnBindingFromMeta(extra)).toEqual({ sessionId: 'sess-meta', turnId: 'turn-meta', lane: 'desktop' });
    expect(withTurnBinding({ board: 'LC' }, extra)).toEqual({
      sessionId: 'sess-meta',
      turnId: 'turn-meta',
      lane: 'desktop',
      board: 'LC',
    });
    expect(turnBindingFromMeta(undefined)).toEqual({});
    expect(turnBindingFromMeta({ _meta: { lionclaw: 'lixo' } })).toEqual({});
  });
});

describe('9.2 (kimi / grok / cursor / lion): binding no context do invokeMcpTool', () => {
  it('chatInvocationContext carrega sessionId/turnId/lane; sem binding fica so a surface', () => {
    expect(chatInvocationContext({ sessionId: 's', turnId: 't', lane: 'desktop' })).toEqual({
      surface: 'chat',
      sessionId: 's',
      turnId: 't',
      lane: 'desktop',
    });
    expect(chatInvocationContext(undefined)).toEqual({ surface: 'chat' });
  });

  it('turnBindingFromContext exige o par completo (par atomico) para virar _meta do pool', () => {
    expect(turnBindingFromContext({ surface: 'chat', sessionId: 's', turnId: 't' })).toEqual({
      sessionId: 's',
      turnId: 't',
    });
    expect(turnBindingFromContext({ surface: 'chat', sessionId: 's' })).toBeUndefined();
    expect(turnBindingFromContext(undefined)).toBeUndefined();
  });
});
