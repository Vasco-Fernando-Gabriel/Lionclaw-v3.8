import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

vi.mock('../open-design/config', () => ({
  getOpenDesignConfig: vi.fn(),
  setOpenDesignConfig: vi.fn(),
  resolveRunDir: vi.fn(),
}));

vi.mock('../open-design/snapshot', () => ({
  captureSnapshot: vi.fn(),
}));

vi.mock('../open-design/manager', () => ({
  stop: vi.fn().mockResolvedValue({ ok: true }),
  start: vi.fn(),
  restart: vi.fn(),
  status: vi.fn(),
  health: vi.fn(),
  stopAll: vi.fn(),
}));

vi.mock('../open-design/validator', () => ({
  validateLock: vi.fn(),
  storyRequiresUI: vi.fn(),
}));

vi.mock('../db', () => ({
  savePipelinePhaseMetrics: vi.fn(),
  getDb: vi.fn(() => ({
    prepare: vi.fn(() => ({
      run: vi.fn(),
      all: vi.fn(() => []),
    })),
  })),
  getHarnessProject: vi.fn(() => ({ config: { openDesign: {} } })),
  updateHarnessProject: vi.fn(),
}));

vi.mock('../pipeline-shared/ipc-emitter', () => ({
  emitIPC: vi.fn(),
}));

import * as configMod from '../open-design/config';
import * as snapshotMod from '../open-design/snapshot';
import * as validatorMod from '../open-design/validator';
import { lock } from '../open-design/lock';

function createSnapshotDir(runDir: string): string {
  const snapshotDir = path.join(runDir, 'open-design', 'snapshots', 'latest');
  const artifactDir = path.join(snapshotDir, 'artifact');
  fs.mkdirSync(artifactDir, { recursive: true });
  fs.writeFileSync(path.join(artifactDir, 'index.html'), '<html><body></body></html>', 'utf-8');
  fs.writeFileSync(
    path.join(snapshotDir, 'manifest.json'),
    JSON.stringify({ version: 1, locked: false, lockedAt: null, hashes: { htmlSha256: 'abc123' } }),
    'utf-8',
  );
  fs.writeFileSync(
    path.join(snapshotDir, 'design-contract.json'),
    JSON.stringify({
      version: '1.0',
      screens: [],
      components: [],
      dataRequirements: [],
      apiExpectations: [],
      deltas: [],
      navigation: { primary: [] },
      visual: {
        direction: '',
        density: 'balanced',
        tokens: { colors: {}, typography: {}, spacing: {}, radii: {} },
      },
    }),
    'utf-8',
  );
  return snapshotDir;
}

describe('Sprint 4 — lock() shape & persistence', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lionclaw-lock-pipeline-test-'));
    const snapshotDir = createSnapshotDir(tmpDir);

    (configMod.getOpenDesignConfig as ReturnType<typeof vi.fn>).mockReturnValue({
      runDir: tmpDir,
      pipelineDocsId: 'docs123',
      locked: false,
      openDesignProjectId: 'lionclaw-runabc',
      conversationId: 'conv_xyz',
    });

    (snapshotMod.captureSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      paths: {
        snapshotDir,
        manifestPath: path.join(snapshotDir, 'manifest.json'),
        contractPath: path.join(snapshotDir, 'design-contract.json'),
        artifactHtmlPath: path.join(snapshotDir, 'artifact', 'index.html'),
      },
      hashes: { htmlSha256: 'abc123', contractSha256: null },
    });

    (validatorMod.validateLock as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      problems: [],
    });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('returns all 6 official paths + lockedAt on success (SPEC L844-852)', async () => {
    const result = await lock('test-project-id');
    if (!('ok' in result) || !result.ok) throw new Error('expected ok');
    expect(result.snapshotDir).toContain('open-design/snapshots/latest');
    expect(result.manifestPath).toContain('manifest.json');
    expect(result.contractPath).toContain('design-contract.json');
    expect(result.briefPath).toContain('design-brief.md');
    expect(result.lockReportPath).toContain('design-lock-report.md');
    expect(result.artifactHtmlPath).toContain('artifact/index.html');
    expect(typeof result.lockedAt).toBe('string');
  });

  it('keeps legacy `reportPath` field equal to `lockReportPath` (backwards-compat)', async () => {
    const result = await lock('test-project-id');
    if (!('ok' in result) || !result.ok) throw new Error('expected ok');
    expect(result.reportPath).toBe(result.lockReportPath);
  });

  it('persists all 6 paths + locked:true into config.openDesign (SPEC L832-841)', async () => {
    await lock('test-project-id');
    const calls = (configMod.setOpenDesignConfig as ReturnType<typeof vi.fn>).mock.calls;
    const successCall = calls.find(
      (c) => c[1] && typeof c[1] === 'object' && (c[1] as { locked?: boolean }).locked === true,
    );
    expect(successCall).toBeDefined();
    if (!successCall) return;

    const patch = successCall[1] as Record<string, unknown>;
    expect(patch.locked).toBe(true);
    expect(typeof patch.lockedAt).toBe('string');
    expect(patch.snapshotDir).toContain('open-design/snapshots/latest');
    expect(patch.manifestPath).toContain('manifest.json');
    expect(patch.contractPath).toContain('design-contract.json');
    expect(patch.briefPath).toContain('design-brief.md');
    expect(patch.lockReportPath).toContain('design-lock-report.md');
    expect(patch.artifactHtmlPath).toContain('artifact/index.html');
  });
});

