const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const mcpDir = path.join(__dirname, '..', 'mcp-servers');
const keepModules = process.env.LIONCLAW_MCP_KEEP_MODULES === '1';

if (!fs.existsSync(mcpDir)) {
  console.log('Pasta mcp-servers/ nao encontrada. Pulando build de MCPs.');
  process.exit(0);
}

function newestMtimeMs(root) {
  let newest = 0;
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    const stat = fs.statSync(current, { throwIfNoEntry: false });
    if (!stat) continue;
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(current)) {
        if (entry === 'node_modules' || entry === 'dist') continue;
        pending.push(path.join(current, entry));
      }
    } else {
      if (stat.mtimeMs > newest) newest = stat.mtimeMs;
    }
  }
  return newest;
}

const sharedDir = path.join(mcpDir, '_shared');
const sharedMtime = fs.existsSync(sharedDir) ? newestMtimeMs(sharedDir) : 0;

function isUpToDate(fullPath, pkg) {
  const entrypoint = path.join(fullPath, ...(pkg.main || 'dist/index.js').split('/'));
  const distStat = fs.statSync(entrypoint, { throwIfNoEntry: false });
  if (!distStat) return false;
  const sourceMtime = Math.max(
    newestMtimeMs(path.join(fullPath, 'src')),
    fs.statSync(path.join(fullPath, 'package.json')).mtimeMs,
    sharedMtime,
  );
  return distStat.mtimeMs > sourceMtime;
}

function needsPrune(fullPath, pkg) {
  const nodeModules = path.join(fullPath, 'node_modules');
  if (!fs.existsSync(nodeModules)) return false;
  const runtimeDeps = Object.keys(pkg.dependencies || {});
  if (runtimeDeps.length === 0) return true;
  return ['esbuild', 'typescript'].some((devDep) => fs.existsSync(path.join(nodeModules, devDep)));
}

function pruneNodeModules(fullPath, pkg, dir) {
  if (keepModules) return;
  const nodeModules = path.join(fullPath, 'node_modules');
  if (!fs.existsSync(nodeModules)) return;
  const runtimeDeps = Object.keys(pkg.dependencies || {});
  if (runtimeDeps.length === 0) {
    fs.rmSync(nodeModules, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
    console.log(`  PRUNE ${dir}: node_modules removido (bundle autossuficiente)`);
  } else {
    execSync('npm prune --omit=dev --no-audit --no-fund', {
      cwd: fullPath,
      stdio: 'inherit',
      timeout: 120000,
    });
    console.log(`  PRUNE ${dir}: apenas deps de runtime mantidas (${runtimeDeps.join(', ')})`);
  }
}

const dirs = fs.readdirSync(mcpDir).filter((d) => fs.statSync(path.join(mcpDir, d)).isDirectory());

let success = 0;
let failed = 0;
let skipped = 0;

for (const dir of dirs) {
  const fullPath = path.join(mcpDir, dir);
  const pkgPath = path.join(fullPath, 'package.json');

  if (!fs.existsSync(pkgPath)) {
    skipped++;
    continue;
  }

  const srcIndex = path.join(fullPath, 'src', 'index.ts');
  if (!fs.existsSync(srcIndex)) {
    console.log(`  SKIP ${dir} (no src/index.ts — shared lib?)`);
    skipped++;
    continue;
  }

  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  if (isUpToDate(fullPath, pkg)) {
    if (!keepModules && needsPrune(fullPath, pkg)) {
      try {
        pruneNodeModules(fullPath, pkg, dir);
      } catch (e) {
        console.error(`  WARN ${dir}: poda pendente falhou: ${e.message}`);
      }
    }
    console.log(`  SKIP ${dir} (dist atualizado)`);
    skipped++;
    continue;
  }

  console.log(`Building MCP: ${dir}...`);
  try {
    execSync('npm install --no-audit --no-fund && npm run build', {
      cwd: fullPath,
      stdio: 'inherit',
      timeout: 300000,
    });
    pruneNodeModules(fullPath, pkg, dir);
    console.log(`  OK ${dir}`);
    success++;
  } catch (e) {
    console.error(`  FAIL ${dir}: ${e.message}`);
    failed++;
  }
}

console.log(`\nMCP Build: ${success} ok, ${failed} failed, ${skipped} skipped`);

if (failed > 0) {
  process.exit(1);
}
