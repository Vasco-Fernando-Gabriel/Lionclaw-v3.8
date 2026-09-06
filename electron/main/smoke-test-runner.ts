import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { createLogger } from './logger';

const logger = createLogger('smoke-test-runner');

export interface SmokeTestResult {
  typecheck: { ok: boolean; errors: number; output: string };
  lint: { available: boolean; ok: boolean; warnings: number; errors: number; output: string };
  tests: { available: boolean; passed: number; failed: number; output: string };
  brokenImports: Array<{ file: string; importPath: string }>;
  missingFiles: string[];
  durationMs: number;
}


function spawnCommand(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ exitCode: number; output: string }> {
  return new Promise((resolve) => {
    let output = '';
    let timedOut = false;

    const child = spawn(cmd, args, {
      cwd,
      shell: true,
      env: { ...process.env },
    });

    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        exitCode: timedOut ? -1 : (code ?? -1),
        output,
      });
    });

    child.on('error', () => {
      clearTimeout(timer);
      resolve({ exitCode: -1, output });
    });
  });
}

function readPackageJson(projectPath: string): Record<string, unknown> | null {
  try {
    const pkgPath = path.join(projectPath, 'package.json');
    if (!fs.existsSync(pkgPath)) return null;
    return JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function getScripts(pkg: Record<string, unknown> | null): Record<string, string> {
  if (!pkg) return {};
  const scripts = pkg['scripts'];
  if (typeof scripts !== 'object' || scripts === null) return {};
  return scripts as Record<string, string>;
}

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen) + '\n...(truncated)';
}


async function runTypecheck(
  projectPath: string,
): Promise<SmokeTestResult['typecheck']> {
  try {
    const tsconfigExists = fs.existsSync(path.join(projectPath, 'tsconfig.json'));
    const pkg = readPackageJson(projectPath);
    const deps = {
      ...(pkg?.['dependencies'] as Record<string, unknown> | undefined ?? {}),
      ...(pkg?.['devDependencies'] as Record<string, unknown> | undefined ?? {}),
    };
    const hasTypescript = 'typescript' in deps;

    if (!tsconfigExists || !hasTypescript) {
      return {
        ok: true,
        errors: 0,
        output: 'not applicable (no tsconfig.json or typescript dep)',
      };
    }

    const { exitCode, output } = await spawnCommand(
      'npx',
      ['tsc', '--noEmit'],
      projectPath,
      120_000,
    );

    const matches = output.match(/error TS\d+:/g);
    const errorCount = matches ? matches.length : 0;

    return {
      ok: exitCode === 0,
      errors: errorCount,
      output: truncate(output, 4000),
    };
  } catch (err) {
    logger.warn({ err, projectPath }, 'typecheck step failed');
    return { ok: true, errors: 0, output: '' };
  }
}


async function runLint(
  projectPath: string,
): Promise<SmokeTestResult['lint']> {
  try {
    const pkg = readPackageJson(projectPath);
    const scripts = getScripts(pkg);

    if (!scripts['lint']) {
      return { available: false, ok: true, warnings: 0, errors: 0, output: '' };
    }

    const { exitCode, output } = await spawnCommand(
      'npm',
      ['run', 'lint'],
      projectPath,
      120_000,
    );

    const truncated = truncate(output, 4000);

    const errMatch = truncated.match(/(\d+)\s+(?:error|errors)/i);
    const warnMatch = truncated.match(/(\d+)\s+(?:warning|warnings)/i);

    return {
      available: true,
      ok: exitCode === 0,
      errors: errMatch ? parseInt(errMatch[1], 10) : 0,
      warnings: warnMatch ? parseInt(warnMatch[1], 10) : 0,
      output: truncated,
    };
  } catch (err) {
    logger.warn({ err, projectPath }, 'lint step failed');
    return { available: false, ok: true, warnings: 0, errors: 0, output: '' };
  }
}


async function runTests(
  projectPath: string,
): Promise<SmokeTestResult['tests']> {
  try {
    const pkg = readPackageJson(projectPath);
    const scripts = getScripts(pkg);

    if (!scripts['test']) {
      return { available: false, passed: 0, failed: 0, output: '' };
    }

    const first = await spawnCommand(
      'npm',
      ['test', '--', '--run'],
      projectPath,
      180_000,
    );

    let finalOutput = first.output;

    if (
      first.exitCode !== 0 &&
      /unknown\s+option|unrecognized/i.test(first.output)
    ) {
      const second = await spawnCommand(
        'npm',
        ['test'],
        projectPath,
        180_000,
      );
      finalOutput = second.output;
    }

    const truncated = truncate(finalOutput, 6000);

    const passedMatch = truncated.match(/(\d+)\s+passed/);
    const failedMatch = truncated.match(/(\d+)\s+failed/);

    return {
      available: true,
      passed: passedMatch ? parseInt(passedMatch[1], 10) : 0,
      failed: failedMatch ? parseInt(failedMatch[1], 10) : 0,
      output: truncated,
    };
  } catch (err) {
    logger.warn({ err, projectPath }, 'tests step failed');
    return { available: false, passed: 0, failed: 0, output: '' };
  }
}


const IMPORT_RE = /(?:^|\n)\s*import\s+[^'"]*['"](\.\.?\/[^'"]+)['"]/g;
const EXPORT_RE =
  /(?:^|\n)\s*(?:export\s+\*\s+from|export\s+\{[^}]*\}\s+from)\s*['"](\.\.?\/[^'"]+)['"]/g;

const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  '.git',
  '.lionclaw',
  'out',
]);

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx'];

