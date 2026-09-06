
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runSmokeTest, writeSmokeTestReport } from '../smoke-test-runner';


const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lionclaw-smoke-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
    }
  }
});


describe('runSmokeTest: empty project', () => {

  it('reports typecheck as not applicable for project without tsconfig or typescript dep', { timeout: 30000 }, async () => {
    const projectPath = makeTmpDir();

    const result = await runSmokeTest(projectPath, []);

    expect(result.typecheck.ok).toBe(true);
    expect(result.typecheck.output).toMatch(/not applicable/i);
    expect(result.lint.available).toBe(false);
    expect(result.tests.available).toBe(false);
    expect(result.brokenImports).toEqual([]);
    expect(result.missingFiles).toEqual([]);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

});

describe('runSmokeTest: missing expected files', () => {

  it('lists files that do not exist on disk in missingFiles', { timeout: 30000 }, async () => {
    const projectPath = makeTmpDir();

    const result = await runSmokeTest(projectPath, ['nonexistent.txt', 'also-missing.ts']);

    expect(result.missingFiles).toContain('nonexistent.txt');
    expect(result.missingFiles).toContain('also-missing.ts');
    expect(result.missingFiles).toHaveLength(2);
  });

  it('does not report present files as missing', { timeout: 30000 }, async () => {
    const projectPath = makeTmpDir();
    fs.writeFileSync(path.join(projectPath, 'present.ts'), '// present', 'utf-8');

    const result = await runSmokeTest(projectPath, ['present.ts', 'absent.ts']);

    expect(result.missingFiles).not.toContain('present.ts');
    expect(result.missingFiles).toContain('absent.ts');
  });

});

describe('runSmokeTest: broken imports detection', () => {

  it('detects broken relative import in a TypeScript source file', { timeout: 30000 }, async () => {
    const projectPath = makeTmpDir();
    fs.writeFileSync(
      path.join(projectPath, 'index.ts'),
      "import x from './missing-module';\nconsole.log(x);\n",
      'utf-8',
    );

    const result = await runSmokeTest(projectPath, []);

    expect(result.brokenImports.length).toBeGreaterThanOrEqual(1);
    const broken = result.brokenImports.find(
      (b) => b.file === 'index.ts' && b.importPath === './missing-module',
    );
    expect(broken).toBeDefined();
    expect(result.typecheck.ok).toBe(true);
  });

});

describe('runSmokeTest: resilience', () => {

  it('resolves to a valid SmokeTestResult even with non-existent project path', async () => {
    const invalidPath = '/path/that/does/not/exist/lionclaw-smoke-invalid';

    await expect(runSmokeTest(invalidPath, [])).resolves.toBeDefined();

    const result = await runSmokeTest(invalidPath, []);
    expect(typeof result.typecheck.ok).toBe('boolean');
    expect(typeof result.lint.available).toBe('boolean');
    expect(typeof result.tests.available).toBe('boolean');
    expect(Array.isArray(result.brokenImports)).toBe(true);
    expect(Array.isArray(result.missingFiles)).toBe(true);
    expect(typeof result.durationMs).toBe('number');
  });

});

describe('writeSmokeTestReport', () => {

  it('creates missing subdirectories and writes the report file', () => {
    const projectPath = makeTmpDir();
    const outputPath = path.join(projectPath, 'non-existent-subdir', 'report.md');

    const fakeResult = {
      typecheck: { ok: true, errors: 0, output: 'not applicable (no tsconfig.json or typescript dep)' },
      lint: { available: false, ok: true, warnings: 0, errors: 0, output: '' },
      tests: { available: false, passed: 0, failed: 0, output: '' },
      brokenImports: [],
      missingFiles: [],
      durationMs: 42,
    };

    writeSmokeTestReport(fakeResult, outputPath);

    expect(fs.existsSync(outputPath)).toBe(true);
    const content = fs.readFileSync(outputPath, 'utf-8');
    expect(content).toContain('Smoke Test Report');
  });

  it('marks typecheck as NOT APPLICABLE in the report when output says not applicable', () => {
    const projectPath = makeTmpDir();
    const outputPath = path.join(projectPath, 'report.md');

    const fakeResult = {
      typecheck: { ok: true, errors: 0, output: 'not applicable (no tsconfig.json or typescript dep)' },
      lint: { available: false, ok: true, warnings: 0, errors: 0, output: '' },
      tests: { available: false, passed: 0, failed: 0, output: '' },
      brokenImports: [],
      missingFiles: [],
      durationMs: 100,
    };

    writeSmokeTestReport(fakeResult, outputPath);

    const content = fs.readFileSync(outputPath, 'utf-8');
    expect(content).toContain('NOT APPLICABLE');
  });

  it('includes broken imports in the report when they exist', () => {
    const projectPath = makeTmpDir();
    const outputPath = path.join(projectPath, 'report.md');

    const fakeResult = {
      typecheck: { ok: true, errors: 0, output: '' },
      lint: { available: false, ok: true, warnings: 0, errors: 0, output: '' },
      tests: { available: false, passed: 0, failed: 0, output: '' },
      brokenImports: [{ file: 'src/index.ts', importPath: './missing' }],
      missingFiles: [],
      durationMs: 50,
    };

    writeSmokeTestReport(fakeResult, outputPath);

    const content = fs.readFileSync(outputPath, 'utf-8');
    expect(content).toContain('src/index.ts');
    expect(content).toContain('./missing');
    expect(content).toContain('1 entries.');
  });

});
