
import path from 'path';
import { describe, it, expect } from 'vitest';
import { resolveSpecPath, resolveSpecProgressPath } from '../pipeline-paths';

describe('resolveSpecPath', () => {
  it('returns project.specPath when set (priority 1)', () => {
    const project = {
      specPath: '/abs/custom/path/to/SPEC-custom.md',
      projectPath: '/abs/projects/foo',
    };
    expect(resolveSpecPath(project)).toBe('/abs/custom/path/to/SPEC-custom.md');
  });

  it('falls back to {projectPath}/SPEC.md when specPath is empty string', () => {
    const project = {
      specPath: '',
      projectPath: '/abs/projects/foo',
    };
    expect(resolveSpecPath(project)).toBe(path.join('/abs/projects/foo', 'SPEC.md'));
  });

  it('falls back to {projectPath}/SPEC.md when specPath is undefined-equivalent (cast)', () => {
    const project = {
      specPath: undefined as unknown as string,
      projectPath: '/abs/projects/bar',
    };
    expect(resolveSpecPath(project)).toBe(path.join('/abs/projects/bar', 'SPEC.md'));
  });

  it('preserves project.specPath even if it points to a non-default location', () => {
    const project = {
      specPath: '/abs/projects/foo/docs/Docs2026/SPEC2026.md',
      projectPath: '/abs/projects/foo',
    };
    expect(resolveSpecPath(project)).toBe('/abs/projects/foo/docs/Docs2026/SPEC2026.md');
  });
});

describe('resolveSpecProgressPath', () => {
  it('always returns {projectPath}/SPEC_PROGRESS.md', () => {
    const project = { projectPath: '/abs/projects/foo' };
    expect(resolveSpecProgressPath(project)).toBe(
      path.join('/abs/projects/foo', 'SPEC_PROGRESS.md'),
    );
  });

  it('does not consider any specPath field — purely projectPath-based', () => {
    const project = {
      projectPath: '/abs/projects/bar',
    };
    expect(resolveSpecProgressPath(project)).toBe(
      path.join('/abs/projects/bar', 'SPEC_PROGRESS.md'),
    );
  });

  it('handles relative project paths consistently with path.join semantics', () => {
    const project = { projectPath: 'relative/projects/baz' };
    expect(resolveSpecProgressPath(project)).toBe(
      path.join('relative/projects/baz', 'SPEC_PROGRESS.md'),
    );
  });
});
