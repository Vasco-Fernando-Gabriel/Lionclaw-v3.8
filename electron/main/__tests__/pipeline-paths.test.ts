import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  generatePipelineDocsId,
  getPipelineDocsContext,
  migrateLegacyDocsToFolder,
  findHarnessSprintsReadPath,
  findPipelineDocReadPath,
  migrateHarnessSprintsToPipelineDocs,
  migrateLegacyHarnessSprintsJsonFile,
  resolveHarnessSprintArtifactDir,
  resolveHarnessSprintsPath,
} from '../pipeline-paths';

describe('generatePipelineDocsId', () => {
  it('returns string in YYYYMMDD_HHMMSS format', () => {
    const id = generatePipelineDocsId();
    expect(id).toMatch(/^\d{8}_\d{6}$/);
  });

  it('two consecutive calls return ids that may be equal (same second OK) but format always valid', () => {
    const a = generatePipelineDocsId();
    const b = generatePipelineDocsId();
    expect(a).toMatch(/^\d{8}_\d{6}$/);
    expect(b).toMatch(/^\d{8}_\d{6}$/);
  });
});

describe('getPipelineDocsContext', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-paths-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('returns null when pipelineDocsId is null', () => {
    expect(getPipelineDocsContext(tmp, null)).toBeNull();
  });

  it('creates docs/Docs<id>/ directory idempotently', () => {
    const id = '20260430_120000';
    const ctx = getPipelineDocsContext(tmp, id);
    expect(ctx).not.toBeNull();
    expect(fs.existsSync(path.join(tmp, 'docs', `Docs${id}`))).toBe(true);

    const ctx2 = getPipelineDocsContext(tmp, id);
    expect(ctx2).not.toBeNull();
    expect(ctx2!.docsDir).toBe(ctx!.docsDir);
  });

  it('resolveDocPath suffixes baseName before extension', () => {
    const id = '20260430_120000';
    const ctx = getPipelineDocsContext(tmp, id);
    expect(ctx!.resolveDocPath('PRD.md')).toBe(path.join(tmp, 'docs', `Docs${id}`, `PRD${id}.md`));
    expect(ctx!.resolveDocPath('sprints.json')).toBe(path.join(tmp, 'docs', `Docs${id}`, `sprints${id}.json`));
    expect(ctx!.resolveDocPath('a.b.json')).toBe(path.join(tmp, 'docs', `Docs${id}`, `a.b${id}.json`));
  });
});

describe('migrateLegacyDocsToFolder', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('returns empty migrated when no legacy files exist', () => {
    const result = migrateLegacyDocsToFolder(tmp, '20260430_120000');
    expect(result.migrated).toEqual([]);
  });

  it('moves PRD.md and SPEC.md to docsDir with id suffix', () => {
    fs.writeFileSync(path.join(tmp, 'PRD.md'), 'PRD content');
    fs.writeFileSync(path.join(tmp, 'SPEC.md'), 'SPEC content');
    const id = '20260430_120000';

    const result = migrateLegacyDocsToFolder(tmp, id);
    expect(result.migrated.length).toBe(2);
    expect(fs.existsSync(path.join(tmp, 'PRD.md'))).toBe(false);
    expect(fs.existsSync(path.join(tmp, 'SPEC.md'))).toBe(false);
    expect(fs.existsSync(path.join(tmp, 'docs', `Docs${id}`, `PRD${id}.md`))).toBe(true);
    expect(fs.existsSync(path.join(tmp, 'docs', `Docs${id}`, `SPEC${id}.md`))).toBe(true);
  });

  it('renames discovery-notes.md to discovery<id>.md (canonical)', () => {
    fs.writeFileSync(path.join(tmp, 'discovery-notes.md'), 'discovery');
    const id = '20260430_120000';
    const result = migrateLegacyDocsToFolder(tmp, id);
    expect(result.errors).toEqual([]);
    expect(fs.existsSync(path.join(tmp, 'docs', `Docs${id}`, `discovery${id}.md`))).toBe(true);
  });

  it('migrates feature-discovery-notes-* glob to discovery<id>.md', () => {
    fs.writeFileSync(path.join(tmp, 'feature-discovery-notes-202604.md'), 'fdisc');
    const id = '20260430_120000';
    const result = migrateLegacyDocsToFolder(tmp, id);
    expect(result.errors).toEqual([]);
    expect(fs.existsSync(path.join(tmp, 'docs', `Docs${id}`, `discovery${id}.md`))).toBe(true);
  });

  it('is idempotent: running twice does not double-migrate', () => {
    fs.writeFileSync(path.join(tmp, 'PRD.md'), 'PRD');
    const id = '20260430_120000';
    const r1 = migrateLegacyDocsToFolder(tmp, id);
    expect(r1.migrated.length).toBe(1);
    const r2 = migrateLegacyDocsToFolder(tmp, id);
    expect(r2.migrated.length).toBe(0);
  });
});

