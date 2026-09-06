import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

// @ts-expect-error script operacional ESM sem declarations TypeScript.
import { calculateBackfillCost, collectClaudeSessions } from '../../../scripts/backfill-pipeline-usage.mjs';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('backfill-pipeline-usage', () => {
  it('deduplica usage repetido por message.id incluindo subagentes', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-backfill-'));
    roots.push(root);
    const projectPath = '/tmp/Projeto Teste';
    const projectDir = path.join(root, '-tmp-Projeto-Teste');
    const sessionId = 'session-1';
    fs.mkdirSync(path.join(projectDir, sessionId, 'subagents'), { recursive: true });
    const record = JSON.stringify({
      timestamp: '2026-07-10T10:00:00.000Z',
      message: {
        id: 'msg-1',
        usage: {
          input_tokens: 10,
          cache_read_input_tokens: 20,
          cache_creation_input_tokens: 5,
          output_tokens: 3,
        },
      },
    });
    fs.writeFileSync(path.join(projectDir, `${sessionId}.jsonl`), `${record}\n${record}\n`);
    fs.writeFileSync(path.join(projectDir, sessionId, 'subagents', 'agent.jsonl'), `${record}\n`);

    expect(collectClaudeSessions(projectPath, root)).toEqual([
      {
        id: sessionId,
        minTime: Date.parse('2026-07-10T10:00:00.000Z'),
        maxTime: Date.parse('2026-07-10T10:00:00.000Z'),
        usage: { inputBase: 10, cacheRead: 20, cacheCreation: 5, output: 3, requests: 1 },
      },
    ]);
  });

  it('recalcula custo sem cobrar cache duas vezes', () => {
    expect(calculateBackfillCost(
      { inputBase: 100, cacheRead: 200, cacheCreation: 50, output: 25, requests: 1 },
      { input: 1, output: 4, cacheRead: 0.2, cacheCreation: 1.25 },
    )).toBe(0.000303);
  });
});
