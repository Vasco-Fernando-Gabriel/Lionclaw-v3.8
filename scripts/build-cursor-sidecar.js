const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..');
const entry = path.join(repoRoot, 'electron', 'main', 'agent-runtime', 'cursor-sidecar', 'sidecar', 'entry.ts');
const srcDir = path.join(repoRoot, 'electron', 'main', 'agent-runtime', 'cursor-sidecar');
const outDir = path.join(repoRoot, 'resources', 'cursor-sidecar');
const outFile = path.join(outDir, 'sidecar.cjs');
const withDeps = process.argv.includes('--with-deps');
const force = process.argv.includes('--force');

function newestMtimeMs(root) {
  let newest = 0;
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    const stat = fs.statSync(current, { throwIfNoEntry: false });
    if (!stat) continue;
    if (stat.isDirectory()) {
      for (const item of fs.readdirSync(current)) pending.push(path.join(current, item));
    } else if (stat.mtimeMs > newest) {
      newest = stat.mtimeMs;
    }
  }
  return newest;
}

function isUpToDate() {
  const outStat = fs.statSync(outFile, { throwIfNoEntry: false });
  if (!outStat) return false;
  return outStat.mtimeMs > Math.max(newestMtimeMs(srcDir), fs.statSync(__filename).mtimeMs);
}

async function bundle() {
  fs.mkdirSync(outDir, { recursive: true });
  await esbuild.build({
    entryPoints: [entry],
    outfile: outFile,
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    sourcemap: false,
    minify: false,
    logLevel: 'info',
    external: ['@cursor/sdk', '@cursor/sdk-*'],
  });
  console.log(`[cursor-sidecar] bundle gerado: ${path.relative(repoRoot, outFile)}`);
}

function readPkg(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
}

function resolvePkgDir(name, fromDirs) {
  for (const from of fromDirs) {
    const candidate = path.join(from, 'node_modules', ...name.split('/'));
    if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
  }
  return null;
}

function collectClosure(rootPkgName) {
  const resolved = new Map();
  const queue = [{ name: rootPkgName, parents: [repoRoot] }];
  while (queue.length > 0) {
    const { name, parents } = queue.shift();
    if (resolved.has(name)) continue;
    const dir = resolvePkgDir(name, parents.concat(repoRoot));
    if (!dir) {
      continue;
    }
    resolved.set(name, dir);
    const pkg = readPkg(dir);
    const deps = Object.keys({ ...(pkg.dependencies || {}), ...(pkg.optionalDependencies || {}) });
    for (const dep of deps) queue.push({ name: dep, parents: [dir, ...parents] });
  }
  return resolved;
}

function copyDirSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  fs.cpSync(src, dest, { recursive: true, dereference: true });
}

function copyDeps() {
  const closure = collectClosure('@cursor/sdk');
  if (!closure.has('@cursor/sdk')) {
    console.error('[cursor-sidecar] @cursor/sdk nao encontrado no node_modules — rode npm install');
    process.exit(1);
  }
  const destModules = path.join(outDir, 'node_modules');
  fs.rmSync(destModules, { recursive: true, force: true });
  for (const [name, dir] of closure) {
    copyDirSync(dir, path.join(destModules, ...name.split('/')));
  }
  console.log(
    `[cursor-sidecar] closure fisica copiada (${closure.size} pacotes) para ` + path.relative(repoRoot, destModules),
  );
}

(async () => {
  if (!force && isUpToDate() && !withDeps) {
    console.log('[cursor-sidecar] bundle atualizado, pulando');
    return;
  }
  await bundle();
  if (withDeps) copyDeps();
})().catch((err) => {
  console.error('[cursor-sidecar] build falhou:', err);
  process.exit(1);
});
