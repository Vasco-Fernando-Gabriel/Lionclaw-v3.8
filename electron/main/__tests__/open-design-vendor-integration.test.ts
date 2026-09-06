
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

function read(rel: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf-8');
}

function readJson(rel: string): unknown {
  return JSON.parse(read(rel));
}


describe('Sprint 5 integration — lock outputs ↔ fase 6+ paths block', () => {
  const lockSrc = read('electron/main/open-design/lock.ts');
  const blockSrc = read('electron/main/pipeline-engine/dev-v2-lock-paths.ts');

  it('lock() exports the 5 canonical output filenames (SPEC L844-852)', () => {
    expect(lockSrc).toMatch(/design-contract\.json/);
    expect(lockSrc).toMatch(/design-brief\.md/);
    expect(lockSrc).toMatch(/design-lock-report\.md/);
    expect(lockSrc).toMatch(/manifest\.json/);
    expect(lockSrc).toMatch(/artifact[\\/]index\.html|artifact', 'index\.html|artifact","index\.html/);
  });

  it('buildDesignLockPathsBlock consumes the same 5 filenames + 2 ids', () => {
    expect(blockSrc).toMatch(/design-contract\.json/);
    expect(blockSrc).toMatch(/design-brief\.md/);
    expect(blockSrc).toMatch(/design-lock-report\.md/);
    expect(blockSrc).toMatch(/manifest\.json/);
    expect(blockSrc).toMatch(/artifact[\\/]index\.html|artifact', 'index\.html/);
    expect(blockSrc).toMatch(/openDesignProjectId/);
    expect(blockSrc).toMatch(/conversationId/);
  });

  it('block header marker is stable for substring assertions (SPEC L884-895)', () => {
    expect(blockSrc).toContain('Inputs explicitos do design lock');
    expect(blockSrc).toContain('- User stories:');
    expect(blockSrc).toContain('- Design Contract:');
    expect(blockSrc).toContain('- Design Brief:');
    expect(blockSrc).toContain('- Lock Report:');
    expect(blockSrc).toContain('- Artifact HTML:');
    expect(blockSrc).toContain('- Manifest:');
    expect(blockSrc).toContain('- OpenDesign Project:');
    expect(blockSrc).toContain('- Conversation:');
  });
});