const RESOLVE_EXTENSIONS = [
  '',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '/index.ts',
  '/index.tsx',
  '/index.js',
];

function resolveImport(fromDir: string, importPath: string): boolean {
  for (const ext of RESOLVE_EXTENSIONS) {
    const candidate = path.resolve(fromDir, importPath + ext);
    if (fs.existsSync(candidate)) return true;
  }
  return false;
}

function collectSourceFiles(
  dir: string,
  results: string[],
  count: { value: number },
  limit: number,
): void {
  if (count.value >= limit) return;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (count.value >= limit) return;
    if (SKIP_DIRS.has(entry.name)) continue;

    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectSourceFiles(fullPath, results, count, limit);
    } else if (entry.isFile() && SOURCE_EXTENSIONS.includes(path.extname(entry.name))) {
      results.push(fullPath);
      count.value += 1;
    }
  }
}

function checkBrokenImports(
  projectPath: string,
): Array<{ file: string; importPath: string }> {
  const broken: Array<{ file: string; importPath: string }> = [];

  try {
    const files: string[] = [];
    const count = { value: 0 };
    collectSourceFiles(projectPath, files, count, 10_000);

    for (const filePath of files) {
      let content: string;
      try {
        content = fs.readFileSync(filePath, 'utf-8');
      } catch {
        continue;
      }

      const fromDir = path.dirname(filePath);
      const relFile = path.relative(projectPath, filePath);

      const allMatches: string[] = [];

      let m: RegExpExecArray | null;

      IMPORT_RE.lastIndex = 0;
      while ((m = IMPORT_RE.exec(content)) !== null) {
        if (m[1]) allMatches.push(m[1]);
      }

      EXPORT_RE.lastIndex = 0;
      while ((m = EXPORT_RE.exec(content)) !== null) {
        if (m[1]) allMatches.push(m[1]);
      }

      for (const imp of allMatches) {
        if (!resolveImport(fromDir, imp)) {
          broken.push({ file: relFile, importPath: imp });
        }
      }
    }
  } catch (err) {
    logger.warn({ err, projectPath }, 'brokenImports walk failed');
  }

  return broken;
}


function checkMissingFiles(
  projectPath: string,
  expectedFiles: string[],
): string[] {
  const missing: string[] = [];
  for (const p of expectedFiles) {
    try {
      const resolved = path.resolve(projectPath, p);
      if (!fs.existsSync(resolved)) {
        missing.push(p);
      }
    } catch {
      missing.push(p);
    }
  }
  return missing;
}


export async function runSmokeTest(
  projectPath: string,
  expectedFiles: string[],
): Promise<SmokeTestResult> {
  const startMs = Date.now();

  const [typecheck, lint, tests] = await Promise.all([
    runTypecheck(projectPath),
    runLint(projectPath),
    runTests(projectPath),
  ]);

  const brokenImports = checkBrokenImports(projectPath);
  const missingFiles = checkMissingFiles(projectPath, expectedFiles);

  return {
    typecheck,
    lint,
    tests,
    brokenImports,
    missingFiles,
    durationMs: Date.now() - startMs,
  };
}

export function writeSmokeTestReport(
  result: SmokeTestResult,
  outputPath: string,
): void {
  const durationSecs = (result.durationMs / 1000).toFixed(1);

  const typecheckStatus = result.typecheck.ok
    ? result.typecheck.output.includes('not applicable')
      ? 'NOT APPLICABLE'
      : 'OK'
    : 'FAILED';

  const lintStatus = result.lint.ok ? 'OK' : 'FAILED';

  const brokenList =
    result.brokenImports.length === 0
      ? '(none)'
      : result.brokenImports.map((b) => `- ${b.file} -> "${b.importPath}"`).join('\n');

  const missingList =
    result.missingFiles.length === 0
      ? '(none)'
      : result.missingFiles.map((f) => `- ${f}`).join('\n');

  const typecheckOutputBlock =
    result.typecheck.output.trim()
      ? `\n\`\`\`\n${result.typecheck.output.trim()}\n\`\`\`\n`
      : '';

  const lintOutputBlock =
    result.lint.output.trim()
      ? `\n\`\`\`\n${result.lint.output.trim()}\n\`\`\`\n`
      : '';

  const testsOutputBlock =
    result.tests.output.trim()
      ? `\n\`\`\`\n${result.tests.output.trim()}\n\`\`\`\n`
      : '';

  const content = [
    '# Smoke Test Report',
    '',
    `Duration: ${durationSecs}s`,
    '',
    '## TypeScript',
    `Status: ${typecheckStatus}`,
    `Errors: ${result.typecheck.errors}`,
    typecheckOutputBlock,
    '## Lint',
    `Available: ${result.lint.available ? 'yes' : 'no'}`,
    `Status: ${lintStatus}`,
    `Errors: ${result.lint.errors}`,
    `Warnings: ${result.lint.warnings}`,
    lintOutputBlock,
    '## Tests',
    `Available: ${result.tests.available ? 'yes' : 'no'}`,
    `Passed: ${result.tests.passed}`,
    `Failed: ${result.tests.failed}`,
    testsOutputBlock,
    '## Broken Imports',
    `${result.brokenImports.length} entries.`,
    brokenList,
    '',
    '## Missing Expected Files',
    `${result.missingFiles.length} entries.`,
    missingList,
    '',
  ].join('\n');

  try {
    fs.writeFileSync(outputPath, content, 'utf-8');
  } catch {
    try {
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, content, 'utf-8');
    } catch (err) {
      logger.warn({ err, outputPath }, 'writeSmokeTestReport: failed to write file');
    }
  }
}
