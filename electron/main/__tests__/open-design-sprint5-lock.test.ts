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
import * as ipcMod from '../pipeline-shared/ipc-emitter';
import * as dbMod from '../db';
import { lock } from '../open-design/lock';
import { destructiveUnlock } from '../open-design/escape-hatch';

function createSnapshotDir(runDir: string) {
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
      visual: { direction: '', density: 'balanced', tokens: { colors: {}, typography: {}, spacing: {}, radii: {} } },
    }),
    'utf-8',
  );
  return snapshotDir;
}

describe('lock() happy path', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lionclaw-lock-test-'));
    const snapshotDir = createSnapshotDir(tmpDir);

    (configMod.getOpenDesignConfig as ReturnType<typeof vi.fn>).mockReturnValue({
      runDir: tmpDir,
      pipelineDocsId: 'docs123',
      locked: false,
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

  it('returns ok:true with manifestPath and lockedAt', async () => {
    const result = await lock('test-project-id');
    expect(result).toMatchObject({ ok: true });
    if (!('ok' in result) || !result.ok) throw new Error('expected ok');
    expect(typeof result.manifestPath).toBe('string');
    expect(typeof result.lockedAt).toBe('string');
  });

  it('patches manifest with locked=true', async () => {
    await lock('test-project-id');
    const manifestPath = path.join(tmpDir, 'open-design', 'snapshots', 'latest', 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as Record<string, unknown>;
    expect(manifest.locked).toBe(true);
    expect(typeof manifest.lockedAt).toBe('string');
  });

  it('never overwrites existing hashes in manifest', async () => {
    const manifestPath = path.join(tmpDir, 'open-design', 'snapshots', 'latest', 'manifest.json');
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({ version: 1, locked: false, lockedAt: null, hashes: { htmlSha256: 'original-hash' } }),
      'utf-8',
    );

    await lock('test-project-id');

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as Record<string, unknown>;
    expect((manifest.hashes as Record<string, string>).htmlSha256).toBe('original-hash');
  });

  it('calls setOpenDesignConfig with locked=true', async () => {
    await lock('test-project-id');
    expect(configMod.setOpenDesignConfig).toHaveBeenCalledWith(
      'test-project-id',
      expect.objectContaining({ locked: true }),
    );
  });

  it('does NOT emit openDesignLockRejected on success', async () => {
    await lock('test-project-id');
    const emitCalls = (ipcMod.emitIPC as ReturnType<typeof vi.fn>).mock.calls;
    const rejectionEmit = emitCalls.find((c: unknown[]) => {
      const payload = (c as [string, Record<string, unknown>])[1];
      const meta = payload?.metadata as Record<string, unknown> | undefined;
      return meta?.openDesignLockRejected === true;
    });
    expect(rejectionEmit).toBeUndefined();
  });
});

describe('lock() rejection path', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lionclaw-lock-reject-test-'));
    const snapshotDir = createSnapshotDir(tmpDir);

    (configMod.getOpenDesignConfig as ReturnType<typeof vi.fn>).mockReturnValue({
      runDir: tmpDir,
      pipelineDocsId: 'docs123',
      locked: false,
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
      problems: [{ rule: '10.2.3', item: 'Tela "Relatorios"', hint: 'nova tela' }],
    });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('returns ok:false with problems when validation fails', async () => {
    const result = await lock('test-project-id');
    expect(result).toMatchObject({ ok: false });
    if (!('ok' in result) || result.ok !== false) throw new Error('expected rejected');
    expect(result.report.problems).toHaveLength(1);
    expect(result.report.problems[0].rule).toBe('10.2.3');
  });

  it('emits pipeline:phase-changed with openDesignLockRejected=true', async () => {
    await lock('test-project-id');
    const emitCalls = (ipcMod.emitIPC as ReturnType<typeof vi.fn>).mock.calls;
    const rejectionEmit = emitCalls.find((c: unknown[]) => {
      const payload = (c as [string, Record<string, unknown>])[1];
      const meta = payload?.metadata as Record<string, unknown> | undefined;
      return meta?.openDesignLockRejected === true;
    });
    expect(rejectionEmit).toBeDefined();
    const payload = (rejectionEmit as [string, Record<string, unknown>])[1];
    expect(payload.phase).toBe(5);
    expect(payload.status).toBe('running');
    expect(payload.awaitingUser).toBe(true);
  });

  it('manifest stays locked=false on rejection', async () => {
    await lock('test-project-id');
    const manifestPath = path.join(tmpDir, 'open-design', 'snapshots', 'latest', 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as Record<string, unknown>;
    expect(manifest.locked).toBe(false);
  });

  it('saves phase 6 metrics with status=failed', async () => {
    await lock('test-project-id');
    expect(dbMod.savePipelinePhaseMetrics).toHaveBeenCalledWith(
      expect.objectContaining({ phaseNumber: 6, status: 'failed' }),
    );
  });

  it('harness_projects.status stays running (DB update called with running/phase 5)', async () => {
    await lock('test-project-id');
    const db = (dbMod.getDb as ReturnType<typeof vi.fn>).mock.results[0]?.value as {
      prepare: ReturnType<typeof vi.fn>;
    };
    const runCalls = (
      db.prepare.mock.results as unknown as Array<{ value: { run: ReturnType<typeof vi.fn> } }>
    ).flatMap((r) => r.value.run.mock.calls);
    const updateCall = runCalls.find((args: unknown[]) => args.includes('test-project-id'));
    expect(updateCall).toBeDefined();
  });
});

describe('destructiveUnlock() happy path', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lionclaw-escape-test-'));
    const snapshotDir = path.join(tmpDir, 'open-design', 'snapshots', 'latest');
    const artifactDir = path.join(snapshotDir, 'artifact');
    fs.mkdirSync(artifactDir, { recursive: true });

    fs.writeFileSync(path.join(artifactDir, 'index.html'), '<html></html>', 'utf-8');
    fs.writeFileSync(path.join(snapshotDir, 'design-contract.json'), '{}', 'utf-8');
    fs.writeFileSync(path.join(snapshotDir, 'design-lock-report.md'), '# Report', 'utf-8');
    fs.writeFileSync(
      path.join(snapshotDir, 'manifest.json'),
      JSON.stringify({
        locked: true,
        lockedAt: '2026-05-10T00:00:00.000Z',
        hashes: { htmlSha256: 'abc' },
      }),
      'utf-8',
    );

    (configMod.getOpenDesignConfig as ReturnType<typeof vi.fn>).mockReturnValue({
      runDir: tmpDir,
      locked: true,
      lockedAt: '2026-05-10T00:00:00.000Z',
    });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('returns ok:true with a new designRevisionId (format rev-<ts>-<hex>)', async () => {
    const result = await destructiveUnlock('test-project-id', 'DESBLOQUEAR DESIGN');
    expect(result).toMatchObject({ ok: true });
    if (!('ok' in result) || !result.ok) throw new Error('expected ok');
    expect(result.designRevisionId).toMatch(/^rev-\d+-[a-f0-9]+$/);
  });

  it('archives latest/ into revisions/<revisionId>/', async () => {
    const result = await destructiveUnlock('test-project-id', 'DESBLOQUEAR DESIGN');
    if (!('ok' in result) || !result.ok) throw new Error('expected ok');
    expect(fs.existsSync(result.archivePath)).toBe(true);
    expect(fs.existsSync(path.join(result.archivePath, 'artifact', 'index.html'))).toBe(true);
  });

  it('writes archived-state.json in the revision dir', async () => {
    const result = await destructiveUnlock('test-project-id', 'DESBLOQUEAR DESIGN');
    if (!('ok' in result) || !result.ok) throw new Error('expected ok');
    const archivedStatePath = path.join(result.archivePath, 'archived-state.json');
    expect(fs.existsSync(archivedStatePath)).toBe(true);
    const state = JSON.parse(fs.readFileSync(archivedStatePath, 'utf-8')) as Record<string, unknown>;
    expect(state.designRevisionId).toBe(result.designRevisionId);
    expect(state.projectId).toBe('test-project-id');
  });

  it('calls setOpenDesignConfig with locked=false and new designRevisionId', async () => {
    const result = await destructiveUnlock('test-project-id', 'DESBLOQUEAR DESIGN');
    if (!('ok' in result) || !result.ok) throw new Error('expected ok');
    expect(configMod.setOpenDesignConfig).toHaveBeenCalledWith(
      'test-project-id',
      expect.objectContaining({ locked: false, designRevisionId: result.designRevisionId }),
    );
  });

  it('emits pipeline:phase-changed with designRevisionRestarted=true and phase=5', async () => {
    await destructiveUnlock('test-project-id', 'DESBLOQUEAR DESIGN');
    const emitCalls = (ipcMod.emitIPC as ReturnType<typeof vi.fn>).mock.calls;
    const restartEmit = emitCalls.find((c: unknown[]) => {
      const payload = (c as [string, Record<string, unknown>])[1];
      const meta = payload?.metadata as Record<string, unknown> | undefined;
      return meta?.designRevisionRestarted === true;
    });
    expect(restartEmit).toBeDefined();
    const payload = (restartEmit as [string, Record<string, unknown>])[1];
    expect(payload.phase).toBe(5);
    expect(payload.awaitingUser).toBe(true);
  });

  it('clears latest/ artifact files after archiving', async () => {
    await destructiveUnlock('test-project-id', 'DESBLOQUEAR DESIGN');
    const snapshotDir = path.join(tmpDir, 'open-design', 'snapshots', 'latest');
    expect(fs.existsSync(path.join(snapshotDir, 'artifact'))).toBe(false);
    expect(fs.existsSync(path.join(snapshotDir, 'manifest.json'))).toBe(false);
  });
});

describe('destructiveUnlock() invalid confirmation', () => {
  it('returns error: invalid-confirmation for wrong phrase', async () => {
    const result = await destructiveUnlock('test-project-id', 'wrong phrase');
    expect(result).toEqual({ error: 'invalid-confirmation' });
  });

  it('returns error for empty string', async () => {
    const result = await destructiveUnlock('test-project-id', '');
    expect(result).toEqual({ error: 'invalid-confirmation' });
  });

  it('is case-sensitive — lowercase fails', async () => {
    const result = await destructiveUnlock('test-project-id', 'desbloquear design');
    expect(result).toEqual({ error: 'invalid-confirmation' });
  });

  it('is case-sensitive — partial match fails', async () => {
    const result = await destructiveUnlock('test-project-id', 'DESBLOQUEAR');
    expect(result).toEqual({ error: 'invalid-confirmation' });
  });

  it('exact phrase succeeds (basic sanity check)', async () => {
    (configMod.getOpenDesignConfig as ReturnType<typeof vi.fn>).mockReturnValue(null);
    const result = await destructiveUnlock('test-project-id', 'DESBLOQUEAR DESIGN');
    expect(result).toHaveProperty('error');
    expect((result as { error: string }).error).not.toBe('invalid-confirmation');
  });
});
