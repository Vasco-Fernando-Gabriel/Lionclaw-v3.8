import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { buildLionRuntimeContextPrompt } from '../runtime-context';

describe('Lion-SDK runtime context prompt', () => {
  it('anchors global memory files to LionClaw home, not project .lionclaw', () => {
    const prompt = buildLionRuntimeContextPrompt();
    const lionHome = path.join(os.homedir(), '.lionclaw');

    expect(prompt).toContain(`LionClaw home: ${lionHome}`);
    expect(prompt).toContain(`Global long-term working memory is ONLY: ${path.join(lionHome, 'MEMORY.md')}`);
    expect(prompt).toContain('Do not hard-code developer-machine paths');
    expect(prompt).toContain('LIONCLAW_HOME');
    expect(prompt).toContain('<project>/.lionclaw/MEMORY.md');
    expect(prompt).toContain('project-local data/artifacts, NOT as LionClaw global memory');
  });
});