describe('harness sprint path resolution', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-sprints-paths-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('resolves standalone harness sprints to project docs/sprints.json', () => {
    const project = {
      id: 'project-1',
      projectPath: tmp,
      pipelineDocsId: null,
    };

    expect(resolveHarnessSprintsPath(project)).toBe(path.join(tmp, 'docs', 'sprints.json'));
    expect(fs.existsSync(path.join(tmp, 'docs'))).toBe(true);
  });

  it('resolves pipeline harness sprints through Docs<id>/sprints<id>.json', () => {
    const docsId = '20260430_120000';
    const project = {
      id: 'project-1',
      projectPath: tmp,
      pipelineDocsId: docsId,
    };

    expect(resolveHarnessSprintsPath(project)).toBe(path.join(tmp, 'docs', `Docs${docsId}`, `sprints${docsId}.json`));
  });

  it('resolves sprint artifacts inside the project docs directory', () => {
    const project = {
      id: 'project-1',
      projectPath: tmp,
      pipelineDocsId: null,
    };

    expect(resolveHarnessSprintArtifactDir(project, 'sprint/db-id')).toBe(
      path.join(tmp, 'docs', 'sprints', 'sprint_db-id'),
    );
  });

  it('finds persisted sprints path only when it exists and is inside the project', () => {
    const project = {
      id: 'project-1',
      projectPath: tmp,
      pipelineDocsId: null,
      sprintsJsonPath: path.join(tmp, 'docs', 'missing.json'),
    };

    expect(findHarnessSprintsReadPath(project)).toBeNull();

    const canonicalPath = path.join(tmp, 'docs', 'sprints.json');
    fs.mkdirSync(path.dirname(canonicalPath), { recursive: true });
    fs.writeFileSync(canonicalPath, '{}', 'utf-8');
    expect(findHarnessSprintsReadPath(project)).toBe(canonicalPath);
  });

  it('prefers Docs<id> canonical sprints over a persisted legacy path', () => {
    const docsId = '20260430_120000';
    const persistedPath = path.join(tmp, 'docs', 'sprints.json');
    fs.mkdirSync(path.dirname(persistedPath), { recursive: true });
    fs.writeFileSync(persistedPath, '{"persisted":true}', 'utf-8');

    const canonicalPath = path.join(tmp, 'docs', `Docs${docsId}`, `sprints${docsId}.json`);
    fs.mkdirSync(path.dirname(canonicalPath), { recursive: true });
    fs.writeFileSync(canonicalPath, '{"canonical":true}', 'utf-8');

    expect(
      findHarnessSprintsReadPath({
        id: 'project-1',
        projectPath: tmp,
        pipelineDocsId: docsId,
        sprintsJsonPath: persistedPath,
      }),
    ).toBe(canonicalPath);
  });

  it('falls back to a persisted sprints path when Docs<id> canonical file is missing', () => {
    const persistedPath = path.join(tmp, 'docs', 'sprints.json');
    fs.mkdirSync(path.dirname(persistedPath), { recursive: true });
    fs.writeFileSync(persistedPath, '{"persisted":true}', 'utf-8');

    expect(
      findHarnessSprintsReadPath({
        id: 'project-1',
        projectPath: tmp,
        pipelineDocsId: '20260430_120000',
        sprintsJsonPath: persistedPath,
      }),
    ).toBe(persistedPath);
  });

  it('returns null when pipelineDocsId is set, canonical missing, sprintsJsonPath is null, and docs/sprints.json exists but is not persisted', () => {
    const docsSprintsPath = path.join(tmp, 'docs', 'sprints.json');
    fs.mkdirSync(path.dirname(docsSprintsPath), { recursive: true });
    fs.writeFileSync(docsSprintsPath, '{"standalone":true}', 'utf-8');

    const result = findHarnessSprintsReadPath({
      id: 'project-1',
      projectPath: tmp,
      pipelineDocsId: '20260430_120000',
      sprintsJsonPath: null,
    });

    expect(result).toBeNull();
  });
});

