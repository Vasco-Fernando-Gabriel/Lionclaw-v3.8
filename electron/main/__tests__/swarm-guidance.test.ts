import os from 'node:os';
import { describe, expect, it } from 'vitest';
import { SWARM_COMITE_EXAMPLE, SWARM_FANOUT_EXAMPLE } from '../../../mcp-servers/_shared/swarm-guidance';
import { normalizedItems, parseSwarmInput } from '../swarm/validation';

describe('Swarm tool examples match the host contract', () => {
  it('comite example produces four specialists on one target in a single plan', () => {
    const plan = parseSwarmInput({ ...SWARM_COMITE_EXAMPLE, cwd: os.tmpdir() }, [os.tmpdir()]);
    const items = normalizedItems(plan);
    expect(items.map((item) => item.slug)).toEqual(['secrets', 'auth', 'owasp', 'isolation']);
    expect(items.every((item) => item.target === '.')).toBe(true);
    expect(new Set(items.map((item) => item.member.kind === 'registered' && item.member.agentId)).size).toBe(4);
  });
  it('fanout example repeats a single profile across its targets', () => {
    const plan = parseSwarmInput({ ...SWARM_FANOUT_EXAMPLE, cwd: os.tmpdir() }, [os.tmpdir()]);
    const items = normalizedItems(plan);
    expect(items).toHaveLength(2);
    expect(items[0].member).toEqual(items[1].member);
    expect(items.map((item) => item.target)).toEqual(['alvo A', 'alvo B']);
    expect(items.every((item) => !item.prompt.includes('{{item}}'))).toBe(true);
  });
});
