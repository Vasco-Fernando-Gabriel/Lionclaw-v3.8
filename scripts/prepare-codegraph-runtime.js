#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');

const REPO_ROOT = path.resolve(__dirname, '..');
const SUPPORTED_TARGETS = ['linux-x64', 'darwin-x64', 'darwin-arm64', 'win32-x64'];

function currentTarget() {
  const target = `${process.platform}-${process.arch}`;
  if (!SUPPORTED_TARGETS.includes(target)) {
    throw new Error(`Target não suportado pelo CodeGraph: ${target}`);
  }
  return target;
}

function sha256File(filePath) {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function walkClosure(root) {
  const entries = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const dirent of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, dirent.name);
      const relative = path.relative(root, absolute).split(path.sep).join('/');
      if (dirent.isSymbolicLink()) {
        const linkTarget = fs.readlinkSync(absolute);
        entries.push({
          path: relative,
          sha256: createHash('sha256').update(linkTarget, 'utf8').digest('hex'),
          kind: 'symlink',
        });
      } else if (dirent.isDirectory()) {
        pending.push(absolute);
      } else if (dirent.isFile()) {
        const stat = fs.statSync(absolute);
        entries.push({ path: relative, sha256: sha256File(absolute), size: stat.size });
      } else {
        throw new Error(`Arquivo especial não suportado na closure: ${relative}`);
      }
    }
  }
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

function main() {
  const target = currentTarget();
  const sourceRoot = path.join(REPO_ROOT, 'node_modules', '@colbymchenry', `codegraph-${target}`);
  const sourcePackageJson = path.join(sourceRoot, 'package.json');
  if (!fs.existsSync(sourcePackageJson)) {
    throw new Error(
      `pacote @colbymchenry/codegraph-${target} não instalado em node_modules. ` +
      'Rode `npm install` na raiz do repo antes deste script.',
    );
  }
  const sourceVersion = JSON.parse(fs.readFileSync(sourcePackageJson, 'utf8')).version;

  const destRoot = path.join(REPO_ROOT, 'out', 'codegraph', target);
  const manifestPath = path.join(
    REPO_ROOT, 'out', 'distribution', 'manifests', 'codegraph', `${target}.json`,
  );

  if (fs.existsSync(manifestPath) && fs.existsSync(destRoot)) {
    try {
      const existing = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      if (existing.sourceVersion === sourceVersion && existing.target === target) {
        console.log(`CodeGraph runtime: atualizado (v${sourceVersion}, ${target})`);
        return;
      }
    } catch {
    }
  }

  console.log(`CodeGraph runtime: staging v${sourceVersion} para out/codegraph/${target}...`);
  fs.rmSync(destRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  fs.mkdirSync(path.dirname(destRoot), { recursive: true });
  fs.cpSync(sourceRoot, destRoot, {
    recursive: true,
    dereference: false,
    verbatimSymlinks: true,
  });

  const files = walkClosure(destRoot);
  const requiredEntrypoints = [
    target.startsWith('win32-') ? 'node.exe' : 'node',
    'lib/dist/bin/codegraph.js',
  ];
  for (const required of requiredEntrypoints) {
    if (!files.some((entry) => entry.path === required)) {
      throw new Error(
        `closure do CodeGraph sem o entrypoint esperado: ${required} ` +
        `(layout do pacote @colbymchenry/codegraph-${target} mudou?)`,
      );
    }
  }

  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(
    manifestPath,
    `${JSON.stringify({ component: 'codegraph', target, sourceVersion, files }, null, 2)}\n`,
  );
  console.log(`CodeGraph runtime: OK (${files.length} arquivos, manifesto gerado)`);
}

try {
  main();
} catch (error) {
  console.error(`CodeGraph runtime FAIL: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