describe('findPipelineDocReadPath', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-doc-read-path-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('prefers Docs<id> canonical document when it exists', () => {
    const docsId = '20260430_120000';
    const ctx = getPipelineDocsContext(tmp, docsId);
    const prdPath = ctx!.resolveDocPath('PRD.md');
    fs.writeFileSync(prdPath, 'canonical PRD', 'utf-8');
    fs.writeFileSync(path.join(tmp, 'PRD.md'), 'legacy PRD', 'utf-8');

    expect(findPipelineDocReadPath(tmp, docsId, 'PRD.md')).toBe(prdPath);
  });

  it('falls back to root legacy document when Docs<id> document is missing', () => {
    const legacySpecPath = path.join(tmp, 'SPEC.md');
    fs.writeFileSync(legacySpecPath, 'legacy SPEC', 'utf-8');

    expect(findPipelineDocReadPath(tmp, '20260430_120000', 'SPEC.md')).toBe(legacySpecPath);
  });

  it('prefers Docs<id> canonical document over an existing persisted path', () => {
    const docsId = '20260430_120000';
    const ctx = getPipelineDocsContext(tmp, docsId);
    const canonicalPath = ctx!.resolveDocPath('stories-requisitos.md');
    fs.writeFileSync(canonicalPath, 'canonical stories', 'utf-8');

    const persistedPath = path.join(tmp, 'custom', 'stories.md');
    fs.mkdirSync(path.dirname(persistedPath), { recursive: true });
    fs.writeFileSync(persistedPath, 'persisted stories', 'utf-8');

    expect(findPipelineDocReadPath(tmp, docsId, 'stories-requisitos.md', 'stories-requisitos.md', persistedPath)).toBe(
      canonicalPath,
    );
  });

  it('falls back to an existing persisted document path when Docs<id> document is missing', () => {
    const persistedPath = path.join(tmp, 'custom', 'stories.md');
    fs.mkdirSync(path.dirname(persistedPath), { recursive: true });
    fs.writeFileSync(persistedPath, 'persisted stories', 'utf-8');

    expect(
      findPipelineDocReadPath(tmp, '20260430_120000', 'stories-requisitos.md', 'stories-requisitos.md', persistedPath),
    ).toBe(persistedPath);
  });
});

describe('migrateHarnessSprintsToPipelineDocs', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-docs-sprints-migrate-test-'));
  });

  it('moves existing docs/sprints.json without a persisted sprintsJsonPath', () => {
    const sourcePath = path.join(tmp, 'docs', 'sprints.json');
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
    fs.writeFileSync(sourcePath, '{"createdBeforeProject":true}', 'utf-8');
    const docsId = '20260430_120000';

    const result = migrateHarnessSprintsToPipelineDocs(
      { id: 'project-1', projectPath: tmp, pipelineDocsId: null },
      docsId,
    );

    const canonicalPath = path.join(tmp, 'docs', `Docs${docsId}`, `sprints${docsId}.json`);
    expect(result.status).toBe('moved');
    expect(result.pathToPersist).toBe(canonicalPath);
    expect(fs.readFileSync(canonicalPath, 'utf-8')).toBe('{"createdBeforeProject":true}');
    expect(fs.existsSync(sourcePath)).toBe(false);
  });

  it('moves root-level sprints.json fallback to Docs<id> canonical file', () => {
    const sourcePath = path.join(tmp, 'sprints.json');
    fs.writeFileSync(sourcePath, '{"rootLegacy":true}', 'utf-8');
    const docsId = '20260430_120000';

    const result = migrateHarnessSprintsToPipelineDocs(
      { id: 'project-1', projectPath: tmp, pipelineDocsId: null },
      docsId,
    );

    const canonicalPath = path.join(tmp, 'docs', `Docs${docsId}`, `sprints${docsId}.json`);
    expect(result.status).toBe('moved');
    expect(result.pathToPersist).toBe(canonicalPath);
    expect(fs.readFileSync(canonicalPath, 'utf-8')).toBe('{"rootLegacy":true}');
    expect(fs.existsSync(sourcePath)).toBe(false);
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('moves docs/sprints.json to the new Docs<id> canonical file', () => {
    const sourcePath = path.join(tmp, 'docs', 'sprints.json');
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
    fs.writeFileSync(sourcePath, '{"current":true}', 'utf-8');
    const docsId = '20260430_120000';

    const result = migrateHarnessSprintsToPipelineDocs(
      { id: 'project-1', projectPath: tmp, pipelineDocsId: null, sprintsJsonPath: sourcePath },
      docsId,
    );

    const canonicalPath = path.join(tmp, 'docs', `Docs${docsId}`, `sprints${docsId}.json`);
    expect(result.status).toBe('moved');
    expect(result.pathToPersist).toBe(canonicalPath);
    expect(fs.readFileSync(canonicalPath, 'utf-8')).toBe('{"current":true}');
    expect(fs.existsSync(sourcePath)).toBe(false);
  });

  it('does not overwrite divergent Docs<id> canonical file and keeps source path safe', () => {
    const sourcePath = path.join(tmp, 'docs', 'sprints.json');
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
    fs.writeFileSync(sourcePath, '{"source":true}', 'utf-8');
    const docsId = '20260430_120000';
    const canonicalPath = path.join(tmp, 'docs', `Docs${docsId}`, `sprints${docsId}.json`);
    fs.mkdirSync(path.dirname(canonicalPath), { recursive: true });
    fs.writeFileSync(canonicalPath, '{"canonical":true}', 'utf-8');

    const result = migrateHarnessSprintsToPipelineDocs(
      { id: 'project-1', projectPath: tmp, pipelineDocsId: null, sprintsJsonPath: sourcePath },
      docsId,
    );

    expect(result.status).toBe('conflict-kept-source');
    expect(result.pathToPersist).toBe(sourcePath);
    expect(fs.readFileSync(sourcePath, 'utf-8')).toBe('{"source":true}');
    expect(fs.readFileSync(canonicalPath, 'utf-8')).toBe('{"canonical":true}');
  });
});