describe('Sprint 5 integration — forbidden endpoints parity (SPEC L809-819)', () => {
  const adapterSrc = read('electron/main/open-design/adapter-http.ts');
  const lockSrc = read('electron/main/open-design/lock.ts');
  const daemonPatchSrc = read('vendor/open-design/apps/daemon/src/import-export-routes.ts');

  it('adapter-http denylist mentions finalize and DESIGN.md', () => {
    expect(adapterSrc).toMatch(/isForbiddenPath|finalize\//);
    expect(adapterSrc).toMatch(/DESIGN\.md/);
  });

  it('lock.ts explicitly states "no finalize/anthropic" and "no DESIGN.md" (defensive comments)', () => {
    expect(lockSrc).toMatch(/finalize\/anthropic/);
    expect(lockSrc).toMatch(/DESIGN\.md/);
  });

  it('vendor daemon patch blocks /finalize/ with 403 when OD_EMBED_HOST=lionclaw', () => {
    expect(daemonPatchSrc).toMatch(/OD_EMBED_HOST/);
    expect(daemonPatchSrc).toMatch(/lionclaw/);
    expect(daemonPatchSrc).toMatch(/\/finalize\//);
    expect(daemonPatchSrc).toMatch(/res\.status\(403\)/);
  });
});


describe('Sprint 5 integration — PreflightResult shape (SPEC L1035-1036)', () => {
  const installerSrc = read('electron/main/open-design/installer.ts');
  const snapshotSrc = read(
    'electron/main/__tests__/__snapshots__/ipc-channels-snapshot.test.ts.snap',
  );

  it('installer.ts defines status union {ready, deps-missing, vendor-missing}', () => {
    expect(installerSrc).toMatch(/'ready'/);
    expect(installerSrc).toMatch(/'deps-missing'/);
    expect(installerSrc).toMatch(/'vendor-missing'/);
  });

  it('IPC snapshot covers all 3 status variants with vendorRoot', () => {
    expect(snapshotSrc).toMatch(/"status": "ready"/);
    expect(snapshotSrc).toMatch(/"status": "deps-missing"/);
    expect(snapshotSrc).toMatch(/"status": "vendor-missing"/);
    expect(snapshotSrc).toMatch(/"vendorRoot":/);
  });

  it('installer.ts does NOT use the legacy field name openDesignRoot in shape', () => {
    expect(installerSrc).not.toMatch(/openDesignRoot:\s/);
  });
});


describe('Sprint 5 integration — preload public surface (SPEC L1247)', () => {
  const preloadSrc = read('electron/preload/index.ts');
  const typesSrc = read('src/types/index.ts');

  it('preload does not invoke open-design:lock', () => {
    expect(preloadSrc).not.toMatch(/ipcRenderer\.invoke\(['"]open-design:lock['"]/);
  });

  it('preload does not invoke open-design:install-deps (legacy CTA)', () => {
    expect(preloadSrc).not.toMatch(/ipcRenderer\.invoke\(['"]open-design:install-deps['"]/);
  });

  it('types/index.ts no longer declares `lock(projectId)` in openDesign namespace', () => {
    expect(typesSrc).not.toMatch(/\n\s*lock:\s*\(projectId: string\)/);
  });

  it('preload still exposes boot-install-* channels (new lifecycle, SPEC L491-506)', () => {
    expect(preloadSrc).toMatch(/boot-install-status/);
    expect(preloadSrc).toMatch(/boot-install-retry/);
    expect(preloadSrc).toMatch(/boot-install-stream/);
  });
});


describe('Sprint 1 wiring — boot installer kickoff (SPEC L457-462)', () => {
  const indexSrc = read('electron/main/index.ts');

  it('electron/main/index.ts triggers ensureVendorReady at boot', () => {
    expect(indexSrc).toMatch(/ensureVendorReady/);
  });

  it('the kickoff lives inside the app.whenReady() block', () => {
    const whenReadyIdx = indexSrc.indexOf('app.whenReady()');
    const ensureIdx = indexSrc.indexOf('ensureVendorReady');
    expect(whenReadyIdx).toBeGreaterThan(-1);
    expect(ensureIdx).toBeGreaterThan(whenReadyIdx);
  });
});


describe('Sprint 5 integration — vendor flatten (SPEC L975-1027)', () => {
  it('vendor/open-design/.vendor-meta.json exists with canonical shape', () => {
    const meta = readJson('vendor/open-design/.vendor-meta.json') as Record<string, unknown>;
    expect(meta).toHaveProperty('upstream');
    expect(meta).toHaveProperty('commit');
    expect(meta).toHaveProperty('importedAt');
    expect(typeof meta.upstream).toBe('string');
    expect(typeof meta.commit).toBe('string');
    expect(typeof meta.importedAt).toBe('string');
  });

  it('vendor/open-design/.git is absent (no nested submodule)', () => {
    const dotGitPath = path.join(REPO_ROOT, 'vendor', 'open-design', '.git');
    expect(fs.existsSync(dotGitPath)).toBe(false);
  });

  it('vendor/open-design/.lionclaw-patches/embed-mode.md documents the patch', () => {
    const patchDoc = read('vendor/open-design/.lionclaw-patches/embed-mode.md');
    expect(patchDoc).toMatch(/OD_EMBED_HOST/);
    expect(patchDoc).toMatch(/host=lionclaw/);
    expect(patchDoc).toMatch(/finalize/);
  });
});


describe('Sprint 5 integration — SessionConfig pt-BR locale (SPEC L632-638)', () => {
  const typesSrc = read('src/types/open-design.ts');
  const sessionViewSrc = read(
    'src/components/open-design/SessionConfigView.tsx',
  );

  it('OpenDesignSessionConfig declares locale field (pt-BR default)', () => {
    expect(typesSrc).toMatch(/locale[?:]?:\s*['"]pt-BR['"]|locale\??:\s*string/);
  });

  it('SessionConfigView pins locale to pt-BR (current sprint scope)', () => {
    expect(sessionViewSrc).toMatch(/['"]pt-BR['"]/);
  });
});


describe('Sprint 5 integration — StudioView lock wiring (SPEC L826, L871-873)', () => {
  const studioSrc = read('src/components/open-design/StudioView.tsx');

  it('StudioView calls window.lionclaw.pipeline.approve', () => {
    expect(studioSrc).toMatch(/pipeline\.approve/);
  });

  it('StudioView passes action lock-and-continue', () => {
    expect(studioSrc).toContain("action: 'lock-and-continue'");
  });

  it('StudioView does NOT call window.lionclaw.openDesign.lock (removed in Sprint 4)', () => {
    expect(studioSrc).not.toMatch(/openDesign\.lock\(/);
  });
});


describe('Sprint 5 integration — gates script wiring', () => {
  const scriptPath = path.join(REPO_ROOT, 'scripts', 'sprint5-gates.sh');

  it('scripts/sprint5-gates.sh exists', () => {
    expect(fs.existsSync(scriptPath)).toBe(true);
  });

  it('scripts/sprint5-gates.sh is executable', () => {
    const stat = fs.statSync(scriptPath);
    expect((stat.mode & 0o100) !== 0).toBe(true);
  });

  it('script documents the 6 gates inline (SPEC L1242-1249)', () => {
    const src = fs.readFileSync(scriptPath, 'utf-8');
    expect(src).toMatch(/Gate 1/);
    expect(src).toMatch(/Gate 2/);
    expect(src).toMatch(/Gate 3/);
    expect(src).toMatch(/Gate 4/);
    expect(src).toMatch(/Gate 5/);
    expect(src).toMatch(/Gate 6/);
    expect(src).toMatch(/SPEC L1242-1249/);
  });
});
