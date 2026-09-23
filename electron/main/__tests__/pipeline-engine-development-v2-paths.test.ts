import { describe, it, expect } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { buildDesignLockPathsBlock } from '../pipeline-engine/dev-v2-lock-paths';

function makeProject(
  overrides: {
    pipelineType?: string;
    locked?: boolean;
    snapshotDir?: string;
    manifestPath?: string;
    contractPath?: string;
    briefPath?: string;
    lockReportPath?: string;
    artifactHtmlPath?: string;
    openDesignProjectId?: string | null;
    conversationId?: string | null;
    pipelineDocsId?: string | null;
    projectPath?: string;
  } = {},
) {
  const projectPath = overrides.projectPath ?? fs.mkdtempSync(path.join(os.tmpdir(), 'lionclaw-pe-paths-'));
  const snapshotDir =
    overrides.snapshotDir ??
    path.join(projectPath, '.lionclaw', 'pipelines', 'development-v2', 'run-abc', 'open-design', 'snapshots', 'latest');
  const openDesignProjectId =
    overrides.openDesignProjectId === null ? undefined : (overrides.openDesignProjectId ?? 'lionclaw-runabc');
  const conversationId = overrides.conversationId === null ? undefined : (overrides.conversationId ?? 'conv_xyz');
  return {
    id: 'project-id-1',
    projectPath,
    pipelineType: overrides.pipelineType ?? 'development-v2',
    pipelineDocsId: overrides.pipelineDocsId ?? 'docs123',
    config: {
      openDesign: {
        locked: overrides.locked ?? true,
        snapshotDir,
        manifestPath: overrides.manifestPath ?? path.join(snapshotDir, 'manifest.json'),
        contractPath: overrides.contractPath ?? path.join(snapshotDir, 'design-contract.json'),
        briefPath: overrides.briefPath ?? path.join(snapshotDir, 'design-brief.md'),
        lockReportPath: overrides.lockReportPath ?? path.join(snapshotDir, 'design-lock-report.md'),
        artifactHtmlPath: overrides.artifactHtmlPath ?? path.join(snapshotDir, 'artifact', 'index.html'),
        openDesignProjectId,
        conversationId,
      },
    },
  };
}

const TARGET_PHASES = [
  { phase: 6, name: 'PRD Completo (pipe2-prd-completo)' },
  { phase: 7, name: 'Database (tech-database)' },
  { phase: 8, name: 'Backend (tech-backend)' },
  { phase: 9, name: 'Frontend Tecnico (pipe2-tech-frontend)' },
  { phase: 10, name: 'Security (tech-security)' },
  { phase: 11, name: 'Spec Generation (pipe2-spec-builder)' },
];

describe('Sprint 4 — buildDesignLockPathsBlock (development-v2 locked)', () => {
  for (const { phase, name } of TARGET_PHASES) {
    describe(`fase ${phase} (${name})`, () => {
      const project = makeProject();
      const block = buildDesignLockPathsBlock(project);

      it('returns a non-null block', () => {
        expect(block).not.toBeNull();
      });

      it('contains the header marker', () => {
        expect(block).toContain('**Inputs explicitos do design lock:**');
      });

      it('contains the User stories path (resolved via pipeline-paths)', () => {
        expect(block).toContain('- User stories:');
        expect(block).toContain('stories-requisitos');
      });

      it('contains the Design Contract path', () => {
        expect(block).toContain('- Design Contract:');
        expect(block).toContain('design-contract.json');
      });

      it('contains the Design Brief path', () => {
        expect(block).toContain('- Design Brief:');
        expect(block).toContain('design-brief.md');
      });

      it('contains the Lock Report path', () => {
        expect(block).toContain('- Lock Report:');
        expect(block).toContain('design-lock-report.md');
      });

      it('contains the Artifact HTML path', () => {
        expect(block).toContain('- Artifact HTML:');
        expect(block).toContain('artifact/index.html');
      });

      it('contains the Manifest path', () => {
        expect(block).toContain('- Manifest:');
        expect(block).toContain('manifest.json');
      });

      it('contains the OpenDesign Project id', () => {
        expect(block).toContain('- OpenDesign Project:');
        expect(block).toContain('lionclaw-runabc');
      });

      it('contains the Conversation id', () => {
        expect(block).toContain('- Conversation:');
        expect(block).toContain('conv_xyz');
      });

      it('instructs the agent to read the files (SPEC L894)', () => {
        expect(block).toContain('Read tool');
      });
    });
  }

  it('phase-independent: all 6 phases share the same fixed block (SPEC L884-895)', () => {
    const project = makeProject();
    const b1 = buildDesignLockPathsBlock(project);
    const b2 = buildDesignLockPathsBlock(project);
    expect(b1).toBe(b2);
  });
});

describe('Sprint 4 — buildDesignLockPathsBlock no-op conditions', () => {
  it('returns null when pipelineType is not development-v2', () => {
    const project = makeProject({ pipelineType: 'feature' });
    expect(buildDesignLockPathsBlock(project)).toBeNull();
  });

  it('returns null when locked=false', () => {
    const project = makeProject({ locked: false });
    expect(buildDesignLockPathsBlock(project)).toBeNull();
  });

  it('returns null when openDesignProjectId is missing', () => {
    const project = makeProject({ openDesignProjectId: null });
    expect(buildDesignLockPathsBlock(project)).toBeNull();
  });

  it('returns null when conversationId is missing', () => {
    const project = makeProject({ conversationId: null });
    expect(buildDesignLockPathsBlock(project)).toBeNull();
  });
});

describe('Sprint 4 — StudioView wiring (static)', () => {
  const studioSrc = fs.readFileSync(
    path.resolve(__dirname, '..', '..', '..', 'src', 'components', 'open-design', 'StudioView.tsx'),
    'utf-8',
  );

  it('calls window.lionclaw.pipeline.approve with action lock-and-continue (SPEC L826, L871-873)', () => {
    expect(studioSrc).toContain('pipeline.approve');
    expect(studioSrc).toContain("action: 'lock-and-continue'");
  });

  it('does NOT call window.lionclaw.openDesign.lock (Sprint 4 removed)', () => {
    expect(studioSrc).not.toMatch(/openDesign\.lock\(/);
  });

  it('renders the "Travar Design e Continuar" button', () => {
    expect(studioSrc).toContain('Travar Design e Continuar');
  });
});

describe('Sprint 4 — public preload removal (defensive)', () => {
  const preloadSrc = fs.readFileSync(path.resolve(__dirname, '..', '..', 'preload', 'index.ts'), 'utf-8');

  it('preload no longer exposes `openDesign.lock` as a method', () => {
    expect(preloadSrc).not.toMatch(/ipcRenderer\.invoke\(['"]open-design:lock['"]/);
  });
});
