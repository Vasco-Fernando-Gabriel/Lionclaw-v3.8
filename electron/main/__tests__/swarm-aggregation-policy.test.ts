import { describe, expect, it } from 'vitest';
import { isSwarmAggregationTool, swarmAggregationGuard, swarmAggregationSdkOptions } from '../swarm/aggregation-policy';

describe('Swarm aggregator cannot execute instructions embedded in findings', () => {
  it('allows only native read and search, denying writes, shell, delegation, MCP and unknown names', async () => {
    for (const name of ['Read', 'Grep', 'Glob']) {
      expect(isSwarmAggregationTool(name)).toBe(true);
      expect(
        await swarmAggregationGuard(
          name,
          { file_path: '/tmp/report' },
          { signal: new AbortController().signal, toolUseID: 'test', requestId: 'test' },
        ),
      ).toEqual({ behavior: 'allow', updatedInput: { file_path: '/tmp/report' } });
    }
    for (const name of [
      'Write',
      'Edit',
      'Bash',
      'Agent',
      'Task',
      'WebFetch',
      'mcp__gateway__mcp_invoke',
      'mcp__swarm__start',
      'unknown',
    ]) {
      expect(isSwarmAggregationTool(name)).toBe(false);
      expect(
        await swarmAggregationGuard(
          name,
          {},
          { signal: new AbortController().signal, toolUseID: 'test', requestId: 'test' },
        ),
      ).toMatchObject({ behavior: 'deny' });
    }
    expect(swarmAggregationSdkOptions()).toMatchObject({
      tools: ['Read', 'Grep', 'Glob'],
      allowedTools: [],
      mcpServers: {},
      agents: {},
      settingSources: [],
    });
  });
});
