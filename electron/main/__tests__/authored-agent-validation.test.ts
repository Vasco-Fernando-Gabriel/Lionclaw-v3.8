import { describe, it, expect } from 'vitest';
import {
  validateAuthoredAgentTypes,
  AUTHORED_WORKFLOW_AGENT_DENYLIST,
} from '../dynamic-workflows/authored-agent-validation';
import { DYNAMIC_WORKFLOW_AGENT_DENYLIST } from '../dynamic-workflows/types';

type FakeAgent = { access: 'read-only' | 'workspace-write'; squad: string };
const CATALOG: Record<string, FakeAgent> = {
  'dynamic-workflow-scout': { access: 'read-only', squad: 'dynamic-workflow' },
  'dynamic-workflow-coder': { access: 'workspace-write', squad: 'dynamic-workflow' },
  'dynamic-workflow-refuter': { access: 'read-only', squad: 'dynamic-workflow' },
  'dynamic-workflow-builder': { access: 'read-only', squad: 'dynamic-workflow' },
  'dynamic-workflow-closer': { access: 'workspace-write', squad: 'dynamic-workflow' },
  'dynamic-workflow-narrator': { access: 'read-only', squad: 'dynamic-workflow' },
  'dynamic-workflow-maestro': { access: 'read-only', squad: 'dynamic-workflow' },
};
const getAgent = (id: string) => CATALOG[id];

const js = (agentType: string) =>
  `export const meta = { name: 'x', description: 'y' };\n` +
  `return await agent('p', { agentType: '${agentType}', timeoutMs: 60000 });\n`;

describe('D18: denylist de autoria', () => {
  it('a fonte unica lista builder, closer, narrator e maestro', () => {
    expect([...DYNAMIC_WORKFLOW_AGENT_DENYLIST].sort()).toEqual(
      [
        'dynamic-workflow-builder',
        'dynamic-workflow-closer',
        'dynamic-workflow-maestro',
        'dynamic-workflow-narrator',
      ].sort(),
    );
    expect(AUTHORED_WORKFLOW_AGENT_DENYLIST).toEqual(new Set(DYNAMIC_WORKFLOW_AGENT_DENYLIST));
  });

  it.each([
    'dynamic-workflow-closer',
    'dynamic-workflow-narrator',
    'dynamic-workflow-maestro',
    'dynamic-workflow-builder',
  ])('rejeita %s mesmo estando na squad dynamic-workflow, nomeando o agente', (agentType) => {
    const r = validateAuthoredAgentTypes(js(agentType), { getAgent });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain(agentType);
    expect(r.error).toMatch(/denylist/);
  });

  it.each(['dynamic-workflow-scout', 'dynamic-workflow-coder', 'dynamic-workflow-refuter'])(
    'aceita %s (papel de node da squad)',
    (agentType) => {
      const r = validateAuthoredAgentTypes(js(agentType), { getAgent });
      expect(r).toEqual({ ok: true, agentTypes: [agentType] });
    },
  );

  it('um .js com scout + closer e rejeitado por causa do closer', () => {
    const src =
      `export const meta = { name: 'x', description: 'y' };\n` +
      `await agent('a', { agentType: 'dynamic-workflow-scout', timeoutMs: 1 });\n` +
      `await agent('b', { agentType: 'dynamic-workflow-closer', timeoutMs: 1 });\n`;
    const r = validateAuthoredAgentTypes(src, { getAgent });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('dynamic-workflow-closer');
  });
});