describe('migrateLegacyHarnessSprintsJsonFile', () => {
  let tmp: string;
  let projectPath: string;
  let lionclawHome: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-sprints-migrate-test-'));
    projectPath = path.join(tmp, 'target-project');
    lionclawHome = path.join(tmp, 'lionclaw-home');
    fs.mkdirSync(projectPath, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('moves legacy sprints JSON to standalone canonical path and removes source', () => {
    const projectId = 'project-1';
    const legacyDir = path.join(lionclawHome, 'harness', 'projects', projectId);
    fs.mkdirSync(legacyDir, { recursive: true });
    const legacyPath = path.join(legacyDir, 'sprints.v3.json');
    fs.writeFileSync(legacyPath, '{"ok":true}', 'utf-8');

    const result = migrateLegacyHarnessSprintsJsonFile(
      { id: projectId, projectPath, pipelineDocsId: null, sprintsJsonPath: legacyPath },
      lionclawHome,
    );

    const canonicalPath = path.join(projectPath, 'docs', 'sprints.json');
    expect(result.status).toBe('moved');
    expect(result.shouldUpdateDb).toBe(true);
    expect(result.canonicalPath).toBe(canonicalPath);
    expect(fs.readFileSync(canonicalPath, 'utf-8')).toBe('{"ok":true}');
    expect(fs.existsSync(legacyPath)).toBe(false);
  });

  it('moves legacy sprints JSON to Docs<id> canonical path', () => {
    const projectId = 'project-2';
    const docsId = '20260430_120000';
    const legacyDir = path.join(lionclawHome, 'harness', 'projects', projectId);
    fs.mkdirSync(legacyDir, { recursive: true });
    const legacyPath = path.join(legacyDir, 'sprints.v1.json');
    fs.writeFileSync(legacyPath, '{"pipeline":true}', 'utf-8');

    const result = migrateLegacyHarnessSprintsJsonFile(
      { id: projectId, projectPath, pipelineDocsId: docsId, sprintsJsonPath: legacyPath },
      lionclawHome,
    );

    const canonicalPath = path.join(projectPath, 'docs', `Docs${docsId}`, `sprints${docsId}.json`);
    expect(result.status).toBe('moved');
    expect(result.canonicalPath).toBe(canonicalPath);
    expect(fs.readFileSync(canonicalPath, 'utf-8')).toBe('{"pipeline":true}');
    expect(fs.existsSync(legacyPath)).toBe(false);
  });

  it('does not overwrite a divergent canonical file', () => {
    const projectId = 'project-3';
    const legacyDir = path.join(lionclawHome, 'harness', 'projects', projectId);
    fs.mkdirSync(legacyDir, { recursive: true });
    const legacyPath = path.join(legacyDir, 'sprints.v1.json');
    fs.writeFileSync(legacyPath, '{"legacy":true}', 'utf-8');
    const canonicalPath = path.join(projectPath, 'docs', 'sprints.json');
    fs.mkdirSync(path.dirname(canonicalPath), { recursive: true });
    fs.writeFileSync(canonicalPath, '{"canonical":true}', 'utf-8');

    const result = migrateLegacyHarnessSprintsJsonFile(
      { id: projectId, projectPath, pipelineDocsId: null, sprintsJsonPath: legacyPath },
      lionclawHome,
    );

    expect(result.status).toBe('conflict-kept-canonical');
    expect(result.shouldUpdateDb).toBe(true);
    expect(fs.readFileSync(canonicalPath, 'utf-8')).toBe('{"canonical":true}');
    expect(fs.readFileSync(legacyPath, 'utf-8')).toBe('{"legacy":true}');
  });
});
