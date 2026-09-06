import { describe, it, expect } from 'vitest';
import * as path from 'path';

function isInsideProjectRoot(resolved: string, projectRoot: string): boolean {
  return resolved === projectRoot || resolved.startsWith(projectRoot + path.sep);
}

describe('pipeline:open-smoke-test path traversal guard', () => {
  it('rejects sibling directories that share the project root prefix', () => {
    const projectRoot = path.resolve('/proj');
    const resolved = path.resolve('/projeto-malicioso/file');
    expect(isInsideProjectRoot(resolved, projectRoot)).toBe(false);
  });

  it('allows files inside the project root', () => {
    const projectRoot = path.resolve('/proj');
    const resolved = path.resolve('/proj/file');
    expect(isInsideProjectRoot(resolved, projectRoot)).toBe(true);
  });

  it('allows the project root itself', () => {
    const projectRoot = path.resolve('/proj');
    const resolved = path.resolve('/proj');
    expect(isInsideProjectRoot(resolved, projectRoot)).toBe(true);
  });

  it('allows nested files several levels deep inside the project root', () => {
    const projectRoot = path.resolve('/proj');
    const resolved = path.resolve('/proj/docs/Docs20260430_120000/smoke-test20260430_120000.md');
    expect(isInsideProjectRoot(resolved, projectRoot)).toBe(true);
  });

  it('rejects a parent directory of the project root', () => {
    const projectRoot = path.resolve('/proj/inner');
    const resolved = path.resolve('/proj');
    expect(isInsideProjectRoot(resolved, projectRoot)).toBe(false);
  });
});