describe('Sprint 4 — lock() rejection persists lockReportPath', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lionclaw-lock-reject-pipeline-test-'));
    const snapshotDir = createSnapshotDir(tmpDir);

    (configMod.getOpenDesignConfig as ReturnType<typeof vi.fn>).mockReturnValue({
      runDir: tmpDir,
      pipelineDocsId: 'docs123',
      locked: false,
      openDesignProjectId: 'lionclaw-runabc',
      conversationId: 'conv_xyz',
    });

    (snapshotMod.captureSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      paths: {
        snapshotDir,
        manifestPath: path.join(snapshotDir, 'manifest.json'),
        contractPath: path.join(snapshotDir, 'design-contract.json'),
        artifactHtmlPath: path.join(snapshotDir, 'artifact', 'index.html'),
      },
      hashes: { htmlSha256: 'abc123', contractSha256: null },
    });

    (validatorMod.validateLock as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      problems: [
        {
          rule: '10.2.3',
          item: 'Tela "Relatorios" (screen-reports)',
          hint: 'Sem story associada.',
        },
      ],
    });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('returns ok:false with lockReportPath populated (SPEC L842, L1079)', async () => {
    const result = await lock('test-project-id');
    if (!('ok' in result) || result.ok) throw new Error('expected ok:false');
    expect(result.lockReportPath).toContain('design-lock-report.md');
    expect(result.reportPath).toBe(result.lockReportPath);
    expect(result.report.ok).toBe(false);
    expect(result.report.problems.length).toBeGreaterThan(0);
  });

  it('persists lockReportPath into config with locked:false (SPEC L1079)', async () => {
    await lock('test-project-id');
    const calls = (configMod.setOpenDesignConfig as ReturnType<typeof vi.fn>).mock.calls;
    const rejectionCall = calls.find(
      (c) => c[1] && typeof c[1] === 'object' && (c[1] as { locked?: boolean }).locked === false,
    );
    expect(rejectionCall).toBeDefined();
    if (!rejectionCall) return;
    const patch = rejectionCall[1] as Record<string, unknown>;
    expect(patch.lockReportPath).toContain('design-lock-report.md');
    expect(patch.locked).toBe(false);
  });
});

describe('Sprint 4 — lock.ts negative invariants (static)', () => {
  const lockSrc = fs.readFileSync(path.resolve(__dirname, '..', 'open-design', 'lock.ts'), 'utf-8');

  function stripComments(src: string): string {
    const withoutBlock = src.replace(/\/\*[\s\S]*?\*\//g, '');
    return withoutBlock
      .split('\n')
      .filter((l) => {
        const t = l.trim();
        if (t.startsWith('//')) return false;
        if (t.startsWith('*')) return false;
        return true;
      })
      .join('\n');
  }

  it('does NOT call POST /api/projects/:id/finalize/anthropic (SPEC L152, L813, L1092)', () => {
    const codeOnly = stripComments(lockSrc);
    expect(codeOnly).not.toMatch(/finalize\/anthropic/);
  });

  it('does NOT contain `/finalize/` outside comments documenting prohibition', () => {
    const codeOnly = stripComments(lockSrc);
    expect(codeOnly).not.toMatch(/\/finalize\//);
  });

  it('does NOT consume DESIGN.md (SPEC L854-856, L1095)', () => {
    const codeOnly = stripComments(lockSrc);
    expect(codeOnly).not.toMatch(/DESIGN\.md/);
  });
});

describe('Sprint 4 — public preload removal (static)', () => {
  const preloadSrc = fs.readFileSync(path.resolve(__dirname, '..', '..', 'preload', 'index.ts'), 'utf-8');
  const typesSrc = fs.readFileSync(path.resolve(__dirname, '..', '..', '..', 'src', 'types', 'index.ts'), 'utf-8');

  it('`window.lionclaw.openDesign.lock:` no longer registered in preload (SPEC L858-869)', () => {
    expect(preloadSrc).not.toMatch(/ipcRenderer\.invoke\(['"]open-design:lock['"]/);
  });

  it('TypeScript namespace no longer declares `lock(projectId)` em openDesign', () => {
    expect(typesSrc).not.toMatch(/\n    lock: \(projectId: string\) => Promise/);
  });
});
